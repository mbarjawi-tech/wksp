'use strict';
const fs   = require('fs');
const path = require('path');
const { makeTempDir, makeGitRepo, makeProject, cleanup } = require('../helpers');
const { addRepo } = require('../../lib/repos');
const { CLAUDE_INCLUDE } = require('../../lib/templates');

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

const prompts  = require('../../lib/prompts');
const config   = require('../../lib/config');
const claude   = require('../../lib/providers/claude');
const startCmd = require('../../lib/commands/start');

let logLines;
beforeEach(() => {
  logLines = [];
  jest.spyOn(console, 'log').mockImplementation((...args) => logLines.push(args.join(' ')));
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation((...args) => logLines.push('ERR ' + args.join(' ')));
  jest.spyOn(process, 'exit').mockImplementation(code => { throw new Error(`process.exit(${code})`); });
  prompts.ask.mockReset();
  prompts.confirm.mockReset();
  prompts.confirmDefaultYes.mockReset();
  claude.launch.mockReset();
  claude.sessions.findLast.mockReset();
  claude.sessions.findLast.mockReturnValue(null);
  config.readConfig.mockReturnValue({ autoResume: false });
});
afterEach(() => jest.restoreAllMocks());

async function runStart(projectDir, ...args) {
  config.findProjectDir.mockReturnValue(projectDir);
  await startCmd.run(args);
}

describe('wksp start — planning session at the project root', () => {
  let projectDir;
  beforeEach(() => { projectDir = makeProject('start-root'); });
  afterEach(() => cleanup(projectDir));

  test('launches at the project root with the root as the only context dir', async () => {
    await runStart(projectDir);
    expect(claude.launch).toHaveBeenCalledTimes(1);
    const [dirs, cwd, resumeId] = claude.launch.mock.calls[0];
    expect(dirs).toEqual([projectDir]);
    expect(cwd).toBe(projectDir);
    expect(resumeId).toBeNull();
  });

  test('works without any repos registered (planning needs no worktrees)', async () => {
    fs.writeFileSync(path.join(projectDir, 'repos.txt'), '');
    await runStart(projectDir);
    expect(claude.launch).toHaveBeenCalledTimes(1);
  });

  test('auto-resumes the last root-keyed session', async () => {
    config.readConfig.mockReturnValue({ autoResume: true });
    claude.sessions.findLast.mockReturnValue({ id: 'root-sess', mtime: Date.now() });

    await runStart(projectDir);

    // Sessions are looked up by the project root path, not a task path.
    expect(claude.sessions.findLast).toHaveBeenCalledWith(projectDir);
    expect(claude.launch.mock.calls[0][2]).toBe('root-sess');
  });

  test('points at PLANNING.md when it exists', async () => {
    fs.writeFileSync(path.join(projectDir, 'PLANNING.md'), '# Planning\n');
    await runStart(projectDir);
    expect(logLines.some(l => l.includes('PLANNING.md'))).toBe(true);
  });

  test('errors when not inside a project', async () => {
    config.findProjectDir.mockReturnValue(null);
    await expect(startCmd.run([])).rejects.toThrow('process.exit(1)');
    expect(claude.launch).not.toHaveBeenCalled();
  });
});

describe('wksp start <id> — create or resume a task', () => {
  let projectDir, repoDir;
  beforeEach(async () => {
    projectDir = makeProject('start-task');
    repoDir    = makeTempDir('repo-start');
    makeGitRepo(repoDir);
    addRepo(projectDir, repoDir, false);
    // Seed one existing task with the repo excluded (no worktree needed).
    prompts.ask.mockResolvedValueOnce('x');
    config.findProjectDir.mockReturnValue(projectDir);
    await require('../../lib/commands/task').run(['create', 'T-EXISTING']);
    claude.launch.mockReset();
    prompts.ask.mockReset();
  });
  afterEach(() => cleanup(projectDir, repoDir));

  test('resumes an existing task by exact id', async () => {
    await runStart(projectDir, 'T-EXISTING');
    expect(claude.launch).toHaveBeenCalledTimes(1);
    expect(claude.launch.mock.calls[0][1]).toBe(path.join(projectDir, 'tasks', 'T-EXISTING'));
    expect(prompts.confirmDefaultYes).not.toHaveBeenCalled();
  });

  test('resumes on a unique partial match', async () => {
    await runStart(projectDir, 'exist');
    expect(claude.launch).toHaveBeenCalledTimes(1);
    expect(claude.launch.mock.calls[0][1]).toBe(path.join(projectDir, 'tasks', 'T-EXISTING'));
  });

  test('offers to create when nothing matches, and creates on Yes', async () => {
    prompts.confirmDefaultYes.mockResolvedValue(true);
    prompts.ask.mockResolvedValueOnce('x'); // exclude the repo from the new task

    await runStart(projectDir, 'T-NEW');

    const taskDir = path.join(projectDir, 'tasks', 'T-NEW');
    expect(fs.existsSync(path.join(taskDir, 'AGENTS.md'))).toBe(true);
    expect(fs.readFileSync(path.join(taskDir, 'CLAUDE.md'), 'utf8')).toBe(CLAUDE_INCLUDE);
    expect(claude.launch).toHaveBeenCalledTimes(1);
    expect(claude.launch.mock.calls[0][1]).toBe(taskDir);
  });

  test('does nothing when task creation is declined', async () => {
    prompts.confirmDefaultYes.mockResolvedValue(false);
    await runStart(projectDir, 'T-NOPE');
    expect(fs.existsSync(path.join(projectDir, 'tasks', 'T-NOPE'))).toBe(false);
    expect(claude.launch).not.toHaveBeenCalled();
    expect(logLines.some(l => l.includes('Cancelled'))).toBe(true);
  });
});
