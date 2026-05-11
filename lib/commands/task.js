'use strict';
const fs   = require('fs');
const path = require('path');
const { open, close, ask, confirm } = require('../prompts');
const config   = require('../config');
const { readRepos } = require('../repos');
const git      = require('../git');
const { discoverWorktrees, WORKTREES_DIR } = require('../worktrees');
const { normalizePath } = require('../paths');
const { launch } = require('../claude');

const TASK_SHARED_FILE = 'task-shared.txt';

function readTaskShared(taskDir) {
  const f = path.join(taskDir, TASK_SHARED_FILE);
  if (!fs.existsSync(f)) return new Set();
  return new Set(fs.readFileSync(f, 'utf8').split('\n').map(l => l.trim()).filter(Boolean));
}

function writeTaskShared(taskDir, set) {
  const f = path.join(taskDir, TASK_SHARED_FILE);
  if (set.size === 0) { if (fs.existsSync(f)) fs.unlinkSync(f); }
  else fs.writeFileSync(f, [...set].join('\n') + '\n');
}

function taskClaudeMd(taskId) {
  return `## Task: ${taskId}
## Goal: (describe the task here)

## Notes
<!-- decisions, constraints, references, links to tickets... -->

## Conflict policy
The project-level CLAUDE.md defines shared conventions. This file adds task-specific context only.
If anything here contradicts the project-level CLAUDE.md, flag the contradiction
and ask for clarification — do not silently resolve it yourself.
`;
}

function writeWorkspaceFile(taskDir, allRepos, taskSharedSet, finalBaseMap) {
  const folders = [];
  for (const repo of allRepos) {
    const name = path.basename(repo.normalized);
    const effectivelyShared = repo.shared || taskSharedSet.has(repo.normalized);
    if (effectivelyShared) {
      folders.push({ path: repo.normalized.replace(/\\/g, '/'), name: `${name} (shared)` });
    } else {
      const wt = finalBaseMap.get(repo.normalized);
      if (!wt) continue;
      folders.push({ path: `${WORKTREES_DIR}/${wt.folderName}`, name });
    }
  }
  fs.writeFileSync(path.join(taskDir, 'task.code-workspace'), JSON.stringify({ folders }, null, 2) + '\n');
}

function printSummary(projectName, taskId, repoInfos) {
  const W     = 44;
  const nameW = repoInfos.length ? Math.max(...repoInfos.map(r => r.name.length)) + 2 : 20;
  const branchW = repoInfos.length ? Math.max(...repoInfos.map(r => (r.branch || '').length)) + 2 : 20;
  console.log('\n' + '─'.repeat(W));
  console.log(`  wksp · ${projectName} / ${taskId}`);
  console.log('─'.repeat(W));
  console.log('  Repos:\n');
  for (const r of repoInfos) {
    const type = r.shared ? '(shared)' : '(worktree)';
    let staleness = '';
    if (!r.shared && r.behind > 0) {
      staleness = `  ⚠ ${r.behind} commit${r.behind !== 1 ? 's' : ''} behind ${r.baseBranch}`;
    }
    console.log(`    ${r.name.padEnd(nameW)} ${(r.branch || 'unknown').padEnd(branchW)} ${type}${staleness}`);
  }
  console.log('\n' + '─'.repeat(W));
  console.log('  Launching Claude...');
}

async function getFolderName(repo, usedNames) {
  const baseName = path.basename(repo.normalized);
  if (!usedNames.has(baseName)) return baseName;
  console.log(`\n  Folder name collision: "${baseName}" is already used.`);
  let name = '';
  while (!name) {
    name = await ask(`  Folder name for ${baseName}: `);
    if (!name) { console.log('  (required)'); continue; }
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) { console.log('  (alphanumeric, hyphens, underscores only)'); name = ''; continue; }
    if (usedNames.has(name)) { console.log(`  "${name}" is already used. Pick another.`); name = ''; }
  }
  return name;
}

