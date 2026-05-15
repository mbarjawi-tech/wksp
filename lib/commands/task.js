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

const TASK_SHARED_FILE   = 'task-shared.txt';
const TASK_EXCLUDED_FILE = 'task-excluded.txt';

function readSetFile(taskDir, file) {
  const f = path.join(taskDir, file);
  if (!fs.existsSync(f)) return new Set();
  return new Set(fs.readFileSync(f, 'utf8').split('\n').map(l => l.trim()).filter(Boolean));
}

function writeSetFile(taskDir, file, set) {
  const f = path.join(taskDir, file);
  if (set.size === 0) { if (fs.existsSync(f)) fs.unlinkSync(f); }
  else fs.writeFileSync(f, [...set].join('\n') + '\n');
}

const readTaskShared   = taskDir       => readSetFile(taskDir, TASK_SHARED_FILE);
const writeTaskShared  = (taskDir, s)  => writeSetFile(taskDir, TASK_SHARED_FILE, s);
const readTaskExcluded  = taskDir      => readSetFile(taskDir, TASK_EXCLUDED_FILE);
const writeTaskExcluded = (taskDir, s) => writeSetFile(taskDir, TASK_EXCLUDED_FILE, s);

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
  const repoName   = repo.folderName;
  const repoBranch = git.currentBranch(repo.normalized) || 'main';

  let branch;
  while (true) {
    const input = await ask(`\n  Branch for ${repoName} [${repoBranch}, s=shared, x=exclude]: `);
    if (input === 's') {
      console.log(`  ✓  ${repoName} → shared`);
      return { kind: 'shared' };
    }
    if (input === 'x') {
      console.log(`  ✓  ${repoName} → excluded from this task`);
      return { kind: 'excluded' };
    }
    branch = input || repoBranch;
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
  taskSharedSet.add(wt.folderName);
  writeTaskShared(taskDir, taskSharedSet);
  console.log(`  ✓  ${wt.folderName} now uses the shared repo path`);
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
    r.folderName === repoArg || r.raw === repoArg
  );
  if (!repo) {
    console.error(`  Error: repo "${repoArg}" not found in repos.txt`); process.exit(1);
  }

  const taskSharedSet   = readTaskShared(taskDir);
  const taskExcludedSet = readTaskExcluded(taskDir);
  const wasShared   = taskSharedSet.delete(repo.folderName);
  const wasExcluded = taskExcludedSet.delete(repo.folderName);
  writeTaskShared(taskDir, taskSharedSet);
  writeTaskExcluded(taskDir, taskExcludedSet);

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
    writeTaskShared(taskDir, taskSharedSet);
    console.log(`  Kept ${repoArg} as shared.`);
  } else if (result.kind === 'excluded') {
    taskExcludedSet.add(repo.folderName);
    writeTaskExcluded(taskDir, taskExcludedSet);
    console.log(`  Kept ${repoArg} excluded.`);
  }
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
    console.log(`     Restore with: wksp task ${taskId} --unarchive\n`);
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
  console.log(`     Resume with: wksp task ${taskId}\n`);
}

// ─── main dispatch ───────────────────────────────────────────────────────────

async function run(args) {
  const flags   = new Set(args.filter(a => a.startsWith('--')));
  const posArgs = args.filter(a => !a.startsWith('--'));
  const taskId  = posArgs[0];

  if (!taskId) {
    console.error('  Usage: wksp task <id> [--del | --to-shared <repo> | --to-worktree <repo> | --archive | --unarchive]');
    process.exit(1);
  }

  const projectDir = config.findProjectDir();
  if (!projectDir) { console.error('  Error: not inside a wksp project'); process.exit(1); }

  const projectCfg  = config.readProjectConfig(projectDir);
  const projectName = projectCfg.name || path.basename(projectDir);

  if (flags.has('--archive')) {
    const { opts } = parseArchiveArgs(args);
    await handleArchive(projectDir, projectName, taskId, opts); return;
  }
  if (flags.has('--unarchive')) {
    const { opts } = parseUnarchiveArgs(args);
    await handleUnarchive(projectDir, projectName, taskId, opts); return;
  }
  if (flags.has('--del'))         { const { opts } = parseArchiveArgs(args); await handleDel(projectDir, taskId, opts); return; }
  if (flags.has('--to-shared'))   { await handleToShared(projectDir, taskId, posArgs[1]); return; }
  if (flags.has('--to-worktree')) { await handleToWorktree(projectDir, taskId, posArgs[1]); return; }

  const allRepos = readRepos(projectDir);

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

  const taskSharedSet   = readTaskShared(taskDir);
  const taskExcludedSet = readTaskExcluded(taskDir);

  // Discover and validate existing worktrees; map is keyed by folderName
  const existingWts    = discoverWorktrees(taskDir);
  const existingBaseMap = new Map();
  for (const wt of existingWts) {
    existingBaseMap.set(wt.folderName, wt);
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

  // Create worktrees for new repos (not shared, not task-shared, not task-excluded, not already covered)
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
    writeTaskShared(taskDir, taskSharedSet);
    writeTaskExcluded(taskDir, taskExcludedSet);
  }

  // Re-discover after creation; build summary with live branch + staleness
  const finalWts    = discoverWorktrees(taskDir);
  const finalBaseMap = new Map();
  for (const wt of finalWts) {
    finalBaseMap.set(wt.folderName, wt);
  }

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

  // Build --add-dir list: project, task, worktrees, shared (project-level + task-level). Excluded repos are omitted.
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

  // Determine whether to resume the last Claude session for this task
  const { autoResume = true } = config.readGlobalConfig();
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

module.exports = { run };
