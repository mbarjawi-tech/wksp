'use strict';
const fs   = require('fs');
const path = require('path');
const { makeTempDir, makeGitRepo, makeProject, cleanup } = require('../helpers');
const { addRepo } = require('../../lib/repos');
const { WORKTREES_DIR } = require('../../lib/worktrees');
const { getCacheDir, CACHE_DIR_NAME } = require('../../lib/deps');

jest.mock('../../lib/prompts', () => ({
  open: jest.fn(), close: jest.fn(), ask: jest.fn(), confirm: jest.fn(),
}));

jest.mock('../../lib/claude', () => ({
  launch:          jest.fn(),
  findLastSession: jest.fn().mockReturnValue(null),
}));

// We mock config so we can control sharedDeps without touching the filesystem .wksp
jest.mock('../../lib/config', () => {
  const actual = jest.requireActual('../../lib/config');
  return {
    ...actual,
    findProjectDir:    jest.fn(),
    readProjectConfig: jest.fn().mockReturnValue({ name: 'test-project' }),
    readGlobalConfig:  jest.fn().mockReturnValue({ autoResume: false }),
    readConfig:        jest.fn().mockReturnValue({ autoResume: false, sharedDeps: [] }),
  };
});

const prompts = require('../../lib/prompts');
const config  = require('../../lib/config');
const taskCmd = require('../../lib/commands/task');

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

function setSharedDeps(deps) {
  config.readConfig.mockReturnValue({ autoResume: false, sharedDeps: deps });
}

// ─── task create with sharedDeps ─────────────────────────────────────────────

describe('task create with sharedDeps configured', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('td-create');
    repoDir    = makeTempDir('repo-td-create');
    makeGitRepo(repoDir);
    addRepo(projectDir, repoDir, false);
    setSharedDeps(['node_modules']);
  });
  afterEach(() => cleanup(projectDir, repoDir));

  test('creates a symlink for node_modules in the worktree', async () => {
    prompts.ask.mockResolvedValueOnce('feature/td-create');
    await runTask(projectDir, 'create', 'TASK-1');

    const folderName  = path.basename(repoDir);
    const wtDir       = path.join(projectDir, 'tasks', 'TASK-1', WORKTREES_DIR, folderName);
    const linkPath    = path.join(wtDir, 'node_modules');
    expect(fs.existsSync(wtDir)).toBe(true);
    const stat = fs.lstatSync(linkPath);
    expect(stat.isSymbolicLink()).toBe(true);
  });

  test('creates the cache directory', async () => {
    prompts.ask.mockResolvedValueOnce('feature/td-create-cache');
    await runTask(projectDir, 'create', 'TASK-CACHE');

    const folderName = path.basename(repoDir);
    const cacheDepDir = path.join(getCacheDir(projectDir, folderName), 'node_modules');
    expect(fs.existsSync(cacheDepDir)).toBe(true);
  });

  test('prints a ✓ deps linked message', async () => {
    prompts.ask.mockResolvedValueOnce('feature/td-create-msg');
    await runTask(projectDir, 'create', 'TASK-MSG');

    expect(logLines.some(l => l.includes('deps linked'))).toBe(true);
  });

  test('link target resolves to the cache dir', async () => {
    prompts.ask.mockResolvedValueOnce('feature/td-create-target');
    await runTask(projectDir, 'create', 'TASK-TARGET');

    const folderName  = path.basename(repoDir);
    const wtDir       = path.join(projectDir, 'tasks', 'TASK-TARGET', WORKTREES_DIR, folderName);
    const linkPath    = path.join(wtDir, 'node_modules');
    const targetPath  = path.join(getCacheDir(projectDir, folderName), 'node_modules');
    expect(fs.realpathSync(linkPath)).toBe(fs.realpathSync(targetPath));
  });
});

// ─── task create without sharedDeps ──────────────────────────────────────────

