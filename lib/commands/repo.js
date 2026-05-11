'use strict';
const fs   = require('fs');
const path = require('path');
const { open, close, ask, confirm } = require('../prompts');
const config     = require('../config');
const repos      = require('../repos');
const git        = require('../git');
const { discoverWorktrees } = require('../worktrees');
const { normalizePath }     = require('../paths');

function isGitUrl(s) { return /^(https?:\/\/|git@|ssh:\/\/)/.test(s); }
function repoNameFromUrl(url) { return url.replace(/\.git$/, '').split('/').pop(); }

async function handleRemove(projectDir, rawPath) {
  const normalized = normalizePath(rawPath);
  const tasksDir   = path.join(projectDir, 'tasks');
  const orphaned   = [];

  if (fs.existsSync(tasksDir)) {
    for (const entry of fs.readdirSync(tasksDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const taskDir = path.join(tasksDir, entry.name);
      for (const wt of discoverWorktrees(taskDir)) {
        if (wt.baseRepo && normalizePath(wt.baseRepo) === normalized) {
          orphaned.push({ taskName: entry.name, wt });
        }
      }
    }
  }

  if (orphaned.length) {
    const repoName = path.basename(normalized);
    console.log(`\n  Warning: ${repoName} has worktrees in ${orphaned.length} task(s):`);
    orphaned.forEach(o => console.log(`    · ${o.taskName} → ${o.wt.folderName}`));
    open();
    const yes = await confirm('  Remove these worktrees too?');
    close();
    if (yes) {
      for (const { taskName, wt } of orphaned) {
        try {
          git.removeWorktree(wt.baseRepo, wt.worktreeDir);
          git.pruneWorktrees(wt.baseRepo);
          console.log(`  ✓  Removed worktree: ${taskName}/${wt.folderName}`);
        } catch {
          console.warn(`  ⚠  Could not remove: ${taskName}/${wt.folderName} — remove manually`);
        }
      }
    }
  }

  repos.removeRepo(projectDir, rawPath);
  console.log(`  ✓  Removed from repos.txt: ${rawPath}`);
}

async function run(args) {
  const flags    = new Set(args.filter(a => a.startsWith('--')));
  const posArgs  = args.filter(a => !a.startsWith('--'));
  const rawInput = posArgs[0];

  if (!rawInput) {
    console.error('  Usage: wksp repo <path-or-url> [--shared] [--remove]');
    process.exit(1);
  }

  const projectDir = config.findProjectDir();
  if (!projectDir) {
    console.error('  Error: not inside a wksp project (no .wksp marker found)');
    process.exit(1);
  }

  if (flags.has('--remove')) { await handleRemove(projectDir, rawInput); return; }

  const shared = flags.has('--shared');
  let finalPath = rawInput;

  if (isGitUrl(rawInput)) {
    let globalCfg = config.readGlobalConfig();
    if (!globalCfg.reposRoot) {
      console.log('\n  reposRoot is not set. Where should repos be cloned?');
      open();
      const cr = await ask('  reposRoot: ');
      close();
      if (!cr) {
        console.error('  Error: reposRoot required for GitHub URLs. Set with: wksp config set reposRoot <path>');
        process.exit(1);
      }
      config.setGlobalConfig('reposRoot', cr);
      globalCfg = config.readGlobalConfig();
      console.log(`  ✓  Saved reposRoot = ${cr}`);
    }
    const repoName  = repoNameFromUrl(rawInput);
    const cloneDest = path.join(globalCfg.reposRoot, repoName);
    if (fs.existsSync(cloneDest)) {
      console.log(`  ✓  Already cloned at ${cloneDest}`);
    } else {
      console.log(`\n  Cloning ${rawInput}\n       → ${cloneDest} ...`);
      git.clone(rawInput, cloneDest);
      console.log(`  ✓  Cloned`);
    }
    finalPath = cloneDest;
  } else if (!fs.existsSync(normalizePath(rawInput))) {
    console.warn(`  ⚠  Path does not exist: ${normalizePath(rawInput)}`);
  }

  repos.addRepo(projectDir, finalPath, shared);
  console.log(`  ✓  Added to repos.txt: ${finalPath}${shared ? '  (--shared)' : ''}`);
}

module.exports = { run };
