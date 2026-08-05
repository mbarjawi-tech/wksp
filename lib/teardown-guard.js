'use strict';
// Guards for the destructive half of task teardown (delete / archive / finish).
//
// Windows keeps a directory open while any process's cwd is inside it, and wksp runs
// as a CHILD of the shell that launched it — so it inherits that shell's cwd. An
// agent or terminal sitting in tasks/<id>/worktrees/<repo> therefore makes wksp
// itself hold the worktree open. And `git worktree remove` deletes a worktree's
// CONTENTS (including its .git file) before it removes the directory, so the lock is
// only discovered once the checkout is already gutted — the half-state that used to
// read back as "corrupted at archive" and silently downgrade the archive record.
//
// Hence three guards, used in this order by lib/commands/task.js:
//   isCwdInside      → refuse up front, before anything is touched (the only safe
//                      answer, because wksp cannot move the parent shell's cwd)
//   probeRemovable   → fail before destroying: a directory we can rename is one we
//                      can delete, and a rename changes nothing when it fails
//   ensureCwdOutside → belt and braces immediately before the delete / rename, the
//                      same move lib/commands/delete.js makes for a project folder
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

// Best-effort check that `dir` can be deleted, meant to run BEFORE the first
// destructive step. A directory the OS lets us rename is one it will let us delete,
// and a rename either succeeds whole or changes nothing — so a lock is caught while
// the worktree is still intact instead of after its contents are gone.
//
// `probeParent` is where the temporary name lives; callers pass the task folder for a
// worktree so a (near-impossible) stranded probe can't be mistaken for a worktree.
// Returns { ok: true } or { ok: false, code, message, stranded } — `stranded` is set
// only when the probe renamed the directory away and then could not put it back, and
// names where it went so nothing is lost silently.
function probeRemovable(dir, probeParent = path.dirname(dir)) {
  if (!fs.existsSync(dir)) return { ok: true };
  const probe = path.join(probeParent, `.wksp-probe-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  if (fs.existsSync(probe)) return { ok: true }; // never touch something already there
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

module.exports = { isCwdInside, ensureCwdOutside, probeRemovable, currentCwd };
