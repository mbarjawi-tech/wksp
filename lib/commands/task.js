'use strict';
const fs   = require('fs');
const path = require('path');
const { open, close, ask, confirm } = require('../prompts');
const config   = require('../config');
const { readRepos } = require('../repos');
const git      = require('../git');
const { discoverWorktrees, WORKTREES_DIR } = require('../worktrees');
const { normalizePath } = require('../paths');
const { launch, findLastSession } = require('../claude');
const archive = require('../archive');
const { readTaskSets, writeTaskSets } = require('../task-state');

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

// Sets are keyed by folderName (alias ?? basename). Map is keyed by folderName too.
function writeWorkspaceFile(taskDir, projectName, taskId, allRepos, taskSharedSet, taskExcludedSet, finalBaseMap) {
  const folders = [];
  for (const repo of allRepos) {
    if (taskExcludedSet.has(repo.folderName)) continue;
    const effectivelyShared = repo.shared || taskSharedSet.has(repo.folderName);
    if (effectivelyShared) {
      folders.push({ path: repo.normalized.replace(/\\/g, '/'), name: `${repo.folderName} (shared)` });
    } else {
      const wt = finalBaseMap.get(repo.folderName);
      if (!wt) continue;
      folders.push({ path: `${WORKTREES_DIR}/${wt.folderName}`, name: repo.folderName });
    }
  }
  const filename = `${projectName}--${taskId}.code-workspace`;
  fs.writeFileSync(path.join(taskDir, filename), JSON.stringify({ folders }, null, 2) + '\n');
  console.log(`  ✓  ${filename}  (VS Code multi-root workspace)`);
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
    const type = r.excluded ? '(excluded)' : r.shared ? '(shared)' : '(worktree)';
    let staleness = '';
    if (!r.shared && !r.excluded && r.behind > 0) {
      staleness = `  ⚠ ${r.behind} commit${r.behind !== 1 ? 's' : ''} behind ${r.baseBranch}`;
    }
    const branchCol = r.excluded ? '—' : (r.branch || 'unknown');
    console.log(`    ${r.name.padEnd(nameW)} ${branchCol.padEnd(branchW)} ${type}${staleness}`);
  }
  console.log('\n' + '─'.repeat(W));
  console.log('  Launching Claude...');
}

async function getFolderName(repo, usedNames) {
  const preferred = repo.folderName;
  if (!usedNames.has(preferred)) return preferred;
  console.log(`\n  Folder name collision: "${preferred}" is already used.`);
  let name = '';
  while (!name) {
    name = await ask(`  Folder name for ${preferred}: `);
    if (!name) { console.log('  (required)'); continue; }
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) { console.log('  (alphanumeric, hyphens, underscores only)'); name = ''; continue; }
    if (usedNames.has(name)) { console.log(`  "${name}" is already used. Pick another.`); name = ''; }
  }
  return name;
}

async function createWorktree(repo, taskDir, usedNames) {
  const repoName      = repo.folderName;
  const defaultBranch = repo.alias ? repo.alias : path.basename(taskDir);

  let branch;
  while (true) {
    const input = await ask(`\n  Branch for ${repoName} [${defaultBranch}, s=shared, x=exclude]: `);
    if (input === 's') {
      console.log(`  ✓  ${repoName} → shared`);
      return { kind: 'shared' };
    }
    if (input === 'x') {
      console.log(`  ✓  ${repoName} → excluded from this task`);
      return { kind: 'excluded' };
    }
    branch = input || defaultBranch;
    const conflict = git.findCheckedOutBranch(repo.normalized, branch);
    if (conflict) {
      console.log(`\n  ⚠  "${branch}" is already checked out in:`);
      console.log(`     ${conflict}`);
      console.log('  Enter a different branch, s=shared, x=exclude, or use --to-shared later.\n');
      continue;
    }
    break;
  }

  const folderName = await getFolderName(repo, usedNames);
  usedNames.add(folderName);

  // Only ask for a base branch when creating a new branch
  let baseBranch = null;
  const isNewBranch = !git.branchExistsLocally(repo.normalized, branch) &&
                      !git.branchExistsCached(repo.normalized, branch) &&
                      !git.branchExistsRemotely(repo.normalized, branch);
  if (isNewBranch) {
    const mainBranch = git.defaultBranch(repo.normalized) || 'main';
    const baseInput  = await ask(`  → new branch on ${repoName}, base off [${mainBranch}]: `);
    baseBranch = baseInput || mainBranch;
  }

  const worktreeDir = path.join(taskDir, WORKTREES_DIR, folderName);
  console.log(`\n  Creating worktree for ${repoName} on "${branch}" ...`);
  git.addWorktree(repo.normalized, worktreeDir, branch, baseBranch);
  console.log(`\n  ✓  ${folderName} → ${branch}`);
  return { kind: 'worktree', folderName, worktreeDir, branch };
}

