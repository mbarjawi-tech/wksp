'use strict';
const fs   = require('fs');
const path = require('path');
const git  = require('./git');
const { readRepos } = require('./repos');

const WORKTREES_DIR = 'worktrees';

function parseGitFile(worktreeDir) {
  const content = fs.readFileSync(path.join(worktreeDir, '.git'), 'utf8').trim();
  if (!content.startsWith('gitdir: ')) return null;
  const gitdirPath = content.slice(8).trim();
  return gitdirPath.replace(/[/\\]\.git[/\\]worktrees[/\\][^/\\]+$/, '');
}

function discoverWorktrees(taskDir) {
  const worktreesDir = path.join(taskDir, WORKTREES_DIR);
  if (!fs.existsSync(worktreesDir)) return [];

  return fs.readdirSync(worktreesDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => {
      const folderName  = d.name;
      const worktreeDir = path.join(worktreesDir, folderName);
      try {
        const baseRepo = parseGitFile(worktreeDir);
        if (!baseRepo) {
          return { folderName, worktreeDir, baseRepo: null, currentBranch: null, corrupted: true, error: 'malformed .git file' };
        }
        return { folderName, worktreeDir, baseRepo, currentBranch: git.currentBranch(worktreeDir), corrupted: false };
      } catch (e) {
        return { folderName, worktreeDir, baseRepo: null, currentBranch: null, corrupted: true, error: e.message };
      }
    });
}

// Which registered base repo still has a worktree at `worktreeDir`, and on what
// branch: { baseRepo, branch } or null.
//
// The point is the case discoverWorktrees can't answer — a worktree whose .git file
// is gone, so its base repo is unknown. Every registered repo is asked instead, and
// the base repo keeps the registration until `git worktree prune`, so this recovers
// the branch of a worktree that was destroyed mid-teardown well enough to name it in
// a warning. Deliberately used for REPORTING only: nothing verified that branch
// merged, so no code path deletes it off the back of this.
function findWorktreeRegistration(projectDir, worktreeDir) {
  for (const repo of readRepos(projectDir)) {
    const entry = git.findWorktreeEntry(repo.normalized, worktreeDir);
    if (entry) return { baseRepo: repo.normalized, branch: entry.branch };
  }
  return null;
}

module.exports = { discoverWorktrees, parseGitFile, findWorktreeRegistration, WORKTREES_DIR };
