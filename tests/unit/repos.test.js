'use strict';
const fs   = require('fs');
const path = require('path');
const { makeTempDir, cleanup } = require('../helpers');
const { readRepos, addRepo, removeRepo } = require('../../lib/repos');

let projectDir;
beforeEach(() => {
  projectDir = makeTempDir('wksp-repos');
  fs.writeFileSync(path.join(projectDir, 'repos.txt'), [
    '# Workspace repos',
    '# Format: <path> [--shared]',
    '',
  ].join('\n'));
});
afterEach(() => cleanup(projectDir));

// Use the current temp dir itself as a "repo path" so normalizePath resolves correctly.
function repoPath(name) {
  const p = path.join(projectDir, name);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

describe('readRepos', () => {
  test('returns [] for a file with only comments and blanks', () => {
    expect(readRepos(projectDir)).toEqual([]);
  });

  test('parses a plain path', () => {
    const p = repoPath('api');
    addRepo(projectDir, p, false);
    const repos = readRepos(projectDir);
    expect(repos).toHaveLength(1);
    expect(repos[0].raw).toBe(p.replace(/\\/g, '/'));
    expect(repos[0].shared).toBe(false);
    expect(repos[0].folderName).toBe('api');
  });

  test('parses --shared flag', () => {
    const p = repoPath('docs');
    addRepo(projectDir, p, true);
    const repos = readRepos(projectDir);
    expect(repos[0].shared).toBe(true);
    expect(repos[0].optional).toBe(false);
    expect(repos[0].folderName).toBe('docs');
  });

  test('parses --optional flag', () => {
    const p = repoPath('tools');
    addRepo(projectDir, p, { optional: true });
    const repos = readRepos(projectDir);
    expect(repos[0].optional).toBe(true);
    expect(repos[0].shared).toBe(false);
    expect(repos[0].folderName).toBe('tools');
  });

  test('parses --shared and --optional together, in either order', () => {
    const p = repoPath('both');
    fs.appendFileSync(path.join(projectDir, 'repos.txt'),
      `${p.replace(/\\/g, '/')}  --optional  --shared\n`);
    const repos = readRepos(projectDir);
    expect(repos[0].shared).toBe(true);
    expect(repos[0].optional).toBe(true);
    expect(repos[0].raw).toBe(p.replace(/\\/g, '/'));
  });

  test('folderName is always basename of path', () => {
    const p = repoPath('my-service');
    addRepo(projectDir, p, false);
    const repos = readRepos(projectDir);
    expect(repos[0].folderName).toBe('my-service');
  });

  test('skips comment lines', () => {
    fs.appendFileSync(path.join(projectDir, 'repos.txt'), '# this is a comment\n');
    expect(readRepos(projectDir)).toHaveLength(0);
  });

  test('normalizes path on read', () => {
    const p = repoPath('frontend');
    addRepo(projectDir, p, false);
    const repos = readRepos(projectDir);
    expect(repos[0].normalized).toBe(path.resolve(p));
  });
});

describe('addRepo', () => {
  test('adds a new repo', () => {
    const p = repoPath('api');
    addRepo(projectDir, p, false);
    expect(readRepos(projectDir)).toHaveLength(1);
  });

  test('adds multiple repos', () => {
    addRepo(projectDir, repoPath('api'),      false);
    addRepo(projectDir, repoPath('frontend'), false);
    addRepo(projectDir, repoPath('docs'),     true);
    expect(readRepos(projectDir)).toHaveLength(3);
  });

  test('throws on duplicate path', () => {
    const p = repoPath('api');
    addRepo(projectDir, p, false);
    expect(() => addRepo(projectDir, p, false)).toThrow('already registered');
  });

  test('writes --optional to the file and survives a round-trip', () => {
    addRepo(projectDir, repoPath('api'),   false);
    addRepo(projectDir, repoPath('tools'), { optional: true });
    const raw = fs.readFileSync(path.join(projectDir, 'repos.txt'), 'utf8');
    expect(raw).toMatch(/tools {2}--optional/);
    const repos = readRepos(projectDir);
    expect(repos.map(r => r.optional)).toEqual([false, true]);
  });

  test('rewriting the file documents --optional in the header comment', () => {
    addRepo(projectDir, repoPath('api'), false);
    const raw = fs.readFileSync(path.join(projectDir, 'repos.txt'), 'utf8');
    expect(raw).toContain('# Format: <path> [--shared] [--optional]');
  });
});

describe('removeRepo', () => {
  test('removes an existing repo', () => {
    const p = repoPath('api');
    addRepo(projectDir, p, false);
    removeRepo(projectDir, p);
    expect(readRepos(projectDir)).toHaveLength(0);
  });

  test('throws when repo is not registered', () => {
    expect(() => removeRepo(projectDir, repoPath('nope'))).toThrow();
  });

  test('does not affect other repos when removing one', () => {
    const a = repoPath('api');
    const b = repoPath('frontend');
    addRepo(projectDir, a, false);
    addRepo(projectDir, b, false);
    removeRepo(projectDir, a);
    const remaining = readRepos(projectDir);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].normalized).toBe(path.resolve(b));
  });
});
