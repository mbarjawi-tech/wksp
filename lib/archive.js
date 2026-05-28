'use strict';
const fs   = require('fs');
const path = require('path');
const git  = require('./git');
const { readRepos } = require('./repos');
const { discoverWorktrees, WORKTREES_DIR } = require('./worktrees');
const { normalizePath } = require('./paths');
const { readTaskSets, writeTaskSets } = require('./task-state');

const ARCHIVED_DIR  = 'archived-tasks';
const MANIFEST_FILE = 'archived.json';
const SCHEMA_VERSION = 1;

function archivedTaskDir(projectDir, taskId) {
  return path.join(projectDir, ARCHIVED_DIR, taskId);
}

function liveTaskDir(projectDir, taskId) {
  return path.join(projectDir, 'tasks', taskId);
}

function readManifest(archivedDir) {
  const p = path.join(archivedDir, MANIFEST_FILE);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

function writeManifest(archivedDir, data) {
  fs.writeFileSync(path.join(archivedDir, MANIFEST_FILE), JSON.stringify(data, null, 2) + '\n');
}

// ─── archive ─────────────────────────────────────────────────────────────────

// Build a manifest entry per repo, capturing the metadata needed to rehydrate later.
// Returns { entries, uncommittedRepos } so the caller can decide whether to refuse.
function captureState(projectDir, taskId, projectName) {
  const taskDir   = liveTaskDir(projectDir, taskId);
  const allRepos  = readRepos(projectDir);
  const { taskSharedSet: sharedSet, taskExcludedSet: excludedSet } = readTaskSets(taskDir);
  const wts = discoverWorktrees(taskDir);
  // Keyed by folderName so two worktrees from the same base repo can be distinguished
  const wtByFolder = new Map();
  for (const wt of wts) wtByFolder.set(wt.folderName, wt);

  const entries = [];
  const uncommittedRepos = [];

  for (const repo of allRepos) {
    const name = repo.folderName;
    if (excludedSet.has(repo.folderName)) {
      entries.push({ name, baseRepo: repo.normalized, status: 'excluded' });
      continue;
    }
    if (repo.shared || sharedSet.has(repo.folderName)) {
      entries.push({ name, baseRepo: repo.normalized, status: 'shared' });
      continue;
    }
    const wt = wtByFolder.get(repo.folderName);
    if (!wt || wt.corrupted) {
      entries.push({
        name, baseRepo: repo.normalized, status: 'worktree',
        folderName: wt ? wt.folderName : null, branch: null, tipSha: null,
        defaultBranch: null, aheadOfDefault: null, hadRemoteTracking: false,
        branchKeptInBaseRepo: false, uncommittedAtArchive: false,
        note: wt ? `corrupted at archive: ${wt.error || 'unknown'}` : 'no worktree found at archive',
      });
      continue;
    }

    const branch          = wt.currentBranch;
    const tipSha          = git.revParse(wt.worktreeDir, 'HEAD');
    const defaultBranch   = git.defaultBranch(repo.normalized);
    const aheadOfDefault  = defaultBranch ? git.aheadCount(wt.worktreeDir, `origin/${defaultBranch}`, 'HEAD') : null;
    const hadRemoteTracking = branch ? git.branchExistsCached(repo.normalized, branch) : false;
    const uncommitted     = !!git.getChangedFiles(wt.worktreeDir);

    if (uncommitted) uncommittedRepos.push(name);

    entries.push({
      name,
      folderName: wt.folderName,
      baseRepo: repo.normalized,
      status: 'worktree',
      branch,
      tipSha,
      tipShaShort: tipSha ? tipSha.slice(0, 7) : null,
      defaultBranch,
      aheadOfDefault,
      hadRemoteTracking,
      branchKeptInBaseRepo: true,        // overwritten later if --delete-branches
      uncommittedAtArchive: uncommitted,
    });
  }

  return { entries, uncommittedRepos };
}

function archiveTask(projectDir, projectName, taskId, capturedEntries, opts = {}) {
  const taskDir = liveTaskDir(projectDir, taskId);
  const targetDir = archivedTaskDir(projectDir, taskId);

  if (!fs.existsSync(taskDir))        throw new Error(`task not found: ${taskId}`);
  if (fs.existsSync(targetDir))       throw new Error(`already archived: ${taskId}`);

  // Remove worktrees and optionally delete branches
  const wts = discoverWorktrees(taskDir);
  // Keyed by folderName to handle multiple worktrees from the same base repo
  const wtByFolder = new Map();
  for (const wt of wts) wtByFolder.set(wt.folderName, wt);
  const affectedBaseRepos = new Set();

  for (const entry of capturedEntries) {
    if (entry.status !== 'worktree') continue;
    const wt = wtByFolder.get(entry.name);
    if (!wt || wt.corrupted) continue;
    try {
      git.removeWorktree(wt.baseRepo, wt.worktreeDir, !!opts.force);
      affectedBaseRepos.add(wt.baseRepo);
    } catch (e) {
      throw new Error(`failed to remove worktree for ${entry.name}: ${e.message}`);
    }
  }

  for (const baseRepo of affectedBaseRepos) {
    try { git.pruneWorktrees(baseRepo); } catch {}
  }

  if (opts.deleteBranches) {
    for (const entry of capturedEntries) {
      if (entry.status !== 'worktree' || !entry.branch) continue;
      const r = git.deleteBranch(entry.baseRepo, entry.branch, !!opts.force);
      entry.branchKeptInBaseRepo = !r.ok;
    }
  }

  // Write manifest into the task folder, then move it
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    archivedAt:    new Date().toISOString(),
    taskId,
    projectName,
    reason:        opts.reason || null,
    repos:         capturedEntries,
  };
  writeManifest(taskDir, manifest);

  // Drop the now-empty worktrees dir (if it exists and is empty); leave it otherwise
  const wtDir = path.join(taskDir, WORKTREES_DIR);
  if (fs.existsSync(wtDir)) {
    try {
      const remaining = fs.readdirSync(wtDir);
      if (remaining.length === 0) fs.rmdirSync(wtDir);
    } catch {}
  }

  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  fs.renameSync(taskDir, targetDir);

  return { manifest, targetDir };
}

