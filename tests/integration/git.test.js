'use strict';
const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { makeTempDir, makeGitRepo, makeGitRepoWithRemote, cleanup } = require('../helpers');
const git = require('../../lib/git');

// ─── helpers ─────────────────────────────────────────────────────────────────

function commit(repoDir, message = 'commit') {
  const f = path.join(repoDir, `${Date.now()}.txt`);
  fs.writeFileSync(f, message);
  execSync('git add .', { cwd: repoDir, stdio: 'pipe' });
  execSync(`git commit -m "${message}"`, { cwd: repoDir, stdio: 'pipe' });
}

// ─── currentBranch ───────────────────────────────────────────────────────────

describe('currentBranch', () => {
  let repoDir;
  beforeEach(() => { repoDir = makeTempDir('git-curr'); makeGitRepo(repoDir); });
  afterEach(()  => cleanup(repoDir));

  test('returns branch name after init', () => {
    expect(git.currentBranch(repoDir)).toBe('main');
  });

  test('returns new branch name after checkout', () => {
    execSync('git checkout -b feature/x', { cwd: repoDir, stdio: 'pipe' });
    expect(git.currentBranch(repoDir)).toBe('feature/x');
  });

  test('returns null for a non-repo path', () => {
    expect(git.currentBranch(makeTempDir())).toBeNull();
  });
});

// ─── branchExistsLocally ─────────────────────────────────────────────────────

describe('branchExistsLocally', () => {
  let repoDir;
  beforeEach(() => { repoDir = makeTempDir('git-local'); makeGitRepo(repoDir); });
  afterEach(()  => cleanup(repoDir));

  test('true for existing branch', () => {
    expect(git.branchExistsLocally(repoDir, 'main')).toBe(true);
  });

  test('false for nonexistent branch', () => {
    expect(git.branchExistsLocally(repoDir, 'does-not-exist')).toBe(false);
  });

  test('true after creating a branch', () => {
    execSync('git checkout -b feature/y', { cwd: repoDir, stdio: 'pipe' });
    expect(git.branchExistsLocally(repoDir, 'feature/y')).toBe(true);
  });
});

// ─── branchExistsCached ──────────────────────────────────────────────────────

describe('branchExistsCached', () => {
  let repoDir, originDir;
  beforeEach(() => {
    ({ repoDir, originDir } = makeGitRepoWithRemote());
  });
  afterEach(() => cleanup(repoDir, originDir));

  test('true for a branch that has been pushed', () => {
    const branch = execSync('git rev-parse --abbrev-ref HEAD',
      { cwd: repoDir, encoding: 'utf8', stdio: 'pipe' }).trim();
    expect(git.branchExistsCached(repoDir, branch)).toBe(true);
  });

  test('false for a branch that has not been pushed', () => {
    execSync('git checkout -b local-only', { cwd: repoDir, stdio: 'pipe' });
    expect(git.branchExistsCached(repoDir, 'local-only')).toBe(false);
  });
});

// ─── addWorktree / removeWorktree ────────────────────────────────────────────

