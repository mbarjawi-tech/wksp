'use strict';
const fs   = require('fs');
const path = require('path');
const { makeTempDir, makeGitRepo, makeProject, cleanup } = require('../helpers');

jest.mock('../../lib/prompts', () => ({
  open: jest.fn(), close: jest.fn(), ask: jest.fn(), confirm: jest.fn(),
}));

jest.mock('../../lib/providers/claude', () => ({
  name: 'claude', instructionFile: 'CLAUDE.md',
  launch: jest.fn(), sessions: { findLast: jest.fn().mockReturnValue(null) },
}));

jest.mock('../../lib/config', () => {
  const actual = jest.requireActual('../../lib/config');
  return {
    ...actual,
    findProjectDir:    jest.fn(),
    readProjectConfig: jest.fn().mockReturnValue({ name: 'test-project' }),
    readConfig:        jest.fn().mockReturnValue({ autoResume: false }),
  };
});

const prompts  = require('../../lib/prompts');
const config   = require('../../lib/config');
const repoCmd  = require('../../lib/commands/repo');

let logLines;
beforeEach(() => {
  logLines = [];
  jest.spyOn(console, 'log').mockImplementation((...args)  => logLines.push(args.join(' ')));
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(process, 'exit').mockImplementation(code => {
    throw new Error(`process.exit(${code})`);
  });
  prompts.ask.mockReset();
  prompts.confirm.mockReset();
  prompts.open.mockReset();
  prompts.close.mockReset();
});
afterEach(() => jest.restoreAllMocks());

async function runRepo(projectDir, ...args) {
  config.findProjectDir.mockReturnValue(projectDir);
  await repoCmd.run(args);
}

// ─── wksp repo add ───────────────────────────────────────────────────────────

describe('wksp repo add', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('repo-add-1');
    repoDir    = makeTempDir('repo-add-src');
    makeGitRepo(repoDir);
  });
  afterEach(() => cleanup(projectDir, repoDir));

  test('adds a local path to repos.txt', async () => {
    await runRepo(projectDir, 'add', repoDir);
    const reposTxt = fs.readFileSync(path.join(projectDir, 'repos.txt'), 'utf8');
    expect(reposTxt).toContain(path.basename(repoDir));
    expect(logLines.some(l => l.includes('Added to repos.txt'))).toBe(true);
  });

  test('adds with --shared flag', async () => {
    await runRepo(projectDir, 'add', repoDir, '--shared');
    const reposTxt = fs.readFileSync(path.join(projectDir, 'repos.txt'), 'utf8');
    expect(reposTxt).toMatch(/--shared/);
    expect(logLines.some(l => l.includes('--shared'))).toBe(true);
  });

  test('exits 1 when no path given', async () => {
    await expect(runRepo(projectDir, 'add')).rejects.toThrow('process.exit(1)');
  });

  test('throws when adding a duplicate repo', async () => {
    await runRepo(projectDir, 'add', repoDir);
    await expect(runRepo(projectDir, 'add', repoDir)).rejects.toThrow('already registered');
  });
});

// ─── wksp repo remove ────────────────────────────────────────────────────────

describe('wksp repo remove', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('repo-remove-1');
    repoDir    = makeTempDir('repo-remove-src');
    makeGitRepo(repoDir);
  });
  afterEach(() => cleanup(projectDir, repoDir));

  test('removes a repo from repos.txt', async () => {
    await runRepo(projectDir, 'add', repoDir);
    await runRepo(projectDir, 'remove', repoDir);
    const reposTxt = fs.readFileSync(path.join(projectDir, 'repos.txt'), 'utf8');
    expect(reposTxt).not.toContain(repoDir.replace(/\\/g, '/'));
    expect(logLines.some(l => l.includes('Removed from repos.txt'))).toBe(true);
  });

  test('exits 1 when no path given', async () => {
    await expect(runRepo(projectDir, 'remove')).rejects.toThrow('process.exit(1)');
  });
});

// ─── wksp repo list ──────────────────────────────────────────────────────────

describe('wksp repo list', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('repo-list-1');
    repoDir    = makeTempDir('repo-list-src');
    makeGitRepo(repoDir);
  });
  afterEach(() => cleanup(projectDir, repoDir));

  test('lists registered repos', async () => {
    await runRepo(projectDir, 'add', repoDir);
    logLines = [];
    await runRepo(projectDir, 'list');
    const out = logLines.join('\n');
    expect(out).toContain(path.basename(repoDir));
  });

  test('shows --shared flag for shared repos', async () => {
    await runRepo(projectDir, 'add', repoDir, '--shared');
    logLines = [];
    await runRepo(projectDir, 'list');
    const out = logLines.join('\n');
    expect(out).toContain('--shared');
  });

  test('prints helpful message when no repos are registered', async () => {
    await runRepo(projectDir, 'list');
    const out = logLines.join('\n');
    expect(out).toContain('No repos registered');
  });
});