// ─── unarchive — classifier ─────────────────────────────────────────────────

// Diagnose what we can do with one archived repo entry, given the current state of its base repo.
// Returns { state, ... } where state is one of:
//   base-missing | present-local | advanced | remote-only | merged | merged-elsewhere |
//   dangling | lost
function classifyRepo(entry) {
  if (entry.status !== 'worktree') return { state: entry.status };

  const baseRepo = entry.baseRepo;
  if (!fs.existsSync(baseRepo)) return { state: 'base-missing' };

  const branch = entry.branch;
  if (branch && git.branchExistsLocally(baseRepo, branch)) {
    const currentSha = git.revParse(baseRepo, branch);
    if (entry.tipSha && currentSha && currentSha !== entry.tipSha) {
      const advanced = git.aheadCount(baseRepo, entry.tipSha, currentSha);
      return { state: 'advanced', branch, currentSha, advanced };
    }
    return { state: 'present-local', branch };
  }

  if (branch && git.branchExistsCached(baseRepo, branch)) {
    return { state: 'remote-only', branch };
  }

  // Branch gone — fall back to the recorded tipSha
  if (!entry.tipSha) return { state: 'lost' };
  if (!git.objectExists(baseRepo, entry.tipSha)) return { state: 'lost' };

  const defaultBranch = entry.defaultBranch || git.defaultBranch(baseRepo);
  if (defaultBranch && git.isAncestor(baseRepo, entry.tipSha, defaultBranch)) {
    return { state: 'merged', sha: entry.tipSha, defaultBranch };
  }
  const containers = git.branchesContaining(baseRepo, entry.tipSha);
  if (containers.length) {
    return { state: 'merged-elsewhere', sha: entry.tipSha, containers };
  }
  return { state: 'dangling', sha: entry.tipSha };
}

