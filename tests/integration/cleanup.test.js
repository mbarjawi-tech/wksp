'use strict';
const fs   = require('fs');
const path = require('path');
const { makeTempDir, makeGitRepo, makeProject, cleanup } = require('../helpers');

jest.mock('../../lib/config', () => {
  const actual = jest.requireActual('../../lib/config');
  return { ...actual, findProjectDir: jest.fn() };
});

const config     = require('../../lib/config');
const cleanupCmd = require('../../lib/commands/cleanup');

let logLines, warnLines;
beforeEach(() => {
  logLines  = [];
  warnLines = [];
  jest.spyOn(console, 'log').mockImplementation((...a)  => logLines.push(a.join(' ')));
  jest.spyOn(console, 'warn').mockImplementation((...a) => warnLines.push(a.join(' ')));
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(process, 'exit').mockImplementation(code => {
    throw new Error(`process.exit(${code})`);
  });
});
afterEach(() => jest.restoreAllMocks());

async function runCleanup(projectDir, ...args) {
  config.findProjectDir.mockReturnValue(projectDir);
  await cleanupCmd.run(args);
}

// ─── zero-arg: scan project repos ────────────────────────────────────────────

describe('wksp cleanup (no args) — scans all project repos', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('cleanup-zeroarg');
    repoDir    = makeTempDir('cleanup-repo');
    makeGitRepo(repoDir);
    // Register the repo
    fs.appendFileSync(path.join(projectDir, 'repos.txt'), repoDir.replace(/\\/g, '/') + '\n');
  });
  afterEach(() => cleanup(projectDir, repoDir));

  test('prunes the registered repo', async () => {
    await runCleanup(projectDir);
    expect(logLines.some(l => l.includes('Pruning'))).toBe(true);
  });

  test('exits 1 when not inside a project', async () => {
    config.findProjectDir.mockReturnValue(null);
    await expect(cleanupCmd.run([])).rejects.toThrow('process.exit(1)');
  });

  test('reports message when no repos are registered', async () => {
    const emptyProject = makeProject('cleanup-empty');
    try {
      await runCleanup(emptyProject);
      expect(logLines.some(l => l.includes('No repos'))).toBe(true);
    } finally {
      cleanup(emptyProject);
    }
  });

  test('warns when a registered repo is not found on disk', async () => {
    fs.appendFileSync(path.join(projectDir, 'repos.txt'), '/nonexistent/path/repo\n');
    await runCleanup(projectDir);
    expect(logLines.some(l => l.includes('not found on disk'))).toBe(true);
  });
});

// ─── explicit path ────────────────────────────────────────────────────────────

describe('wksp cleanup <path>', () => {
  let repoDir;
  beforeEach(() => {
    repoDir = makeTempDir('cleanup-explicit');
    makeGitRepo(repoDir);
  });
  afterEach(() => cleanup(repoDir));

  test('prunes a specific git repo', async () => {
    await cleanupCmd.run([repoDir]);
    expect(logLines.some(l => l.includes('Pruning') || l.includes('Pruned'))).toBe(true);
  });

  test('warns when path is not a git repo', async () => {
    const notGit = makeTempDir('cleanup-notgit');
    try {
      await cleanupCmd.run([notGit]);
      expect(logLines.some(l => l.includes('Not a git repo'))).toBe(true);
    } finally {
      cleanup(notGit);
    }
  });

  test('exits 1 when path does not exist', async () => {
    await expect(cleanupCmd.run(['/no/such/path'])).rejects.toThrow('process.exit(1)');
  });
});

// ─── --recursive ─────────────────────────────────────────────────────────────

describe('wksp cleanup <path> --recursive', () => {
  let parentDir, repo1, repo2;
  beforeEach(() => {
    parentDir = makeTempDir('cleanup-recursive');
    repo1 = path.join(parentDir, 'repo1');
    repo2 = path.join(parentDir, 'repo2');
    fs.mkdirSync(repo1);
    fs.mkdirSync(repo2);
    makeGitRepo(repo1);
    makeGitRepo(repo2);
  });
  afterEach(() => cleanup(parentDir));

  test('prunes all subdirectory git repos', async () => {
    await cleanupCmd.run([parentDir, '--recursive']);
    const pruningLogs = logLines.filter(l => l.includes('Pruning'));
    expect(pruningLogs.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── deprecated aliases ───────────────────────────────────────────────────────

describe('wksp cleanup — deprecated alias handling', () => {
  let repoDir;
  beforeEach(() => {
    repoDir = makeTempDir('cleanup-depr');
    makeGitRepo(repoDir);
  });
  afterEach(() => cleanup(repoDir));

  test('--stale <path> still works and prints deprecation warning', async () => {
    await cleanupCmd.run(['--stale', repoDir]);
    expect(warnLines.some(l => l.includes('Deprecated') && l.includes('--stale'))).toBe(true);
    expect(logLines.some(l => l.includes('Pruning') || l.includes('Pruned'))).toBe(true);
  });

  test('-r is rewritten to --recursive with a deprecation warning', async () => {
    const parentDir = makeTempDir('cleanup-r-flag');
    const sub = path.join(parentDir, 'subrepo');
    fs.mkdirSync(sub);
    makeGitRepo(sub);
    try {
      await cleanupCmd.run([parentDir, '-r']);
      expect(warnLines.some(l => l.includes('Deprecated') && l.includes('-r'))).toBe(true);
      expect(logLines.some(l => l.includes('Pruning'))).toBe(true);
    } finally {
      cleanup(parentDir);
    }
  });
});
