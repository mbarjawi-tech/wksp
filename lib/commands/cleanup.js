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

  // Detect removed v1 flags and give specific migration hints
  if (args.includes('--stale')) {
    const idx  = args.indexOf('--stale');
    const path = idx + 1 < args.length && !args[idx + 1].startsWith('-') ? args[idx + 1] : '<path>';
    console.error(`\n  Error: "--stale" was removed in v2.5.0.`);
    console.error(`         Use instead: wksp cleanup ${path}\n`);
    process.exit(1);
  }
  if (args.includes('-r')) {
    console.error(`\n  Error: "-r" was removed in v2.5.0.`);
    console.error(`         Use instead: --recursive\n`);
    process.exit(1);
  }

  const recursive = args.includes('--recursive');
  const positional = args.filter(a => !a.startsWith('-'));

  // ── zero-arg: scan all project repos ───────────────────────────────────────
  if (positional.length === 0) {
    const projectDir = config.findProjectDir();
    if (!projectDir) {
      console.error('  Error: not inside a wksp project. Provide a path: wksp cleanup <path>');
      config.printNoProjectHint();
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