async function handleDelArchived(projectDir, taskId, deleteBranches) {
  const archivedDir = archive.archivedTaskDir(projectDir, taskId);
  const manifest    = archive.readManifest(archivedDir);

  console.log(`\n  About to delete archived task ${taskId}:`);
  console.log(`    · Delete folder: archived-tasks/${taskId}/ and all contents`);
  if (deleteBranches && manifest) {
    const branches = manifest.repos
      .filter(r => r.status === 'worktree' && r.branch && r.branchKeptInBaseRepo)
      .map(r => `${r.branch} (${path.basename(r.baseRepo)})`);
    if (branches.length) console.log(`    · Delete branches: ${branches.join(', ')}`);
  }
  console.log('');

  open();
  const yes = await confirm('  Confirm?');
  close();
  if (!yes) { console.log('  Cancelled.'); return; }

  if (deleteBranches && manifest) {
    for (const r of manifest.repos) {
      if (r.status !== 'worktree' || !r.branch || !r.branchKeptInBaseRepo) continue;
      if (!fs.existsSync(r.baseRepo)) continue;
      const result = git.deleteBranch(r.baseRepo, r.branch, true);
      if (result.ok) console.log(`  ✓  Deleted branch: ${r.branch} (${path.basename(r.baseRepo)})`);
      else            console.warn(`  ⚠  Could not delete: ${r.branch} (${path.basename(r.baseRepo)})`);
    }
  }

  fs.rmSync(archivedDir, { recursive: true, force: true });
  console.log(`  ✓  Deleted archived-tasks/${taskId}/`);
}

async function handleDel(projectDir, taskId, opts = {}) {
  const liveDir     = path.join(projectDir, 'tasks', taskId);
  const archivedDir = archive.archivedTaskDir(projectDir, taskId);

  if (!fs.existsSync(liveDir) && fs.existsSync(archivedDir)) {
    return handleDelArchived(projectDir, taskId, !!opts.deleteBranches);
  }
  if (!fs.existsSync(liveDir)) {
    console.error(`  Error: task "${taskId}" not found`); process.exit(1);
  }
  const taskDir = liveDir;

  const wts = discoverWorktrees(taskDir);
  console.log(`\n  About to delete task ${taskId}:`);
  if (wts.length) console.log(`    · Remove worktrees: ${wts.map(w => w.folderName).join(', ')}`);
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

  if (removed.length) {
    const uniqueBranches = [...new Set(removed.map(r => r.branch))];
    console.log('');
    const delBranches = await confirm(`  Delete local branches (${uniqueBranches.join(', ')})?`);
    if (delBranches) {
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
    }
  }

  close();
  fs.rmSync(taskDir, { recursive: true, force: true });
  console.log(`  ✓  Deleted tasks/${taskId}/`);
}

async function handleToShared(projectDir, taskId, repoArg) {
  if (!repoArg) { console.error('  Usage: wksp task repo <id> <repo> share'); process.exit(1); }

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

  const { taskSharedSet, taskExcludedSet } = readTaskSets(taskDir);
  taskSharedSet.add(wt.folderName);
  writeTaskSets(taskDir, taskSharedSet, taskExcludedSet);
  console.log(`  ✓  ${wt.folderName} now uses the shared repo path`);
  console.log(`     (${wt.baseRepo})`);
}

