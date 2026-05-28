'use strict';
const fs   = require('fs');
const path = require('path');
const { makeTempDir, cleanup } = require('../helpers');
const {
  CACHE_DIR_NAME,
  getCacheDir,
  ensureCacheDir,
  createDepLinks,
  removeDepLinks,
  isDepLinked,
  hasRealDepDir,
} = require('../../lib/deps');

// ─── getCacheDir ──────────────────────────────────────────────────────────────

describe('getCacheDir', () => {
  test('returns <projectDir>/.wksp-cache/<repoFolderName>', () => {
    const result = getCacheDir('/projects/acme', 'backend');
    expect(result).toBe(path.join('/projects/acme', CACHE_DIR_NAME, 'backend'));
  });
});

// ─── ensureCacheDir ───────────────────────────────────────────────────────────

describe('ensureCacheDir', () => {
  let projectDir;
  beforeEach(() => { projectDir = makeTempDir('wksp-deps-ensure'); });
  afterEach(()  => cleanup(projectDir));

  test('creates <cacheDir>/<dep>/ for each dep', () => {
    ensureCacheDir(projectDir, 'backend', ['node_modules', '.venv']);
    const cacheDir = getCacheDir(projectDir, 'backend');
    expect(fs.existsSync(path.join(cacheDir, 'node_modules'))).toBe(true);
    expect(fs.existsSync(path.join(cacheDir, '.venv'))).toBe(true);
  });

  test('is a no-op when dirs already exist', () => {
    ensureCacheDir(projectDir, 'backend', ['node_modules']);
    // Write a sentinel file into the cache dir
    const cacheDir = getCacheDir(projectDir, 'backend');
    fs.writeFileSync(path.join(cacheDir, 'node_modules', 'sentinel.txt'), 'x');
    // Calling again must not throw and must not clear the dir
    expect(() => ensureCacheDir(projectDir, 'backend', ['node_modules'])).not.toThrow();
    expect(fs.existsSync(path.join(cacheDir, 'node_modules', 'sentinel.txt'))).toBe(true);
  });

  test('handles empty deps list', () => {
    expect(() => ensureCacheDir(projectDir, 'backend', [])).not.toThrow();
  });
});

// ─── createDepLinks ───────────────────────────────────────────────────────────