describe('task create without sharedDeps', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('td-no-shared');
    repoDir    = makeTempDir('repo-td-no-shared');
    makeGitRepo(repoDir);
    addRepo(projectDir, repoDir, false);
    setSharedDeps([]);
  });
  afterEach(() => cleanup(projectDir, repoDir));

  test('does not create a symlink or cache dir', async () => {
    prompts.ask.mockResolvedValueOnce('feature/td-no-shared');
    await runTask(projectDir, 'create', 'TASK-NS');

    const folderName = path.basename(repoDir);
    const wtDir      = path.join(projectDir, 'tasks', 'TASK-NS', WORKTREES_DIR, folderName);
    expect(fs.existsSync(wtDir)).toBe(true);
    expect(fs.existsSync(path.join(wtDir, 'node_modules'))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, CACHE_DIR_NAME))).toBe(false);
  });
});

// ─── resume: existing junction preserved (idempotent) ────────────────────────

describe('task resume — existing junction preserved', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('td-resume');
    repoDir    = makeTempDir('repo-td-resume');
    makeGitRepo(repoDir);
    addRepo(projectDir, repoDir, false);
    setSharedDeps(['node_modules']);
  });
  afterEach(() => cleanup(projectDir, repoDir));

  test('junction still present and intact after resume', async () => {
    prompts.ask.mockResolvedValueOnce('feature/td-resume');
    await runTask(projectDir, 'create', 'TASK-RESUME');

    const folderName = path.basename(repoDir);
    const wtDir      = path.join(projectDir, 'tasks', 'TASK-RESUME', WORKTREES_DIR, folderName);

    // Write something into the cache so we can confirm link stays valid
    const cacheDir = getCacheDir(projectDir, folderName);
    fs.writeFileSync(path.join(cacheDir, 'node_modules', 'sentinel.txt'), 'ok');

    await runTask(projectDir, 'resume', 'TASK-RESUME');

    const linkPath = path.join(wtDir, 'node_modules');
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    // Sentinel reachable through the link
    expect(fs.existsSync(path.join(linkPath, 'sentinel.txt'))).toBe(true);
  });
});

// ─── resume: auto-opt-out for existing real dep dirs ─────────────────────────

describe('task resume — auto-opt-out when real dep dir found', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('td-autooptout');
    repoDir    = makeTempDir('repo-td-autooptout');
    makeGitRepo(repoDir);
    addRepo(projectDir, repoDir, false);
    setSharedDeps(['node_modules']);
  });
  afterEach(() => cleanup(projectDir, repoDir));

  test('marks as own-deps and warns instead of linking', async () => {
    // Create task without sharedDeps so no junction is created
    setSharedDeps([]);
    prompts.ask.mockResolvedValueOnce('feature/td-autooptout');
    await runTask(projectDir, 'create', 'TASK-AUTO');

    // Place a real node_modules in the worktree (simulating user's own install)
    const folderName = path.basename(repoDir);
    const wtDir      = path.join(projectDir, 'tasks', 'TASK-AUTO', WORKTREES_DIR, folderName);
    fs.mkdirSync(path.join(wtDir, 'node_modules'), { recursive: true });

    // Now enable sharedDeps and resume
    setSharedDeps(['node_modules']);
    await runTask(projectDir, 'resume', 'TASK-AUTO');

    // Should NOT have replaced the real dir with a symlink
    const stat = fs.lstatSync(path.join(wtDir, 'node_modules'));
    expect(stat.isDirectory()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);

    // Warning printed
    expect(warnLines.some(l => l.includes('own-deps'))).toBe(true);

    // Written to task-own-deps.txt
    const ownDepsFile = path.join(projectDir, 'tasks', 'TASK-AUTO', 'task-own-deps.txt');
    expect(fs.existsSync(ownDepsFile)).toBe(true);
    expect(fs.readFileSync(ownDepsFile, 'utf8')).toContain(folderName);
  });
});

// ─── wksp task repo own-deps ──────────────────────────────────────────────────