async function handleToWorktree(projectDir, taskId, repoArg) {
  if (!repoArg) { console.error('  Usage: wksp task repo <id> <repo> worktree'); process.exit(1); }

  const taskDir = path.join(projectDir, 'tasks', taskId);
  if (!fs.existsSync(taskDir)) {
    console.error(`  Error: task "${taskId}" not found`); process.exit(1);
  }

  const allRepos = readRepos(projectDir);
  const repo = allRepos.find(r =>
    r.folderName === repoArg || r.raw === repoArg
  );
  if (!repo) {
    console.error(`  Error: repo "${repoArg}" not found in repos.txt`); process.exit(1);
  }

  const { taskSharedSet, taskExcludedSet } = readTaskSets(taskDir);
  const wasShared   = taskSharedSet.delete(repo.folderName);
  const wasExcluded = taskExcludedSet.delete(repo.folderName);
  writeTaskSets(taskDir, taskSharedSet, taskExcludedSet);

  const wts      = discoverWorktrees(taskDir);
  const existing = wts.find(w => w.folderName === repo.folderName);
  if (existing) {
    console.log(`  "${repoArg}" already has a worktree: ${existing.folderName} on ${existing.currentBranch}`);
    return;
  }

  if (!fs.existsSync(repo.normalized)) {
    console.error(`  Error: repo not found on disk: ${repo.normalized}`); process.exit(1);
  }

  if (wasExcluded) console.log(`  "${repoArg}" was excluded — adding worktree now.`);

  const usedNames = new Set(wts.map(w => w.folderName));
  open();
  const result = await createWorktree(repo, taskDir, usedNames);
  close();
  if (result.kind === 'shared') {
    taskSharedSet.add(repo.folderName);
    writeTaskSets(taskDir, taskSharedSet, taskExcludedSet);
    console.log(`  Kept ${repoArg} as shared.`);
  } else if (result.kind === 'excluded') {
    taskExcludedSet.add(repo.folderName);
    writeTaskSets(taskDir, taskSharedSet, taskExcludedSet);
    console.log(`  Kept ${repoArg} excluded.`);
  }
}

async function handleToExclude(projectDir, taskId, repoArg) {
  if (!repoArg) { console.error('  Usage: wksp task repo <id> <repo> exclude'); process.exit(1); }

  const taskDir = path.join(projectDir, 'tasks', taskId);
  if (!fs.existsSync(taskDir)) {
    console.error(`  Error: task "${taskId}" not found`); process.exit(1);
  }

  const allRepos = readRepos(projectDir);
  const repo = allRepos.find(r => r.folderName === repoArg || r.raw === repoArg);
  if (!repo) {
    console.error(`  Error: repo "${repoArg}" not found in repos.txt`); process.exit(1);
  }

  const { taskSharedSet, taskExcludedSet } = readTaskSets(taskDir);

  if (taskExcludedSet.has(repo.folderName)) {
    console.log(`  "${repoArg}" is already excluded from this task.`);
    return;
  }

  // Remove worktree if one exists
  const wts = discoverWorktrees(taskDir);
  const wt  = wts.find(w => w.folderName === repo.folderName);

  if (wt && !wt.corrupted) {
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
  }

  taskSharedSet.delete(repo.folderName);
  taskExcludedSet.add(repo.folderName);
  writeTaskSets(taskDir, taskSharedSet, taskExcludedSet);
  console.log(`  ✓  ${repo.folderName} excluded from this task`);
}

async function handleRename(projectDir, projectName, oldId, newId) {
  if (!newId) { console.error('  Usage: wksp task rename <id> <new-id>'); process.exit(1); }

  const oldTaskDir = path.join(projectDir, 'tasks', oldId);
  const newTaskDir = path.join(projectDir, 'tasks', newId);

  if (!fs.existsSync(oldTaskDir)) {
    console.error(`  Error: task "${oldId}" not found`); process.exit(1);
  }
  if (fs.existsSync(newTaskDir)) {
    console.error(`  Error: task "${newId}" already exists`); process.exit(1);
  }

  const wts = discoverWorktrees(oldTaskDir);

  fs.renameSync(oldTaskDir, newTaskDir);

  for (const wt of wts) {
    if (wt.corrupted || !wt.baseRepo) continue;
    const newWorktreeDir = path.join(newTaskDir, WORKTREES_DIR, wt.folderName);
    try {
      git.worktreeRepair(wt.baseRepo, newWorktreeDir);
    } catch (e) {
      console.warn(`  ⚠  Could not repair worktree ${wt.folderName}: ${e.message}`);
    }
  }

  const oldWorkspace = path.join(newTaskDir, `${projectName}--${oldId}.code-workspace`);
  const newWorkspace = path.join(newTaskDir, `${projectName}--${newId}.code-workspace`);
  if (fs.existsSync(oldWorkspace)) fs.renameSync(oldWorkspace, newWorkspace);

  const claudeMdPath = path.join(newTaskDir, 'CLAUDE.md');
  if (fs.existsSync(claudeMdPath)) {
    const content = fs.readFileSync(claudeMdPath, 'utf8');
    const updated = content.replace(`## Task: ${oldId}`, `## Task: ${newId}`);
    if (updated !== content) fs.writeFileSync(claudeMdPath, updated);
  }

  const repairedCount = wts.filter(w => !w.corrupted && w.baseRepo).length;
  console.log(`  ✓  Renamed task ${oldId} → ${newId}`);
  if (repairedCount) console.log(`  ✓  Repaired ${repairedCount} worktree path(s)`);
}