describe('createDepLinks', () => {
  let projectDir, worktreeDir;
  beforeEach(() => {
    projectDir  = makeTempDir('wksp-deps-create-proj');
    worktreeDir = makeTempDir('wksp-deps-create-wt');
  });
  afterEach(() => cleanup(projectDir, worktreeDir));

  test('creates a symlink/junction pointing to the cache dir', () => {
    ensureCacheDir(projectDir, 'backend', ['node_modules']);
    const cacheDir = getCacheDir(projectDir, 'backend');

    createDepLinks(worktreeDir, cacheDir, ['node_modules']);

    const linkPath = path.join(worktreeDir, 'node_modules');
    const stat = fs.lstatSync(linkPath);
    expect(stat.isSymbolicLink()).toBe(true);
  });

  test('link target resolves to the cache dep directory', () => {
    ensureCacheDir(projectDir, 'backend', ['node_modules']);
    const cacheDir = getCacheDir(projectDir, 'backend');

    createDepLinks(worktreeDir, cacheDir, ['node_modules']);

    const linkPath   = path.join(worktreeDir, 'node_modules');
    const targetPath = path.join(cacheDir, 'node_modules');
    // fs.realpathSync follows junctions and symlinks
    expect(fs.realpathSync(linkPath)).toBe(fs.realpathSync(targetPath));
  });

  test('is idempotent — skips if link already exists', () => {
    ensureCacheDir(projectDir, 'backend', ['node_modules']);
    const cacheDir = getCacheDir(projectDir, 'backend');

    createDepLinks(worktreeDir, cacheDir, ['node_modules']);
    // Second call must not throw
    expect(() => createDepLinks(worktreeDir, cacheDir, ['node_modules'])).not.toThrow();

    // Still a symlink
    expect(fs.lstatSync(path.join(worktreeDir, 'node_modules')).isSymbolicLink()).toBe(true);
  });

  test('skips dep when a real directory already exists at link path', () => {
    ensureCacheDir(projectDir, 'backend', ['node_modules']);
    const cacheDir = getCacheDir(projectDir, 'backend');

    // Simulate user's own install already in place
    const existingDir = path.join(worktreeDir, 'node_modules');
    fs.mkdirSync(existingDir, { recursive: true });

    createDepLinks(worktreeDir, cacheDir, ['node_modules']);

    // Must remain a real directory, not a symlink
    const stat = fs.lstatSync(existingDir);
    expect(stat.isDirectory()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);
  });

  test('links multiple deps in one call', () => {
    ensureCacheDir(projectDir, 'backend', ['node_modules', '.venv']);
    const cacheDir = getCacheDir(projectDir, 'backend');

    createDepLinks(worktreeDir, cacheDir, ['node_modules', '.venv']);

    expect(fs.lstatSync(path.join(worktreeDir, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(worktreeDir, '.venv')).isSymbolicLink()).toBe(true);
  });
});

// ─── removeDepLinks ───────────────────────────────────────────────────────────

describe('removeDepLinks', () => {
  let projectDir, worktreeDir;
  beforeEach(() => {
    projectDir  = makeTempDir('wksp-deps-remove-proj');
    worktreeDir = makeTempDir('wksp-deps-remove-wt');
  });
  afterEach(() => cleanup(projectDir, worktreeDir));

  test('removes a symlink/junction that was created by createDepLinks', () => {
    ensureCacheDir(projectDir, 'backend', ['node_modules']);
    const cacheDir = getCacheDir(projectDir, 'backend');
    createDepLinks(worktreeDir, cacheDir, ['node_modules']);

    removeDepLinks(worktreeDir, ['node_modules']);

    expect(fs.existsSync(path.join(worktreeDir, 'node_modules'))).toBe(false);
  });

  test('leaves a real (non-symlink) directory untouched', () => {
    const realDir = path.join(worktreeDir, 'node_modules');
    fs.mkdirSync(realDir, { recursive: true });
    fs.writeFileSync(path.join(realDir, 'package.json'), '{}');

    removeDepLinks(worktreeDir, ['node_modules']);

    // Real dir must still exist
    expect(fs.existsSync(realDir)).toBe(true);
    expect(fs.existsSync(path.join(realDir, 'package.json'))).toBe(true);
  });

  test('is a no-op when dep does not exist', () => {
    expect(() => removeDepLinks(worktreeDir, ['node_modules'])).not.toThrow();
  });

  test('removes only symlinks when called with mixed list', () => {
    ensureCacheDir(projectDir, 'backend', ['node_modules']);
    const cacheDir = getCacheDir(projectDir, 'backend');
    createDepLinks(worktreeDir, cacheDir, ['node_modules']);

    const realVenv = path.join(worktreeDir, '.venv');
    fs.mkdirSync(realVenv, { recursive: true });

    removeDepLinks(worktreeDir, ['node_modules', '.venv']);

    expect(fs.existsSync(path.join(worktreeDir, 'node_modules'))).toBe(false);
    expect(fs.existsSync(realVenv)).toBe(true); // real dir preserved
  });
});

// ─── isDepLinked ─────────────────────────────────────────────────────────────

describe('isDepLinked', () => {
  let projectDir, worktreeDir;
  beforeEach(() => {
    projectDir  = makeTempDir('wksp-deps-islinked-proj');
    worktreeDir = makeTempDir('wksp-deps-islinked-wt');
  });
  afterEach(() => cleanup(projectDir, worktreeDir));

  test('returns true when dep is a symlink/junction', () => {
    ensureCacheDir(projectDir, 'backend', ['node_modules']);
    const cacheDir = getCacheDir(projectDir, 'backend');
    createDepLinks(worktreeDir, cacheDir, ['node_modules']);

    expect(isDepLinked(worktreeDir, 'node_modules')).toBe(true);
  });

  test('returns false when dep is a real directory', () => {
    fs.mkdirSync(path.join(worktreeDir, 'node_modules'), { recursive: true });
    expect(isDepLinked(worktreeDir, 'node_modules')).toBe(false);
  });

  test('returns false when dep does not exist', () => {
    expect(isDepLinked(worktreeDir, 'node_modules')).toBe(false);
  });
});

// ─── hasRealDepDir ────────────────────────────────────────────────────────────

describe('hasRealDepDir', () => {
  let projectDir, worktreeDir;
  beforeEach(() => {
    projectDir  = makeTempDir('wksp-deps-realdir-proj');
    worktreeDir = makeTempDir('wksp-deps-realdir-wt');
  });
  afterEach(() => cleanup(projectDir, worktreeDir));

  test('returns true when dep is a real (non-symlink) directory', () => {
    fs.mkdirSync(path.join(worktreeDir, 'node_modules'), { recursive: true });
    expect(hasRealDepDir(worktreeDir, 'node_modules')).toBe(true);
  });

  test('returns false when dep is a symlink/junction', () => {
    ensureCacheDir(projectDir, 'backend', ['node_modules']);
    const cacheDir = getCacheDir(projectDir, 'backend');
    createDepLinks(worktreeDir, cacheDir, ['node_modules']);

    expect(hasRealDepDir(worktreeDir, 'node_modules')).toBe(false);
  });

  test('returns false when dep does not exist', () => {
    expect(hasRealDepDir(worktreeDir, 'node_modules')).toBe(false);
  });
});
