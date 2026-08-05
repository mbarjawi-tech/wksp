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
//   scanStrandedProbes   → before probing anything, find a worktree a CRASHED run left
//                          renamed aside (see probeRemovable) and — for a caller with
//                          destructive intent, `recover: true` — put it back so it is
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
// scanStrandedProbes.
const PROBE_PREFIX = '.wksp-probe-';

// Best-effort check that `dir` can be deleted, meant to run BEFORE the first
// destructive step. A directory the OS lets us rename is one it will let us delete,
// and a rename either succeeds whole or changes nothing — so a lock is caught while
// the worktree is still intact instead of after its contents are gone.
//
// `probeParent` is where the temporary name lives; callers pass the task folder for a
// worktree, both so a stranded probe never gets mistaken for one of the worktrees
// under worktrees/, and so scanStrandedProbes (which scans exactly that folder)
// can find it. Returns { ok: true } or { ok: false, code, message, stranded } —
// `stranded` is set only when the probe renamed the directory away and then could
// not put it back, and names where it went so nothing is lost silently.
function probeRemovable(dir, probeParent = path.dirname(dir)) {
  if (!fs.existsSync(dir)) return { ok: true };
  const probe = path.join(probeParent, `${PROBE_PREFIX}${path.basename(dir)}`);
  if (fs.existsSync(probe)) {
    // With the old pid+random name a collision here was a coincidence so unlikely it
    // was safe to shrug off. The deterministic name makes this deliberate instead: it
    // means a probe from an earlier run is still stranded and scanStrandedProbes —
    // which every destructive caller runs first — already could not put it back. Report
    // it as locked rather than silently assuming removable.
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
    // Belt and braces for a concurrent recovery: ENOENT means the probe path is gone,
    // and `dir` existing again means someone else already put the folder back for us —
    // a second wksp run whose scanStrandedProbes(recover: true) landed in the window
    // between our two renames. The worktree is exactly where it belongs and it
    // demonstrably renames, so that is the success case. Reporting `stranded` here
    // would be a false "locked" verdict naming a path that no longer exists, with
    // remediation pointing at a directory that is already correct.
    //
    // `!fs.existsSync(probe)` is what makes that reasoning sound: OUR folder must
    // genuinely be back at `dir`. Without it, a different directory appearing at `dir`
    // while ours still sat at `probe` would read as the same success and lose the trail.
    if (e.code === 'ENOENT' && !fs.existsSync(probe) && fs.existsSync(dir)) return { ok: true };
    return { ok: false, code: e.code || null, message: e.message, stranded: probe };
  }
  return { ok: true };
}

// Detects a worktree probe (above) left stranded by a run that died BETWEEN the two
// renames — crash, kill, power loss — so the worktree sits as a SIBLING of
// worktrees/, under its deterministic name, invisible to anything that only scans
// worktrees/*. Called from discoverWorktrees, so every consumer at least SEES it
// rather than it vanishing from view and later being swept up, unnoticed, by a bulk
// delete of the task folder.
//
// `recover` is the caller's destructive intent, not a convenience. Putting the folder
// back is a filesystem mutation, so only the commands that were already going to move
// or delete this worktree ask for it (delete / archive / finish / repo remove / the
// project-wide delete). A read-oriented command — status, list, brief, export — scans
// and reports: renaming a directory as a side effect of merely looking is surprising,
// and it races the very probe it would be helping. One run's probeRemovable is between
// its two renames when a concurrent `wksp status` puts the folder back for it; its own
// rename-back then fails ENOENT and it reports the worktree as locked, with
// remediation naming a path that no longer exists. (probeRemovable now survives that
// race too — see the ENOENT branch above — but not creating it is the actual fix.)
//
// Returns { recovered: [folderName, ...], stranded: [{ folderName, strandedPath,
// targetPath, code, message, attempted }] }. Under `recover` a `stranded` entry means
// the rename back itself failed (still locked) or the target already exists (should not
// happen, and is never overwritten) — the caller must refuse rather than silently
// continue. Without `recover`, every probe found is reported as stranded with
// `attempted: false`, because nothing was tried.
function scanStrandedProbes(taskDir, worktreesDirName, { recover = false } = {}) {
  const recovered = [];
  const stranded  = [];
  let entries;
  try {
    if (!fs.existsSync(taskDir)) return { recovered, stranded };
    entries = fs.readdirSync(taskDir, { withFileTypes: true });
  } catch {
    // taskDir unreadable — EACCES/EPERM, or something that is not a directory. Every
    // read command funnels through discoverWorktrees and none of them catch, so a throw
    // from here turns `wksp status` / `list` / `brief` / `export` into a bare `Fatal:`.
    // This scan is advisory, not the command's actual work: report nothing instead.
    return { recovered, stranded };
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(PROBE_PREFIX)) continue;
    const folderName   = entry.name.slice(PROBE_PREFIX.length);
    const strandedPath = path.join(taskDir, entry.name);
    const targetPath   = path.join(taskDir, worktreesDirName, folderName);
    if (!recover) {
      stranded.push({ folderName, strandedPath, targetPath, code: null, message: 'not moved back — this command only reports it', attempted: false });
      continue;
    }
    if (fs.existsSync(targetPath)) {
      stranded.push({ folderName, strandedPath, targetPath, code: 'EEXIST', message: `${targetPath} already exists`, attempted: true });
      continue;
    }
    try {
      fs.renameSync(strandedPath, targetPath);
      recovered.push(folderName);
    } catch (e) {
      stranded.push({ folderName, strandedPath, targetPath, code: e.code || null, message: e.message, attempted: true });
    }
  }
  return { recovered, stranded };
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
  isCwdInside, ensureCwdOutside, probeRemovable, currentCwd, scanStrandedProbes,
};
