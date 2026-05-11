'use strict';
const { execSync } = require('child_process');

function run(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: 'pipe' }).trim();
}

function tryRun(cmd) {
  try   { return { ok: true,  output: run(cmd) }; }
  catch (e) { return { ok: false, output: e.message }; }
}

function currentBranch(repoPath) {
  const r = tryRun(`git -C "${repoPath}" rev-parse --abbrev-ref HEAD`);
  return r.ok ? r.output : null;
}

function branchExistsLocally(repoPath, branch) {
  return tryRun(`git -C "${repoPath}" rev-parse --verify "refs/heads/${branch}"`).ok;
}

function branchExistsRemotely(repoPath, branch) {
  return tryRun(`git -C "${repoPath}" ls-remote --exit-code --heads origin "${branch}"`).ok;
}

function branchExistsCached(repoPath, branch) {
  return tryRun(`git -C "${repoPath}" rev-parse --verify "refs/remotes/origin/${branch}"`).ok;
}

function findCheckedOutBranch(repoPath, branch) {
  const r = tryRun(`git -C "${repoPath}" worktree list --porcelain`);
  if (!r.ok) return null;
  const blocks = r.output.split(/\n\n+/).filter(Boolean);
  for (const block of blocks) {
    const lines = block.split('\n');
    const branchLine  = lines.find(l => l.startsWith('branch '));
    const worktreeLine = lines.find(l => l.startsWith('worktree '));
    if (!branchLine || !worktreeLine) continue;
    const wBranch = branchLine.replace('branch refs/heads/', '').trim();
    if (wBranch === branch) return worktreeLine.replace('worktree ', '').trim();
  }
  return null;
}

function addWorktree(basePath, worktreePath, branch, baseBranch = null) {
  const localExists  = branchExistsLocally(basePath, branch);
  const remoteExists = !localExists && branchExistsRemotely(basePath, branch);
  if (!localExists && !remoteExists) {
    let startPoint = '';
    if (baseBranch) {
      if (branchExistsCached(basePath, baseBranch))   startPoint = `"origin/${baseBranch}"`;
      else if (branchExistsLocally(basePath, baseBranch)) startPoint = `"${baseBranch}"`;
    }
    const cmd = `git -C "${basePath}" worktree add -b "${branch}" "${worktreePath}"${startPoint ? ' ' + startPoint : ''}`;
    execSync(cmd, { stdio: 'inherit' });
  } else {
    execSync(`git -C "${basePath}" worktree add "${worktreePath}" "${branch}"`, { stdio: 'inherit' });
  }
}

function removeWorktree(basePath, worktreePath, force = false) {
  const flag = force ? ' --force' : '';
  execSync(`git -C "${basePath}" worktree remove${flag} "${worktreePath}"`, { stdio: 'inherit' });
}

function pruneWorktrees(basePath) {
  execSync(`git -C "${basePath}" worktree prune`, { stdio: 'inherit' });
}

function getChangedFiles(worktreePath) {
  const r = tryRun(`git -C "${worktreePath}" status --short`);
  return r.ok ? r.output : '';
}

function isGitRepo(p) {
  return tryRun(`git -C "${p}" rev-parse --git-dir`).ok;
}

function defaultBranch(repoPath) {
  const r = tryRun(`git -C "${repoPath}" symbolic-ref refs/remotes/origin/HEAD`);
  if (r.ok) return r.output.replace('refs/remotes/origin/', '').trim();
  for (const b of ['main', 'master', 'production', 'production-new']) {
    if (tryRun(`git -C "${repoPath}" rev-parse --verify "refs/remotes/origin/${b}"`).ok) return b;
  }
  return null;
}

function behindCount(worktreeDir, baseBranch) {
  if (!baseBranch) return null;
  const r = tryRun(`git -C "${worktreeDir}" rev-list --count "HEAD..origin/${baseBranch}"`);
  if (!r.ok) return null;
  const n = parseInt(r.output, 10);
  return isNaN(n) ? null : n;
}

function clone(url, dest, branch = null) {
  const branchFlag = branch ? `-b "${branch}" ` : '';
  execSync(`git clone ${branchFlag}"${url}" "${dest}"`, { stdio: 'inherit' });
}

module.exports = {
  currentBranch, branchExistsLocally, branchExistsRemotely, branchExistsCached,
  findCheckedOutBranch, addWorktree, removeWorktree, pruneWorktrees,
  getChangedFiles, isGitRepo, clone, tryRun, defaultBranch, behindCount,
};