async function createWorktree(repo, taskDir, usedNames) {
  const repoName      = path.basename(repo.normalized);
  const folderName    = await getFolderName(repo, usedNames);
  usedNames.add(folderName);
  const repoBranch    = git.currentBranch(repo.normalized) || 'main';

  let branch;
  while (true) {
    const input = await ask(`\n  Branch for ${repoName} [${repoBranch}]: `);
    branch = input || repoBranch;
    const conflict = git.findCheckedOutBranch(repo.normalized, branch);
    if (conflict) {
      console.log(`\n  ⚠  "${branch}" is already checked out in:`);
      console.log(`     ${conflict}`);
      console.log('  Enter a different branch, or use --to-shared to skip the worktree.\n');
      continue;
    }
    break;
  }

  // Only ask for a base branch when creating a new branch
  let baseBranch = null;
  const isNewBranch = !git.branchExistsLocally(repo.normalized, branch) &&
                      !git.branchExistsCached(repo.normalized, branch) &&
                      !git.branchExistsRemotely(repo.normalized, branch);
  if (isNewBranch) {
    const mainBranch = git.defaultBranch(repo.normalized) || 'main';
    const baseInput  = await ask(`  Base branch for ${repoName} [${mainBranch}]: `);
    baseBranch = baseInput || mainBranch;
  }

  const worktreeDir = path.join(taskDir, WORKTREES_DIR, folderName);
  console.log(`\n  Creating worktree for ${repoName} on "${branch}" ...`);
  git.addWorktree(repo.normalized, worktreeDir, branch, baseBranch);
  console.log(`\n  ✓  ${folderName} → ${branch}`);
  return { folderName, worktreeDir, branch };
}

async function handleDel(projectDir, taskId) {
  const taskDir = path.join(projectDir, 'tasks', taskId);
  if (!fs.existsSync(taskDir)) {
    console.error(`  Error: task "${taskId}" not found`); process.exit(1);
  }

  const wts = discoverWorktrees(taskDir);
  const uniqueBranches = [...new Set(wts.filter(w => w.currentBranch).map(w => w.currentBranch))];
  console.log(`\n  About to delete task ${taskId}:`);
  if (wts.length)          console.log(`    · Remove worktrees: ${wts.map(w => w.folderName).join(', ')}`);
  if (uniqueBranches.length) console.log(`    · Delete local branches: ${uniqueBranches.join(', ')}`);
  console.log(`    · Delete folder: tasks/${taskId}/ and all contents\n`);

  open();
  const yes = await confirm('  Confirm?');
  if (!yes) { close(); console.log('  Cancelled.'); return; }

  const removed = []; // { baseRepo, branch } for each successfully removed worktree
  const affectedRepos = new Set();
  for (const wt of wts) {
    if (wt.corrupted || !wt.baseRepo) { console.warn(`  ⚠  Skipping corrupted: ${wt.folderName}`); continue; }
    try {
      git.removeWorktree(wt.baseRepo, wt.worktreeDir);
      affectedRepos.add(wt.baseRepo);
      if (wt.currentBranch) removed.push({ baseRepo: wt.baseRepo, branch: wt.currentBranch });
      console.log(`  ✓  Removed worktree: ${wt.folderName}`);
    } catch {
      const changed = git.getChangedFiles(wt.worktreeDir);
      if (changed) {
        console.log(`\n  Worktree "${wt.folderName}" has uncommitted changes:`);
        console.log(changed.split('\n').map(l => '    ' + l).join('\n'));
      }
      const force = await confirm(`  Force remove "${wt.folderName}"? (discards uncommitted changes)`);
      if (force) {
        try {
          git.removeWorktree(wt.baseRepo, wt.worktreeDir, true);
          affectedRepos.add(wt.baseRepo);
          if (wt.currentBranch) removed.push({ baseRepo: wt.baseRepo, branch: wt.currentBranch });
          console.log(`  ✓  Force-removed: ${wt.folderName}`);
        } catch (e) { console.error(`  ✗  Failed: ${e.message}`); }
      } else { console.log(`  ⚠  Skipped: ${wt.folderName}`); }
    }
  }

  for (const br of affectedRepos) { try { git.pruneWorktrees(br); } catch {} }

  for (const { baseRepo, branch } of removed) {
    const r = git.deleteBranch(baseRepo, branch);
    if (r.ok) {
      console.log(`  ✓  Deleted branch: ${branch} (${path.basename(baseRepo)})`);
    } else {
      console.log(`\n  Branch "${branch}" in ${path.basename(baseRepo)} has unmerged commits.`);
      const force = await confirm('  Force delete?');
      if (force) {
        const r2 = git.deleteBranch(baseRepo, branch, true);
        if (r2.ok) console.log(`  ✓  Force-deleted: ${branch} (${path.basename(baseRepo)})`);
        else        console.warn(`  ⚠  Could not delete: ${branch} — remove manually`);
      } else {
        console.log(`  ⚠  Kept branch: ${branch} (${path.basename(baseRepo)})`);
      }
    }
  }

  close();
  fs.rmSync(taskDir, { recursive: true, force: true });
  console.log(`  ✓  Deleted tasks/${taskId}/`);
}

