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
    expect(repos[0].raw).toBe(p);
    expect(repos[0].shared).toBe(false);
  });

  test('parses --shared flag', () => {
    const p = repoPath('docs');
    addRepo(projectDir, p, true);
    const repos = readRepos(projectDir);
    expect(repos[0].shared).toBe(true);
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

  test('throws on duplicate (same normalized path)', () => {
    const p = repoPath('api');
    addRepo(projectDir, p, false);
    expect(() => addRepo(projectDir, p, false)).toThrow();
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
