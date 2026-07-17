'use strict';
const fs   = require('fs');
const path = require('path');

const { hubClaudeMd }   = require('./templates');
const { readRepos }     = require('./repos');
const { writeTaskSets } = require('./task-state');
const { WORKTREES_DIR } = require('./worktrees');

// The reserved planning task. Every project may have exactly one; it holds the
// feature backlog, cross-cutting design, and open decisions, and has no worktree.
const HUB_TASK_ID = 'hub';

function hubDir(projectDir) {
  return path.join(projectDir, 'tasks', HUB_TASK_ID);
}

function hubExists(projectDir) {
  return fs.existsSync(hubDir(projectDir));
}

// Scaffold the hub task: CLAUDE.md, WORKLOG.md, task.json (every registered repo
// excluded so no worktrees are ever prompted for), and a minimal .code-workspace.
// Idempotent-safe callers should check hubExists() first. Returns the hub dir.
function scaffoldHub(projectDir, projectName) {
  const taskDir = hubDir(projectDir);
  fs.mkdirSync(path.join(taskDir, WORKTREES_DIR), { recursive: true });

  fs.writeFileSync(path.join(taskDir, 'CLAUDE.md'), hubClaudeMd());
  fs.writeFileSync(path.join(taskDir, 'WORKLOG.md'), `# Work Log: ${HUB_TASK_ID}\n`);

  // Exclude every currently-registered repo so the hub never carries a worktree.
  const excluded = new Set(readRepos(projectDir).map(r => r.folderName));
  writeTaskSets(taskDir, new Set(), excluded);

  const wsFile = `${projectName}--${HUB_TASK_ID}.code-workspace`;
  const folders = [{ path: '.', name: `${HUB_TASK_ID} (planning)` }];
  fs.writeFileSync(path.join(taskDir, wsFile), JSON.stringify({ folders }, null, 2) + '\n');

  return taskDir;
}

module.exports = { HUB_TASK_ID, hubDir, hubExists, scaffoldHub };