async function handleToShared(projectDir, taskId, repoArg) {
  if (!repoArg) { console.error('  Usage: wksp task <id> --to-shared <repo-name>'); process.exit(1); }

  const taskDir = path.join(projectDir, 'tasks', taskId);
  if (!fs.existsSync(taskDir)) {
    console.error(`  Error: task "${taskId}" not found`); process.exit(1);
  }

  const wts = discoverWorktrees(taskDir);
  const wt  = wts.find(w =>
    w.folderName === repoArg ||
    (w.baseRepo && path.basename(normalizePath(w.baseRepo)) === repoArg)
  );

  if (!wt) {
    console.error(`  Error: no worktree found matching "${repoArg}" in task ${taskId}`);
    if (wts.length) console.error(`  Available: ${wts.map(w => w.folderName).join(', ')}`);
    process.exit(1);
  }
  if (wt.corrupted || !wt.baseRepo) {
    console.error(`  Error: worktree "${wt.folderName}" is corrupted`); process.exit(1);
  }

  const changed = git.getChangedFiles(wt.worktreeDir);
  if (changed) {
    console.log(`\n  Worktree "${wt.folderName}" has uncommitted changes:`);
    console.log(changed.split('\n').map(l => '    ' + l).join('\n'));
    open();
    const force = await confirm('\n  Remove worktree anyway? (discards changes)');
    close();
    if (!force) { console.log('  Cancelled.'); return; }
  }

  try {
    git.removeWorktree(wt.baseRepo, wt.worktreeDir, !!changed);
    git.pruneWorktrees(wt.baseRepo);
    console.log(`  ✓  Removed worktree: ${wt.folderName}`);
  } catch (e) { console.error(`  Error: ${e.message}`); process.exit(1); }

  const taskSharedSet = readTaskShared(taskDir);
  taskSharedSet.add(normalizePath(wt.baseRepo));
  writeTaskShared(taskDir, taskSharedSet);
  console.log(`  ✓  ${path.basename(wt.baseRepo)} now uses the shared repo path`);
  console.log(`     (${wt.baseRepo})`);
}

async function handleToWorktree(projectDir, taskId, repoArg) {
  if (!repoArg) { console.error('  Usage: wksp task <id> --to-worktree <repo-name>'); process.exit(1); }

  const taskDir = path.join(projectDir, 'tasks', taskId);
  if (!fs.existsSync(taskDir)) {
    console.error(`  Error: task "${taskId}" not found`); process.exit(1);
  }

  const allRepos = readRepos(projectDir);
  const repo = allRepos.find(r =>
    path.basename(r.normalized) === repoArg || r.raw === repoArg
  );
  if (!repo) {
    console.error(`  Error: repo "${repoArg}" not found in repos.txt`); process.exit(1);
  }

  const taskSharedSet = readTaskShared(taskDir);
  taskSharedSet.delete(repo.normalized);
  writeTaskShared(taskDir, taskSharedSet);

  const wts      = discoverWorktrees(taskDir);
  const existing = wts.find(w => w.baseRepo && normalizePath(w.baseRepo) === repo.normalized);
  if (existing) {
    console.log(`  "${repoArg}" already has a worktree: ${existing.folderName} on ${existing.currentBranch}`);
    return;
  }

  if (!fs.existsSync(repo.normalized)) {
    console.error(`  Error: repo not found on disk: ${repo.normalized}`); process.exit(1);
  }

  const usedNames = new Set(wts.map(w => w.folderName));
  open();
  await createWorktree(repo, taskDir, usedNames);
  close();
}

