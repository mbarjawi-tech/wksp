'use strict';
const fs   = require('fs');
const path = require('path');
const git  = require('../git');
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
  wksp cleanup --stale <path>      Prune stale git worktree refs from a base repo

  Options:
    -r                             Also scan first-level subdirectories of <path>

  Examples:
    wksp cleanup --stale /c/dev/repos
    wksp cleanup --stale /c/dev/repos -r
`);
    process.exit(0);
  }

  if (!args.includes('--stale')) {
    console.error('  Usage: wksp cleanup --stale <path> [-r]');
    process.exit(1);
  }

  const staleIdx = args.indexOf('--stale');
  const target   = args[staleIdx + 1];
  if (!target || target.startsWith('-')) {
    console.error('  Error: --stale requires a path argument');
    process.exit(1);
  }

  const recursive  = args.includes('-r');
  const normalized = normalizePath(target);

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