// Build the action plan for unarchive. Returns an array of items, one per repo
// (manifest entries + drift: new repos in repos.txt). Each item has:
//   { name, baseRepo, source: 'manifest'|'new', classification, action }
//
// action is one of:
//   { kind: 'worktree', branch: STRING }
//   { kind: 'worktree-from-sha', sha: STRING, branch: STRING_OR_NULL }
//   { kind: 'shared' }
//   { kind: 'excluded' }
//   { kind: 'skip' }          // nothing recorded; user can --to-worktree later
//   { kind: 'prompt' }        // for new (drifted) repos — caller must prompt at unarchive time
function buildPlan(manifest, currentRepos, overrides = {}) {
  const skipSet   = overrides.skip   || new Set();
  const sharedSet = overrides.shared || new Set();
  const branchMap = overrides.branch || new Map();

  const items = [];

  // Items from the manifest
  for (const entry of manifest.repos) {
    const c = classifyRepo(entry);
    let action;

    if (skipSet.has(entry.name))    action = { kind: 'skip' };
    else if (sharedSet.has(entry.name)) action = { kind: 'shared' };
    else if (branchMap.has(entry.name)) action = { kind: 'worktree', branch: branchMap.get(entry.name) };
    else if (entry.status === 'shared')   action = { kind: 'shared' };
    else if (entry.status === 'excluded') action = { kind: 'excluded' };
    else if (c.state === 'base-missing')  action = { kind: 'skip' };
    else if (c.state === 'present-local') action = { kind: 'worktree', branch: c.branch };
    else if (c.state === 'advanced')      action = { kind: 'worktree', branch: c.branch };
    else if (c.state === 'remote-only')   action = { kind: 'worktree', branch: c.branch };
    else if (c.state === 'merged')        action = { kind: 'worktree', branch: c.defaultBranch };
    else if (c.state === 'merged-elsewhere') {
      const preferred = c.containers.find(b => b === 'main' || b === 'master')
                     || c.containers.find(b => b.startsWith('release/'))
                     || c.containers[0];
      action = { kind: 'worktree', branch: preferred.replace(/^origin\//, '') };
    }
    else if (c.state === 'dangling')      action = { kind: 'worktree-from-sha', sha: c.sha, branch: entry.branch };
    else /* lost */                        action = { kind: 'skip' };

    items.push({
      name: entry.name,
      baseRepo: entry.baseRepo,
      source: 'manifest',
      entry,
      classification: c,
      action: resolveCheckoutConflict(entry.baseRepo, action),
    });
  }

  // Drift — repos in repos.txt that weren't in the manifest (keyed by folderName)
  const manifestNames = new Set(manifest.repos.map(r => r.name));
  for (const repo of currentRepos) {
    if (manifestNames.has(repo.folderName)) continue;
    let action;
    if (skipSet.has(repo.folderName))    action = { kind: 'skip' };
    else if (sharedSet.has(repo.folderName)) action = { kind: 'shared' };
    else if (branchMap.has(repo.folderName)) action = { kind: 'worktree', branch: branchMap.get(repo.folderName) };
    else if (repo.shared)                action = { kind: 'shared' }; // project-level shared
    else                                  action = { kind: 'prompt' };
    items.push({
      name: repo.folderName,
      baseRepo: repo.normalized,
      source: 'new',
      entry: null,
      classification: { state: 'new-since-archive' },
      action: resolveCheckoutConflict(repo.normalized, action),
    });
  }

  return items;
}

// If the planned worktree branch is already checked out elsewhere, adjust the action:
// - checked out in the base repo itself → mark as task-shared (use base repo path)
// - checked out in some other worktree → skip (user can fix manually with --to-worktree)
function resolveCheckoutConflict(baseRepo, action) {
  if ((action.kind !== 'worktree' && action.kind !== 'worktree-from-sha') || !action.branch) return action;
  if (!fs.existsSync(baseRepo)) return action;
  const checkedOutAt = git.findCheckedOutBranch(baseRepo, action.branch);
  if (!checkedOutAt) return action;
  if (path.resolve(checkedOutAt) === path.resolve(baseRepo)) {
    return { kind: 'shared' };
  }
  return { kind: 'skip', reason: `branch already checked out in ${checkedOutAt}` };
}

// Decide whether the unarchive plan has anything worth showing to the user.
// "Boring" = everything is present-local or shared/excluded or skipped via override.
function planIsInteresting(items) {
  return items.some(it => {
    if (it.source === 'new') return true;
    const s = it.classification.state;
    if (s === 'present-local' && it.action.kind === 'worktree') return false;
    if (s === 'shared'        && it.action.kind === 'shared')   return false;
    if (s === 'excluded'      && it.action.kind === 'excluded') return false;
    return true;
  });
}

// Render the plan as a printable table. Returns an array of strings (lines).
function renderPlan(items, manifest) {
  const lines = [];
  const nameW   = Math.max(...items.map(i => i.name.length), 4) + 2;
  const branchW = Math.max(...items.map(i => (i.entry && i.entry.branch || '—').length), 6) + 2;
  const stateW  = Math.max(...items.map(i => stateLabel(i).length), 6) + 2;

  lines.push(`  Repo${' '.repeat(nameW - 4)}Branch${' '.repeat(branchW - 6)}Status${' '.repeat(stateW - 6)}Plan`);
  lines.push(`  ${'─'.repeat(nameW - 1)} ${'─'.repeat(branchW - 1)} ${'─'.repeat(stateW - 1)} ${'─'.repeat(20)}`);
  for (const it of items) {
    const branch = (it.entry && it.entry.branch) || '—';
    const state  = stateLabel(it);
    const plan   = planLabel(it);
    lines.push(`  ${it.name.padEnd(nameW)}${branch.padEnd(branchW)}${state.padEnd(stateW)}${plan}`);
  }
  return lines;
}

function stateLabel(it) {
  if (it.source === 'new') return 'added since archive';
  const s = it.classification.state;
  if (s === 'advanced')         return `advanced (+${it.classification.advanced})`;
  if (s === 'merged-elsewhere') return 'merged into other ref';
  if (s === 'merged')           return 'merged into default';
  return s;
}

function planLabel(it) {
  const a = it.action;
  if (a.kind === 'worktree')          return `worktree on ${a.branch}`;
  if (a.kind === 'worktree-from-sha') return `worktree from ${a.sha.slice(0, 7)}${a.branch ? ` as ${a.branch}` : ''}`;
  if (a.kind === 'shared')             return 'keep shared';
  if (a.kind === 'excluded')           return 'keep excluded';
  if (a.kind === 'skip')               return 'skip';
  if (a.kind === 'prompt')             return 'prompt at launch';
  return a.kind;
}

// Apply the plan: rename folder, recreate worktrees per action. Mutates task-shared/excluded files.
// Returns { successes: [...names], failures: [{name, error}], promptRepos: [{name, baseRepo, repoEntry}] }
function applyPlan(projectDir, taskId, items) {
  const archivedDir = archivedTaskDir(projectDir, taskId);
  const liveDir     = liveTaskDir(projectDir, taskId);

  if (!fs.existsSync(archivedDir)) throw new Error(`not archived: ${taskId}`);
  if (fs.existsSync(liveDir))       throw new Error(`live task already exists: ${taskId}`);

  fs.mkdirSync(path.dirname(liveDir), { recursive: true });
  fs.renameSync(archivedDir, liveDir);

  // Remove the now-stale manifest (task is live again)
  const manifestPath = path.join(liveDir, MANIFEST_FILE);
  if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);

  fs.mkdirSync(path.join(liveDir, WORKTREES_DIR), { recursive: true });

  const { taskSharedSet: sharedSet, taskExcludedSet: excludedSet } = readTaskSets(liveDir);

  const successes = [];
  const failures  = [];
  const promptRepos = [];

  for (const it of items) {
    const a = it.action;
    // Worktree folder is named after it.name (the folderName / alias)
    const wtDir = path.join(liveDir, WORKTREES_DIR, (it.entry && it.entry.folderName) || it.name);

    // Strip from both task-level sets first — we'll re-add based on action below.
    sharedSet.delete(it.name);
    excludedSet.delete(it.name);

    try {
      if (a.kind === 'shared') {
        sharedSet.add(it.name);
        successes.push(it.name);
      } else if (a.kind === 'excluded' || a.kind === 'skip') {
        excludedSet.add(it.name);
        successes.push(it.name);
      } else if (a.kind === 'prompt') {
        // Caller (the command handler) will run the interactive prompt for these
        promptRepos.push({ name: it.name, baseRepo: it.baseRepo });
      } else if (a.kind === 'worktree') {
        if (!fs.existsSync(it.baseRepo)) throw new Error(`base repo not found: ${it.baseRepo}`);
        git.addWorktree(it.baseRepo, wtDir, a.branch);
        successes.push(it.name);
      } else if (a.kind === 'worktree-from-sha') {
        if (!fs.existsSync(it.baseRepo)) throw new Error(`base repo not found: ${it.baseRepo}`);
        if (a.branch && !git.branchExistsLocally(it.baseRepo, a.branch)) {
          const r = git.createBranch(it.baseRepo, a.branch, a.sha);
          if (!r.ok) throw new Error(`could not create branch ${a.branch} at ${a.sha}: ${r.output}`);
        }
        git.addWorktree(it.baseRepo, wtDir, a.branch || a.sha);
        successes.push(it.name);
      }
    } catch (e) {
      failures.push({ name: it.name, error: e.message });
    }
  }

  writeTaskSets(liveDir, sharedSet, excludedSet);

  return { successes, failures, promptRepos };
}

function fetchBaseRepos(baseRepos) {
  for (const base of new Set(baseRepos)) {
    if (!fs.existsSync(base)) continue;
    try { git.fetchOrigin(base); } catch {}
  }
}

module.exports = {
  ARCHIVED_DIR, MANIFEST_FILE, SCHEMA_VERSION,
  archivedTaskDir, liveTaskDir,
  readManifest, writeManifest,
  captureState, archiveTask,
  classifyRepo, buildPlan, planIsInteresting, renderPlan, applyPlan, fetchBaseRepos,
};
