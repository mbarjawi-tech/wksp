'use strict';
const fs   = require('fs');
const path = require('path');
const config = require('../config');
const { readRepos } = require('../repos');
const { discoverWorktrees } = require('../worktrees');
const git  = require('../git');

async function run() {
  const projectDir = config.findProjectDir();
  if (!projectDir) { console.error('  Error: not inside a wksp project'); process.exit(1); }

  const cwd      = process.cwd();
  const tasksDir = path.join(projectDir, 'tasks');
  let taskId     = null;

  if (cwd.startsWith(tasksDir + path.sep) || cwd === tasksDir) {
    const rel = path.relative(tasksDir, cwd);
    taskId = rel.split(path.sep)[0] || null;
  }

  if (!taskId) {
    if (!fs.existsSync(tasksDir)) { console.log('\n  No tasks yet.\n'); return; }
    const names = fs.readdirSync(tasksDir, { withFileTypes: true })
      .filter(e => e.isDirectory()).map(e => e.name);
    if (!names.length) { console.log('\n  No tasks yet.\n'); return; }
    console.log('\n  Not inside a task folder. Use: wksp list\n');
    console.log('  Available tasks:');
    names.forEach(n => console.log(`    · ${n}`));
    console.log();
    return;
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
    if (repo.shared) {
      const branch = git.currentBranch(repo.normalized) || 'unknown';
      console.log(`    ${name.padEnd(nameW)} ${branch.padEnd(branchW)} (shared)`);
      continue;
    }
    const wt = baseMap.get(repo.folderName);
    if (!wt)           { console.log(`    ${name.padEnd(nameW)} ${'(no worktree)'.padEnd(branchW)}`); continue; }
    if (wt.corrupted)  { console.log(`    ${name.padEnd(nameW)} ${'(corrupted)'.padEnd(branchW)} ✗`); continue; }
    const branch = wt.currentBranch || 'unknown';
    const health = fs.existsSync(wt.worktreeDir) ? '✓' : '⚠ missing';
    console.log(`    ${name.padEnd(nameW)} ${branch.padEnd(branchW)} ${health}`);
  }
  console.log('\n' + '─'.repeat(W) + '\n');
}

module.exports = { run };