// ─── archive / unarchive handlers ────────────────────────────────────────────

function parseArchiveArgs(args) {
  const opts = { deleteBranches: false, force: false, reason: null };
  let taskId = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--archive' || a === '--unarchive' || a === '--del') continue;
    if (a === '--delete-branches') { opts.deleteBranches = true; continue; }
    if (a === '--force')           { opts.force = true; continue; }
    if (a === '--reason')          { opts.reason = args[++i] || null; continue; }
    if (!a.startsWith('--') && !taskId) taskId = a;
  }
  return { taskId, opts };
}

function parseUnarchiveArgs(args) {
  const opts = { dryRun: false, fetch: false, skip: new Set(), shared: new Set(), branch: new Map() };
  let taskId = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--unarchive') continue;
    if (a === '--dry-run')   { opts.dryRun = true; continue; }
    if (a === '--fetch')     { opts.fetch = true; continue; }
    if (a === '--skip')      { const v = args[++i]; if (v) opts.skip.add(v); continue; }
    if (a === '--shared')    { const v = args[++i]; if (v) opts.shared.add(v); continue; }
    if (a === '--branch')    {
      const v = args[++i] || '';
      const eq = v.indexOf('=');
      if (eq > 0) opts.branch.set(v.slice(0, eq), v.slice(eq + 1));
      continue;
    }
    if (!a.startsWith('--') && !taskId) taskId = a;
  }
  return { taskId, opts };
}

async function handleArchive(projectDir, projectName, taskId, opts) {
  const taskDir = path.join(projectDir, 'tasks', taskId);
  if (!fs.existsSync(taskDir)) {
    console.error(`  Error: task "${taskId}" not found`); process.exit(1);
  }
  if (fs.existsSync(archive.archivedTaskDir(projectDir, taskId))) {
    console.error(`  Error: task "${taskId}" is already archived`); process.exit(1);
  }

  const { entries, uncommittedRepos } = archive.captureState(projectDir, taskId, projectName);

  if (uncommittedRepos.length && !opts.force) {
    console.error(`\n  Cannot archive — uncommitted changes in: ${uncommittedRepos.join(', ')}`);
    console.error('  Commit / stash / discard them, or re-run with --force to archive anyway.\n');
    process.exit(1);
  }

  const wtEntries = entries.filter(e => e.status === 'worktree');
  console.log(`\n  About to archive ${taskId}:`);
  if (wtEntries.length) console.log(`    · Remove worktrees: ${wtEntries.map(e => e.name).join(', ')}`);
  console.log(`    · ${opts.deleteBranches ? 'Delete' : 'Keep'} local branches in base repos`);
  console.log(`    · Move task → archived-tasks/${taskId}/`);
  if (uncommittedRepos.length) console.log(`    · ⚠ Discard uncommitted changes in: ${uncommittedRepos.join(', ')}`);
  console.log('');

  open();
  const yes = await confirm('  Confirm?');
  close();
  if (!yes) { console.log('  Cancelled.'); return; }

  try {
    archive.archiveTask(projectDir, projectName, taskId, entries, opts);
    console.log(`\n  ✓  Archived ${taskId}.`);
    console.log(`     Restore with: wksp task unarchive ${taskId}\n`);
  } catch (e) {
    console.error(`  Error during archive: ${e.message}`); process.exit(1);
  }
}

