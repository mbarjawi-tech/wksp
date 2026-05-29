'use strict';
const fs   = require('fs');
const path = require('path');
const { makeTempDir, makeGitRepo, makeProject, cleanup } = require('../helpers');
const { addRepo } = require('../../lib/repos');
const git = require('../../lib/git');
const { WORKTREES_DIR } = require('../../lib/worktrees');

jest.mock('../../lib/prompts', () => ({
  open:    jest.fn(),
  close:   jest.fn(),
  ask:     jest.fn(),
  confirm: jest.fn(),
}));

jest.mock('../../lib/claude', () => ({
  launch:           jest.fn(),
  findLastSession:  jest.fn().mockReturnValue(null),
}));

jest.mock('../../lib/config', () => {
  const actual = jest.requireActual('../../lib/config');
  return {
    ...actual,
    findProjectDir:    jest.fn(),
    readProjectConfig: jest.fn().mockReturnValue({ name: 'test-project' }),
    readGlobalConfig:  jest.fn().mockReturnValue({ autoResume: false }),
  };
});

jest.spyOn(process, 'exit').mockImplementation(code => { throw new Error(`process.exit(${code})`); });

const prompts = require('../../lib/prompts');
const claude  = require('../../lib/claude');
const config  = require('../../lib/config');
const taskCmd = require('../../lib/commands/task');

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  prompts.ask.mockReset();
  prompts.confirm.mockReset();
  prompts.open.mockReset();
  prompts.close.mockReset();
  claude.launch.mockReset();
});
afterEach(() => jest.restoreAllMocks());

async function runTask(projectDir, ...args) {
  config.findProjectDir.mockReturnValue(projectDir);
  await taskCmd.run(args);
}

describe('exclude at new-repo prompt', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('exclude-1');
    repoDir    = makeTempDir('repo-exclude-1');
    makeGitRepo(repoDir);
    addRepo(projectDir, repoDir, false);
  });
  afterEach(() => cleanup(projectDir, repoDir));

  test('typing "x" excludes the repo and writes task.json', async () => {
    prompts.ask.mockResolvedValueOnce('x');

    await runTask(projectDir, 'TASK-EX');

    const jsonFile = path.join(projectDir, 'tasks', 'TASK-EX', 'task.json');
    expect(fs.existsSync(jsonFile)).toBe(true);
    const data = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
    expect((data.excluded || [])).toContain(path.basename(repoDir));
  });

  test('excluded repo gets no worktree', async () => {
    prompts.ask.mockResolvedValueOnce('x');

    await runTask(projectDir, 'TASK-NW');

    const wtPath = path.join(projectDir, 'tasks', 'TASK-NW', WORKTREES_DIR, path.basename(repoDir));
    expect(fs.existsSync(wtPath)).toBe(false);
  });

  test('excluded repo is omitted from launch dirs and workspace file', async () => {
    prompts.ask.mockResolvedValueOnce('x');

    await runTask(projectDir, 'TASK-LAUNCH');

    expect(claude.launch).toHaveBeenCalledTimes(1);
    const dirs = claude.launch.mock.calls[0][0];
    expect(dirs).not.toContain(repoDir);

    const wsFile = path.join(projectDir, 'tasks', 'TASK-LAUNCH', 'test-project--TASK-LAUNCH.code-workspace');
    const ws     = JSON.parse(fs.readFileSync(wsFile, 'utf8'));
    expect(ws.folders.find(f => f.path.includes(path.basename(repoDir)))).toBeUndefined();
  });
});

describe('exclude persists across resume', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('exclude-2');
    repoDir    = makeTempDir('repo-exclude-2');
    makeGitRepo(repoDir);
    addRepo(projectDir, repoDir, false);
  });
  afterEach(() => cleanup(projectDir, repoDir));

  test('resuming an excluded task does not re-prompt for the repo', async () => {
    prompts.ask.mockResolvedValueOnce('x');
    await runTask(projectDir, 'TASK-RESUME');

    prompts.ask.mockReset();
    await runTask(projectDir, 'TASK-RESUME');

    expect(prompts.ask).not.toHaveBeenCalled();
  });
});

describe('--to-worktree on an excluded repo', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('exclude-3');
    repoDir    = makeTempDir('repo-exclude-3');
    makeGitRepo(repoDir);
    addRepo(projectDir, repoDir, false);
  });
  afterEach(() => cleanup(projectDir, repoDir));

  test('clears the exclusion and creates a worktree on the chosen branch', async () => {
    prompts.ask.mockResolvedValueOnce('x');
    await runTask(projectDir, 'TASK-FLIP');

    const jsonFile = path.join(projectDir, 'tasks', 'TASK-FLIP', 'task.json');
    expect(fs.existsSync(jsonFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(jsonFile, 'utf8')).excluded).toContain(path.basename(repoDir));

    prompts.ask.mockReset();
    prompts.ask.mockResolvedValueOnce('feature/flipped');
    await runTask(projectDir, 'TASK-FLIP', '--to-worktree', path.basename(repoDir));

    // After clearing exclusion (both sets empty), task.json is deleted
    expect(fs.existsSync(jsonFile)).toBe(false);
    const wtPath = path.join(projectDir, 'tasks', 'TASK-FLIP', WORKTREES_DIR, path.basename(repoDir));
    expect(fs.existsSync(wtPath)).toBe(true);
    expect(git.currentBranch(wtPath)).toBe('feature/flipped');
  });
});

describe('new repo added after task creation can be excluded', () => {
  let projectDir, repoA, repoB;
  beforeEach(() => {
    projectDir = makeProject('exclude-4');
    repoA = makeTempDir('repo-A');
    repoB = makeTempDir('repo-B');
    makeGitRepo(repoA);
    makeGitRepo(repoB);
    addRepo(projectDir, repoA, false);
  });
  afterEach(() => cleanup(projectDir, repoA, repoB));

  test('on next launch, the late-added repo can be excluded too', async () => {
    prompts.ask.mockResolvedValueOnce('feature/work');
    await runTask(projectDir, 'TASK-LATE');

    addRepo(projectDir, repoB, false);

    prompts.ask.mockReset();
    prompts.ask.mockResolvedValueOnce('x');
    await runTask(projectDir, 'TASK-LATE');

    const jsonFile = path.join(projectDir, 'tasks', 'TASK-LATE', 'task.json');
    expect(fs.existsSync(jsonFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(jsonFile, 'utf8')).excluded).toContain(path.basename(repoB));

    const wtB = path.join(projectDir, 'tasks', 'TASK-LATE', WORKTREES_DIR, path.basename(repoB));
    expect(fs.existsSync(wtB)).toBe(false);
  });
});