async function run(args) {
  const flags   = new Set(args.filter(a => a.startsWith('--')));
  const posArgs = args.filter(a => !a.startsWith('--'));
  const taskId  = posArgs[0];

  if (!taskId) {
    console.error('  Usage: wksp task <id> [--del | --to-shared <repo> | --to-worktree <repo>]');
    process.exit(1);
  }

  const projectDir = config.findProjectDir();
  if (!projectDir) { console.error('  Error: not inside a wksp project'); process.exit(1); }

  if (flags.has('--del'))         { await handleDel(projectDir, taskId); return; }
  if (flags.has('--to-shared'))   { await handleToShared(projectDir, taskId, posArgs[1]); return; }
  if (flags.has('--to-worktree')) { await handleToWorktree(projectDir, taskId, posArgs[1]); return; }

  const projectCfg  = config.readProjectConfig(projectDir);
  const projectName = projectCfg.name || path.basename(projectDir);
  const allRepos    = readRepos(projectDir);

  if (!allRepos.length) { console.error('  No repos registered. Run: wksp repo <path>'); process.exit(1); }

  const taskDir = path.join(projectDir, 'tasks', taskId);
  const isNew   = !fs.existsSync(taskDir);

  if (isNew) {
    fs.mkdirSync(path.join(taskDir, WORKTREES_DIR), { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'CLAUDE.md'), taskClaudeMd(taskId));
    console.log(`\n  Created task: ${taskId}`);
  } else {
    console.log(`\n  Resuming task: ${taskId}`);
  }

  const taskSharedSet = readTaskShared(taskDir);

  // Discover and validate existing worktrees
  const existingWts    = discoverWorktrees(taskDir);
  const existingBaseMap = new Map();
  for (const wt of existingWts) {
    if (wt.baseRepo) existingBaseMap.set(normalizePath(wt.baseRepo), wt);
  }
  const usedNames = new Set(existingWts.map(w => w.folderName));

  const criticalErrors = [];
  for (const wt of existingWts) {
    if (wt.corrupted) {
      criticalErrors.push(`  ✗  Corrupted worktree: ${wt.folderName} (${wt.error})`);
    } else if (!fs.existsSync(wt.baseRepo)) {
      criticalErrors.push(`  ✗  Base repo not found: ${wt.baseRepo}`);
    } else if (!fs.existsSync(wt.worktreeDir)) {
      console.warn(`  ⚠  Worktree folder missing: ${wt.folderName}`);
    }
  }

  if (criticalErrors.length) {
    console.error('\n  Critical errors — cannot launch:\n');
    criticalErrors.forEach(e => console.error(e));
    console.error(`\n  Fix the above, or run: wksp task ${taskId} --del\n`);
    process.exit(1);
  }

  // Create worktrees for new repos (not shared, not task-shared, not already covered)
  const newRepos = allRepos.filter(r =>
    !r.shared && !taskSharedSet.has(r.normalized) && !existingBaseMap.has(r.normalized)
  );

  if (newRepos.length) {
    open();
    for (const repo of newRepos) {
      if (!isNew) console.log(`\n  New repo in repos.txt: ${path.basename(repo.normalized)} — creating worktree.`);
      if (!fs.existsSync(repo.normalized)) {
        console.warn(`  ⚠  Repo not found on disk: ${repo.normalized} — skipping`); continue;
      }
      await createWorktree(repo, taskDir, usedNames);
    }
    close();
  }

  // Re-discover after creation; build summary with live branch + staleness
  const finalWts    = discoverWorktrees(taskDir);
  const finalBaseMap = new Map();
  for (const wt of finalWts) {
    if (wt.baseRepo) finalBaseMap.set(normalizePath(wt.baseRepo), wt);
  }

  const repoInfos = allRepos.map(repo => {
    const name             = path.basename(repo.normalized);
    const effectivelyShared = repo.shared || taskSharedSet.has(repo.normalized);
    if (effectivelyShared) {
      return { name, branch: git.currentBranch(repo.normalized) || 'unknown', shared: true, behind: null };
    }
    const wt = finalBaseMap.get(repo.normalized);
    if (!wt) return { name, branch: null, shared: false, behind: null };
    const baseBranch = git.defaultBranch(repo.normalized);
    const behind     = git.behindCount(wt.worktreeDir, baseBranch);
    return { name, branch: wt.currentBranch, shared: false, behind, baseBranch };
  });

  writeWorkspaceFile(taskDir, allRepos, taskSharedSet, finalBaseMap);
  printSummary(projectName, taskId, repoInfos);

  // Build --add-dir list: project, task, worktrees, shared (project-level + task-level)
  const dirs = [projectDir, taskDir];
  for (const repo of allRepos) {
    const effectivelyShared = repo.shared || taskSharedSet.has(repo.normalized);
    if (!effectivelyShared) {
      const wt = finalBaseMap.get(repo.normalized);
      if (wt) dirs.push(wt.worktreeDir);
    } else {
      dirs.push(repo.normalized);
    }
  }

  launch(dirs, taskDir);
}

module.exports = { run };
