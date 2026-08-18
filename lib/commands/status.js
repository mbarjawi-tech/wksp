'use strict';
const fs   = require('fs');
const path = require('path');
const config = require('../config');
const { readRepos } = require('../repos');
const { discoverWorktrees, WORKTREES_DIR } = require('../worktrees');
const { readTaskSets } = require('../task-state');
const git  = require('../git');

async function run(args = []) {
  const flags = new Set(args.filter(a => a.startsWith('--')));
  if (flags.has('--help') || args.includes('-h')) {
    console.log(`
  wksp status [task-id]            Show repo branches and health for a task

  Arguments:
    task-id                        Task to inspect (auto-detected from cwd if omitted)

  Examples:
    wksp status                    Show status for the task you're inside
    wksp status PROJ-1234          Show status for a specific task from anywhere
`);
    process.exit(0);
  }

  const projectDir = config.findProjectDir();
  if (!projectDir) {
    console.error('  Error: not inside a wksp project');
    config.printNoProjectHint();
    process.exit(1);
  }

  const tasksDir = path.join(projectDir, 'tasks');

  // Accept an explicit task-id argument, falling back to cwd detection
  let taskId = args.filter(a => !a.startsWith('--'))[0] || null;

  if (!taskId) {
    const cwd = process.cwd();
    if (cwd.startsWith(tasksDir + path.sep) || cwd === tasksDir) {
      const rel = path.relative(tasksDir, cwd);
      taskId = rel.split(path.sep)[0] || null;
    }
  }

  if (!taskId) {
    if (!fs.existsSync(tasksDir)) { console.log('\n  No tasks yet.\n'); return; }
    const names = fs.readdirSync(tasksDir, { withFileTypes: true })
      .filter(e => e.isDirectory()).map(e => e.name);
    if (!names.length) { console.log('\n  No tasks yet.\n'); return; }
    console.log('\n  Not inside a task folder. Pass a task id or cd into one:\n');
    console.log('  Usage: wksp status [<task-id>]\n');
    console.log('  Available tasks:');
    names.forEach(n => console.log(`    · ${n}`));
    console.log();
    return;
  }

  if (!fs.existsSync(path.join(tasksDir, taskId))) {
    console.error(`  Error: task "${taskId}" not found in ${tasksDir}`);
    process.exit(1);
  }

  const taskDir    = path.join(tasksDir, taskId);
  const allRepos   = readRepos(projectDir);
  const wts        = discoverWorktrees(taskDir);
  // Keyed by folderName so aliases are handled correctly
  const baseMap    = new Map();
  for (const wt of wts) {
    baseMap.set(wt.folderName, wt);
  }

  const projectCfg  = config.readProjectConfig(projectDir);
  const projectName = projectCfg.name || path.basename(projectDir);
  const W = 44;
  const nameW   = allRepos.length ? Math.max(...allRepos.map(r => r.folderName.length)) + 2 : 20;
  const branchW = 26;

  console.log('\n' + '─'.repeat(W));
  console.log(`  wksp status · ${projectName} / ${taskId}`);
  console.log('─'.repeat(W));
  console.log('  Repos:\n');

  // task.json carries the two dispositions that have no on-disk trace of their own.
  // Without reading it, a repo deliberately shared with this task looked exactly like
  // one that never got set up — both printed "(no worktree)" — so status could neither
  // confirm a healthy task nor reveal a half-built one.
  const { taskSharedSet, taskExcludedSet } = readTaskSets(taskDir);
  const unset = [];
  const staleRegistrations = [];

  for (const repo of allRepos) {
    const name = repo.folderName;
    const opt  = repo.optional ? '  (optional)' : '';
    if (repo.shared || taskSharedSet.has(name)) {
      const branch = git.currentBranch(repo.normalized) || 'unknown';
      const scope  = repo.shared ? '(shared)' : '(shared — this task)';
      console.log(`    ${name.padEnd(nameW)} ${branch.padEnd(branchW)} ${scope}${opt}`);
      continue;
    }
    if (taskExcludedSet.has(name)) {
      const label = repo.optional ? '(optional — not in task)' : '(excluded)';
      console.log(`    ${name.padEnd(nameW)} ${label.padEnd(branchW)}`);
      continue;
    }
    const wt = baseMap.get(repo.folderName);
    if (!wt) {
      // An --optional repo with no worktree is doing exactly what it was registered to
      // do: start outside every task until one asks for it. Absence is its default, so
      // it is reported plainly and never counted as something needing attention.
      if (repo.optional) {
        console.log(`    ${name.padEnd(nameW)} ${'(optional — not in task)'.padEnd(branchW)}`);
        continue;
      }
      // "No folder under worktrees/" is not the same as "never decided". A worktree
      // whose folder was deleted by hand leaves the base repo's registration behind,
      // and git will keep refusing the branch as "already checked out" at a path that
      // no longer exists — so telling that user to re-run would send them into a dead
      // end. Ask the base repo before blaming the task. Only reached for repos that
      // would otherwise be reported undecided, so it costs nothing in the normal case.
      const stale = git.findWorktreeEntry(repo.normalized, path.join(taskDir, WORKTREES_DIR, name));
      if (stale) {
        console.log(`    ${name.padEnd(nameW)} ${'(folder missing)'.padEnd(branchW)} ⚠`);
        staleRegistrations.push({ name, branch: stale.branch, baseRepo: repo.normalized });
        continue;
      }
      // A non-optional repo with no worktree, no registration and no entry in
      // task.json: nobody ever decided. It is silently absent from everything a
      // session is given, so say so rather than print an empty-looking row.
      unset.push(name);
      console.log(`    ${name.padEnd(nameW)} ${'(not set up)'.padEnd(branchW)} ⚠`);
      continue;
    }
    // A stranded probe is not a corrupted worktree — its `worktreeDir` is a path that
    // doesn't exist right now, so `(corrupted) ✗` describes a phantom. Name the real state.
    // Not "see above": the detail (and the move that fixes it) goes to stderr, which is
    // absent when stdout is piped, and interleaving is not guaranteed even when it isn't.
    if (wt.strandedProbe) { console.log(`    ${name.padEnd(nameW)} ${'(renamed aside)'.padEnd(branchW)} ⚠`); continue; }
    if (wt.corrupted)  { console.log(`    ${name.padEnd(nameW)} ${'(corrupted)'.padEnd(branchW)} ✗`); continue; }
    const branch = wt.currentBranch || 'unknown';
    const health = fs.existsSync(wt.worktreeDir) ? '✓' : '⚠ missing';
    console.log(`    ${name.padEnd(nameW)} ${branch.padEnd(branchW)} ${health}${opt}`);
  }
  console.log('\n' + '─'.repeat(W));
  if (unset.length) {
    console.log(`\n  ⚠  Not set up in this task: ${unset.join(', ')}`);
    console.log('     These are registered in repos.txt but this task has no worktree and no');
    console.log('     recorded choice for them, so a session here is not given them at all.');
    console.log(`     Finish setting the task up:  wksp start ${taskId}`);
    console.log(`     Or decide one outright:      wksp task repo ${taskId} ${unset[0]} share|worktree|exclude`);
  }
  for (const s of staleRegistrations) {
    console.log(`\n  ⚠  ${s.name}: the worktree folder is gone, but its base repo still registers it`);
    if (s.branch) console.log(`     git still holds "${s.branch}" as checked out there, so re-creating it is refused.`);
    console.log(`     Clear the registration first:  git -C "${s.baseRepo}" worktree prune`);
    console.log(`     Then:                          wksp start ${taskId}`);
  }
  console.log('');
}

module.exports = { run };
