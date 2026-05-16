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

function deleteBranch(repoPath, branch, force = false) {
  return tryRun(`git -C "${repoPath}" branch ${force ? '-D' : '-d'} "${branch}"`);
}

function clone(url, dest, branch = null) {
  const branchFlag = branch ? `-b "${branch}" ` : '';
  execSync(`git clone ${branchFlag}"${url}" "${dest}"`, { stdio: 'inherit' });
}

function revParse(repoPath, ref) {
  const r = tryRun(`git -C "${repoPath}" rev-parse --verify "${ref}^{commit}"`);
  return r.ok ? r.output : null;
}

function objectExists(repoPath, sha) {
  return tryRun(`git -C "${repoPath}" cat-file -e "${sha}^{commit}"`).ok;
}

function isAncestor(repoPath, ancestor, descendant) {
  return tryRun(`git -C "${repoPath}" merge-base --is-ancestor "${ancestor}" "${descendant}"`).ok;
}

function branchesContaining(repoPath, sha) {
  const local  = tryRun(`git -C "${repoPath}" branch --contains "${sha}" --format="%(refname:short)"`);
  const remote = tryRun(`git -C "${repoPath}" branch -r --contains "${sha}" --format="%(refname:short)"`);
  const lines = [];
  if (local.ok)  lines.push(...local.output.split('\n').map(l => l.trim()).filter(Boolean));
  if (remote.ok) lines.push(...remote.output.split('\n').map(l => l.trim()).filter(Boolean));
  return lines;
}

function aheadCount(repoPath, base, head) {
  if (!base || !head) return null;
  const r = tryRun(`git -C "${repoPath}" rev-list --count "${base}..${head}"`);
  if (!r.ok) return null;
  const n = parseInt(r.output, 10);
  return isNaN(n) ? null : n;
}

function createBranch(repoPath, branch, startPoint) {
  return tryRun(`git -C "${repoPath}" branch "${branch}" "${startPoint}"`);
}

function fetchOrigin(repoPath) {
  return tryRun(`git -C "${repoPath}" fetch origin --prune`);
}

function worktreeRepair(basePath, worktreePath) {
  execSync(`git -C "${basePath}" worktree repair "${worktreePath}"`, { stdio: 'pipe' });
}

module.exports = {
  currentBranch, branchExistsLocally, branchExistsRemotely, branchExistsCached,
  findCheckedOutBranch, addWorktree, removeWorktree, pruneWorktrees,
  getChangedFiles, isGitRepo, clone, tryRun, defaultBranch, behindCount, deleteBranch,
  revParse, objectExists, isAncestor, branchesContaining, aheadCount, createBranch, fetchOrigin,
  worktreeRepair,
};
