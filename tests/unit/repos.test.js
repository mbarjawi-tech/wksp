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
    expect(repos[0].alias).toBeNull();
    expect(repos[0].folderName).toBe('api');
  });

  test('parses --shared flag', () => {
    const p = repoPath('docs');
    addRepo(projectDir, p, true);
    const repos = readRepos(projectDir);
    expect(repos[0].shared).toBe(true);
    expect(repos[0].alias).toBeNull();
  });

  test('parses --as alias', () => {
    const p = repoPath('malachite');
    addRepo(projectDir, p, false, 'malachite-b');
    const repos = readRepos(projectDir);
    expect(repos[0].alias).toBe('malachite-b');
    expect(repos[0].folderName).toBe('malachite-b');
  });

  test('parses --shared combined with --as', () => {
    const p = repoPath('docs');
    addRepo(projectDir, p, true, 'ref-docs');
    const repos = readRepos(projectDir);
    expect(repos[0].shared).toBe(true);
    expect(repos[0].alias).toBe('ref-docs');
    expect(repos[0].folderName).toBe('ref-docs');
  });

  test('folderName defaults to basename when no alias', () => {
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

  test('throws on duplicate path without alias', () => {
    const p = repoPath('api');
    addRepo(projectDir, p, false);
    expect(() => addRepo(projectDir, p, false)).toThrow('already registered');
  });

  test('allows duplicate path when alias is provided', () => {
    const p = repoPath('malachite');
    addRepo(projectDir, p, false);
    addRepo(projectDir, p, false, 'malachite-b');
    const repos = readRepos(projectDir);
    expect(repos).toHaveLength(2);
    expect(repos[0].folderName).toBe('malachite');
    expect(repos[1].folderName).toBe('malachite-b');
  });

  test('throws when alias collides with existing folderName', () => {
    const p = repoPath('malachite');
    addRepo(projectDir, p, false);
    expect(() => addRepo(projectDir, p, false, 'malachite')).toThrow('already in use');
  });

  test('throws when alias collides with another alias', () => {
    const p  = repoPath('malachite');
    const p2 = repoPath('other-repo');
    addRepo(projectDir, p,  false, 'shared-name');
    expect(() => addRepo(projectDir, p2, false, 'shared-name')).toThrow('already in use');
  });

  test('throws on invalid alias characters', () => {
    const p = repoPath('malachite');
    expect(() => addRepo(projectDir, p, false, 'bad alias!')).toThrow('Invalid alias');
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

  test('throws on ambiguous remove when multiple entries share a path', () => {
    const p = repoPath('malachite');
    addRepo(projectDir, p, false);
    addRepo(projectDir, p, false, 'malachite-b');
    expect(() => removeRepo(projectDir, p)).toThrow('disambiguate');
  });

  test('removes the aliased entry when alias is specified', () => {
    const p = repoPath('malachite');
    addRepo(projectDir, p, false);
    addRepo(projectDir, p, false, 'malachite-b');
    removeRepo(projectDir, p, 'malachite-b');
    const repos = readRepos(projectDir);
    expect(repos).toHaveLength(1);
    expect(repos[0].alias).toBeNull();
    expect(repos[0].folderName).toBe('malachite');
  });

  test('throws when specified alias does not exist', () => {
    const p = repoPath('malachite');
    addRepo(projectDir, p, false);
    addRepo(projectDir, p, false, 'malachite-b');
    expect(() => removeRepo(projectDir, p, 'no-such-alias')).toThrow('alias');
  });
});
