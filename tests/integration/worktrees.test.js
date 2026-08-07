'use strict';
const fs   = require('fs');
const path = require('path');
const { makeTempDir, makeGitRepo, cleanup } = require('../helpers');
const { discoverWorktrees, WORKTREES_DIR } = require('../../lib/worktrees');
const { samePathCanonical } = require('../../lib/paths');
const git = require('../../lib/git');

describe('discoverWorktrees', () => {
  let taskDir;
  beforeEach(() => { taskDir = makeTempDir('wksp-disc-wt'); });
  afterEach(()  => cleanup(taskDir));

  test('returns [] when WORKTREES_DIR does not exist', () => {
    expect(discoverWorktrees(taskDir)).toEqual([]);
  });

  test('returns [] for an empty WORKTREES_DIR', () => {
    fs.mkdirSync(path.join(taskDir, WORKTREES_DIR));
    expect(discoverWorktrees(taskDir)).toEqual([]);
  });

  test('marks a dir without a .git file as corrupted', () => {
    const wtDir = path.join(taskDir, WORKTREES_DIR, 'nongit');
    fs.mkdirSync(wtDir, { recursive: true });
    // no .git file — should be reported as corrupted
    const wts = discoverWorktrees(taskDir);
    expect(wts).toHaveLength(1);
    expect(wts[0].corrupted).toBe(true);
  });

  test('marks a dir with an invalid .git file as corrupted', () => {
    const wtDir = path.join(taskDir, WORKTREES_DIR, 'bad');
    fs.mkdirSync(wtDir, { recursive: true });
    fs.writeFileSync(path.join(wtDir, '.git'), 'not a gitdir pointer\n');
    const wts = discoverWorktrees(taskDir);
    expect(wts[0].corrupted).toBe(true);
  });

  test('discovers a real worktree with correct metadata', () => {
    const repoDir = makeTempDir('wksp-base-repo');
    makeGitRepo(repoDir);

    const wtPath = path.join(taskDir, WORKTREES_DIR, 'api');
    fs.mkdirSync(path.join(taskDir, WORKTREES_DIR), { recursive: true });
    // wtPath must not exist — git creates it; just ensure the parent exists
    git.addWorktree(repoDir, wtPath, 'feature/disc-test');

    try {
      const wts = discoverWorktrees(taskDir);
      expect(wts).toHaveLength(1);
      const wt = wts[0];
      expect(wt.corrupted).toBeFalsy();
      expect(wt.folderName).toBe('api');
      expect(wt.currentBranch).toBe('feature/disc-test');
      expect(wt.baseRepo).toBeTruthy();
      // `baseRepo` comes out of the worktree's .git file, so it is git's long on-disk
      // spelling, while `repoDir` is whatever os.tmpdir() handed us — an 8.3 short path
      // on the GitHub Windows runner. This asserts they are the same DIRECTORY, which is
      // what the code cares about; comparing the two strings asserts a coincidence of
      // spelling instead. See tests/integration/short-paths.test.js.
      expect(samePathCanonical(wt.baseRepo, repoDir)).toBe(true);
    } finally {
      git.removeWorktree(repoDir, wtPath);
      git.deleteBranch(repoDir, 'feature/disc-test', true);
      cleanup(repoDir);
    }
  });
});
