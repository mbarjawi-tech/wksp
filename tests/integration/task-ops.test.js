'use strict';
const fs   = require('fs');
const path = require('path');
const { makeTempDir, makeGitRepo, makeProject, cleanup } = require('../helpers');
const { addRepo } = require('../../lib/repos');
const git = require('../../lib/git');
const { WORKTREES_DIR } = require('../../lib/worktrees');

jest.mock('../../lib/prompts', () => ({
  open: jest.fn(), close: jest.fn(), ask: jest.fn(), confirm: jest.fn(),
}));

jest.mock('../../lib/claude', () => ({
  launch:          jest.fn(),
  findLastSession: jest.fn().mockReturnValue(null),
}));

jest.mock('../../lib/config', () => {
  const actual = jest.requireActual('../../lib/config');
  return {
    ...actual,
    findProjectDir:    jest.fn(),
    readProjectConfig: jest.fn().mockReturnValue({ name: 'test-project' }),
    readGlobalConfig:  jest.fn().mockReturnValue({ autoResume: false }),
    readConfig:        jest.fn().mockReturnValue({ autoResume: false }),
  };
});

const prompts = require('../../lib/prompts');
const config  = require('../../lib/config');
const taskCmd = require('../../lib/commands/task');

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

async function runTask(projectDir, ...args) {
  config.findProjectDir.mockReturnValue(projectDir);
  await taskCmd.run(args);
}

// ─── .code-workspace stdout ────────────────────────────────────────────────

describe('.code-workspace filename printed to stdout', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('ws-stdout');
    repoDir    = makeTempDir('repo-ws-stdout');
    makeGitRepo(repoDir);
    addRepo(projectDir, repoDir, false);
  });
  afterEach(() => cleanup(projectDir, repoDir));

  test('logs a line containing the .code-workspace filename on task creation', async () => {
    prompts.ask.mockResolvedValueOnce('feature/ws-test');
    await runTask(projectDir, 'TASK-WS');
    expect(logLines.some(l => l.includes('.code-workspace'))).toBe(true);
    expect(logLines.some(l => l.includes('TASK-WS'))).toBe(true);
  });
});

// ─── task rename ──────────────────────────────────────────────────────────

describe('wksp task --rename', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('rename-1');
    repoDir    = makeTempDir('repo-rename-1');
    makeGitRepo(repoDir);
    addRepo(projectDir, repoDir, false);
  });
  afterEach(() => cleanup(projectDir, repoDir));

  test('renames the task folder', async () => {
    prompts.ask.mockResolvedValueOnce('feature/rename-branch');
    await runTask(projectDir, 'OLD-TASK');

    await runTask(projectDir, 'OLD-TASK', '--rename', 'NEW-TASK');

    expect(fs.existsSync(path.join(projectDir, 'tasks', 'OLD-TASK'))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, 'tasks', 'NEW-TASK'))).toBe(true);
  });

  test('renames the .code-workspace file', async () => {
    prompts.ask.mockResolvedValueOnce('feature/rename-ws');
    await runTask(projectDir, 'OLD-WS');

    await runTask(projectDir, 'OLD-WS', '--rename', 'NEW-WS');

    const newTaskDir = path.join(projectDir, 'tasks', 'NEW-WS');
    expect(fs.existsSync(path.join(newTaskDir, 'test-project--NEW-WS.code-workspace'))).toBe(true);
    expect(fs.existsSync(path.join(newTaskDir, 'test-project--OLD-WS.code-workspace'))).toBe(false);
  });

  test('updates ## Task: header in CLAUDE.md', async () => {
    prompts.ask.mockResolvedValueOnce('feature/rename-md');
    await runTask(projectDir, 'OLD-MD');

    await runTask(projectDir, 'OLD-MD', '--rename', 'NEW-MD');

    const claudeMd = fs.readFileSync(
      path.join(projectDir, 'tasks', 'NEW-MD', 'CLAUDE.md'), 'utf8'
    );
    expect(claudeMd).toMatch(/## Task: NEW-MD/);
    expect(claudeMd).not.toMatch(/## Task: OLD-MD/);
  });

  test('exits 1 if the old task does not exist', async () => {
    await expect(runTask(projectDir, 'GHOST', '--rename', 'NEW')).rejects.toThrow('process.exit(1)');
  });

  test('exits 1 if the new name is already taken', async () => {
    prompts.ask.mockResolvedValueOnce('feature/a');
    await runTask(projectDir, 'TASK-A');
    prompts.ask.mockResolvedValueOnce('feature/b');
    await runTask(projectDir, 'TASK-B');

    await expect(runTask(projectDir, 'TASK-A', '--rename', 'TASK-B')).rejects.toThrow('process.exit(1)');
  });
});

