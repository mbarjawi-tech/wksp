'use strict';
const fs   = require('fs');
const path = require('path');
const { readRepos }        = require('./repos');
const { readTaskSets, TASK_CONFIG_FILE } = require('./task-state');
const { discoverWorktrees, WORKTREES_DIR } = require('./worktrees');
const { AGENTS_FILE }      = require('./templates');
const git = require('./git');

// The task brief: everything a launch would have put in front of an agent, as a
// document instead. It is what makes hub-driven work possible — a session at the
// project root can read a task's brief and work in it as if it had been launched
// there, because a task folder lives under the project root either way.
//
// `create --json`, `resume --json` and `wksp task brief --json` all emit this one
// shape (versioned, so an agent can depend on it).

const BRIEF_VERSION = 1;

// Absolute, forward slashes — readable on every platform and safe to paste.
function fwd(p) {
  return p ? p.replace(/\\/g, '/') : p;
}

function fileOrNull(p) {
  return fs.existsSync(p) ? fwd(p) : null;
}

// The rules that keep hub-driven work from turning into a mess. Shipped inside the
// document on purpose: an agent that only reads the JSON still learns them.
function guidanceFor(taskId) {
  return [
    `Read tasks/${taskId}/${AGENTS_FILE} first — it is this task's scope contract — then the project ${AGENTS_FILE}.`,
    'Change code only inside the repo paths listed above.',
    `Record what you did in tasks/${taskId}/WORKLOG.md: one line per concern, rewritten in place rather than appended twice.`,
    'Keep anything that outlives this task in the project root: PLANNING.md for decisions and backlog, WORKLOG.md for planning history.',
    `Close the task out with: wksp task finish ${taskId}`,
  ];
}

// Build the brief from what's on disk. `extra` carries facts only the caller knows:
// { created, createdWorktrees: Set<name>, launched, provider }.
function buildBrief(projectDir, projectName, taskId, extra = {}) {
  const taskDir  = path.join(projectDir, 'tasks', taskId);
  const allRepos = readRepos(projectDir);
  const { taskSharedSet, taskExcludedSet } = readTaskSets(taskDir);

  const wtByName = new Map();
  for (const wt of discoverWorktrees(taskDir)) wtByName.set(wt.folderName, wt);

  const created = extra.createdWorktrees || new Set();
  const repos = allRepos.map(repo => {
    const name = repo.folderName;
    if (taskExcludedSet.has(name)) {
      return { name, mode: 'excluded', optional: !!repo.optional, branch: null, path: null };
    }
    if (repo.shared || taskSharedSet.has(name)) {
      return {
        name, mode: 'shared', optional: !!repo.optional,
        branch: git.currentBranch(repo.normalized) || null,
        path:   fwd(repo.normalized),
        baseRepo: fwd(repo.normalized),
      };
    }
    const wt = wtByName.get(name);
    if (!wt) return { name, mode: 'missing', optional: !!repo.optional, branch: null, path: null };
    // Staleness is worth knowing before changing code, and the brief replaces the
    // launch summary that used to carry it. Local refs only — nothing is fetched.
    const baseBranch = git.defaultBranch(repo.normalized);
    return {
      name, mode: 'worktree', optional: !!repo.optional,
      branch:   wt.currentBranch || null,
      path:     fwd(wt.worktreeDir),
      baseRepo: fwd(wt.baseRepo),
      baseBranch: baseBranch || null,
      behind:   git.behindCount(wt.worktreeDir, baseBranch),
      created:  created.has(name),
      corrupted: !!wt.corrupted || undefined,
    };
  });

  // The dirs a launch would pass to the AI tool, in the same order.
  const contextDirs = [fwd(projectDir), fwd(taskDir)];
  for (const r of repos) {
    if (r.mode === 'worktree' || r.mode === 'shared') contextDirs.push(r.path);
  }

  return {
    ok: true,
    briefVersion: BRIEF_VERSION,
    project: {
      name:       projectName,
      dir:        fwd(projectDir),
      agentsMd:   fileOrNull(path.join(projectDir, AGENTS_FILE)),
      planningMd: fileOrNull(path.join(projectDir, 'PLANNING.md')),
      worklog:    fileOrNull(path.join(projectDir, 'WORKLOG.md')),
    },
    task: {
      id:            taskId,
      dir:           fwd(taskDir),
      created:       !!extra.created,
      agentsMd:      fileOrNull(path.join(taskDir, AGENTS_FILE)),
      worklog:       fileOrNull(path.join(taskDir, 'WORKLOG.md')),
      taskJson:      fileOrNull(path.join(taskDir, TASK_CONFIG_FILE)),
      workspaceFile: fileOrNull(path.join(taskDir, `${projectName}--${taskId}.code-workspace`)),
      worktreesDir:  fwd(path.join(taskDir, WORKTREES_DIR)),
    },
    repos,
    contextDirs,
    launched: !!extra.launched,
    provider: extra.provider || null,
    guidance: guidanceFor(taskId),
  };
}

// Text rendering of the same document, for `--no-launch` and `wksp task brief`.
function renderBrief(brief) {
  const W = 64;
  const t = brief.task;
  const lines = [
    '\n' + '─'.repeat(W),
    `  wksp · ${brief.project.name} / ${t.id} — task brief`,
    '─'.repeat(W),
    `  Task folder:   ${t.dir}`,
  ];
  if (t.agentsMd) lines.push(`  Instructions:  ${t.agentsMd}`);
  if (t.worklog)  lines.push(`  Work log:      ${t.worklog}`);
  const projectFiles = [
    brief.project.agentsMd   ? `${path.basename(brief.project.agentsMd)} (conventions)` : null,
    brief.project.planningMd ? 'PLANNING.md (backlog, decisions)' : null,
  ].filter(Boolean);
  if (projectFiles.length) lines.push(`  Project root:  ${brief.project.dir}`);
  if (projectFiles.length) lines.push(`                 ${projectFiles.join('  ·  ')}`);

  lines.push('', '  Repos:', '');
  if (!brief.repos.length) {
    lines.push('    (none registered)');
  } else {
    const nameW   = Math.max(...brief.repos.map(r => r.name.length)) + 2;
    const branchW = Math.max(...brief.repos.map(r => (r.branch || '—').length)) + 2;
    for (const r of brief.repos) {
      const mode = r.mode === 'missing' ? 'no worktree' : r.mode;
      const loc  = r.path || '—';
      const stale = r.behind > 0
        ? `  ⚠ ${r.behind} commit${r.behind === 1 ? '' : 's'} behind ${r.baseBranch}`
        : '';
      lines.push(`    ${r.name.padEnd(nameW)}${(r.branch || '—').padEnd(branchW)}${mode.padEnd(11)} ${loc}${stale}`);
    }
  }

  lines.push('', '  Working in this task from here:');
  for (const g of brief.guidance) lines.push(`    · ${g}`);
  lines.push('', `  For a focused session in the task instead:  wksp start ${t.id}`);
  lines.push('─'.repeat(W));
  return lines;
}

module.exports = { buildBrief, renderBrief, BRIEF_VERSION };
