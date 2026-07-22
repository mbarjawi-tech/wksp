'use strict';
const fs   = require('fs');
const path = require('path');
const { makeTempDir, makeGitRepo, makeProject, cleanup } = require('../helpers');
const { addRepo } = require('../../lib/repos');
const { readTaskSets } = require('../../lib/task-state');
const { WORKTREES_DIR } = require('../../lib/worktrees');

jest.mock('../../lib/prompts', () => ({
  open: jest.fn(), close: jest.fn(), ask: jest.fn(),
  confirm: jest.fn(), confirmDefaultYes: jest.fn(),
}));

jest.mock('../../lib/providers/claude', () => {
  const actual = jest.requireActual('../../lib/providers/claude');
  return {
    ...actual,
    launch: jest.fn(),
    sessions: { ...actual.sessions, findLast: jest.fn().mockReturnValue(null) },
  };
});

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
const claude  = require('../../lib/providers/claude');
const taskCmd = require('../../lib/commands/task');

let logLines;
beforeEach(() => {
  logLines = [];
  jest.spyOn(console, 'log').mockImplementation((...args) => logLines.push(args.join(' ')));
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation((...args) => logLines.push('ERR ' + args.join(' ')));
  jest.spyOn(process, 'exit').mockImplementation(code => { throw new Error(`process.exit(${code})`); });
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

describe('wksp task create hub', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('hub');
    repoDir    = makeTempDir('repo-hub');
    makeGitRepo(repoDir);
    addRepo(projectDir, repoDir, false);
  });
  afterEach(() => cleanup(projectDir, repoDir));

  test('scaffolds a worktree-less hub even when repos are registered', async () => {
    prompts.ask.mockResolvedValue('');  // Enter = Yes
    await runTask(projectDir, 'create', 'hub');

    const hubDir = path.join(projectDir, 'tasks', 'hub');
    expect(fs.existsSync(path.join(hubDir, 'CLAUDE.md'))).toBe(true);
    expect(fs.existsSync(path.join(hubDir, 'WORKLOG.md'))).toBe(true);
    expect(fs.existsSync(path.join(hubDir, 'test-project--hub.code-workspace'))).toBe(true);

    // The hub CLAUDE.md is hub-flavored.
    expect(fs.readFileSync(path.join(hubDir, 'CLAUDE.md'), 'utf8')).toContain('## Feature backlog');

    // No worktree was created for the registered repo.
    const wtEntries = fs.readdirSync(path.join(hubDir, WORKTREES_DIR));
    expect(wtEntries).toHaveLength(0);

    // The registered repo is recorded as excluded.
    const { taskExcludedSet } = readTaskSets(hubDir);
    expect(taskExcludedSet.has(path.basename(repoDir))).toBe(true);

    // Claude was launched (no worktree dirs among the launch dirs).
    expect(claude.launch).toHaveBeenCalledTimes(1);
    const dirs = claude.launch.mock.calls[0][0];
    expect(dirs).toContain(hubDir);
    expect(dirs.some(d => d.includes(WORKTREES_DIR))).toBe(false);
  });

  test('errors when a hub already exists', async () => {
    prompts.ask.mockResolvedValue('y');
    await runTask(projectDir, 'create', 'hub');
    claude.launch.mockReset();
    await expect(runTask(projectDir, 'create', 'hub')).rejects.toThrow('process.exit(1)');
    expect(claude.launch).not.toHaveBeenCalled();
    expect(logLines.some(l => l.includes('already exists'))).toBe(true);
  });

  test('explains the hub and does nothing when the prompt is declined', async () => {
    prompts.ask.mockResolvedValue('n');
    await runTask(projectDir, 'create', 'hub');
    expect(logLines.some(l => l.includes("this project's planning task"))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'tasks', 'hub'))).toBe(false);
    expect(claude.launch).not.toHaveBeenCalled();
  });
});

describe('wksp task resume hub', () => {
  let projectDir;
  beforeEach(() => { projectDir = makeProject('hub-resume'); });
  afterEach(() => cleanup(projectDir));

  test('errors when there is no hub yet', async () => {
    await expect(runTask(projectDir, 'resume', 'hub')).rejects.toThrow('process.exit(1)');
    expect(logLines.some(l => l.includes('no hub yet'))).toBe(true);
  });
});

describe('hub delete / rename guards', () => {
  let projectDir;
  beforeEach(async () => {
    projectDir = makeProject('hub-guard');
    prompts.ask.mockResolvedValue('y');   // confirm hub creation
    await runTask(projectDir, 'create', 'hub');
    claude.launch.mockReset();
  });
  afterEach(() => cleanup(projectDir));

  test('delete warns before removing the hub', async () => {
    prompts.confirm.mockResolvedValue(true);
    await runTask(projectDir, 'delete', 'hub');
    expect(logLines.some(l => l.includes("planning task"))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'tasks', 'hub'))).toBe(false);
  });

  test('rename asks to confirm and can be cancelled', async () => {
    prompts.confirm.mockResolvedValue(false);
    await runTask(projectDir, 'rename', 'hub', 'planning');
    expect(logLines.some(l => l.includes('reserved planning task'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'tasks', 'hub'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'tasks', 'planning'))).toBe(false);
  });

  test('rename proceeds when confirmed', async () => {
    prompts.confirm.mockResolvedValue(true);
    await runTask(projectDir, 'rename', 'hub', 'planning');
    expect(fs.existsSync(path.join(projectDir, 'tasks', 'hub'))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, 'tasks', 'planning'))).toBe(true);
    expect(fs.readFileSync(path.join(projectDir, 'tasks', 'planning', 'CLAUDE.md'), 'utf8'))
      .toContain('## Task: planning');
  });
});
