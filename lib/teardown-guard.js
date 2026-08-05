'use strict';
// Guards for the destructive half of task teardown (delete / archive / finish /
// `task repo <id> <repo> share|exclude` / `repo remove` / the project-wide `delete`).
//
// Windows keeps a directory open while any process's cwd is inside it, and wksp runs
// as a CHILD of the shell that launched it — so it inherits that shell's cwd. An
// agent or terminal sitting in tasks/<id>/worktrees/<repo> therefore makes wksp
// itself hold the worktree open. And `git worktree remove` deletes a worktree's
// CONTENTS (including its .git file) before it removes the directory, so the lock is
// only discovered once the checkout is already gutted — the half-state that used to
// read back as "corrupted at archive" and silently downgrade the archive record.
//
// Hence the guards, used in this order by callers:
//   isCwdInside          → refuse up front, before anything is touched (the only safe
//                          answer, because wksp cannot move the parent shell's cwd)
//   recoverStrandedProbes → before probing anything, put back a worktree a CRASHED
//                          run left renamed aside (see probeRemovable) so it is
//                          discovered and torn down normally, not silently invisible
//   probeRemovable       → fail before destroying: a directory we can rename is one we
//                          can delete, and a rename changes nothing when it fails
//   ensureCwdOutside     → belt and braces immediately before the delete / rename, the
//                          same move lib/commands/delete.js makes for a project folder
//
// This module only holds the PURE checks (no console, no process.exit) so they stay
// trivially mockable from outside — see the note above module.exports for why the
// print-and-exit wrappers deliberately do NOT live here.
const fs   = require('fs');
const path = require('path');
const { isInside } = require('./paths');

// The process cwd, or null when it no longer exists — process.cwd() throws ENOENT
// once the directory it points at has been deleted.
function currentCwd() {
  try { return process.cwd(); } catch { return null; }
}

// True when this process's cwd is `dir` itself or anything under it.
function isCwdInside(dir) {
  const cwd = currentCwd();
  if (!cwd) return false;
  if (isInside(cwd, dir)) return true;
  // A junction, an 8.3 short name or a symlinked temp dir can make one directory
  // look like two different paths, so compare the resolved forms too.
  return isInside(realish(cwd), realish(dir));
}

function realish(p) {
  try { return fs.realpathSync(p); } catch { return p; }
}

// Move the process out of `dir` before `dir` is deleted or renamed, mirroring what
// lib/commands/delete.js does before rmSync'ing a project folder: chdir somewhere
// safe, and degrade gracefully when even that fails. Returns true when the cwd is
// clear of `dir` (including when it never was inside).
//
// Belt and braces only — it cannot rescue a run whose PARENT shell sits in the
// folder, since that handle is not ours to release. That is what the up-front
// refusal is for.
function ensureCwdOutside(dir, safeDir) {
  if (!isCwdInside(dir)) return true;
  try { process.chdir(safeDir); return true; }
  catch { return false; }
}

// The probe folder's name is deterministic (encodes the worktree's own folder name)
// rather than pid+random, precisely so a run that crashes between the two renames
// below leaves something the NEXT run can recognise and put back — see
// recoverStrandedProbes.
const PROBE_PREFIX = '.wksp-probe-';

// Best-effort check that `dir` can be deleted, meant to run BEFORE the first
// destructive step. A directory the OS lets us rename is one it will let us delete,
// and a rename either succeeds whole or changes nothing — so a lock is caught while
// the worktree is still intact instead of after its contents are gone.
//
// `probeParent` is where the temporary name lives; callers pass the task folder for a
// worktree, both so a stranded probe never gets mistaken for one of the worktrees
// under worktrees/, and so recoverStrandedProbes (which scans exactly that folder)
// can find it. Returns { ok: true } or { ok: false, code, message, stranded } —
// `stranded` is set only when the probe renamed the directory away and then could
// not put it back, and names where it went so nothing is lost silently.
function probeRemovable(dir, probeParent = path.dirname(dir)) {
  if (!fs.existsSync(dir)) return { ok: true };
  const probe = path.join(probeParent, `${PROBE_PREFIX}${path.basename(dir)}`);
  if (fs.existsSync(probe)) {
    // With the old pid+random name a collision here was a coincidence so unlikely it
    // was safe to shrug off. The deterministic name makes this deliberate instead: it
    // means a probe from an earlier run is still stranded and recoverStrandedProbes —
    // which every caller runs first — already could not put it back. Report it as
    // locked rather than silently assuming removable.
    return { ok: false, code: 'EEXIST', message: `probe path already exists: ${probe}` };
  }
  try {
    fs.renameSync(dir, probe);
  } catch (e) {
    return { ok: false, code: e.code || null, message: e.message };
  }
  try {
    fs.renameSync(probe, dir);
  } catch (e) {
    return { ok: false, code: e.code || null, message: e.message, stranded: probe };
  }
  return { ok: true };
}

// Detects a worktree probe (above) left stranded by a run that died BETWEEN the two
// renames — crash, kill, power loss — so the worktree sits as a SIBLING of
// worktrees/, under its deterministic name, invisible to anything that only scans
// worktrees/*. Puts it back before the caller does anything else. Called from
// discoverWorktrees, so every consumer sees the recovered worktree as an ordinary one
// again — discovered, merge-checked, torn down normally — rather than it vanishing
// from view and later being swept up, unnoticed, by a bulk delete of the task folder.
//
// Returns { recovered: [folderName, ...], failed: [{ folderName, strandedPath,
// targetPath, code, message }] }. `failed` entries are when the rename back itself
// fails (still locked) or the target already exists (should not happen, and is never
// overwritten) — the caller must refuse rather than silently continue.
function recoverStrandedProbes(taskDir, worktreesDirName) {
  const recovered = [];
  const failed = [];
  if (!fs.existsSync(taskDir)) return { recovered, failed };
  for (const entry of fs.readdirSync(taskDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(PROBE_PREFIX)) continue;
    const folderName   = entry.name.slice(PROBE_PREFIX.length);
    const strandedPath = path.join(taskDir, entry.name);
    const targetPath   = path.join(taskDir, worktreesDirName, folderName);
    if (fs.existsSync(targetPath)) {
      failed.push({ folderName, strandedPath, targetPath, code: 'EEXIST', message: `${targetPath} already exists` });
      continue;
    }
    try {
      fs.renameSync(strandedPath, targetPath);
      recovered.push(folderName);
    } catch (e) {
      failed.push({ folderName, strandedPath, targetPath, code: e.code || null, message: e.message });
    }
  }
  return { recovered, failed };
}

// The print-and-exit wrappers (refuseIfCwdInside / refuseIfLocked /
// refuseIfStrandedProbes) live in lib/commands/task.js, not here: they call
// probeRemovable, and task.js's tests simulate a lock by mocking probeRemovable on
// this module from the OUTSIDE (`jest.mock('../teardown-guard', ...)`), which only
// intercepts calls that go through `require()` — a same-module function reference
// would bypass it. Keeping the wrappers in the consuming module keeps them testable
// without a self-referential export just to make mocking reach them. `wksp repo
// remove` and the project-wide `wksp delete` reuse the pure checks below directly,
// with their own wording, since "Cannot tear down <taskId>" doesn't fit either.

module.exports = {
  isCwdInside, ensureCwdOutside, probeRemovable, currentCwd, recoverStrandedProbes,
};
