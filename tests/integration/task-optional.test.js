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

jest.mock('../../lib/providers/claude', () => ({
  name: 'claude', instructionFile: 'CLAUDE.md',
  launch:   jest.fn(),
  sessions: { findLast: jest.fn().mockReturnValue(null) },
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
const claude  = require('../../lib/providers/claude');
const config  = require('../../lib/config');
const taskCmd = require('../../lib/commands/task');

let logLines;
beforeEach(() => {
  logLines = [];
  jest.spyOn(console, 'log').mockImplementation((...args) => logLines.push(args.join(' ')));
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

describe('create skips --optional repos silently', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('optional-1');
    repoDir    = makeTempDir('repo-optional-1');
    makeGitRepo(repoDir);
    addRepo(projectDir, repoDir, { optional: true });
  });
  afterEach(() => cleanup(projectDir, repoDir));

  test('no prompt; recorded as excluded in task.json; no worktree', async () => {
    await runTask(projectDir, 'create', 'TASK-OPT');

    expect(prompts.ask).not.toHaveBeenCalled();

    const jsonFile = path.join(projectDir, 'tasks', 'TASK-OPT', 'task.json');
    expect(fs.existsSync(jsonFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(jsonFile, 'utf8')).excluded).toContain(path.basename(repoDir));

    const wtPath = path.join(projectDir, 'tasks', 'TASK-OPT', WORKTREES_DIR, path.basename(repoDir));
    expect(fs.existsSync(wtPath)).toBe(false);
  });

  test('omitted from launch dirs and workspace file; summary shows (optional)', async () => {
    await runTask(projectDir, 'create', 'TASK-OPT-LAUNCH');

    expect(claude.launch).toHaveBeenCalledTimes(1);
    const dirs = claude.launch.mock.calls[0][0];
    expect(dirs).not.toContain(repoDir);

    const wsFile = path.join(projectDir, 'tasks', 'TASK-OPT-LAUNCH', 'test-project--TASK-OPT-LAUNCH.code-workspace');
    const ws     = JSON.parse(fs.readFileSync(wsFile, 'utf8'));
    expect(ws.folders.find(f => f.path.includes(path.basename(repoDir)))).toBeUndefined();

    expect(logLines.some(l => l.includes(path.basename(repoDir)) && l.includes('(optional)'))).toBe(true);
  });
});

describe('mixed registry — only non-optional repos are prompted for', () => {
  let projectDir, repoA, repoB;
  beforeEach(() => {
    projectDir = makeProject('optional-2');
    repoA = makeTempDir('repo-normal');
    repoB = makeTempDir('repo-opt');
    makeGitRepo(repoA);
    makeGitRepo(repoB);
    addRepo(projectDir, repoA, false);
    addRepo(projectDir, repoB, { optional: true });
  });
  afterEach(() => cleanup(projectDir, repoA, repoB));

  test('one branch prompt for the normal repo, none for the optional one', async () => {
    prompts.ask.mockResolvedValueOnce('feature/work');

    await runTask(projectDir, 'create', 'TASK-MIX');

    // Two asks for the normal repo (branch + base-off for the new branch);
    // never one that mentions the optional repo.
    expect(prompts.ask).toHaveBeenCalledTimes(2);
    expect(prompts.ask.mock.calls.some(c => String(c[0]).includes(path.basename(repoB)))).toBe(false);

    const wtA = path.join(projectDir, 'tasks', 'TASK-MIX', WORKTREES_DIR, path.basename(repoA));
    expect(fs.existsSync(wtA)).toBe(true);
    expect(git.currentBranch(wtA)).toBe('feature/work');

    const data = JSON.parse(fs.readFileSync(path.join(projectDir, 'tasks', 'TASK-MIX', 'task.json'), 'utf8'));
    expect(data.excluded).toEqual([path.basename(repoB)]);
  });
});

describe('resume — a repo made optional after task creation is excluded silently', () => {
  let projectDir, repoA, repoB;
  beforeEach(() => {
    projectDir = makeProject('optional-3');
    repoA = makeTempDir('repo-existing');
    repoB = makeTempDir('repo-late-opt');
    makeGitRepo(repoA);
    makeGitRepo(repoB);
    addRepo(projectDir, repoA, false);
  });
  afterEach(() => cleanup(projectDir, repoA, repoB));

  test('no "new repo" prompt on resume; recorded as excluded', async () => {
    prompts.ask.mockResolvedValueOnce('feature/work');
    await runTask(projectDir, 'create', 'TASK-LATE-OPT');

    addRepo(projectDir, repoB, { optional: true });

    prompts.ask.mockReset();
    await runTask(projectDir, 'resume', 'TASK-LATE-OPT');

    expect(prompts.ask).not.toHaveBeenCalled();
    const data = JSON.parse(fs.readFileSync(path.join(projectDir, 'tasks', 'TASK-LATE-OPT', 'task.json'), 'utf8'));
    expect(data.excluded).toContain(path.basename(repoB));
    expect(fs.existsSync(path.join(projectDir, 'tasks', 'TASK-LATE-OPT', WORKTREES_DIR, path.basename(repoB)))).toBe(false);
  });
});

describe('pulling an optional repo into a task', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('optional-4');
    repoDir    = makeTempDir('repo-pull-in');
    makeGitRepo(repoDir);
    addRepo(projectDir, repoDir, { optional: true });
  });
  afterEach(() => cleanup(projectDir, repoDir));

  test('task repo <id> <repo> worktree creates the worktree; resume keeps it', async () => {
    await runTask(projectDir, 'create', 'TASK-PULL');

    prompts.ask.mockResolvedValueOnce('feature/pulled');
    await runTask(projectDir, 'repo', 'TASK-PULL', path.basename(repoDir), 'worktree');

    const wtPath = path.join(projectDir, 'tasks', 'TASK-PULL', WORKTREES_DIR, path.basename(repoDir));
    expect(fs.existsSync(wtPath)).toBe(true);
    expect(git.currentBranch(wtPath)).toBe('feature/pulled');

    // Resume must not re-exclude a pulled-in optional repo, and must not prompt.
    prompts.ask.mockReset();
    await runTask(projectDir, 'resume', 'TASK-PULL');

    expect(prompts.ask).not.toHaveBeenCalled();
    expect(fs.existsSync(wtPath)).toBe(true);
    const jsonFile = path.join(projectDir, 'tasks', 'TASK-PULL', 'task.json');
    if (fs.existsSync(jsonFile)) {
      const data = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
      expect(data.excluded || []).not.toContain(path.basename(repoDir));
    }

    const dirs = claude.launch.mock.calls.at(-1)[0];
    expect(dirs).toContain(wtPath);
  });
});

describe('--shared --optional together', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('optional-5');
    repoDir    = makeTempDir('repo-shared-opt');
    makeGitRepo(repoDir);
    addRepo(projectDir, repoDir, { shared: true, optional: true });
  });
  afterEach(() => cleanup(projectDir, repoDir));

  test('optional wins the default: excluded, not included as shared', async () => {
    await runTask(projectDir, 'create', 'TASK-SHOPT');

    expect(prompts.ask).not.toHaveBeenCalled();
    const data = JSON.parse(fs.readFileSync(path.join(projectDir, 'tasks', 'TASK-SHOPT', 'task.json'), 'utf8'));
    expect(data.excluded).toContain(path.basename(repoDir));

    const dirs = claude.launch.mock.calls[0][0];
    expect(dirs).not.toContain(repoDir);
  });
});