async function handleUnarchive(projectDir, projectName, taskId, opts) {
  const archivedDir = archive.archivedTaskDir(projectDir, taskId);
  if (!fs.existsSync(archivedDir)) {
    console.error(`  Error: no archived task "${taskId}"`); process.exit(1);
  }
  if (fs.existsSync(path.join(projectDir, 'tasks', taskId))) {
    console.error(`  Error: a live task "${taskId}" already exists — cannot unarchive`); process.exit(1);
  }
  const manifest = archive.readManifest(archivedDir);
  if (!manifest) {
    console.error(`  Error: archived-tasks/${taskId}/${archive.MANIFEST_FILE} missing or unreadable`); process.exit(1);
  }

  const currentRepos = readRepos(projectDir);
  if (opts.fetch) {
    console.log('\n  Fetching origin for affected repos...');
    archive.fetchBaseRepos(manifest.repos.filter(r => r.status === 'worktree').map(r => r.baseRepo));
  }

  const items = archive.buildPlan(manifest, currentRepos, opts);
  const interesting = archive.planIsInteresting(items);

  if (interesting || opts.dryRun) {
    const archivedAt = manifest.archivedAt ? new Date(manifest.archivedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'unknown';
    console.log(`\n  wksp · ${projectName} / ${taskId} — unarchive preview`);
    console.log(`  Archived ${archivedAt}\n`);
    for (const line of archive.renderPlan(items, manifest)) console.log(line);
    console.log('');
  }

  if (opts.dryRun) { console.log('  --dry-run: nothing applied.\n'); return; }

  if (interesting) {
    open();
    const yes = await confirm('  Continue?');
    close();
    if (!yes) { console.log('  Cancelled.'); return; }
  }

  let result;
  try {
    result = archive.applyPlan(projectDir, taskId, items);
  } catch (e) {
    console.error(`  Error during unarchive: ${e.message}`); process.exit(1);
  }

  if (!interesting) {
    console.log(`\n  Unarchived ${taskId} — ${result.successes.length} repo${result.successes.length === 1 ? '' : 's'} restored.`);
  } else {
    console.log(`\n  Unarchived ${taskId}.`);
    for (const name of result.successes) console.log(`  ✓  ${name}`);
    for (const f of result.failures)      console.log(`  ✗  ${f.name} — ${f.error}`);
    if (result.promptRepos.length) console.log(`     ${result.promptRepos.length} repo(s) will be prompted on next launch: ${result.promptRepos.map(r => r.name).join(', ')}`);
  }
  console.log(`     Resume with: wksp task resume ${taskId}\n`);
}

// ─── open / create / resume ──────────────────────────────────────────────────

async function handleOpen(projectDir, projectName, taskId, mode) {
  const allRepos = readRepos(projectDir);
  if (!allRepos.length) { console.error('  No repos registered. Run: wksp repo add <path>'); process.exit(1); }

  const taskDir = path.join(projectDir, 'tasks', taskId);
  const exists  = fs.existsSync(taskDir);

  if (mode === 'create' && exists) {
    console.error(`  Error: task "${taskId}" already exists. Use: wksp task resume ${taskId}`);
    process.exit(1);
  }
  if (mode === 'resume' && !exists) {
    console.error(`  Error: task "${taskId}" not found. Use: wksp task create ${taskId}`);
    process.exit(1);
  }

  const isNew = !exists;

  if (isNew) {
    fs.mkdirSync(path.join(taskDir, WORKTREES_DIR), { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'CLAUDE.md'), taskClaudeMd(taskId));
    console.log(`\n  Created task: ${taskId}`);
  } else {
    console.log(`\n  Resuming task: ${taskId}`);
  }

  const { taskSharedSet, taskExcludedSet } = readTaskSets(taskDir);

  const existingWts    = discoverWorktrees(taskDir);
  const existingBaseMap = new Map();
  for (const wt of existingWts) existingBaseMap.set(wt.folderName, wt);
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
    console.error(`\n  Fix the above, or run: wksp task delete ${taskId}\n`);
    process.exit(1);
  }

  const newRepos = allRepos.filter(r =>
    !r.shared &&
    !taskSharedSet.has(r.folderName) &&
    !taskExcludedSet.has(r.folderName) &&
    !existingBaseMap.has(r.folderName)
  );

  if (newRepos.length) {
    open();
    for (const repo of newRepos) {
      if (!isNew) console.log(`\n  New repo in repos.txt: ${repo.folderName} — pick branch, share, or exclude.`);
      if (!fs.existsSync(repo.normalized)) {
        console.warn(`  ⚠  Repo not found on disk: ${repo.normalized} — skipping`); continue;
      }
      const result = await createWorktree(repo, taskDir, usedNames);
      if (result.kind === 'shared')   taskSharedSet.add(repo.folderName);
      if (result.kind === 'excluded') taskExcludedSet.add(repo.folderName);
    }
    close();
    writeTaskSets(taskDir, taskSharedSet, taskExcludedSet);
  }

  const finalWts    = discoverWorktrees(taskDir);
  const finalBaseMap = new Map();
  for (const wt of finalWts) finalBaseMap.set(wt.folderName, wt);

  const repoInfos = allRepos.map(repo => {
    const name = repo.folderName;
    if (taskExcludedSet.has(repo.folderName)) {
      return { name, branch: null, shared: false, excluded: true, behind: null };
    }
    const effectivelyShared = repo.shared || taskSharedSet.has(repo.folderName);
    if (effectivelyShared) {
      return { name, branch: git.currentBranch(repo.normalized) || 'unknown', shared: true, excluded: false, behind: null };
    }
    const wt = finalBaseMap.get(repo.folderName);
    if (!wt) return { name, branch: null, shared: false, excluded: false, behind: null };
    const baseBranch = git.defaultBranch(repo.normalized);
    const behind     = git.behindCount(wt.worktreeDir, baseBranch);
    return { name, branch: wt.currentBranch, shared: false, excluded: false, behind, baseBranch };
  });

  writeWorkspaceFile(taskDir, projectName, taskId, allRepos, taskSharedSet, taskExcludedSet, finalBaseMap);
  printSummary(projectName, taskId, repoInfos);

  const dirs = [projectDir, taskDir];
  for (const repo of allRepos) {
    if (taskExcludedSet.has(repo.folderName)) continue;
    const effectivelyShared = repo.shared || taskSharedSet.has(repo.folderName);
    if (!effectivelyShared) {
      const wt = finalBaseMap.get(repo.folderName);
      if (wt) dirs.push(wt.worktreeDir);
    } else {
      dirs.push(repo.normalized);
    }
  }

  const { autoResume = true } = config.readConfig(projectDir);
  const lastSession = findLastSession(taskDir);
  let resumeId = null;

  if (lastSession) {
    const date = new Date(lastSession.mtime).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    if (autoResume) {
      console.log(`\n  Resuming last Claude session (${date})...`);
      resumeId = lastSession.id;
    } else {
      open();
      const yes = await confirm(`\n  Resume last Claude session (${date})?`);
      close();
      if (yes) resumeId = lastSession.id;
    }
  }

  launch(dirs, taskDir, resumeId);
}

