'use strict';
const fs   = require('fs');
const path = require('path');
const git  = require('../git');
const config = require('../config');
const { readRepos } = require('../repos');
const { normalizePath } = require('../paths');

async function pruneRepo(repoPath) {
  if (!git.isGitRepo(repoPath)) { console.log(`  ⚠  Not a git repo: ${repoPath}`); return; }
  console.log(`  Pruning: ${repoPath}`);
  try { git.pruneWorktrees(repoPath); console.log(`  ✓  Pruned`); }
  catch (e) { console.error(`  ✗  ${e.message}`); }
}

async function run(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
  wksp cleanup [<path>] [--recursive]

  Prune stale git worktree refs from base repos.

  With no arguments: scans all repos registered in the current project.
  With <path>: prune a specific repo directory.

  Options:
    --recursive    Also scan first-level subdirectories of <path>

  Examples:
    wksp cleanup                          # scan all project repos (smart default)
    wksp cleanup /c/dev/backend           # prune a specific repo
    wksp cleanup /c/dev/repos --recursive # scan all subdirs of a directory

  Deprecated (still works, but will be removed):
    wksp cleanup --stale <path>           # use: wksp cleanup <path>
    wksp cleanup --stale <path> -r        # use: wksp cleanup <path> --recursive
`);
    process.exit(0);
  }

  // ── deprecated alias handling ───────────────────────────────────────────────
  let args2 = [...args];
  if (args2.includes('--stale')) {
    const idx = args2.indexOf('--stale');
    console.warn('\n  ⚠  Deprecated: --stale <path>');
    console.warn('     Use instead: wksp cleanup <path>\n');
    // Rewrite: pull the path out of --stale position and make it a positional
    if (idx + 1 < args2.length && !args2[idx + 1].startsWith('-')) {
      const stalePath = args2.splice(idx, 2)[1]; // remove --stale <path>
      args2 = [stalePath, ...args2];
    } else {
      args2.splice(idx, 1); // just remove --stale, no path
    }
  }
  if (args2.includes('-r') && !args2.includes('--recursive')) {
    console.warn('\n  ⚠  Deprecated: -r');
    console.warn('     Use instead: --recursive\n');
    args2[args2.indexOf('-r')] = '--recursive';
  }

  const recursive = args2.includes('--recursive');
  const positional = args2.filter(a => !a.startsWith('-'));

  // ── zero-arg: scan all project repos ───────────────────────────────────────
  if (positional.length === 0) {
    const projectDir = config.findProjectDir();
    if (!projectDir) {
      console.error('  Error: not inside a wksp project. Provide a path: wksp cleanup <path>');
      process.exit(1);
    }
    const allRepos = readRepos(projectDir);
    if (!allRepos.length) {
      console.log('  No repos registered in this project.');
      return;
    }
    console.log('\n  Pruning stale worktree refs for all project repos...\n');
    for (const repo of allRepos) {
      if (fs.existsSync(repo.normalized)) await pruneRepo(repo.normalized);
      else console.log(`  ⚠  Repo not found on disk: ${repo.normalized}`);
    }
    return;
  }

  // ── explicit path ───────────────────────────────────────────────────────────
  const normalized = normalizePath(positional[0]);
  if (!fs.existsSync(normalized)) {
    console.error(`  Error: path not found: ${normalized}`); process.exit(1);
  }

  if (recursive) {
    for (const entry of fs.readdirSync(normalized, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sub = path.join(normalized, entry.name);
      if (git.isGitRepo(sub)) await pruneRepo(sub);
    }
  } else {
    await pruneRepo(normalized);
  }
}

module.exports = { run };
