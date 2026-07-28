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
const { taskAgentsMd, writeInstructionFiles, AGENTS_FILE, CLAUDE_FILE } = require('../templates');
const { splitArgs, parseRepoMap } = require('../args');
const { planRepos, renderPlan, renderErrors } = require('../task-plan');
const { buildBrief, renderBrief } = require('../brief');
const { withJsonStdout, childStdio, printJson, failJson } = require('../out');

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

function printSummary(projectName, taskId, repoInfos, footer) {
  const W     = 44;
  const nameW = repoInfos.length ? Math.max(...repoInfos.map(r => r.name.length)) + 2 : 20;
  const branchW = repoInfos.length ? Math.max(...repoInfos.map(r => (r.branch || '').length)) + 2 : 20;
  console.log('\n' + '─'.repeat(W));
  console.log(`  wksp · ${projectName} / ${taskId}`);
  console.log('─'.repeat(W));
  console.log('  Repos:\n');
  for (const r of repoInfos) {
    const type = r.excluded ? (r.optional ? '(optional)' : '(excluded)') : r.shared ? '(shared)' : '(worktree)';
    let staleness = '';
    if (!r.shared && !r.excluded && r.behind > 0) {
      staleness = `  ⚠ ${r.behind} commit${r.behind !== 1 ? 's' : ''} behind ${r.baseBranch}`;
    }
    const branchCol = r.excluded ? '—' : (r.branch || 'unknown');
    console.log(`    ${r.name.padEnd(nameW)} ${branchCol.padEnd(branchW)} ${type}${staleness}`);
  }
  console.log('\n' + '─'.repeat(W));
  if (footer) console.log(`  ${footer}`);
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

async function handleDelArchived(projectDir, taskId, deleteBranches, autoYes = false) {
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

  let yes = autoYes;
  if (!yes) {
    open();
    yes = await confirm('  Confirm?');
    close();
  }
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

  // --yes makes teardown scriptable, deliberately without becoming a --force: it
  // answers the questions whose answer is already implied ("yes, delete it"), and
  // stops rather than answering the ones that would lose work.
  const auto = !!opts.yes;

  if (!fs.existsSync(liveDir) && fs.existsSync(archivedDir)) {
    return handleDelArchived(projectDir, taskId, !!opts.deleteBranches, auto);
  }
  if (!fs.existsSync(liveDir)) {
    console.error(`  Error: task "${taskId}" not found`); process.exit(1);
  }
  const taskDir = liveDir;

  const wts = discoverWorktrees(taskDir);
  console.log(`\n  About to delete task ${taskId}:`);
  if (wts.length) console.log(`    · Remove worktrees: ${wts.map(w => w.folderName).join(', ')}`);
  console.log(`    · Delete folder: tasks/${taskId}/ and all contents\n`);

  if (!auto) {
    open();
    const yes = await confirm('  Confirm?');
    if (!yes) { close(); console.log('  Cancelled.'); return; }
  }

  const removed = []; // { baseRepo, branch } for each successfully removed worktree
  const affectedRepos = new Set();
  const blocked = [];  // worktrees kept because removing them would discard changes
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
      if (auto) {
        blocked.push(wt.folderName);
        console.warn(`  ⚠  Kept ${wt.folderName} — --yes never discards uncommitted work.`);
        continue;
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
    const delBranches = auto ? !!opts.deleteBranches : await confirm(`  Delete local branches (${uniqueBranches.join(', ')})?`);
    if (delBranches) {
      for (const { baseRepo, branch } of removed) {
        const r = git.deleteBranch(baseRepo, branch);
        if (r.ok) {
          console.log(`  ✓  Deleted branch: ${branch} (${path.basename(baseRepo)})`);
          continue;
        }
        console.log(`\n  Branch "${branch}" in ${path.basename(baseRepo)} has unmerged commits.`);
        if (auto) {
          console.warn(`  ⚠  Kept branch: ${branch} (${path.basename(baseRepo)}) — --yes never force-deletes unmerged commits.`);
          continue;
        }
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

  if (!auto) close();

  if (blocked.length) {
    console.warn(`\n  ⚠  Kept tasks/${taskId}/ — uncommitted changes in: ${blocked.join(', ')}`);
    console.warn(`     Commit or discard them, or re-run without --yes to confirm discarding.\n`);
    return;
  }

  fs.rmSync(taskDir, { recursive: true, force: true });
  console.log(`  ✓  Deleted tasks/${taskId}/`);
}

// A worktree with uncommitted changes has to be discarded to switch modes. Asking
// is the interactive answer; --yes refuses instead — the same line delete --yes
// draws, so "don't ask me" never means "throw my work away".
function confirmDiscard(o, folderName, changed) {
  console.log(`\n  Worktree "${folderName}" has uncommitted changes:`);
  console.log(changed.split('\n').map(l => '    ' + l).join('\n'));
  if (o.yes) {
    console.error(`\n  Error: --yes never discards uncommitted work in ${folderName}.`);
    console.error('         Commit or discard the changes, or re-run without --yes to confirm.\n');
    process.exit(1);
  }
  return null; // caller prompts
}

async function handleToShared(projectDir, taskId, repoArg, rawOpts = {}) {
  if (!repoArg) { console.error('  Usage: wksp task repo <id> <repo> share'); process.exit(1); }
  const o = openOpts(rawOpts);

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
    confirmDiscard(o, wt.folderName, changed);
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

async function handleToWorktree(projectDir, taskId, repoArg, rawOpts = {}) {
  if (!repoArg) { console.error('  Usage: wksp task repo <id> <repo> worktree'); process.exit(1); }
  const o = openOpts(rawOpts);

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

  // Supplying the branch up front makes this non-interactive — the same plan-then-
  // validate path headless create uses, so a bad branch is refused rather than
  // half-applied. `explicit: true`: naming a repos.txt --shared repo here is the
  // documented way to give one task a worktree for it, not a mistake to refuse.
  const branchGiven = o.yes || o.branch.map.has(repo.folderName) ||
                      o.branch.fallback !== null || o.base.map.has(repo.folderName);
  if (branchGiven) {
    const { items, errors } = planRepos({
      allRepos, pending: [repo], taskId, usedNames, opts: { ...o, explicit: true },
    });
    if (errors.length) {
      for (const line of renderErrors(errors)) console.error(line);
      console.error('');
      process.exit(1);
    }
    applyRepoPlan(items, {
      taskDir, taskSharedSet, taskExcludedSet, usedNames,
      fail: msg => { console.error(`  Error: ${msg}`); process.exit(1); },
      stdio: 'inherit',
    });
    writeTaskSets(taskDir, taskSharedSet, taskExcludedSet);
    return;
  }

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

async function handleToExclude(projectDir, taskId, repoArg, rawOpts = {}) {
  if (!repoArg) { console.error('  Usage: wksp task repo <id> <repo> exclude'); process.exit(1); }
  const o = openOpts(rawOpts);

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
      confirmDiscard(o, wt.folderName, changed);
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

  // AGENTS.md is canonical; CLAUDE.md is checked too for tasks that predate the
  // v4 conversion (their content still lives there).
  for (const file of ['AGENTS.md', 'CLAUDE.md']) {
    const p = path.join(newTaskDir, file);
    if (!fs.existsSync(p)) continue;
    const content = fs.readFileSync(p, 'utf8');
    const updated = content.replace(`## Task: ${oldId}`, `## Task: ${newId}`);
    if (updated !== content) fs.writeFileSync(p, updated);
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

  await migrateRenamedSessions(projectDir, oldTaskDir, newTaskDir, opts);
}

// Claude keys session transcripts by the encoded absolute folder path, so the
// rename orphaned them under the old key. Offer to re-key the dir (confirm-then-
// migrate, default Yes); only ever touches this task's two encoded dirs.
async function migrateRenamedSessions(projectDir, oldTaskDir, newTaskDir, opts) {
  const provider = getProvider(projectDir);
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

// Every value-carrying flag across the subcommands, so positional arguments are
// never confused with a flag's value (see lib/args.js).
const VALUE_FLAGS = ['--reason', '--skip', '--shared', '--exclude', '--branch', '--base', '--goal'];

const lastValue = (values, flag) => {
  const list = values.get(flag);
  return list && list.length ? list[list.length - 1] : null;
};

function parseArchiveArgs(args) {
  const { positionals, flags, values } = splitArgs(args, VALUE_FLAGS);
  return {
    taskId: positionals[1] || null,
    opts: {
      deleteBranches: flags.has('--delete-branches'),
      force:          flags.has('--force'),
      reason:         lastValue(values, '--reason'),
      yes:            flags.has('--yes'),
    },
  };
}

function parseFinishArgs(args) {
  const { positionals, flags, values } = splitArgs(args, VALUE_FLAGS);
  return {
    taskId: positionals[1] || null,
    opts: {
      keepBranches: flags.has('--keep-branches'),
      force:        flags.has('--force'),
      reason:       lastValue(values, '--reason'),
      yes:          flags.has('--yes'),
    },
  };
}

function parseUnarchiveArgs(args) {
  const { positionals, flags, values } = splitArgs(args, VALUE_FLAGS);
  const branch = new Map();
  for (const v of values.get('--branch') || []) {
    const eq = v.indexOf('=');
    if (eq > 0) branch.set(v.slice(0, eq), v.slice(eq + 1));
  }
  return {
    taskId: positionals[1] || null,
    opts: {
      dryRun: flags.has('--dry-run'),
      fetch:  flags.has('--fetch'),
      skip:   new Set(values.get('--skip')   || []),
      shared: new Set(values.get('--shared') || []),
      branch,
    },
  };
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

// ─── open / create / resume ──────────────────────────────────────────────────

// Flags on create / resume / brief that carry a value.
const OPEN_VALUE_FLAGS = ['--branch', '--base', '--shared', '--exclude', '--goal'];

// Headless options for create / resume, along three independent axes:
//   · does wksp prompt?  --yes  (implied by --json and --dry-run)
//   · does wksp launch?  --no-launch  (implied by --json and --dry-run)
//   · which answers are already known?  --branch / --base / --shared / --exclude
// Repos a disposition flag names are decided up front; anything left over is still
// prompted for, unless --yes says not to. The bare `--branch <branch>` form (no
// `<repo>=` prefix) applies to every repo, so it answers the whole prompt on its
// own; `--base` only supplies a starting point for branches that don't exist yet.
function parseOpenArgs(args) {
  const { flags, values } = splitArgs(args, OPEN_VALUE_FLAGS);
  const json   = flags.has('--json');
  const dryRun = flags.has('--dry-run');
  const goals  = values.get('--goal') || [];
  return {
    json,
    dryRun,
    yes:     flags.has('--yes') || json || dryRun,
    launch:  !(flags.has('--no-launch') || json || dryRun),
    goal:    goals.length ? goals[goals.length - 1] : null,
    branch:  parseRepoMap(values.get('--branch')),
    base:    parseRepoMap(values.get('--base')),
    shared:  new Set(values.get('--shared')  || []),
    exclude: new Set(values.get('--exclude') || []),
  };
}

// Defaults, so callers that don't parse flags (start.js, tests) can pass a partial
// object — or nothing — and get exactly today's interactive behavior.
function openOpts(opts = {}) {
  return {
    json: false, dryRun: false, yes: false, launch: true, goal: null,
    branch: { map: new Map(), fallback: null },
    base:   { map: new Map(), fallback: null },
    shared: new Set(), exclude: new Set(),
    ...opts,
  };
}

// Record the hub's one-line goal in the task's instruction file. AGENTS.md is
// canonical; CLAUDE.md is touched too for tasks that predate the v4 conversion,
// where the real content still lives there (same pairing as handleRename).
function applyGoal(taskDir, goal) {
  const placeholder = '## Goal: (describe the task here)';
  const updated = [];
  for (const file of [AGENTS_FILE, CLAUDE_FILE]) {
    const p = path.join(taskDir, file);
    if (!fs.existsSync(p)) continue;
    const content = fs.readFileSync(p, 'utf8');
    const next = content.includes(placeholder)
      ? content.replace(placeholder, `## Goal: ${goal}`)
      : content.replace(/^## Goal:.*$/m, `## Goal: ${goal}`);
    if (next !== content) { fs.writeFileSync(p, next); updated.push(file); }
  }
  if (updated.length) console.log(`  ✓  Goal recorded in ${updated.join(' + ')}`);
  else console.warn(`  ⚠  No "## Goal:" line in the instruction file — goal not recorded.`);
}

const planItemJson = i => ({
  name: i.name, mode: i.mode,
  branch: i.branch || null, base: i.baseBranch || null, newBranch: !!i.isNewBranch,
});

// Carry out a validated plan — every decision is already made, so nothing here can
// ask a question. Mutates the two disposition sets; the caller persists them.
// Shared by headless create/resume and `wksp task repo <id> <repo> worktree`.
function applyRepoPlan(items, { taskDir, taskSharedSet, taskExcludedSet, usedNames, fail, stdio }) {
  const created = new Set();
  for (const item of items) {
    taskSharedSet.delete(item.name);
    taskExcludedSet.delete(item.name);
    if (item.mode === 'shared')   { taskSharedSet.add(item.name);   console.log(`  ✓  ${item.name} → shared`); continue; }
    if (item.mode === 'excluded') { taskExcludedSet.add(item.name); console.log(`  ✓  ${item.name} → excluded from this task`); continue; }

    const worktreeDir = path.join(taskDir, WORKTREES_DIR, item.name);
    console.log(`\n  Creating worktree for ${item.name} on "${item.branch}" ...`);
    try {
      git.addWorktree(item.repo.normalized, worktreeDir, item.branch, item.baseBranch, stdio);
    } catch (e) {
      fail(`could not create the worktree for ${item.name} on "${item.branch}": ${String(e.message || e).split('\n')[0]}`);
    }
    created.add(item.name);
    if (usedNames) usedNames.add(item.name);
    console.log(`\n  ✓  ${item.name} → ${item.branch}`);
  }
  return created;
}

async function handleOpen(projectDir, projectName, taskId, mode, rawOpts = {}) {
  const o = openOpts(rawOpts);
  // Every expected failure goes through here so a --json run gets a machine-readable
  // error instead of prose (an unexpected throw still surfaces as `Fatal:`).
  const fail = (message, extra) => {
    if (o.json) failJson(message, extra);
    console.error(`  Error: ${message}`);
    process.exit(1);
  };

  const allRepos = readRepos(projectDir);
  if (!allRepos.length) {
    if (o.json) failJson('no repos registered — run: wksp repo add <path>');
    console.error('  No repos registered. Run: wksp repo add <path>'); process.exit(1);
  }

  const taskDir = path.join(projectDir, 'tasks', taskId);
  const exists  = fs.existsSync(taskDir);

  if (mode === 'create' && exists) fail(`task "${taskId}" already exists. Use: wksp task resume ${taskId}`);
  if (mode === 'resume' && !exists) fail(`task "${taskId}" not found. Use: wksp task create ${taskId}`);

  const isNew = !exists;

  // Read the task's state before anything is written: a non-interactive run has to
  // be able to validate the whole plan and bail out having created nothing. All of
  // these are safe on a task dir that doesn't exist yet.
  const { taskSharedSet, taskExcludedSet } = readTaskSets(taskDir);

  const existingWts     = discoverWorktrees(taskDir);
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
    if (o.json) failJson(`task "${taskId}" has worktrees that need fixing`, { details: criticalErrors.map(e => e.replace(/^\s*✗\s*/, '')) });
    console.error('\n  Critical errors — cannot launch:\n');
    criticalErrors.forEach(e => console.error(e));
    console.error(`\n  Fix the above, or run: wksp task delete ${taskId}\n`);
    process.exit(1);
  }

  // A repo named by a flag is wanted in this task even if it is --optional (which
  // otherwise starts excluded) or was excluded by an earlier run.
  const named = n => o.branch.map.has(n) || o.base.map.has(n) || o.shared.has(n);

  // --optional repos are excluded by default: instead of prompting, record them as
  // excluded silently — on create and on resume (covering tasks that predate the
  // flag). Pull one in with a flag here, or: wksp task repo <id> <repo> worktree
  const optionalNames = new Set(allRepos
    .filter(r => r.optional && !named(r.folderName) &&
                 !taskSharedSet.has(r.folderName) && !taskExcludedSet.has(r.folderName) &&
                 !existingBaseMap.has(r.folderName))
    .map(r => r.folderName));

  const pending = allRepos.filter(r => {
    const n = r.folderName;
    if (existingBaseMap.has(n)) return false;   // already has a worktree in this task
    if (optionalNames.has(n))   return false;   // optional → excluded without asking
    if (taskSharedSet.has(n) || taskExcludedSet.has(n)) {
      // Already dispositioned: only re-decided when a flag names it.
      if (taskExcludedSet.has(n) && o.exclude.has(n)) return false;
      return named(n) || o.exclude.has(n);
    }
    if (r.shared) return o.exclude.has(n);      // repos.txt --shared never gets a worktree
    return true;
  });

  // Split into "already answered" (planned up front, validated, no prompt) and the
  // rest, which still go through the branch prompt unless --yes covers them.
  const preAnswered = r => o.yes || named(r.folderName) || o.exclude.has(r.folderName) ||
                           o.branch.fallback !== null;
  const planned  = pending.filter(preAnswered);
  const toPrompt = pending.filter(r => !preAnswered(r));

  const { items, errors } = planRepos({ allRepos, pending: planned, taskId, usedNames, opts: o });
  if (errors.length) {
    if (o.json) failJson(`cannot set up task "${taskId}" without asking`, {
      details: errors.map(e => (e.hint ? `${e.message} — ${e.hint}` : e.message)),
    });
    for (const line of renderErrors(errors)) console.error(line);
    console.error('');
    process.exit(1);
  }

  if (o.dryRun) {
    for (const line of renderPlan(items, { projectName, taskId, exists })) console.log(line);
    if (toPrompt.length) {
      console.log(`\n    ${toPrompt.map(r => r.folderName).join(', ')} — would be prompted for (pass --yes to take defaults)`);
    }
    if (o.json) {
      printJson({
        ok: true, dryRun: true,
        project: { name: projectName, dir: projectDir.replace(/\\/g, '/') },
        task:    { id: taskId, dir: taskDir.replace(/\\/g, '/'), exists },
        plan:    items.map(planItemJson),
      });
      return;
    }
    console.log('\n  --dry-run: nothing created.\n');
    return;
  }

  fs.mkdirSync(path.join(taskDir, WORKTREES_DIR), { recursive: true });
  if (isNew) {
    writeInstructionFiles(taskDir, taskAgentsMd(taskId));
    fs.writeFileSync(path.join(taskDir, 'WORKLOG.md'), `# Work Log: ${taskId}\n`);
    console.log(`\n  Created task: ${taskId}`);
  } else {
    console.log(`\n  Resuming task: ${taskId}`);
  }
  if (o.goal) applyGoal(taskDir, o.goal);

  let setsDirty = optionalNames.size > 0 || items.length > 0;
  for (const n of optionalNames) taskExcludedSet.add(n);

  const createdWorktrees = applyRepoPlan(items, {
    taskDir, taskSharedSet, taskExcludedSet, usedNames, fail, stdio: childStdio(o.json),
  });

  if (toPrompt.length) {
    setsDirty = true;
    open();
    for (const repo of toPrompt) {
      if (!isNew) console.log(`\n  New repo in repos.txt: ${repo.folderName} — pick branch, share, or exclude.`);
      if (!fs.existsSync(repo.normalized)) {
        console.warn(`  ⚠  Repo not found on disk: ${repo.normalized} — skipping`); continue;
      }
      const result = await createWorktree(repo, taskDir, usedNames);
      taskSharedSet.delete(repo.folderName);
      taskExcludedSet.delete(repo.folderName);
      if (result.kind === 'shared')   taskSharedSet.add(repo.folderName);
      if (result.kind === 'excluded') taskExcludedSet.add(repo.folderName);
    }
    close();
  }

  if (setsDirty) writeTaskSets(taskDir, taskSharedSet, taskExcludedSet);

  const finalWts    = discoverWorktrees(taskDir);
  const finalBaseMap = new Map();
  for (const wt of finalWts) finalBaseMap.set(wt.folderName, wt);

  writeWorkspaceFile(taskDir, projectName, taskId, allRepos, taskSharedSet, taskExcludedSet, finalBaseMap);

  // Headless: hand back the same context a launch would have put in front of the AI
  // tool, as a document. A task folder lives under the project root, so a session
  // there can work in the task straight from this brief. The brief supersedes the
  // launch summary here — it carries the same repo table plus the paths and rules.
  if (!o.launch) {
    let providerName = null;
    try { providerName = getProvider(projectDir).name; } catch { /* not launching — a bad aiProvider is not fatal here */ }
    const brief = buildBrief(projectDir, projectName, taskId, {
      created: isNew, createdWorktrees, launched: false, provider: providerName,
    });
    if (o.json) { printJson(brief); return; }
    for (const line of renderBrief(brief)) console.log(line);
    console.log('');
    return;
  }

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

  const repoInfos = allRepos.map(repo => {
    const name = repo.folderName;
    if (taskExcludedSet.has(repo.folderName)) {
      return { name, branch: null, shared: false, excluded: true, optional: repo.optional, behind: null };
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

  const provider = getProvider(projectDir);
  printSummary(projectName, taskId, repoInfos, provider.name === 'none' ? null : `Launching ${provider.name}...`);

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

// ─── brief (the handoff surface) ─────────────────────────────────────────────

// Print everything needed to work in a task without launching a session. Same
// document as `create --json` / `resume --json`, so an agent learns one shape.
async function handleBrief(projectDir, projectName, taskId, opts = {}) {
  const taskDir = path.join(projectDir, 'tasks', taskId);
  if (!fs.existsSync(taskDir)) {
    if (opts.json) failJson(`task "${taskId}" not found`);
    console.error(`  Error: task "${taskId}" not found`); process.exit(1);
  }

  let providerName = null;
  try { providerName = getProvider(projectDir).name; } catch { /* the brief doesn't launch anything */ }
  const brief = buildBrief(projectDir, projectName, taskId, { provider: providerName });

  if (opts.json) { printJson(brief); return; }
  for (const line of renderBrief(brief)) console.log(line);
  console.log('');
}

// ─── repo participation ──────────────────────────────────────────────────────

async function handleRepo(projectDir, projectName, taskId, repoArg, modeArg, opts = {}) {
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

  if (mode === 'share')    await handleToShared(projectDir, taskId, repo.folderName, opts);
  if (mode === 'worktree') await handleToWorktree(projectDir, taskId, repo.folderName, opts);
  if (mode === 'exclude')  await handleToExclude(projectDir, taskId, repo.folderName, opts);
}

// ─── task selection (picker + partial-name match) ───────────────────────────

// Last activity for a task: the most recent Claude session mtime, falling back
// to the task directory's own mtime.
function lastActivity(taskDir, projectDir) {
  const provider = getProvider(projectDir);
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
      return { id: e.name, worktrees, lastActive: lastActivity(taskDir, projectDir) };
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

const PICKER_VERBS = { resume: 'Resume', delete: 'Delete', archive: 'Archive', finish: 'Finish', brief: 'Show' };

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
//
// `opts.nonInteractive` forbids the picker: an ambiguous or missing id becomes an
// error naming the candidates, since a headless caller has no way to answer it.
async function resolveTaskId(projectDir, sub, provided, opts = {}) {
  const tasks = listLiveTasks(projectDir);
  const cannotAsk = (message, extra) => {
    if (opts.json) failJson(message, extra);
    console.error(`  Error: ${message}`);
    if (extra && extra.details) console.error(`         ${extra.details.join(', ')}`);
    process.exit(1);
  };

  if (provided) {
    if (tasks.some(t => t.id === provided)) return provided;
    const matches = tasks.filter(t => t.id.toLowerCase().includes(provided.toLowerCase()));
    if (matches.length === 1) { console.log(`  → ${matches[0].id}`); return matches[0].id; }
    if (matches.length > 1) {
      if (opts.nonInteractive) {
        cannotAsk(`"${provided}" matches ${matches.length} tasks — name one exactly`,
          { details: matches.map(t => t.id) });
      }
      return pickTask(matches, sub);
    }
    return provided; // no live match — let the handler's own not-found logic run
  }

  if (!tasks.length) {
    console.log('\n  No live tasks. Create one with: wksp task create <id>\n');
    return null;
  }
  if (opts.nonInteractive) {
    cannotAsk(`wksp task ${sub} needs a task id in a non-interactive run`,
      { details: tasks.map(t => t.id) });
  }
  return pickTask(tasks, sub);
}

// ─── main dispatch ───────────────────────────────────────────────────────────

const SUBCOMMANDS = new Set(['create', 'resume', 'delete', 'rename', 'archive', 'unarchive', 'finish', 'repo', 'brief']);
// Commands that operate on an existing task: id is optional (picker) and may be a partial name.
const PICKER_SUBS = new Set(['resume', 'delete', 'archive', 'finish', 'brief']);
// Subcommands that share the headless flag set.
const OPEN_SUBS = new Set(['create', 'resume', 'brief', 'repo']);

async function run(rawArgs) {
  const args = rawArgs.map(a => (a === '-y' ? '--yes' : a)); // -y is shorthand for --yes
  const { positionals: posArgs, flags } = splitArgs(args, VALUE_FLAGS);
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
                                   worktree + --branch <b> [--base <b>] skips the prompt
    brief [id]                     Print everything needed to work in the task without launching

  resume / delete / archive / finish / brief: omit the id to pick from a list, or pass part
  of a name (e.g. wksp task resume isa) — a unique match is used, otherwise you pick.

  Planning happens at the project root, not in a task: wksp start (no id) launches
  a session there, with PLANNING.md as the living backlog.

  Headless flags for create / resume — three independent axes: whether wksp asks
  (--yes), whether it launches (--no-launch), and which answers you supply up front:
    --json                         Emit the task brief as JSON on stdout (implies --yes --no-launch)
    --no-launch                    Set the task up and print its brief; don't launch the AI tool
    --yes, -y                      Never ask: repos with no flag take their defaults
    --dry-run                      Show the plan and create nothing (implies --yes --no-launch)
    --branch <repo>=<branch>       Branch for one repo (repeatable)
    --branch <branch>              Branch for every repo not named individually
    --base <repo>=<branch>         Base for a branch that doesn't exist yet (also --base <branch>)
    --shared <repo>                Use the base repo path, no worktree (repeatable)
    --exclude <repo>               Leave the repo out of this task (repeatable)
    --goal <text>                  Fill in the "## Goal:" line of the task's AGENTS.md

  A headless run validates everything first: an unknown repo, a branch already checked
  out elsewhere, or a missing repo path is an error naming the flag that fixes it, and
  the task is left uncreated.

  Flag for brief:
    --json                         Machine-readable brief (same shape as create --json)

  Flags for repo:
    --branch <branch>              Branch for the worktree — skips the branch prompt
    --base <branch>                Base for a branch that doesn't exist yet
    --yes, -y                      Don't ask. Refuses to discard uncommitted work rather
                                   than removing a dirty worktree to switch modes

  Flags for rename:
    --no-migrate-sessions          Don't move Claude session history to the new key
    --yes, -y                      Auto-confirm the session-history move (scripts/CI)

  Flags for delete:
    --delete-branches              Also delete local branches when tearing down
    --yes, -y                      Don't ask (scripts/agents). Never discards uncommitted
                                   work and never force-deletes unmerged branches — it
                                   keeps the task instead and tells you why

  Flags for archive:
    --delete-branches              Delete local branches during archive
    --force                        Archive even when uncommitted changes exist
    --yes, -y                      Skip the confirmation (scripts/agents)

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

  Repos registered with --optional are never prompted for — they start excluded.
  Pull one into a task with: wksp task repo <id> <repo> worktree
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

  const openArgs = OPEN_SUBS.has(sub) ? parseOpenArgs(args) : null;

  // resume / delete / archive accept a partial name, or no name at all (picker).
  let taskId = posArgs[1];
  if (PICKER_SUBS.has(sub)) {
    taskId = await resolveTaskId(projectDir, sub, taskId, {
      nonInteractive: openArgs ? openArgs.yes : flags.has('--yes'),
      json:           !!(openArgs && openArgs.json),
    });
    if (!taskId) return; // nothing to act on, or the user cancelled the picker
  } else if (!taskId) {
    console.error(`  Usage: wksp task ${sub} <id>`);
    process.exit(1);
  }

  switch (sub) {
    case 'create':
    case 'resume':
      // In --json mode human output is diverted to stderr so stdout stays parseable.
      if (openArgs.json) {
        await withJsonStdout(() => handleOpen(projectDir, projectName, taskId, sub, openArgs));
      } else {
        await handleOpen(projectDir, projectName, taskId, sub, openArgs);
      }
      break;
    case 'brief':
      if (openArgs.json) {
        await withJsonStdout(() => handleBrief(projectDir, projectName, taskId, openArgs));
      } else {
        await handleBrief(projectDir, projectName, taskId, openArgs);
      }
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
      await handleRepo(projectDir, projectName, taskId, posArgs[2], posArgs[3], openArgs); break;
  }
}

module.exports = { run, resolveTaskId, listLiveTasks, handleOpen, handleBrief, parseOpenArgs };
