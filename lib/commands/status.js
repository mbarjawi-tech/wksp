'use strict';
const fs   = require('fs');
const path = require('path');
const config = require('../config');
const { readRepos } = require('../repos');
const { discoverWorktrees } = require('../worktrees');
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
  if (!projectDir) { console.error('  Error: not inside a wksp project'); process.exit(1); }

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

  for (const repo of allRepos) {
    const name = repo.folderName;
    const opt  = repo.optional ? '  (optional)' : '';
    if (repo.shared) {
      const branch = git.currentBranch(repo.normalized) || 'unknown';
      console.log(`    ${name.padEnd(nameW)} ${branch.padEnd(branchW)} (shared)${opt}`);
      continue;
    }
    const wt = baseMap.get(repo.folderName);
    if (!wt) {
      const label = repo.optional ? '(optional — not in task)' : '(no worktree)';
      console.log(`    ${name.padEnd(nameW)} ${label.padEnd(branchW)}`);
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
  console.log('\n' + '─'.repeat(W) + '\n');
}

module.exports = { run };
