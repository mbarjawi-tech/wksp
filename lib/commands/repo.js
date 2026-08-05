'use strict';
const fs   = require('fs');
const path = require('path');
const { open, close, ask, confirm } = require('../prompts');
const config     = require('../config');
const repos      = require('../repos');
const git        = require('../git');
const { discoverWorktrees } = require('../worktrees');
const { normalizePath }     = require('../paths');
const { isCwdInside, probeRemovable, currentCwd } = require('../teardown-guard');

function isGitUrl(s) { return /^(https?:\/\/|git@|ssh:\/\/)/.test(s); }
function repoNameFromUrl(url) { return url.replace(/\.git$/, '').split('/').pop(); }

// ─── add ─────────────────────────────────────────────────────────────────────

async function handleAdd(projectDir, rawInput, flags) {
  if (!rawInput) {
    console.error('  Usage: wksp repo add <path-or-url> [--shared] [--optional]');
    process.exit(1);
  }

  const shared   = flags.has('--shared');
  const optional = flags.has('--optional');
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

  repos.addRepo(projectDir, finalPath, { shared, optional });
  let label = finalPath;
  if (shared)   label += '  (--shared)';
  if (optional) label += '  (--optional)';
  console.log(`  ✓  Added to repos.txt: ${label}`);
  if (optional) {
    console.log(`     Optional — new tasks skip it. Pull it into a task with:`);
    console.log(`       wksp task repo <task-id> ${path.basename(normalizePath(finalPath))} worktree`);
  }
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
    const flags = (repo.shared ? '  --shared' : '') + (repo.optional ? '  --optional' : '');
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
        orphaned.push({ taskName: entry.name, taskDir, wt });
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
      // Refuse before touching anything — same guards task teardown uses, since
      // `git worktree remove` deletes a worktree's contents before it fails on a
      // lock, and wksp inherits its cwd from the shell that launched it.
      for (const { taskName, wt } of orphaned) {
        if (isCwdInside(wt.worktreeDir)) {
          console.error(`\n  Error: cannot remove — your shell is inside ${currentCwd()} (${taskName}/${wt.folderName}).`);
          console.error(`  cd out of it and re-run: wksp repo remove ${rawPath}\n`);
          process.exit(1);
        }
      }
      for (const { taskName, taskDir, wt } of orphaned) {
        const probe = probeRemovable(wt.worktreeDir, taskDir);
        if (probe.ok) continue;
        console.error(`\n  Error: "${taskName}/${wt.folderName}" is locked${probe.code ? ` (${probe.code})` : ''} — nothing removed.`);
        console.error(`  Close whatever is using ${wt.worktreeDir}, then re-run: wksp repo remove ${rawPath}`);
        if (probe.stranded) {
          console.error(`  ⚠  The lock check could not put the folder back. It is now at: ${probe.stranded}`);
          console.error(`     Move it back to: ${wt.worktreeDir}`);
        }
        console.error('');
        process.exit(1);
      }
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
    --optional                     Excluded from tasks by default (no prompt); pull into a
                                   task with: wksp task repo <task-id> <repo> worktree

  Examples:
    wksp repo list
    wksp repo add /c/dev/myrepo
    wksp repo add github.com/org/repo
    wksp repo add /c/dev/myrepo --shared
    wksp repo add /c/dev/scratch-tools --optional
    wksp repo remove /c/dev/myrepo
`);
    process.exit(0);
  }

  if (!SUBCOMMANDS.has(sub)) {
    // Detect removed v1 syntax and give a specific migration hint
    const looksLikePath = sub.startsWith('/') || sub.startsWith('.') || /^[A-Za-z]:/.test(sub);
    const looksLikeUrl  = sub.includes('github.com') || sub.includes('://');
    if (looksLikePath || looksLikeUrl) {
      if (flags.has('--remove')) {
        console.error(`\n  Error: "wksp repo <path> --remove" was removed in v2.5.0.`);
        console.error(`         Use instead: wksp repo remove ${sub}\n`);
      } else {
        const shared = flags.has('--shared') ? ' --shared' : '';
        console.error(`\n  Error: "wksp repo <path>" was removed in v2.5.0.`);
        console.error(`         Use instead: wksp repo add ${sub}${shared}\n`);
      }
    } else {
      console.error(`\n  Error: unknown subcommand "${sub}". Run: wksp repo --help\n`);
    }
    process.exit(1);
  }

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
