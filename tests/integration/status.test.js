'use strict';
const fs   = require('fs');
const path = require('path');
const { makeTempDir, makeGitRepo, makeProject, cleanup } = require('../helpers');
const { addRepo } = require('../../lib/repos');
const { WORKTREES_DIR } = require('../../lib/worktrees');
const git = require('../../lib/git');

jest.mock('../../lib/config', () => {
  const actual = jest.requireActual('../../lib/config');
  return {
    ...actual,
    findProjectDir:    jest.fn(),
    readProjectConfig: jest.fn().mockReturnValue({ name: 'test-project' }),
    readGlobalConfig:  jest.fn().mockReturnValue({}),
  };
});

const config    = require('../../lib/config');
const statusCmd = require('../../lib/commands/status');

let logLines;
beforeEach(() => {
  logLines = [];
  jest.spyOn(console, 'log').mockImplementation((...args) => logLines.push(args.join(' ')));
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(process, 'exit').mockImplementation(code => {
    throw new Error(`process.exit(${code})`);
  });
});
afterEach(() => jest.restoreAllMocks());

async function runStatus(projectDir, ...args) {
  config.findProjectDir.mockReturnValue(projectDir);
  await statusCmd.run(args);
}

describe('wksp status — no tasks', () => {
  let projectDir;
  beforeEach(() => { projectDir = makeProject('status-empty'); });
  afterEach(()  => cleanup(projectDir));

  test('prints "No tasks yet" when tasks dir does not exist', async () => {
    fs.rmdirSync(path.join(projectDir, 'tasks'));
    await runStatus(projectDir);
    expect(logLines.join('\n')).toMatch(/No tasks yet/);
  });

  test('prints "No tasks yet" when tasks dir is empty', async () => {
    await runStatus(projectDir);
    expect(logLines.join('\n')).toMatch(/No tasks yet/);
  });
});

describe('wksp status — no task-id, no cwd context', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('status-list');
    repoDir    = makeTempDir('repo-status');
    makeGitRepo(repoDir);
    addRepo(projectDir, repoDir, false);
    fs.mkdirSync(path.join(projectDir, 'tasks', 'TASK-A'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'tasks', 'TASK-B'), { recursive: true });
  });
  afterEach(() => cleanup(projectDir, repoDir));

  test('lists available tasks when not inside one', async () => {
    await runStatus(projectDir);
    const out = logLines.join('\n');
    expect(out).toMatch(/TASK-A/);
    expect(out).toMatch(/TASK-B/);
  });
});

describe('wksp status <task-id> — explicit argument', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('status-explicit');
    repoDir    = makeTempDir('repo-status-expl');
    makeGitRepo(repoDir);
    addRepo(projectDir, repoDir, false);
  });
  afterEach(() => cleanup(projectDir, repoDir));

  test('shows status for a task with a worktree', async () => {
    // Create task + worktree manually
    const taskDir    = path.join(projectDir, 'tasks', 'TASK-X');
    const worktreeDir = path.join(taskDir, WORKTREES_DIR, path.basename(repoDir));
    git.addWorktree(repoDir, worktreeDir, 'feature/status-test', null);

    await runStatus(projectDir, 'TASK-X');

    const out = logLines.join('\n');
    expect(out).toMatch(/TASK-X/);
    expect(out).toMatch(/feature\/status-test/);
  });

  test('exits 1 when the given task does not exist', async () => {
    await expect(runStatus(projectDir, 'TASK-MISSING')).rejects.toThrow('process.exit(1)');
  });
});