// ─── repo participation ──────────────────────────────────────────────────────

async function handleRepo(projectDir, projectName, taskId, repoArg, modeArg) {
  const taskDir = path.join(projectDir, 'tasks', taskId);
  if (!fs.existsSync(taskDir)) {
    console.error(`  Error: task "${taskId}" not found`); process.exit(1);
  }

  const allRepos = readRepos(projectDir);
  if (!allRepos.length) {
    console.error('  No repos registered. Run: wksp repo add <path>'); process.exit(1);
  }

  const { taskSharedSet, taskExcludedSet } = readTaskSets(taskDir);

  function currentMode(r) {
    if (taskExcludedSet.has(r.folderName)) return 'excluded';
    if (r.shared || taskSharedSet.has(r.folderName)) return 'shared';
    return 'worktree';
  }

  const VALID_MODES = ['share', 'worktree', 'exclude'];

  // Validate args before opening any prompt
  if (modeArg && !VALID_MODES.includes(modeArg)) {
    console.error(`  Error: unknown mode "${modeArg}". Use: share, worktree, or exclude`);
    process.exit(1);
  }

  let repo;
  if (repoArg) {
    repo = allRepos.find(r => r.folderName === repoArg);
    if (!repo) {
      console.error(`  Error: repo "${repoArg}" not registered`);
      console.error(`  Available: ${allRepos.map(r => r.folderName).join(', ')}`);
      process.exit(1);
    }
  }

  const needsPrompt = !repo || !modeArg;
  if (needsPrompt) open();

  if (!repo) {
    console.log('\n  Repos in this task:');
    for (const r of allRepos) console.log(`    ${r.folderName}  [${currentMode(r)}]`);
    const input = (await ask('\n  Repo name: ')).trim();
    repo = allRepos.find(r => r.folderName === input);
    if (!repo) { close(); console.error(`  Error: repo "${input}" not found`); process.exit(1); }
  }

  let mode = modeArg;
  if (!mode) {
    const cur = currentMode(repo);
    console.log(`\n  ${repo.folderName} is currently: ${cur}`);
    console.log('    share    — use the shared repo path (no worktree)');
    console.log('    worktree — create or restore a worktree');
    console.log('    exclude  — exclude from this task entirely');
    const input = (await ask('\n  Mode [share / worktree / exclude]: ')).trim();
    if (!VALID_MODES.includes(input)) {
      close(); console.error(`  Error: unknown mode "${input}"`); process.exit(1);
    }
    mode = input;
  }

  if (needsPrompt) close();

  if (mode === 'share')    await handleToShared(projectDir, taskId, repo.folderName);
  if (mode === 'worktree') await handleToWorktree(projectDir, taskId, repo.folderName);
  if (mode === 'exclude')  await handleToExclude(projectDir, taskId, repo.folderName);
}