describe('addWorktree', () => {
  let repoDir, wtDir;
  beforeEach(() => {
    repoDir = makeTempDir('git-add-wt'); makeGitRepo(repoDir);
    wtDir   = makeTempDir('git-wt-target');
    fs.rmdirSync(wtDir); // addWorktree creates the dir itself
  });
  afterEach(() => {
    try { git.removeWorktree(repoDir, wtDir); } catch {}
    try { git.deleteBranch(repoDir, 'feature/new', true); } catch {}
    cleanup(repoDir, wtDir);
  });

  test('creates a new branch worktree', () => {
    git.addWorktree(repoDir, wtDir, 'feature/new');
    expect(fs.existsSync(wtDir)).toBe(true);
    expect(git.currentBranch(wtDir)).toBe('feature/new');
  });

  test('new branch is based on specified local base branch', () => {
    // Create a second commit on main so we can verify the base
    commit(repoDir, 'second commit');
    const mainSha = execSync('git rev-parse main', { cwd: repoDir, encoding: 'utf8', stdio: 'pipe' }).trim();

    // Create a divergent branch from the first commit
    execSync('git checkout -b old HEAD~1', { cwd: repoDir, stdio: 'pipe' });
    execSync('git checkout main', { cwd: repoDir, stdio: 'pipe' });

    git.addWorktree(repoDir, wtDir, 'feature/new', 'main');
    const wtSha = execSync('git rev-parse HEAD', { cwd: wtDir, encoding: 'utf8', stdio: 'pipe' }).trim();
    expect(wtSha).toBe(mainSha);
  });

  test('checks out an existing local branch', () => {
    execSync('git checkout -b feature/existing', { cwd: repoDir, stdio: 'pipe' });
    execSync('git checkout main', { cwd: repoDir, stdio: 'pipe' });
    git.addWorktree(repoDir, wtDir, 'feature/existing');
    expect(git.currentBranch(wtDir)).toBe('feature/existing');
  });
});

// ─── removeWorktree ───────────────────────────────────────────────────────────

describe('removeWorktree', () => {
  let repoDir, wtDir;
  beforeEach(() => {
    repoDir = makeTempDir('git-rm-wt'); makeGitRepo(repoDir);
    wtDir   = makeTempDir('git-wt-rm');
    fs.rmdirSync(wtDir);
    git.addWorktree(repoDir, wtDir, 'feature/to-remove');
  });
  afterEach(() => {
    try { git.deleteBranch(repoDir, 'feature/to-remove', true); } catch {}
    cleanup(repoDir, wtDir);
  });

  test('removes the worktree directory', () => {
    git.removeWorktree(repoDir, wtDir);
    expect(fs.existsSync(wtDir)).toBe(false);
  });

  test('force-removes a worktree with uncommitted changes', () => {
    fs.writeFileSync(path.join(wtDir, 'dirty.txt'), 'dirty');
    git.removeWorktree(repoDir, wtDir, true);
    expect(fs.existsSync(wtDir)).toBe(false);
  });
});

// ─── deleteBranch ────────────────────────────────────────────────────────────

describe('deleteBranch', () => {
  let repoDir;
  beforeEach(() => { repoDir = makeTempDir('git-del-br'); makeGitRepo(repoDir); });
  afterEach(()  => cleanup(repoDir));

  test('deletes a merged branch safely', () => {
    execSync('git checkout -b to-delete', { cwd: repoDir, stdio: 'pipe' });
    execSync('git checkout main', { cwd: repoDir, stdio: 'pipe' });
    // merge to-delete into main so -d succeeds
    execSync('git merge to-delete', { cwd: repoDir, stdio: 'pipe' });
    const r = git.deleteBranch(repoDir, 'to-delete');
    expect(r.ok).toBe(true);
    expect(git.branchExistsLocally(repoDir, 'to-delete')).toBe(false);
  });

  test('safe delete fails on a branch with unmerged commits', () => {
    execSync('git checkout -b unmerged', { cwd: repoDir, stdio: 'pipe' });
    commit(repoDir, 'unmerged work');
    execSync('git checkout main', { cwd: repoDir, stdio: 'pipe' });
    const r = git.deleteBranch(repoDir, 'unmerged', false);
    expect(r.ok).toBe(false);
    expect(git.branchExistsLocally(repoDir, 'unmerged')).toBe(true);
  });

  test('force delete removes branch with unmerged commits', () => {
    execSync('git checkout -b unmerged', { cwd: repoDir, stdio: 'pipe' });
    commit(repoDir, 'unmerged work');
    execSync('git checkout main', { cwd: repoDir, stdio: 'pipe' });
    const r = git.deleteBranch(repoDir, 'unmerged', true);
    expect(r.ok).toBe(true);
    expect(git.branchExistsLocally(repoDir, 'unmerged')).toBe(false);
  });
});

