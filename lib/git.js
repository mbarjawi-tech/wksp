'use strict';
const { execSync } = require('child_process');
const { samePathCanonical } = require('./paths');

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

// The base repo's own registration for the worktree at `worktreePath`, or null when
// it has none: { branch } — branch is null for a detached-HEAD worktree.
//
// Reads the base repo's registry rather than the worktree itself, so it still answers
// for a worktree whose .git file is gone: git keeps listing the entry (as prunable)
// until `git worktree prune`. That makes this the last place the branch name of a
// worktree destroyed mid-teardown can be read — see the teardown reporting in
// lib/commands/task.js.
//
// The path comparison is CANONICAL because git always reports the long, on-disk form
// while the caller's path is whatever wksp built it from — an 8.3 short %TEMP%, a
// junctioned project root. Comparing the raw strings made this return null for a
// worktree that plainly exists, which is how a branch name went "unrecoverable" and,
// through repo.js, how a teardown guard was skipped entirely (PLANNING #25).
function findWorktreeEntry(repoPath, worktreePath) {
  const r = tryRun(`git -C "${repoPath}" worktree list --porcelain`);
  if (!r.ok) return null;
  for (const block of r.output.split(/\n\n+/).filter(Boolean)) {
    const lines = block.split('\n');
    const wLine = lines.find(l => l.startsWith('worktree '));
    if (!wLine) continue;
    if (!samePathCanonical(wLine.slice('worktree '.length).trim(), worktreePath)) continue;
    const bLine = lines.find(l => l.startsWith('branch '));
    return { branch: bLine ? bLine.replace('branch refs/heads/', '').trim() : null };
  }
  return null;
}

// Fetch ONE branch into its remote-tracking ref. An explicit refspec rather than a
// bare `fetch origin <branch>`: the bare form's job is to update FETCH_HEAD, and it
// only writes refs/remotes/origin/<branch> as a side effect of the remote's configured
// refspec — which a clone made with --single-branch, or a hand-edited remote, need not
// have. Naming the destination makes the one thing we depend on the thing we asked for.
function fetchBranch(repoPath, branch) {
  return tryRun(`git -C "${repoPath}" fetch origin "+refs/heads/${branch}:refs/remotes/origin/${branch}"`);
}

// `stdio` is overridable so a --json run can point git's own progress output at
// stderr (['ignore', 2, 2]) instead of letting it corrupt the JSON on stdout.
function addWorktree(basePath, worktreePath, branch, baseBranch = null, stdio = 'inherit') {
  const localExists = branchExistsLocally(basePath, branch);
  // `git worktree add <path> <branch>` resolves LOCAL refs only. Knowing the branch
  // exists on the server is therefore not enough to use it — the ref has to be in this
  // clone. Ask the cheap local question first (it also skips a network round-trip per
  // repo in the common case), and only when that fails ask the remote; if the remote
  // has it and we don't, fetch it before handing git a name it cannot resolve.
  // Without this, a branch a colleague pushed after your last fetch died on
  // `fatal: invalid reference: <branch>` mid-way through building the task.
  let cached = !localExists && branchExistsCached(basePath, branch);
  if (!localExists && !cached && branchExistsRemotely(basePath, branch)) {
    const fetched = fetchBranch(basePath, branch);
    cached = branchExistsCached(basePath, branch);
    // The remote answered "I have it", so falling through to the create-a-new-branch
    // path below would silently start an UNRELATED branch under a name that is already
    // taken on origin — diverging from a colleague's work and only surfacing at push
    // time. A fetch we asked for and did not get is an error, not a default.
    if (!cached) {
      const detail = (fetched.output || '').split('\n').find(Boolean) || 'fetch failed';
      throw new Error(
        `"${branch}" exists on origin but could not be fetched into ${basePath} — ${detail}`
      );
    }
  }

  if (localExists) {
    execSync(`git -C "${basePath}" worktree add "${worktreePath}" "${branch}"`, { stdio });
  } else if (cached) {
    // Name origin/<branch> explicitly rather than leaning on git's DWIM, which only
    // fires when EXACTLY ONE remote carries the name: a clone with both `origin` and an
    // `upstream` (the ordinary fork setup) would fail `invalid reference` again — the
    // very error this path exists to remove — even though we just fetched the ref.
    execSync(`git -C "${basePath}" worktree add --track -b "${branch}" "${worktreePath}" "origin/${branch}"`, { stdio });
  } else {
    let startPoint = '';
    if (baseBranch) {
      if (branchExistsCached(basePath, baseBranch))   startPoint = `"origin/${baseBranch}"`;
      else if (branchExistsLocally(basePath, baseBranch)) startPoint = `"${baseBranch}"`;
    }
    const cmd = `git -C "${basePath}" worktree add -b "${branch}" "${worktreePath}"${startPoint ? ' ' + startPoint : ''}`;
    execSync(cmd, { stdio });
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

function mergeFfOnly(repoPath, ref) {
  return tryRun(`git -C "${repoPath}" merge --ff-only "${ref}"`);
}

function worktreeRepair(basePath, worktreePath) {
  execSync(`git -C "${basePath}" worktree repair "${worktreePath}"`, { stdio: 'pipe' });
}

function getRemoteUrl(repoPath) {
  const r = tryRun(`git -C "${repoPath}" remote get-url origin`);
  return r.ok ? r.output.trim() : null;
}

// Returns number of commits in <branch> not in origin/<branch>.
// Returns null if origin/<branch> doesn't exist (branch never pushed).
function countUnpushed(repoPath, branch) {
  const r = tryRun(`git -C "${repoPath}" rev-list --count "origin/${branch}..${branch}"`);
  if (!r.ok) return null;
  const n = parseInt(r.output, 10);
  return isNaN(n) ? null : n;
}

module.exports = {
  currentBranch, branchExistsLocally, branchExistsRemotely, branchExistsCached,
  findCheckedOutBranch, findWorktreeEntry, addWorktree, removeWorktree, pruneWorktrees,
  getChangedFiles, isGitRepo, clone, tryRun, defaultBranch, behindCount, deleteBranch,
  revParse, objectExists, isAncestor, branchesContaining, aheadCount, createBranch, fetchOrigin, fetchBranch,
  mergeFfOnly, worktreeRepair, getRemoteUrl, countUnpushed,
};