// ─── task --to-shared (share) ──────────────────────────────────────────────

describe('wksp task --to-shared', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('shared-1');
    repoDir    = makeTempDir('repo-shared-1');
    makeGitRepo(repoDir);
    addRepo(projectDir, repoDir, false);
  });
  afterEach(() => cleanup(projectDir, repoDir));

  test('removes the worktree and writes task-shared.txt', async () => {
    prompts.ask.mockResolvedValueOnce('feature/to-share');
    await runTask(projectDir, 'TASK-SH');

    const wtPath = path.join(projectDir, 'tasks', 'TASK-SH', WORKTREES_DIR, path.basename(repoDir));
    expect(fs.existsSync(wtPath)).toBe(true);

    prompts.confirm.mockResolvedValueOnce(false); // no uncommitted changes prompt
    await runTask(projectDir, 'TASK-SH', '--to-shared', path.basename(repoDir));

    expect(fs.existsSync(wtPath)).toBe(false);
    const sharedFile = path.join(projectDir, 'tasks', 'TASK-SH', 'task-shared.txt');
    expect(fs.existsSync(sharedFile)).toBe(true);
    expect(fs.readFileSync(sharedFile, 'utf8')).toContain(path.basename(repoDir));
  });

  test('exits 1 when no repo arg given', async () => {
    prompts.ask.mockResolvedValueOnce('feature/sh-noarg');
    await runTask(projectDir, 'TASK-NOARG');
    await expect(runTask(projectDir, 'TASK-NOARG', '--to-shared')).rejects.toThrow('process.exit(1)');
  });
});

// ─── task --to-exclude ────────────────────────────────────────────────────

describe('wksp task --to-exclude', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('excl-cmd-1');
    repoDir    = makeTempDir('repo-excl-cmd-1');
    makeGitRepo(repoDir);
    addRepo(projectDir, repoDir, false);
  });
  afterEach(() => cleanup(projectDir, repoDir));

  test('removes the worktree and writes task-excluded.txt', async () => {
    prompts.ask.mockResolvedValueOnce('feature/to-excl');
    await runTask(projectDir, 'TASK-EX2');

    const wtPath = path.join(projectDir, 'tasks', 'TASK-EX2', WORKTREES_DIR, path.basename(repoDir));
    expect(fs.existsSync(wtPath)).toBe(true);

    await runTask(projectDir, 'TASK-EX2', '--to-exclude', path.basename(repoDir));

    expect(fs.existsSync(wtPath)).toBe(false);
    const excludedFile = path.join(projectDir, 'tasks', 'TASK-EX2', 'task-excluded.txt');
    expect(fs.existsSync(excludedFile)).toBe(true);
    expect(fs.readFileSync(excludedFile, 'utf8')).toContain(path.basename(repoDir));
  });

  test('is idempotent — no error if already excluded', async () => {
    prompts.ask.mockResolvedValueOnce('x');
    await runTask(projectDir, 'TASK-IDEM');

    // Second --to-exclude on already-excluded repo should not throw
    await expect(
      runTask(projectDir, 'TASK-IDEM', '--to-exclude', path.basename(repoDir))
    ).resolves.not.toThrow();
  });

  test('exits 1 when no repo arg given', async () => {
    prompts.ask.mockResolvedValueOnce('feature/ex-noarg');
    await runTask(projectDir, 'TASK-EXNOARG');
    await expect(runTask(projectDir, 'TASK-EXNOARG', '--to-exclude')).rejects.toThrow('process.exit(1)');
  });
});
