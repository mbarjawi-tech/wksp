'use strict';
const fs   = require('fs');
const path = require('path');
const { open, close, confirm, confirmTyped } = require('../prompts');
const config = require('../config');
const { discoverWorktrees } = require('../worktrees');
const git  = require('../git');

async function run() {
  const projectDir = config.findProjectDir();
  if (!projectDir) { console.error('  Error: not inside a wksp project'); process.exit(1); }

  const projectCfg  = config.readProjectConfig(projectDir);
  const projectName = projectCfg.name || path.basename(projectDir);
  const tasksDir    = path.join(projectDir, 'tasks');

  const taskInfos = [];
  if (fs.existsSync(tasksDir)) {
    for (const entry of fs.readdirSync(tasksDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const taskDir = path.join(tasksDir, entry.name);
      taskInfos.push({ name: entry.name, taskDir, wts: discoverWorktrees(taskDir) });
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

  open();
  const confirmed = await confirmTyped(`  Type "${projectName}" to confirm: `, projectName);
  if (!confirmed) { close(); console.log('\n  Cancelled.\n'); return; }

  let deleted = 0;
  for (let i = 0; i < taskInfos.length; i++) {
    const task = taskInfos[i];
    console.log(`\n  Deleting task: ${task.name}`);
    let ok = true;

    for (const wt of task.wts) {
      if (wt.corrupted || !wt.baseRepo) { console.warn(`  ⚠  Skipping corrupted: ${wt.folderName}`); continue; }
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
      console.error(`  Fix with: wksp task <id> --del  then re-run: wksp delete\n`);
      process.exit(1);
    }

    const baseRepos = new Set(task.wts.filter(w => w.baseRepo).map(w => w.baseRepo));
    for (const br of baseRepos) { try { git.pruneWorktrees(br); } catch {} }
    fs.rmSync(task.taskDir, { recursive: true, force: true });
    console.log(`  ✓  Deleted tasks/${task.name}/`);
    deleted++;
  }
  close();

  fs.rmSync(projectDir, { recursive: true, force: true });
  console.log(`\n  ✓  Deleted project: ${projectName}/`);
  console.log('  Done.\n');
}

module.exports = { run };
