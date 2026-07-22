'use strict';
const fs   = require('fs');
const path = require('path');
const { makeTempDir, makeGitRepo, makeProject, cleanup } = require('../helpers');
const { addRepo } = require('../../lib/repos');
const git = require('../../lib/git');
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

// â”€â”€â”€ .code-workspace stdout â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
    await runTask(projectDir, 'create', 'TASK-WS');
    expect(logLines.some(l => l.includes('.code-workspace'))).toBe(true);
    expect(logLines.some(l => l.includes('TASK-WS'))).toBe(true);
  });
});

// â”€â”€â”€ task rename â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('wksp task rename', () => {
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
    await runTask(projectDir, 'create', 'OLD-TASK');

    await runTask(projectDir, 'rename', 'OLD-TASK', 'NEW-TASK');

    expect(fs.existsSync(path.join(projectDir, 'tasks', 'OLD-TASK'))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, 'tasks', 'NEW-TASK'))).toBe(true);
  });

  test('renames the .code-workspace file', async () => {
    prompts.ask.mockResolvedValueOnce('feature/rename-ws');
    await runTask(projectDir, 'create', 'OLD-WS');

    await runTask(projectDir, 'rename', 'OLD-WS', 'NEW-WS');

    const newTaskDir = path.join(projectDir, 'tasks', 'NEW-WS');
    expect(fs.existsSync(path.join(newTaskDir, 'test-project--NEW-WS.code-workspace'))).toBe(true);
    expect(fs.existsSync(path.join(newTaskDir, 'test-project--OLD-WS.code-workspace'))).toBe(false);
  });

  test('updates ## Task: header in AGENTS.md', async () => {
    prompts.ask.mockResolvedValueOnce('feature/rename-md');
    await runTask(projectDir, 'create', 'OLD-MD');

    await runTask(projectDir, 'rename', 'OLD-MD', 'NEW-MD');

    const agentsMd = fs.readFileSync(
      path.join(projectDir, 'tasks', 'NEW-MD', 'AGENTS.md'), 'utf8'
    );
    expect(agentsMd).toMatch(/## Task: NEW-MD/);
    expect(agentsMd).not.toMatch(/## Task: OLD-MD/);
  });

  test('exits 1 if the old task does not exist', async () => {
    await expect(runTask(projectDir, 'rename', 'GHOST', 'NEW')).rejects.toThrow('process.exit(1)');
  });

  test('exits 1 if the new name is already taken', async () => {
    prompts.ask.mockResolvedValueOnce('feature/a');
    await runTask(projectDir, 'create', 'TASK-A');
    prompts.ask.mockResolvedValueOnce('feature/b');
    await runTask(projectDir, 'create', 'TASK-B');

    await expect(runTask(projectDir, 'rename', 'TASK-A', 'TASK-B')).rejects.toThrow('process.exit(1)');
  });
});

// â”€â”€â”€ task --to-exclude â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// â”€â”€â”€ task repo (v2 scripted) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('wksp task repo â€” scripted', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('repo-cmd-1');
    repoDir    = makeTempDir('repo-repo-cmd-1');
    makeGitRepo(repoDir);
    addRepo(projectDir, repoDir, false);
  });
  afterEach(() => cleanup(projectDir, repoDir));

  test('share mode removes the worktree and writes task.json', async () => {
    prompts.ask.mockResolvedValueOnce('feature/repo-share');
    await runTask(projectDir, 'create', 'TASK-RS');

    const wtPath = path.join(projectDir, 'tasks', 'TASK-RS', WORKTREES_DIR, path.basename(repoDir));
    expect(fs.existsSync(wtPath)).toBe(true);

    await runTask(projectDir, 'repo', 'TASK-RS', path.basename(repoDir), 'share');

    expect(fs.existsSync(wtPath)).toBe(false);
    const jsonFile = path.join(projectDir, 'tasks', 'TASK-RS', 'task.json');
    expect(fs.existsSync(jsonFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(jsonFile, 'utf8')).shared).toContain(path.basename(repoDir));
  });

  test('exclude mode removes the worktree and writes task.json', async () => {
    prompts.ask.mockResolvedValueOnce('feature/repo-excl');
    await runTask(projectDir, 'create', 'TASK-RE');

    const wtPath = path.join(projectDir, 'tasks', 'TASK-RE', WORKTREES_DIR, path.basename(repoDir));
    expect(fs.existsSync(wtPath)).toBe(true);

    await runTask(projectDir, 'repo', 'TASK-RE', path.basename(repoDir), 'exclude');

    expect(fs.existsSync(wtPath)).toBe(false);
    const jsonFile = path.join(projectDir, 'tasks', 'TASK-RE', 'task.json');
    expect(fs.existsSync(jsonFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(jsonFile, 'utf8')).excluded).toContain(path.basename(repoDir));
  });

  test('exits 1 when task does not exist', async () => {
    await expect(
      runTask(projectDir, 'repo', 'NO-SUCH-TASK', path.basename(repoDir), 'share')
    ).rejects.toThrow('process.exit(1)');
  });

  test('exits 1 when repo not registered', async () => {
    prompts.ask.mockResolvedValueOnce('feature/repo-notfound');
    await runTask(projectDir, 'create', 'TASK-RNF');
    await expect(
      runTask(projectDir, 'repo', 'TASK-RNF', 'nonexistent-repo', 'share')
    ).rejects.toThrow('process.exit(1)');
  });

  test('exits 1 on unknown mode', async () => {
    prompts.ask.mockResolvedValueOnce('feature/repo-badmode');
    await runTask(projectDir, 'create', 'TASK-RBM');
    await expect(
      runTask(projectDir, 'repo', 'TASK-RBM', path.basename(repoDir), 'badmode')
    ).rejects.toThrow('process.exit(1)');
  });
});

// â”€â”€â”€ task repo (v2 interactive) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('wksp task repo â€” interactive', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('repo-inter-1');
    repoDir    = makeTempDir('repo-inter-repo');
    makeGitRepo(repoDir);
    addRepo(projectDir, repoDir, false);
  });
  afterEach(() => cleanup(projectDir, repoDir));

  test('prompts for both repo and mode when neither given', async () => {
    prompts.ask.mockResolvedValueOnce('feature/inter-both');
    await runTask(projectDir, 'create', 'TASK-IB');

    prompts.ask
      .mockResolvedValueOnce(path.basename(repoDir)) // repo name prompt
      .mockResolvedValueOnce('exclude');             // mode prompt

    await runTask(projectDir, 'repo', 'TASK-IB');

    const jsonFile = path.join(projectDir, 'tasks', 'TASK-IB', 'task.json');
    expect(fs.existsSync(jsonFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(jsonFile, 'utf8')).excluded).toContain(path.basename(repoDir));
  });

  test('prompts only for mode when repo given but mode omitted', async () => {
    prompts.ask.mockResolvedValueOnce('feature/inter-mode');
    await runTask(projectDir, 'create', 'TASK-IM');

    prompts.ask.mockResolvedValueOnce('share'); // mode prompt only

    await runTask(projectDir, 'repo', 'TASK-IM', path.basename(repoDir));

    const jsonFile = path.join(projectDir, 'tasks', 'TASK-IM', 'task.json');
    expect(fs.existsSync(jsonFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(jsonFile, 'utf8')).shared).toContain(path.basename(repoDir));
  });
});

