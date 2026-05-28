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

// ─── add ─────────────────────────────────────────────────────────────────────

async function handleAdd(projectDir, rawInput, flags) {
  if (!rawInput) {
    console.error('  Usage: wksp repo add <path-or-url> [--shared]');
    process.exit(1);
  }

  const shared = flags.has('--shared');
  let finalPath = rawInput;

  if (isGitUrl(rawInput)) {
    let globalCfg = config.readConfig(projectDir);
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
      globalCfg = config.readConfig(projectDir);
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
  let label = finalPath;
  if (shared) label += '  (--shared)';
  console.log(`  ✓  Added to repos.txt: ${label}`);
}

// ─── list ────────────────────────────────────────────────────────────────────

function handleList(projectDir) {
  const all = repos.readRepos(projectDir);
  if (!all.length) {
    console.log('  No repos registered. Add one with: wksp repo add <path-or-url>');
    return;
  }
  const pathW = Math.max(...all.map(r => r.normalized.length)) + 2;
  console.log('');
  for (const repo of all) {
    const flags = repo.shared ? '  --shared' : '';
    console.log(`  ${repo.normalized.padEnd(pathW)}${flags}`);
  }
  console.log('');
}

// ─── remove ──────────────────────────────────────────────────────────────────

async function handleRemove(projectDir, rawPath) {
  if (!rawPath) {
    console.error('  Usage: wksp repo remove <path-or-url>');
    process.exit(1);
  }

  const normalized = normalizePath(rawPath);
  const tasksDir   = path.join(projectDir, 'tasks');
  const orphaned   = [];

  if (fs.existsSync(tasksDir)) {
    for (const entry of fs.readdirSync(tasksDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const taskDir = path.join(tasksDir, entry.name);
      for (const wt of discoverWorktrees(taskDir)) {
        if (!wt.baseRepo || normalizePath(wt.baseRepo) !== normalized) continue;
        orphaned.push({ taskName: entry.name, wt });
      }
    }
  }

  if (orphaned.length) {
    const label = path.basename(normalized);
    console.log(`\n  Warning: ${label} has worktrees in ${orphaned.length} task(s):`);
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

// ─── deprecation shim (TODO v2.1.0: remove) ──────────────────────────────────

function warnDeprecated(oldSyntax, newSyntax) {
  console.warn(`\n  ⚠  Deprecated: ${oldSyntax}`);
  console.warn(`     Use instead: ${newSyntax}\n`);
}

async function handleLegacy(args) {
  const flags   = new Set(args.filter(a => a.startsWith('--')));
  const posArgs = args.filter(a => !a.startsWith('--'));
  const rawInput = posArgs[0];

  if (!rawInput) { console.error('  Usage: wksp repo <subcommand> <path-or-url>'); process.exit(1); }

  const projectDir = config.findProjectDir();
  if (!projectDir) { console.error('  Error: not inside a wksp project (no .wksp marker found)'); process.exit(1); }

  const sharedStr = flags.has('--shared') ? ' --shared' : '';

  if (flags.has('--remove')) {
    warnDeprecated(`wksp repo ${rawInput} --remove`, `wksp repo remove ${rawInput}`);
    await handleRemove(projectDir, rawInput);
  } else {
    warnDeprecated(`wksp repo ${rawInput}${sharedStr}`, `wksp repo add ${rawInput}${sharedStr}`);
    await handleAdd(projectDir, rawInput, flags);
  }
}

// ─── main dispatch ────────────────────────────────────────────────────────────

const SUBCOMMANDS = new Set(['add', 'remove', 'list']);

async function run(args) {
  const flags   = new Set(args.filter(a => a.startsWith('--')));
  const posArgs = args.filter(a => !a.startsWith('--'));
  const sub     = posArgs[0];

  if (!sub || flags.has('--help') || args.includes('-h') || sub === '--help') {
    console.log(`
  wksp repo <subcommand> [<path-or-url>]

  Subcommands:
    list                           List all registered repos
    add <path-or-url>              Register a repo in the current project
    remove <path-or-url>           Remove the repo from repos.txt

  Options for add:
    --shared                       Never create a worktree; always use the original path

  Examples:
    wksp repo list
    wksp repo add /c/dev/myrepo
    wksp repo add github.com/org/repo
    wksp repo add /c/dev/myrepo --shared
    wksp repo remove /c/dev/myrepo
`);
    process.exit(0);
  }

  // TODO v2.1.0: remove this deprecation shim
  if (!SUBCOMMANDS.has(sub)) { await handleLegacy(args); return; }

  const rawInput = posArgs[1];

  const projectDir = config.findProjectDir();
  if (!projectDir) { console.error('  Error: not inside a wksp project (no .wksp marker found)'); process.exit(1); }

  switch (sub) {
    case 'list':   handleList(projectDir);                        break;
    case 'add':    await handleAdd(projectDir, rawInput, flags);  break;
    case 'remove': await handleRemove(projectDir, rawInput);      break;
  }
}

module.exports = { run };