// ─── main dispatch ───────────────────────────────────────────────────────────

const SUBCOMMANDS = new Set(['create', 'resume', 'delete', 'rename', 'archive', 'unarchive', 'repo']);

async function run(args) {
  const posArgs = args.filter(a => !a.startsWith('--'));
  const flags   = new Set(args.filter(a => a.startsWith('--')));
  const sub     = posArgs[0];

  if (!sub || flags.has('--help') || args.includes('-h') || sub === '--help') {
    console.log(`
  wksp task <subcommand> <id>

  Subcommands:
    create <id>                    Create a new task workspace and launch Claude
    resume <id>                    Resume an existing task and launch Claude
    delete <id>                    Tear down worktrees and delete the task folder
    rename <id> <new-id>           Rename the task in place
    archive <id>                   Remove worktrees and move task to archived-tasks/
    unarchive <id>                 Restore an archived task
    repo <id> [repo] [mode]        Configure how a repo participates in this task
                                   Modes: share, worktree, exclude
                                   Omit repo or mode to be prompted interactively

  Flags for delete:
    --delete-branches              Also delete local branches when tearing down

  Flags for archive:
    --delete-branches              Delete local branches during archive
    --force                        Archive even when uncommitted changes exist

  Flags for unarchive:
    --dry-run                      Show restore plan without applying
    --fetch                        Fetch remote refs before classifying branches
    --skip <repo>                  Skip a specific repo during restore
    --shared <repo>                Restore a repo as task-shared instead of worktree
    --branch <repo>=<branch>       Override the branch used for a specific repo

  Branch prompt (shown when creating worktrees):
    <name>                         Branch name to create or check out
    Enter                          Use the default branch name
    s                              Use shared path (no worktree)
    x                              Exclude this repo from the task
`);
    process.exit(0);
  }

  if (!SUBCOMMANDS.has(sub)) {
    console.error(`  Error: unknown subcommand "${sub}". Run: wksp task --help`);
    process.exit(1);
  }

  const taskId = posArgs[1];
  if (!taskId) {
    console.error(`  Usage: wksp task ${sub} <id>`);
    process.exit(1);
  }

  const projectDir = config.findProjectDir();
  if (!projectDir) { console.error('  Error: not inside a wksp project'); process.exit(1); }
  const projectCfg  = config.readProjectConfig(projectDir);
  const projectName = projectCfg.name || path.basename(projectDir);

  switch (sub) {
    case 'create':
    case 'resume':
      await handleOpen(projectDir, projectName, taskId, sub); break;
    case 'delete': {
      const { opts } = parseArchiveArgs(args);
      await handleDel(projectDir, taskId, opts); break;
    }
    case 'rename':
      await handleRename(projectDir, projectName, taskId, posArgs[2]); break;
    case 'archive': {
      const { opts } = parseArchiveArgs(args);
      await handleArchive(projectDir, projectName, taskId, opts); break;
    }
    case 'unarchive': {
      const { opts } = parseUnarchiveArgs(args);
      await handleUnarchive(projectDir, projectName, taskId, opts); break;
    }
    case 'repo':
      await handleRepo(projectDir, projectName, taskId, posArgs[2], posArgs[3]); break;
  }
}

module.exports = { run };
