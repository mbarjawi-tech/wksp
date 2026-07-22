'use strict';
const fs   = require('fs');
const path = require('path');
const { open, close, ask, confirm, confirmDefaultYes } = require('../prompts');
const config   = require('../config');
const { readRepos } = require('../repos');
const git      = require('../git');
const { discoverWorktrees, WORKTREES_DIR } = require('../worktrees');
const { normalizePath } = require('../paths');
const { getProvider } = require('../providers');
const archive = require('../archive');
const { readTaskSets, writeTaskSets } = require('../task-state');
const { taskClaudeMd } = require('../templates');
const { HUB_TASK_ID, hubExists, scaffoldHub } = require('../hub');

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
  if (taskId === HUB_TASK_ID) console.log(`    ⚠  This is the project's planning task — deleting it removes the feature backlog and cross-task notes.`);
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

async function handleRename(projectDir, projectName, oldId, newId, opts = {}) {
  if (!newId) { console.error('  Usage: wksp task rename <id> <new-id>'); process.exit(1); }

  const oldTaskDir = path.join(projectDir, 'tasks', oldId);
  const newTaskDir = path.join(projectDir, 'tasks', newId);

  if (!fs.existsSync(oldTaskDir)) {
    console.error(`  Error: task "${oldId}" not found`); process.exit(1);
  }
  if (fs.existsSync(newTaskDir)) {
    console.error(`  Error: task "${newId}" already exists`); process.exit(1);
  }

  if (oldId === HUB_TASK_ID && !opts.yes) {
    console.log(`\n  ⚠  "${HUB_TASK_ID}" is the project's reserved planning task. Renaming it leaves`);
    console.log(`     the project without a hub until you create one (wksp task create ${HUB_TASK_ID}).`);
    open();
    const yes = await confirm(`  Rename "${HUB_TASK_ID}" → "${newId}" anyway?`);
    close();
    if (!yes) { console.log('  Cancelled.'); return; }
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

  // Same class of bug as the CLAUDE.md heading: keep the WORKLOG title in sync.
  const worklogPath = path.join(newTaskDir, 'WORKLOG.md');
  if (fs.existsSync(worklogPath)) {
    const content = fs.readFileSync(worklogPath, 'utf8');
    const updated = content.replace(`# Work Log: ${oldId}`, `# Work Log: ${newId}`);
    if (updated !== content) fs.writeFileSync(worklogPath, updated);
  }

  const repairedCount = wts.filter(w => !w.corrupted && w.baseRepo).length;
  console.log(`  ✓  Renamed task ${oldId} → ${newId}`);
  if (repairedCount) console.log(`  ✓  Repaired ${repairedCount} worktree path(s)`);

  await migrateRenamedSessions(oldTaskDir, newTaskDir, opts);
}

// Claude keys session transcripts by the encoded absolute folder path, so the
// rename orphaned them under the old key. Offer to re-key the dir (confirm-then-
// migrate, default Yes); only ever touches this task's two encoded dirs.
async function migrateRenamedSessions(oldTaskDir, newTaskDir, opts) {
  const provider = getProvider();
  if (!provider.sessions) return; // provider can't track sessions → nothing to migrate
  const { from, to, sessionCount, targetExists } = provider.sessions.dirsFor(oldTaskDir, newTaskDir);
  if (!fs.existsSync(from)) return; // no history under the old key → nothing to do

  const label     = sessionCount === 1 ? '1 session' : `${sessionCount} sessions`;
  const manualCmd = process.platform === 'win32' ? `move "${from}" "${to}"` : `mv "${from}" "${to}"`;

  if (opts.migrateSessions === false) {
    console.log(`\n  ⚠  Claude session history left under the old key (${label}).`);
    console.log(`     resume / status won't find it until you move it:`);
    console.log(`       ${manualCmd}`);
    return;
  }

  if (!opts.yes) {
    console.log(`\n  Claude stores this task's sessions under a path-derived key, so the`);
    console.log(`  rename leaves ${label} behind. wksp can move them to match:`);
    console.log(`    from: ${from}`);
    console.log(`    to:   ${to}`);
    if (targetExists) console.log(`    (target already exists — sessions will be merged)`);
    open();
    const yes = await confirmDefaultYes('  Move session history now?');
    close();
    if (!yes) {
      console.log(`  Left under the old key. Move it later with:`);
      console.log(`    ${manualCmd}`);
      return;
    }
  }

  const res = provider.sessions.migrate(from, to);
  for (const w of res.warnings) console.log(`  ⚠  ${w}`);

  // The source dir is removed only once fully drained, so its survival is the
  // reliable signal that some (or all) history could not be moved — e.g. the
  // folder was locked, or a collision left entries behind. Warn loudly rather
  // than let chat history be silently orphaned under the old key.
  if (!fs.existsSync(from)) {
    console.log(`  ✓  Migrated session history → ${to}`);
  } else {
    const what = (res.moved || res.merged)
      ? 'Some chat history could not be moved'
      : "Couldn't move this task's chat history";
    console.log(`\n  ⚠  ${what} — it's still under the old key, so resume / status won't`);
    console.log(`     find it and you may lose it. Move it yourself to keep it:`);
    console.log(`       from: ${from}`);
    console.log(`       to:   ${to}`);
    console.log(`       (e.g. ${manualCmd})`);
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

function parseFinishArgs(args) {
  const opts = { keepBranches: false, force: false, reason: null, yes: false };
  let taskId = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--keep-branches') { opts.keepBranches = true; continue; }
    if (a === '--force')         { opts.force = true; continue; }
    if (a === '--yes')           { opts.yes = true; continue; }
    if (a === '--reason')        { opts.reason = args[++i] || null; continue; }
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
  if (taskId === HUB_TASK_ID) console.log(`    ⚠  This is the project's planning task — the project will have no hub until you restore or recreate it.`);
  if (wtEntries.length) console.log(`    · Remove worktrees: ${wtEntries.map(e => e.name).join(', ')}`);
  console.log(`    · ${opts.deleteBranches ? 'Delete' : 'Keep'} local branches in base repos`);
  console.log(`    · Move task → archived-tasks/${taskId}/`);
  if (uncommittedRepos.length) console.log(`    · ⚠ Discard uncommitted changes in: ${uncommittedRepos.join(', ')}`);
  console.log('');

  let yes = !!opts.yes;
  if (!yes) {
    open();
    yes = await confirm('  Confirm?');
    close();
  }
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

// ─── finish (post-merge completion) ──────────────────────────────────────────

// finish = the explicit post-merge verb: verify the task's branches are merged
// into each base repo's default branch, archive with branch deletion defaulted,
// then fast-forward the base repos where that is safe. Never switches branches
// or clobbers local state — repos that aren't clean-and-on-default get a hint.
async function handleFinish(projectDir, projectName, taskId, opts) {
  const taskDir = path.join(projectDir, 'tasks', taskId);
  if (!fs.existsSync(taskDir)) {
    console.error(`  Error: task "${taskId}" not found`); process.exit(1);
  }

  const wts = discoverWorktrees(taskDir).filter(w => !w.corrupted && w.baseRepo && fs.existsSync(w.baseRepo));

  // (1) merged verification — fetch first so a PR merged on the remote counts.
  const checks = [];
  for (const wt of wts) {
    git.fetchOrigin(wt.baseRepo);
    const def = git.defaultBranch(wt.baseRepo) ||
                ['main', 'master'].find(b => git.branchExistsLocally(wt.baseRepo, b)) || null;
    let target = null, merged = false;
    if (def && wt.currentBranch === def) {
      target = def; merged = true;                 // worktree sits on the default branch itself
    } else if (def && wt.currentBranch) {
      target = git.branchExistsCached(wt.baseRepo, def) ? `origin/${def}` : def;
      merged = git.isAncestor(wt.baseRepo, wt.currentBranch, target);
    }
    checks.push({ wt, defaultBranch: def, target, merged });
  }

  const unmerged = checks.filter(c => !c.merged);
  if (checks.length && !unmerged.length) {
    console.log(`\n  ✓  All branches merged into the default branch.`);
  }
  if (unmerged.length) {
    console.log('\n  ⚠  Not merged into the default branch:');
    for (const c of unmerged) {
      const where = c.target ? ` (checked against ${c.target})` : ' — no default branch found';
      console.log(`     · ${c.wt.currentBranch || '?'} in ${path.basename(c.wt.baseRepo)}${where}`);
    }
    console.log('     A squash- or rebase-merged PR shows as unmerged here — make sure the');
    console.log('     PR really merged. Continuing deletes these local branches.');
    if (!opts.yes) {
      open();
      const yes = await confirm(`  Finish ${taskId} anyway?`);
      close();
      if (!yes) { console.log('  Cancelled.'); return; }
    }
  }

  // (2) the existing archive path, with branch deletion defaulted. Forcing the
  // deletion is safe: every branch was verified merged or confirmed above, and
  // plain `-d` would refuse legitimately squash-merged branches.
  await handleArchive(projectDir, projectName, taskId, {
    deleteBranches:      !opts.keepBranches,
    forceDeleteBranches: !opts.keepBranches,
    force:               opts.force,
    reason:              opts.reason || 'finished',
    yes:                 opts.yes,
  });
  if (!fs.existsSync(archive.archivedTaskDir(projectDir, taskId))) return; // archive was cancelled

  // (3) safe-update each base repo's default branch — fast-forward only, and
  // only when the repo is clean and already on that branch.
  const seen = new Set();
  for (const c of checks) {
    const base = c.wt.baseRepo;
    if (seen.has(base)) continue;
    seen.add(base);
    updateBaseRepo(base, c.defaultBranch);
  }
}

function updateBaseRepo(baseRepo, def) {
  const name = path.basename(baseRepo);
  if (!def || !git.branchExistsCached(baseRepo, def)) return; // nothing to update from
  const onBranch = git.currentBranch(baseRepo);
  const dirty    = !!git.getChangedFiles(baseRepo);
  if (onBranch !== def || dirty) {
    const why = dirty ? 'has uncommitted changes' : `is on "${onBranch}"`;
    console.log(`  ⚠  ${name} ${why} — not touching ${def}. When ready:`);
    console.log(`       git -C "${baseRepo}" pull --ff-only`);
    return;
  }
  const before = git.revParse(baseRepo, 'HEAD');
  const r = git.mergeFfOnly(baseRepo, `origin/${def}`);
  if (!r.ok) {
    console.log(`  ⚠  Could not fast-forward ${name} (${def}) — update it yourself:`);
    console.log(`       git -C "${baseRepo}" pull --ff-only`);
    return;
  }
  const after = git.revParse(baseRepo, 'HEAD');
  if (before !== after) console.log(`  ✓  Fast-forwarded ${name} ${def} → ${(after || '').slice(0, 7)}`);
  else                  console.log(`  ✓  ${name} ${def} already up to date`);
}

// ─── hub (reserved planning task) ────────────────────────────────────────────

// create/resume for the reserved `hub` task. The hub has no worktree, so it skips
// the whole repo-prompting flow of handleOpen (which also requires ≥1 repo). This
// is what reserves the name: `wksp task create hub` can never make a normal task.
async function handleHub(projectDir, projectName, mode) {
  const taskDir = path.join(projectDir, 'tasks', HUB_TASK_ID);
  const exists  = hubExists(projectDir);

  if (mode === 'create' && exists) {
    console.error(`  Error: "${HUB_TASK_ID}" is the project's planning task and already exists.`);
    console.error(`         Resume it with: wksp task resume ${HUB_TASK_ID}`);
    process.exit(1);
  }
  if (mode === 'resume' && !exists) {
    console.error(`  Error: no ${HUB_TASK_ID} yet. Create it with: wksp task create ${HUB_TASK_ID}`);
    process.exit(1);
  }

  if (!exists) {
    console.log(`\n  The ${HUB_TASK_ID} is this project's planning task — a worktree-less place for the`);
    console.log(`  feature backlog, cross-cutting design, and open decisions. One per project.`);
    console.log(`  Docs: https://github.com/mbarjawi-tech/wksp/blob/main/docs/reference.md#the-hub`);
    open();
    const ans = await ask(`\n  Create the ${HUB_TASK_ID} now? [Y/n]: `);
    close();
    if (['n', 'no'].includes(ans.toLowerCase())) { console.log('  Cancelled.'); return; }
    scaffoldHub(projectDir, projectName);
    console.log(`\n  ✓  Created the ${HUB_TASK_ID}. Track the backlog and cross-cutting design in tasks/${HUB_TASK_ID}/CLAUDE.md.`);
  } else {
    console.log(`\n  Resuming the ${HUB_TASK_ID}.`);
  }

  // The hub normally has no worktrees, but honor any pulled in via
  // `wksp task repo hub <repo> worktree`.
  const dirs = [projectDir, taskDir];
  for (const wt of discoverWorktrees(taskDir)) {
    if (!wt.corrupted && wt.baseRepo && fs.existsSync(wt.worktreeDir)) dirs.push(wt.worktreeDir);
  }

  const provider = getProvider();
  const { autoResume = true } = config.readConfig(projectDir);
  const lastSession = provider.sessions ? provider.sessions.findLast(taskDir) : null;
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

  provider.launch(dirs, taskDir, resumeId);
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
    fs.writeFileSync(path.join(taskDir, 'WORKLOG.md'), `# Work Log: ${taskId}\n`);
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

  const provider = getProvider();
  const { autoResume = true } = config.readConfig(projectDir);
  const lastSession = provider.sessions ? provider.sessions.findLast(taskDir) : null;
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

  provider.launch(dirs, taskDir, resumeId);
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

// ─── task selection (picker + partial-name match) ───────────────────────────

// Last activity for a task: the most recent Claude session mtime, falling back
// to the task directory's own mtime.
function lastActivity(taskDir) {
  const provider = getProvider();
  const session = provider.sessions ? provider.sessions.findLast(taskDir) : null;
  if (session && session.mtime) {
    const t = new Date(session.mtime).getTime();
    if (!Number.isNaN(t)) return t;
  }
  try { return fs.statSync(taskDir).mtimeMs; } catch { return 0; }
}

// Live tasks, newest activity first: [{ id, worktrees, lastActive }].
function listLiveTasks(projectDir) {
  const root = path.join(projectDir, 'tasks');
  if (!fs.existsSync(root)) return [];
  const tasks = fs.readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => {
      const taskDir = path.join(root, e.name);
      let worktrees = 0;
      try { worktrees = discoverWorktrees(taskDir).length; } catch {}
      return { id: e.name, worktrees, lastActive: lastActivity(taskDir) };
    });
  tasks.sort((a, b) => b.lastActive - a.lastActive);
  return tasks;
}

function relativeDate(ms) {
  if (!ms) return '—';
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days <= 0)  return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7)   return `${days}d ago`;
  if (days < 30)  return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

const PICKER_VERBS = { resume: 'Resume', delete: 'Delete', archive: 'Archive', finish: 'Finish' };

// Interactive numbered picker. Returns the chosen task id, or null if cancelled.
// Line-based (never calls setRawMode) so the terminal handed to Claude is intact.
async function pickTask(tasks, sub) {
  const verb  = PICKER_VERBS[sub] || 'Select';
  const nameW = Math.max(...tasks.map(t => t.id.length), 4) + 2;
  console.log(`\n  ${verb} which task?\n`);
  tasks.forEach((t, i) => {
    const wt   = `${t.worktrees} worktree${t.worktrees === 1 ? '' : 's'}`;
    const when = relativeDate(t.lastActive);
    console.log(`    ${String(i + 1).padStart(2)}) ${t.id.padEnd(nameW)} ${wt.padEnd(12)} ${when}`);
  });

  open();
  try {
    while (true) {
      const input = (await ask('\n  Number or part of a name (Enter to cancel): ')).trim();
      if (!input) { console.log('  Cancelled.'); return null; }
      if (/^\d+$/.test(input)) {
        const idx = parseInt(input, 10) - 1;
        if (idx >= 0 && idx < tasks.length) return tasks[idx].id;
        console.log(`  Enter a number between 1 and ${tasks.length}, or part of a name.`);
        continue;
      }
      const matches = tasks.filter(t => t.id.toLowerCase().includes(input.toLowerCase()));
      if (matches.length === 1) return matches[0].id;
      if (matches.length === 0) { console.log('  No match — try a number or a different fragment.'); continue; }
      console.log(`  ${matches.length} matches: ${matches.map(t => t.id).join(', ')} — narrow it down or use the number.`);
    }
  } finally {
    close();
  }
}

// Resolve the task id for a command that acts on an existing task:
//   - no id      → interactive picker over live tasks
//   - exact id   → used as-is (also lets a handler do its own lookup, e.g.
//                  delete's fallback to an archived task)
//   - partial id → a unique substring match is used; multiple → picker;
//                  no match → returned unchanged so the handler errors as before
// Returns the chosen id, or null when there is nothing to act on / user cancelled.
async function resolveTaskId(projectDir, sub, provided) {
  const tasks = listLiveTasks(projectDir);

  if (provided) {
    if (tasks.some(t => t.id === provided)) return provided;
    const matches = tasks.filter(t => t.id.toLowerCase().includes(provided.toLowerCase()));
    if (matches.length === 1) { console.log(`  → ${matches[0].id}`); return matches[0].id; }
    if (matches.length > 1)   return pickTask(matches, sub);
    return provided; // no live match — let the handler's own not-found logic run
  }

  if (!tasks.length) {
    console.log('\n  No live tasks. Create one with: wksp task create <id>\n');
    return null;
  }
  return pickTask(tasks, sub);
}

// ─── main dispatch ───────────────────────────────────────────────────────────

const SUBCOMMANDS = new Set(['create', 'resume', 'delete', 'rename', 'archive', 'unarchive', 'finish', 'repo']);
// Commands that operate on an existing task: id is optional (picker) and may be a partial name.
const PICKER_SUBS = new Set(['resume', 'delete', 'archive', 'finish']);

async function run(rawArgs) {
  const args    = rawArgs.map(a => (a === '-y' ? '--yes' : a)); // -y is shorthand for --yes
  const posArgs = args.filter(a => !a.startsWith('--'));
  const flags   = new Set(args.filter(a => a.startsWith('--')));
  let sub = posArgs[0];
  if (sub === 'done') sub = 'finish'; // only the subcommand position — a task could be named "done"

  if (!sub || flags.has('--help') || args.includes('-h') || sub === '--help') {
    console.log(`
  wksp task <subcommand> <id>

  Subcommands:
    create <id>                    Create a new task workspace and launch Claude
    resume [id]                    Resume an existing task and launch Claude
    delete [id]                    Tear down worktrees and delete the task folder
    rename <id> <new-id>           Rename the task in place
    archive [id]                   Remove worktrees and move task to archived-tasks/
    unarchive <id>                 Restore an archived task
    finish [id]                    Verify merged → archive (delete branches) → fast-forward base repos (alias: done)
    repo <id> [repo] [mode]        Configure how a repo participates in this task
                                   Modes: share, worktree, exclude
                                   Omit repo or mode to be prompted interactively

  resume / delete / archive / finish: omit the id to pick from a list, or pass part of a
  name (e.g. wksp task resume isa) — a unique match is used, otherwise you pick.

  The reserved "hub" task is the project's planning task (no worktree). It is
  auto-created by wksp init; add one to an older project with: wksp task create hub.
  Its name is reserved, and delete/rename warn before proceeding.

  Flags for rename:
    --no-migrate-sessions          Don't move Claude session history to the new key
    --yes, -y                      Auto-confirm the session-history move (scripts/CI)

  Flags for delete:
    --delete-branches              Also delete local branches when tearing down

  Flags for archive:
    --delete-branches              Delete local branches during archive
    --force                        Archive even when uncommitted changes exist

  Flags for finish:
    --keep-branches                Keep local branches instead of deleting them
    --force                        Finish even when uncommitted changes exist
    --reason <text>                Record a reason in the archive manifest (default: "finished")
    --yes, -y                      Skip confirmations (scripts/CI)

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
    // Detect removed v1 flags and give a specific migration hint
    const v1FlagMap = {
      '--del':         id => `wksp task delete ${id}`,
      '--archive':     id => `wksp task archive ${id}`,
      '--unarchive':   id => `wksp task unarchive ${id}`,
      '--rename':      id => `wksp task rename ${id} <new-id>`,
      '--to-shared':   id => `wksp task repo ${id} <repo> share`,
      '--to-worktree': id => `wksp task repo ${id} <repo> worktree`,
      '--to-exclude':  id => `wksp task repo ${id} <repo> exclude`,
    };
    const v1Flag = Object.keys(v1FlagMap).find(f => flags.has(f));
    if (v1Flag) {
      console.error(`\n  Error: "${v1Flag}" was removed in v2.5.0.`);
      console.error(`         Use instead: ${v1FlagMap[v1Flag](sub)}\n`);
    } else {
      // Bare task ID — old "wksp task <id>" create/resume shorthand
      console.error(`\n  Error: unknown subcommand "${sub}".`);
      console.error(`         The v1 shorthand "wksp task <id>" was removed in v2.5.0.`);
      console.error(`         Use instead: wksp task create ${sub}  (or: wksp task resume ${sub})\n`);
    }
    process.exit(1);
  }

  const projectDir = config.findProjectDir();
  if (!projectDir) { console.error('  Error: not inside a wksp project'); process.exit(1); }
  const projectCfg  = config.readProjectConfig(projectDir);
  const projectName = projectCfg.name || path.basename(projectDir);

  // resume / delete / archive accept a partial name, or no name at all (picker).
  let taskId = posArgs[1];
  if (PICKER_SUBS.has(sub)) {
    taskId = await resolveTaskId(projectDir, sub, taskId);
    if (!taskId) return; // nothing to act on, or the user cancelled the picker
  } else if (!taskId) {
    console.error(`  Usage: wksp task ${sub} <id>`);
    process.exit(1);
  }

  switch (sub) {
    case 'create':
    case 'resume':
      if (taskId === HUB_TASK_ID) await handleHub(projectDir, projectName, sub);
      else                        await handleOpen(projectDir, projectName, taskId, sub);
      break;
    case 'delete': {
      const { opts } = parseArchiveArgs(args);
      await handleDel(projectDir, taskId, opts); break;
    }
    case 'rename':
      await handleRename(projectDir, projectName, taskId, posArgs[2], {
        migrateSessions: !flags.has('--no-migrate-sessions'),
        yes:             flags.has('--yes'),
      }); break;
    case 'archive': {
      const { opts } = parseArchiveArgs(args);
      await handleArchive(projectDir, projectName, taskId, opts); break;
    }
    case 'unarchive': {
      const { opts } = parseUnarchiveArgs(args);
      await handleUnarchive(projectDir, projectName, taskId, opts); break;
    }
    case 'finish': {
      const { opts } = parseFinishArgs(args);
      await handleFinish(projectDir, projectName, taskId, opts); break;
    }
    case 'repo':
      await handleRepo(projectDir, projectName, taskId, posArgs[2], posArgs[3]); break;
  }
}

module.exports = { run, resolveTaskId, listLiveTasks };
