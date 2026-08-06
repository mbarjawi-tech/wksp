'use strict';
const fs   = require('fs');
const path = require('path');
const { open, close, confirm, confirmTyped } = require('../prompts');
const config = require('../config');
const { discoverWorktrees } = require('../worktrees');
const git  = require('../git');
const { isCwdInside, probeRemovable, currentCwd } = require('../teardown-guard');
const { unsafeProjectDirReason } = require('../paths');

// A shell sitting in tasks/<id>/ ITSELF — not in one of its worktrees — passes the
// per-worktree cwd check below and then makes the bulk `fs.rmSync(task.taskDir, ...)`
// fail with a bare EBUSY. The process.chdir further down comes too late: it only
// protects the project folder, after every task folder has already been deleted. wksp
// inherits its cwd from the shell that launched it and cannot release that shell's
// handle, so refusing is the answer here as everywhere else.
function refuseTaskCwd(taskDir) {
  if (!isCwdInside(taskDir)) return false;
  console.error(`\n  Your shell is inside ${currentCwd()} — cd out of it, then re-run: wksp delete`);
  return true;
}

async function run() {
  const projectDir = config.findProjectDir();
  if (!projectDir) {
    console.error('  Error: not inside a wksp project');
    config.printNoProjectHint();
    process.exit(1);
  }

  // Last line of defence, and the reason it exists: this command recursively deletes
  // whatever it is pointed at. Project resolution can no longer hand back the home
  // directory (lib/config.js checks the marker's path AND its shape), but `delete` is the
  // one command where being wrong is unrecoverable — so it refuses these paths outright,
  // whatever a marker sitting there claims. Only the typed-name confirmation stood
  // between `wksp delete` and `rm -rf ~` before.
  const unsafe = unsafeProjectDirReason(projectDir);
  if (unsafe) {
    console.error(`\n  Refusing to delete ${projectDir} — ${unsafe}.`);
    console.error('  This is never a wksp project. Nothing was deleted.');
    // Two different situations reach this line, and the old advice ("remove the stray .wksp
    // by hand") was actively wrong for the second: a genuine project can sit at a
    // filesystem root, and telling someone to delete its marker would orphan the whole
    // project rather than let them delete it.
    console.error('  If a real project is there, move it into a subdirectory and run wksp delete from inside it.');
    console.error('  If it is only a stray .wksp file, remove that file by hand.\n');
    process.exit(1);
  }

  const projectCfg  = config.readProjectConfig(projectDir);
  const projectName = projectCfg.name || path.basename(projectDir);
  const tasksDir    = path.join(projectDir, 'tasks');

  const taskInfos = [];
  if (fs.existsSync(tasksDir)) {
    for (const entry of fs.readdirSync(tasksDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const taskDir = path.join(tasksDir, entry.name);
      // Strictly read-only: this enumeration runs BEFORE the confirm gate, so it must not
      // rename a thing. A user who mistypes the project name and cancels has to find every
      // folder exactly where it was — the recovery happens per task in the deletion loop
      // below, once deleting is actually going ahead. `report: false` for the same reason:
      // the loop's own scan says what it moved, and a pre-confirm "this command only
      // reports it" would be a notice about a command the user may never confirm.
      taskInfos.push({ name: entry.name, taskDir, wts: discoverWorktrees(taskDir, { report: false }) });
    }
  }

  const totalWt = taskInfos.reduce((s, t) => s + t.wts.length, 0);
  console.log(`\n  ⚠  DESTRUCTIVE: Delete project "${projectName}"?`);
  if (taskInfos.length) {
    const summary = taskInfos.map(t => `${t.name} (${t.wts.length} worktree${t.wts.length !== 1 ? 's' : ''})`).join(', ');
    console.log(`  Tasks: ${summary}`);
    console.log(`  This will remove ${totalWt} worktree(s) and delete the ${projectName}/ folder.`);
  } else {
    console.log(`  No tasks. This will delete the ${projectName}/ folder.`);
  }
  console.log();

  // Pre-loop over every task, as lib/commands/repo.js does for its own cwd check: a shell
  // sitting in task N used to surface only after tasks 1..N-1 had already been deleted,
  // turning one blocker into a half-deleted project. Checked before the confirm too — no
  // point making someone type the project name for a run that cannot finish.
  for (const task of taskInfos) {
    if (refuseTaskCwd(task.taskDir)) { console.error(''); process.exit(1); }
  }

  open();
  const confirmed = await confirmTyped(`  Type "${projectName}" to confirm: `, projectName);
  if (!confirmed) { close(); console.log('\n  Cancelled.\n'); return; }

  let deleted = 0;
  for (let i = 0; i < taskInfos.length; i++) {
    const task = taskInfos[i];
    console.log(`\n  Deleting task: ${task.name}`);
    // Now — past the confirm — is when a stranded probe earns being put back: `recover:
    // true`, since deleting the whole project is about as destructive as intent gets.
    const wts = discoverWorktrees(task.taskDir, { recover: true });
    let ok = true;
    let cwdBlocked = false;

    for (const wt of wts) {
      // A worktree probe an earlier crashed run left stranded, and this run could not
      // put back automatically: it is a still-valid git worktree sitting as a sibling
      // of worktrees/, so treating it like ordinary corruption (skip and continue)
      // would let the `fs.rmSync(task.taskDir, ...)` below sweep it up unnoticed —
      // orphaning the base repo's registration and discarding the branch's identity
      // with no trail. Stop this task rather than silently lose it.
      if (wt.strandedProbe) {
        console.error(`\n  "${wt.folderName}" has a worktree probe stranded by an earlier run that`);
        console.error(`  could not be moved back automatically. It is currently at:\n    ${wt.strandedPath}`);
        console.error(`  Move it back by hand to:\n    ${wt.worktreeDir}`);
        ok = false;
        break;
      }
      if (wt.corrupted || !wt.baseRepo) { console.warn(`  ⚠  Skipping corrupted: ${wt.folderName}`); continue; }

      // Refuse before touching anything — same guards task teardown uses: a shell
      // inside this worktree, or a lock on it, would otherwise surface only after
      // `git worktree remove` has already deleted its contents. The pre-loop above
      // covers a cwd under the task folder; this still catches a worktree that is a
      // junction or symlink whose resolved path sits outside it.
      if (isCwdInside(wt.worktreeDir)) {
        console.error(`\n  Your shell is inside ${currentCwd()} — cd out of it, then re-run: wksp delete`);
        ok = false;
        cwdBlocked = true;
        break;
      }
      const probe = probeRemovable(wt.worktreeDir, task.taskDir);
      if (!probe.ok) {
        console.error(`\n  "${wt.folderName}" is locked${probe.code ? ` (${probe.code})` : ''} — nothing removed for it.`);
        if (probe.stranded) {
          console.error(`  ⚠  The lock check could not put the folder back. It is now at: ${probe.stranded}`);
          console.error(`     Move it back to: ${wt.worktreeDir}`);
        }
        ok = false;
        break;
      }

      try {
        git.removeWorktree(wt.baseRepo, wt.worktreeDir);
        console.log(`  ✓  Removed worktree: ${wt.folderName}`);
      } catch {
        const changed = git.getChangedFiles(wt.worktreeDir);
        if (changed) {
          console.log(`  Uncommitted changes in "${wt.folderName}":`);
          console.log(changed.split('\n').map(l => '    ' + l).join('\n'));
        }
        const force = await confirm(`  Force remove "${wt.folderName}"? (discards changes)`);
        if (force) {
          try { git.removeWorktree(wt.baseRepo, wt.worktreeDir, true); console.log(`  ✓  Force-removed: ${wt.folderName}`); }
          catch (e) { console.error(`  ✗  Failed: ${e.message}`); ok = false; }
        } else { ok = false; }
      }
    }

    if (!ok) {
      close();
      const remaining = taskInfos.slice(i).map(t => t.name).join(', ');
      console.error(`\n  Stopped at task "${task.name}". Deleted ${deleted} of ${taskInfos.length}.`);
      console.error(`  Remaining: ${remaining}`);
      // Pointless advice when the blocker is our own inherited cwd — `wksp task delete`
      // would refuse for exactly the same reason. The cd instruction is already printed.
      if (!cwdBlocked) console.error(`  Fix with: wksp task delete <id>  then re-run: wksp delete`);
      console.error('');
      process.exit(1);
    }

    const baseRepos = new Set(wts.filter(w => w.baseRepo).map(w => w.baseRepo));
    for (const br of baseRepos) { try { git.pruneWorktrees(br); } catch {} }
    try {
      fs.rmSync(task.taskDir, { recursive: true, force: true });
    } catch (e) {
      // Same pattern as the task commands' own rmSync: this task's worktrees are already
      // gone, so re-running finishes the job — say which command, instead of letting a
      // locked file out as a bare `Fatal:` from bin/wksp.js.
      close();
      console.error(`\n  ✗  Kept tasks/${task.name}/ — could not delete it (${e.code || e.message}).`);
      console.error('     Something has a file or folder inside it open. Close it, then re-run: wksp delete\n');
      process.exit(1);
    }
    console.log(`  ✓  Deleted tasks/${task.name}/`);
    deleted++;
  }
  close();

  // Move out of the project folder before deleting it — on Windows,
  // rmSync fails with EBUSY if the shell's cwd is inside the target directory.
  try {
    process.chdir(path.dirname(projectDir));
  } catch {
    // Parent directory inaccessible — all tasks are already torn down;
    // only the project folder itself remains.
    console.log(`\n  ✓  All tasks and worktrees removed.`);
    console.log(`  ⚠  Could not navigate to the parent directory to delete the project folder.`);
    console.log(`     Please delete it manually:\n`);
    console.log(`       rm -rf "${projectDir}"\n`);
    return;
  }

  fs.rmSync(projectDir, { recursive: true, force: true });
  console.log(`\n  ✓  Deleted project: ${projectName}/`);
  console.log('  Done.');
  console.log(`\n  💡  Your shell is still in the deleted folder — run: cd ..\n`);
}

module.exports = { run };
