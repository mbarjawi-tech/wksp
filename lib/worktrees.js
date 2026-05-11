'use strict';
const fs   = require('fs');
const path = require('path');
const git  = require('./git');

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

module.exports = { discoverWorktrees, parseGitFile, WORKTREES_DIR };
