'use strict';
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execSync } = require('child_process');

const { makeTempDir, makeGitRepo, makeGitRepoWithRemote, makeProject, cleanup } = require('../helpers');
const { addRepo } = require('../../lib/repos');
const git = require('../../lib/git');
const { WORKTREES_DIR } = require('../../lib/worktrees');

// ─── Module mocks ────────────────────────────────────────────────────────────

jest.mock('../../lib/prompts', () => ({
  open:    jest.fn(),
  close:   jest.fn(),
  ask:     jest.fn(),
  confirm: jest.fn(),
}));

jest.mock('../../lib/claude', () => {
  const actual = jest.requireActual('../../lib/claude');
  return {
    ...actual,
    launch:          jest.fn(),
    findLastSession: jest.fn().mockReturnValue(null),
  };
});

jest.mock('../../lib/config', () => {
  const actual = jest.requireActual('../../lib/config');
  return {
    ...actual,
    findProjectDir:    jest.fn(),
    readProjectConfig: jest.fn(),
    readConfig:        jest.fn().mockReturnValue({}),
  };
});

const prompts  = require('../../lib/prompts');
const config   = require('../../lib/config');
const claudeMod = require('../../lib/claude');
const exportCmd = require('../../lib/commands/export');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function gitCmd(cwd, cmd) {
  return execSync(`git ${cmd}`, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

async function runExport(projectDir, projectName, ...args) {
  config.findProjectDir.mockReturnValue(projectDir);
  config.readProjectConfig.mockReturnValue({ name: projectName, schemaVersion: 2 });
  await exportCmd.run(args);
}

// Creates a full project + task with a worktree on a feature branch.
// repoDir must be a clone with a remote (makeGitRepoWithRemote).
function setupTaskWithWorktree(projectDir, repoDir, taskId, branch) {
  addRepo(projectDir, repoDir, false);
  const taskDir = path.join(projectDir, 'tasks', taskId);
  fs.mkdirSync(path.join(taskDir, WORKTREES_DIR), { recursive: true });
  const wtDir = path.join(taskDir, WORKTREES_DIR, path.basename(repoDir));
  git.addWorktree(repoDir, wtDir, branch, 'main');
  return { taskDir, wtDir };
}

// ─── beforeEach / afterEach ───────────────────────────────────────────────────

beforeEach(() => {
  jest.spyOn(process, 'exit').mockImplementation(code => {
    throw new Error(`process.exit(${code})`);
  });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  prompts.ask.mockReset();
  prompts.confirm.mockReset();
  prompts.open.mockReset();
  prompts.close.mockReset();
  claudeMod.findLastSession.mockReturnValue(null);
});
afterEach(() => jest.restoreAllMocks());

// ─── Happy path ───────────────────────────────────────────────────────────────

describe('export — happy path', () => {
  let projectDir, repoDir, originDir, outDir;
  beforeEach(() => {
    projectDir = makeProject('exp-happy');
    outDir     = makeTempDir('exp-out');
    ({ repoDir, originDir } = makeGitRepoWithRemote());
    addRepo(projectDir, repoDir, false);
    const taskDir = path.join(projectDir, 'tasks', 'TASK-1');
    fs.mkdirSync(path.join(taskDir, WORKTREES_DIR), { recursive: true });
    const wtDir = path.join(taskDir, WORKTREES_DIR, path.basename(repoDir));
    git.addWorktree(repoDir, wtDir, 'feature/task-1', 'main');
    // Push the branch so it's not "unpushed"
    gitCmd(wtDir, 'push origin feature/task-1');
  });
  afterEach(() => cleanup(projectDir, repoDir, originDir, outDir));

  test('exports bundle with correct project name and task id', async () => {
    const outFile = path.join(outDir, 'bundle.wksp-bundle');
    await runExport(projectDir, 'exp-happy', 'TASK-1', '--out', outFile);
    expect(fs.existsSync(outFile)).toBe(true);
    const bundle = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    expect(bundle.bundleVersion).toBe(1);
    expect(bundle.project.name).toBe('exp-happy');
    expect(bundle.task.id).toBe('TASK-1');
  });

  test('bundle repos array has the registered repo', async () => {
    const outFile = path.join(outDir, 'bundle.wksp-bundle');
    await runExport(projectDir, 'exp-happy', 'TASK-1', '--out', outFile);
    const bundle = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    expect(bundle.repos).toHaveLength(1);
    expect(bundle.repos[0].folderName).toBe(path.basename(repoDir));
    expect(bundle.repos[0].hasRemote).toBe(true);
  });

  test('task repos array has worktree entry with branch', async () => {
    const outFile = path.join(outDir, 'bundle.wksp-bundle');
    await runExport(projectDir, 'exp-happy', 'TASK-1', '--out', outFile);
    const bundle = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    expect(bundle.task.repos).toHaveLength(1);
    expect(bundle.task.repos[0].status).toBe('worktree');
    expect(bundle.task.repos[0].branch).toBe('feature/task-1');
  });

  test('session is null when --with-session not passed', async () => {
    const outFile = path.join(outDir, 'bundle.wksp-bundle');
    await runExport(projectDir, 'exp-happy', 'TASK-1', '--out', outFile);
    const bundle = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    expect(bundle.session).toBeNull();
  });

  test('exportedBy.machine is set', async () => {
    const outFile = path.join(outDir, 'bundle.wksp-bundle');
    await runExport(projectDir, 'exp-happy', 'TASK-1', '--out', outFile);
    const bundle = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    expect(bundle.exportedBy).toBeDefined();
    expect(typeof bundle.exportedBy.machine).toBe('string');
  });
});

// ─── Uncommitted changes → error ─────────────────────────────────────────────

describe('export — uncommitted changes', () => {
  let projectDir, repoDir, originDir, outDir;
  beforeEach(() => {
    projectDir = makeProject('exp-uncommit');
    outDir     = makeTempDir('exp-uncommit-out');
    ({ repoDir, originDir } = makeGitRepoWithRemote());
    addRepo(projectDir, repoDir, false);
    const taskDir = path.join(projectDir, 'tasks', 'TASK-UC');
    fs.mkdirSync(path.join(taskDir, WORKTREES_DIR), { recursive: true });
    const wtDir = path.join(taskDir, WORKTREES_DIR, path.basename(repoDir));
    git.addWorktree(repoDir, wtDir, 'feature/uncommit', 'main');
    // Create an uncommitted change
    fs.writeFileSync(path.join(wtDir, 'dirty.txt'), 'dirty\n');
  });
  afterEach(() => cleanup(projectDir, repoDir, originDir, outDir));

  test('exits 1 and prints error about uncommitted changes', async () => {
    const outFile = path.join(outDir, 'bundle.wksp-bundle');
    await expect(runExport(projectDir, 'exp-uncommit', 'TASK-UC', '--out', outFile))
      .rejects.toThrow('process.exit(1)');
    expect(fs.existsSync(outFile)).toBe(false);
    const errCalls = console.error.mock.calls.map(a => a.join(' ')).join('\n');
    expect(errCalls).toMatch(/uncommitted/i);
  });
});

// ─── Unpushed commits → error ─────────────────────────────────────────────────

describe('export — unpushed commits', () => {
  let projectDir, repoDir, originDir, outDir;
  beforeEach(() => {
    projectDir = makeProject('exp-unpush');
    outDir     = makeTempDir('exp-unpush-out');
    ({ repoDir, originDir } = makeGitRepoWithRemote());
    addRepo(projectDir, repoDir, false);
    const taskDir = path.join(projectDir, 'tasks', 'TASK-UP');
    fs.mkdirSync(path.join(taskDir, WORKTREES_DIR), { recursive: true });
    const wtDir = path.join(taskDir, WORKTREES_DIR, path.basename(repoDir));
    git.addWorktree(repoDir, wtDir, 'feature/unpush', 'main');
    // Push the branch first so remote tracking exists
    gitCmd(wtDir, 'push origin feature/unpush');
    // Then add an unpushed commit
    fs.writeFileSync(path.join(wtDir, 'new.txt'), 'new\n');
    gitCmd(wtDir, 'add new.txt');
    gitCmd(wtDir, '-c user.email=t@t.com -c user.name=T commit -m "unpushed"');
  });
  afterEach(() => cleanup(projectDir, repoDir, originDir, outDir));

  test('exits 1 and reports unpushed commits', async () => {
    const outFile = path.join(outDir, 'bundle.wksp-bundle');
    await expect(runExport(projectDir, 'exp-unpush', 'TASK-UP', '--out', outFile))
      .rejects.toThrow('process.exit(1)');
    const errCalls = console.error.mock.calls.map(a => a.join(' ')).join('\n');
    expect(errCalls).toMatch(/unpushed/i);
  });
});

// ─── Branch never pushed → error ─────────────────────────────────────────────

describe('export — branch never pushed to origin', () => {
  let projectDir, repoDir, originDir, outDir;
  beforeEach(() => {
    projectDir = makeProject('exp-nopush');
    outDir     = makeTempDir('exp-nopush-out');
    ({ repoDir, originDir } = makeGitRepoWithRemote());
    addRepo(projectDir, repoDir, false);
    const taskDir = path.join(projectDir, 'tasks', 'TASK-NP');
    fs.mkdirSync(path.join(taskDir, WORKTREES_DIR), { recursive: true });
    const wtDir = path.join(taskDir, WORKTREES_DIR, path.basename(repoDir));
    // Add worktree but never push the branch
    git.addWorktree(repoDir, wtDir, 'feature/never-pushed', 'main');
  });
  afterEach(() => cleanup(projectDir, repoDir, originDir, outDir));

  test('exits 1 with error about branch not being pushed', async () => {
    const outFile = path.join(outDir, 'bundle.wksp-bundle');
    await expect(runExport(projectDir, 'exp-nopush', 'TASK-NP', '--out', outFile))
      .rejects.toThrow('process.exit(1)');
    const errCalls = console.error.mock.calls.map(a => a.join(' ')).join('\n');
    expect(errCalls).toMatch(/push/i);
  });
});

// ─── Archived task → error ────────────────────────────────────────────────────

describe('export — archived task', () => {
  let projectDir, outDir;
  beforeEach(() => {
    projectDir = makeProject('exp-arch');
    outDir     = makeTempDir('exp-arch-out');
    // Create a fake archived task
    const archivedDir = path.join(projectDir, 'archived-tasks', 'TASK-ARCH');
    fs.mkdirSync(archivedDir, { recursive: true });
    fs.writeFileSync(path.join(archivedDir, 'archived.json'), JSON.stringify({ taskId: 'TASK-ARCH' }));
  });
  afterEach(() => cleanup(projectDir, outDir));

  test('exits 1 with archived error message', async () => {
    const outFile = path.join(outDir, 'bundle.wksp-bundle');
    await expect(runExport(projectDir, 'exp-arch', 'TASK-ARCH', '--out', outFile))
      .rejects.toThrow('process.exit(1)');
    const errCalls = console.error.mock.calls.map(a => a.join(' ')).join('\n');
    expect(errCalls).toMatch(/archived/i);
  });
});

// ─── Task not found → error ───────────────────────────────────────────────────

describe('export — task not found', () => {
  let projectDir, outDir;
  beforeEach(() => {
    projectDir = makeProject('exp-notfound');
    outDir     = makeTempDir('exp-notfound-out');
  });
  afterEach(() => cleanup(projectDir, outDir));

  test('exits 1 with task not found message', async () => {
    const outFile = path.join(outDir, 'bundle.wksp-bundle');
    await expect(runExport(projectDir, 'exp-notfound', 'GHOST-TASK', '--out', outFile))
      .rejects.toThrow('process.exit(1)');
    const errCalls = console.error.mock.calls.map(a => a.join(' ')).join('\n');
    expect(errCalls).toMatch(/not found/i);
  });
});

// ─── --out flag ───────────────────────────────────────────────────────────────

describe('export — --out flag', () => {
  let projectDir, repoDir, originDir, outDir;
  beforeEach(() => {
    projectDir = makeProject('exp-out-flag');
    outDir     = makeTempDir('exp-out-flag-dir');
    ({ repoDir, originDir } = makeGitRepoWithRemote());
    addRepo(projectDir, repoDir, false);
    const taskDir = path.join(projectDir, 'tasks', 'TASK-OF');
    fs.mkdirSync(path.join(taskDir, WORKTREES_DIR), { recursive: true });
    const wtDir = path.join(taskDir, WORKTREES_DIR, path.basename(repoDir));
    git.addWorktree(repoDir, wtDir, 'feature/out-flag', 'main');
    gitCmd(wtDir, 'push origin feature/out-flag');
  });
  afterEach(() => cleanup(projectDir, repoDir, originDir, outDir));

  test('writes bundle to the specified --out path', async () => {
    const outFile = path.join(outDir, 'custom-name.wksp-bundle');
    await runExport(projectDir, 'exp-out-flag', 'TASK-OF', '--out', outFile);
    expect(fs.existsSync(outFile)).toBe(true);
    const bundle = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    expect(bundle.task.id).toBe('TASK-OF');
  });
});

// ─── --with-session, no session found ─────────────────────────────────────────

describe('export — --with-session, no session', () => {
  let projectDir, repoDir, originDir, outDir;
  beforeEach(() => {
    projectDir = makeProject('exp-nosess');
    outDir     = makeTempDir('exp-nosess-out');
    ({ repoDir, originDir } = makeGitRepoWithRemote());
    addRepo(projectDir, repoDir, false);
    const taskDir = path.join(projectDir, 'tasks', 'TASK-NS');
    fs.mkdirSync(path.join(taskDir, WORKTREES_DIR), { recursive: true });
    const wtDir = path.join(taskDir, WORKTREES_DIR, path.basename(repoDir));
    git.addWorktree(repoDir, wtDir, 'feature/nosess', 'main');
    gitCmd(wtDir, 'push origin feature/nosess');
    claudeMod.findLastSession.mockReturnValue(null);
  });
  afterEach(() => cleanup(projectDir, repoDir, originDir, outDir));

  test('warns and exports without session', async () => {
    const outFile = path.join(outDir, 'bundle.wksp-bundle');
    await runExport(projectDir, 'exp-nosess', 'TASK-NS', '--with-session', '--out', outFile);
    expect(fs.existsSync(outFile)).toBe(true);
    const bundle = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    expect(bundle.session).toBeNull();
    const logCalls = console.log.mock.calls.map(a => a.join(' ')).join('\n');
    expect(logCalls).toMatch(/no claude session/i);
  });
});

// ─── --with-session, session found ────────────────────────────────────────────

describe('export — --with-session, session present', () => {
  let projectDir, repoDir, originDir, outDir, tempHome;
  beforeAll(() => { tempHome = makeTempDir('exp-sess-home'); });
  afterAll(() => cleanup(tempHome));

  beforeEach(() => {
    projectDir = makeProject('exp-sess');
    outDir     = makeTempDir('exp-sess-out');
    ({ repoDir, originDir } = makeGitRepoWithRemote());
    addRepo(projectDir, repoDir, false);
    const taskDir = path.join(projectDir, 'tasks', 'TASK-SE');
    fs.mkdirSync(path.join(taskDir, WORKTREES_DIR), { recursive: true });
    const wtDir = path.join(taskDir, WORKTREES_DIR, path.basename(repoDir));
    git.addWorktree(repoDir, wtDir, 'feature/sess', 'main');
    gitCmd(wtDir, 'push origin feature/sess');

    // Set up a fake session file
    const { encodeProjectPath } = require('../../lib/claude');
    const encoded  = encodeProjectPath(taskDir);
    const sessDir  = path.join(tempHome, '.claude', 'projects', encoded);
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(path.join(sessDir, 'abc123.jsonl'), '{"role":"user","content":"hello"}\n');

    // Mock os.homedir to return tempHome — need to re-require after mock
    jest.spyOn(os, 'homedir').mockReturnValue(tempHome);
    claudeMod.findLastSession.mockReturnValue({ id: 'abc123', mtime: Date.now() });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    cleanup(projectDir, repoDir, originDir, outDir);
  });

  test('includes session in bundle when --with-session is passed', async () => {
    const outFile = path.join(outDir, 'bundle.wksp-bundle');
    await runExport(projectDir, 'exp-sess', 'TASK-SE', '--with-session', '--out', outFile);
    const bundle = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    expect(bundle.session).not.toBeNull();
    expect(bundle.session.id).toBe('abc123');
    expect(bundle.session.jsonl).toContain('hello');
  });
});