describe('wksp task repo own-deps', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('td-own');
    repoDir    = makeTempDir('repo-td-own');
    makeGitRepo(repoDir);
    addRepo(projectDir, repoDir, false);
    setSharedDeps(['node_modules']);
  });
  afterEach(() => cleanup(projectDir, repoDir));

  test('removes junction and writes task-own-deps.txt', async () => {
    prompts.ask.mockResolvedValueOnce('feature/td-own');
    await runTask(projectDir, 'create', 'TASK-OWN');

    const folderName = path.basename(repoDir);
    const wtDir      = path.join(projectDir, 'tasks', 'TASK-OWN', WORKTREES_DIR, folderName);
    // Confirm junction exists first
    expect(fs.lstatSync(path.join(wtDir, 'node_modules')).isSymbolicLink()).toBe(true);

    // Switch to own-deps
    await runTask(projectDir, 'repo', 'TASK-OWN', folderName, 'own-deps');

    // Junction removed
    expect(fs.existsSync(path.join(wtDir, 'node_modules'))).toBe(false);

    // Written to task-own-deps.txt
    const ownDepsFile = path.join(projectDir, 'tasks', 'TASK-OWN', 'task-own-deps.txt');
    expect(fs.existsSync(ownDepsFile)).toBe(true);
    expect(fs.readFileSync(ownDepsFile, 'utf8')).toContain(folderName);
  });
});

// ─── wksp task repo link-deps ─────────────────────────────────────────────────

describe('wksp task repo link-deps', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('td-link');
    repoDir    = makeTempDir('repo-td-link');
    makeGitRepo(repoDir);
    addRepo(projectDir, repoDir, false);
    setSharedDeps(['node_modules']);
  });
  afterEach(() => cleanup(projectDir, repoDir));

  test('restores junction and removes from task-own-deps.txt', async () => {
    prompts.ask.mockResolvedValueOnce('feature/td-link');
    await runTask(projectDir, 'create', 'TASK-LINK');

    const folderName = path.basename(repoDir);

    // Switch to own-deps first
    await runTask(projectDir, 'repo', 'TASK-LINK', folderName, 'own-deps');

    const wtDir    = path.join(projectDir, 'tasks', 'TASK-LINK', WORKTREES_DIR, folderName);
    const linkPath = path.join(wtDir, 'node_modules');
    expect(fs.existsSync(linkPath)).toBe(false);

    // Switch back to link-deps
    await runTask(projectDir, 'repo', 'TASK-LINK', folderName, 'link-deps');

    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);

    // Removed from task-own-deps.txt
    const ownDepsFile = path.join(projectDir, 'tasks', 'TASK-LINK', 'task-own-deps.txt');
    const content = fs.existsSync(ownDepsFile) ? fs.readFileSync(ownDepsFile, 'utf8') : '';
    expect(content).not.toContain(folderName);
  });

  test('errors when a real dep dir exists at the link path', async () => {
    prompts.ask.mockResolvedValueOnce('feature/td-link-err');
    await runTask(projectDir, 'create', 'TASK-LINK-ERR');

    const folderName = path.basename(repoDir);
    const wtDir      = path.join(projectDir, 'tasks', 'TASK-LINK-ERR', WORKTREES_DIR, folderName);

    // Switch to own-deps
    await runTask(projectDir, 'repo', 'TASK-LINK-ERR', folderName, 'own-deps');

    // Simulate user placing a real install where the link would go
    fs.mkdirSync(path.join(wtDir, 'node_modules'), { recursive: true });

    await expect(
      runTask(projectDir, 'repo', 'TASK-LINK-ERR', folderName, 'link-deps')
    ).rejects.toThrow('process.exit(1)');
  });
});

// ─── resume after own-deps: junction not recreated ───────────────────────────

describe('resume after own-deps — junction not recreated', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('td-resume-own');
    repoDir    = makeTempDir('repo-td-resume-own');
    makeGitRepo(repoDir);
    addRepo(projectDir, repoDir, false);
    setSharedDeps(['node_modules']);
  });
  afterEach(() => cleanup(projectDir, repoDir));

  test('own-deps persists across resume — no junction recreated', async () => {
    prompts.ask.mockResolvedValueOnce('feature/td-resume-own');
    await runTask(projectDir, 'create', 'TASK-RES-OWN');

    const folderName = path.basename(repoDir);

    // Switch to own-deps
    await runTask(projectDir, 'repo', 'TASK-RES-OWN', folderName, 'own-deps');

    // Resume — should not recreate the link
    await runTask(projectDir, 'resume', 'TASK-RES-OWN');

    const wtDir    = path.join(projectDir, 'tasks', 'TASK-RES-OWN', WORKTREES_DIR, folderName);
    const linkPath = path.join(wtDir, 'node_modules');
    // Should not exist (own-deps, no install done)
    expect(fs.existsSync(linkPath)).toBe(false);
  });
});