// ─── findCheckedOutBranch ─────────────────────────────────────────────────────

describe('findCheckedOutBranch', () => {
  let repoDir, wtDir;
  beforeEach(() => {
    repoDir = makeTempDir('git-find-co'); makeGitRepo(repoDir);
    wtDir   = makeTempDir('git-wt-find');
    fs.rmdirSync(wtDir);
    git.addWorktree(repoDir, wtDir, 'feature/checked-out');
  });
  afterEach(() => {
    try { git.removeWorktree(repoDir, wtDir); } catch {}
    try { git.deleteBranch(repoDir, 'feature/checked-out', true); } catch {}
    cleanup(repoDir, wtDir);
  });

  test('returns the worktree path when branch is checked out', () => {
    const result = git.findCheckedOutBranch(repoDir, 'feature/checked-out');
    expect(result).toBeTruthy();
    expect(result.replace(/\\/g, '/')).toContain(wtDir.replace(/\\/g, '/'));
  });

  test('returns null for a branch not checked out anywhere', () => {
    expect(git.findCheckedOutBranch(repoDir, 'not-checked-out')).toBeNull();
  });
});

// ─── getChangedFiles ─────────────────────────────────────────────────────────

describe('getChangedFiles', () => {
  let repoDir;
  beforeEach(() => { repoDir = makeTempDir('git-changed'); makeGitRepo(repoDir); });
  afterEach(()  => cleanup(repoDir));

  test('returns empty string for a clean repo', () => {
    expect(git.getChangedFiles(repoDir)).toBe('');
  });

  test('returns changed file list', () => {
    fs.writeFileSync(path.join(repoDir, 'dirty.txt'), 'dirty');
    expect(git.getChangedFiles(repoDir)).toContain('dirty.txt');
  });
});

// ─── defaultBranch ───────────────────────────────────────────────────────────

describe('defaultBranch', () => {
  let repoDir, originDir;
  beforeEach(() => { ({ repoDir, originDir } = makeGitRepoWithRemote()); });
  afterEach(()  => cleanup(repoDir, originDir));

  test('returns the default branch name via symbolic-ref', () => {
    const branch = git.defaultBranch(repoDir);
    expect(branch).toBeTruthy();
    expect(['main', 'master'].includes(branch)).toBe(true);
  });
});

// ─── behindCount ─────────────────────────────────────────────────────────────

describe('behindCount', () => {
  let repoDir, originDir;
  beforeEach(() => { ({ repoDir, originDir } = makeGitRepoWithRemote()); });
  afterEach(()  => cleanup(repoDir, originDir));

  test('returns 0 when branch is up to date', () => {
    const branch = git.defaultBranch(repoDir);
    expect(git.behindCount(repoDir, branch)).toBe(0);
  });

  test('returns n when branch is behind remote', () => {
    // Add 2 commits to origin that the local clone hasn't fetched
    commit(repoDir, 'ahead 1');
    commit(repoDir, 'ahead 2');
    execSync('git push', { cwd: repoDir, stdio: 'pipe' });

    // Create a worktree on the old state
    const wtDir = makeTempDir('git-behind-wt');
    fs.rmdirSync(wtDir);
    const defaultBr = git.defaultBranch(repoDir);
    execSync('git checkout -b behind-branch HEAD~2', { cwd: repoDir, stdio: 'pipe' });
    execSync(`git checkout ${defaultBr}`, { cwd: repoDir, stdio: 'pipe' });
    git.addWorktree(repoDir, wtDir, 'behind-branch');

    try {
      const branch = git.defaultBranch(repoDir);
      const count  = git.behindCount(wtDir, branch);
      expect(count).toBe(2);
    } finally {
      git.removeWorktree(repoDir, wtDir);
      git.deleteBranch(repoDir, 'behind-branch', true);
      cleanup(wtDir);
    }
  });
});
