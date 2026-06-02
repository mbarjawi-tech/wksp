'use strict';
const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { makeTempDir, makeGitRepo, makeProject, cleanup } = require('../helpers');
const { addRepo } = require('../../lib/repos');
const git = require('../../lib/git');
const { WORKTREES_DIR } = require('../../lib/worktrees');

// ─── module mocks (must be at file level so Jest hoists them) ────────────────

jest.mock('../../lib/prompts', () => ({
  open:         jest.fn(),
  close:        jest.fn(),
  ask:          jest.fn(),
  askRequired:  jest.fn(),
  confirm:      jest.fn(),
  confirmTyped: jest.fn(),
}));

jest.mock('../../lib/claude', () => ({ launch: jest.fn() }));

jest.mock('../../lib/config', () => {
  const actual = jest.requireActual('../../lib/config');
  return {
    ...actual,
    findProjectDir:    jest.fn(),
    readProjectConfig: jest.fn().mockReturnValue({ name: 'test-project' }),
  };
});

// Prevent process.exit() from killing the Jest worker.
jest.spyOn(process, 'exit').mockImplementation(code => {
  throw new Error(`process.exit(${code})`);
});

const prompts  = require('../../lib/prompts');
const config   = require('../../lib/config');
const taskCmd  = require('../../lib/commands/task');

// ─── setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  prompts.confirm.mockReset();
  prompts.ask.mockReset();
  prompts.open.mockReset();
  prompts.close.mockReset();
});
afterEach(() => jest.restoreAllMocks());

// ─── helpers ─────────────────────────────────────────────────────────────────

async function createTaskWithWorktree(projectDir, repoDir, taskId, branch) {
  const taskDir = path.join(projectDir, 'tasks', taskId);
  fs.mkdirSync(path.join(taskDir, WORKTREES_DIR), { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'CLAUDE.md'), `## Task: ${taskId}\n`);
  const wtPath = path.join(taskDir, WORKTREES_DIR, path.basename(repoDir));
  git.addWorktree(repoDir, wtPath, branch);
  return { taskDir, wtPath };
}

async function runDel(projectDir, taskId) {
  config.findProjectDir.mockReturnValue(projectDir);
  await taskCmd.run(['delete', taskId]);
}

// ─── --del: no worktrees ──────────────────────────────────────────────────────

describe('wksp task delete — no worktrees', () => {
  let projectDir;
  beforeEach(() => { projectDir = makeProject('del-empty'); });
  afterEach(()  => cleanup(projectDir));

  test('deletes the task folder after confirmation', async () => {
    const taskDir = path.join(projectDir, 'tasks', 'EMPTY-1');
    fs.mkdirSync(path.join(taskDir, WORKTREES_DIR), { recursive: true });

    prompts.confirm.mockResolvedValueOnce(true); // "Confirm?" → yes

    await runDel(projectDir, 'EMPTY-1');
    expect(fs.existsSync(taskDir)).toBe(false);
  });

  test('cancels without deleting when user says no', async () => {
    const taskDir = path.join(projectDir, 'tasks', 'EMPTY-2');
    fs.mkdirSync(path.join(taskDir, WORKTREES_DIR), { recursive: true });

    prompts.confirm.mockResolvedValueOnce(false); // "Confirm?" → no

    await runDel(projectDir, 'EMPTY-2');
    expect(fs.existsSync(taskDir)).toBe(true);
  });
});

// ─── --del: user says YES to branch deletion ──────────────────────────────────

describe('wksp task delete — user chooses to delete branches', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('del-yes');
    repoDir    = makeTempDir('repo-del-yes');
    makeGitRepo(repoDir);
    addRepo(projectDir, repoDir, false);
  });
  afterEach(() => cleanup(projectDir, repoDir));

  test('removes worktrees and deletes the branch', async () => {
    await createTaskWithWorktree(projectDir, repoDir, 'TASK-YES', 'feature/del-yes');

    prompts.confirm
      .mockResolvedValueOnce(true)  // "Confirm?" → yes
      .mockResolvedValueOnce(true); // "Delete local branches?" → yes

    await runDel(projectDir, 'TASK-YES');

    expect(fs.existsSync(path.join(projectDir, 'tasks', 'TASK-YES'))).toBe(false);
    expect(git.branchExistsLocally(repoDir, 'feature/del-yes')).toBe(false);
  });
});

// ─── --del: user says NO to branch deletion ───────────────────────────────────

describe('wksp task delete — user keeps branches', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('del-no');
    repoDir    = makeTempDir('repo-del-no');
    makeGitRepo(repoDir);
    addRepo(projectDir, repoDir, false);
  });
  afterEach(() => {
    try { git.deleteBranch(repoDir, 'feature/del-no', true); } catch {}
    cleanup(projectDir, repoDir);
  });

  test('removes worktrees but keeps the branch', async () => {
    await createTaskWithWorktree(projectDir, repoDir, 'TASK-NO', 'feature/del-no');

    prompts.confirm
      .mockResolvedValueOnce(true)   // "Confirm?" → yes
      .mockResolvedValueOnce(false); // "Delete local branches?" → no

    await runDel(projectDir, 'TASK-NO');

    expect(fs.existsSync(path.join(projectDir, 'tasks', 'TASK-NO'))).toBe(false);
    expect(git.branchExistsLocally(repoDir, 'feature/del-no')).toBe(true);
  });
});

// ─── --del: unmerged commits → force delete ───────────────────────────────────

describe('wksp task delete — unmerged commits → force delete', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('del-force');
    repoDir    = makeTempDir('repo-del-force');
    makeGitRepo(repoDir);
    addRepo(projectDir, repoDir, false);
  });
  afterEach(() => cleanup(projectDir, repoDir));

  test('force-deletes branch when user confirms', async () => {
    const { wtPath } = await createTaskWithWorktree(projectDir, repoDir, 'TASK-FORCE', 'feature/unmerged');
    fs.writeFileSync(path.join(wtPath, 'work.txt'), 'work');
    execSync('git add .', { cwd: wtPath, stdio: 'pipe' });
    execSync('git commit -m "unmerged work"', { cwd: wtPath, stdio: 'pipe' });

    prompts.confirm
      .mockResolvedValueOnce(true)  // "Confirm?" → yes
      .mockResolvedValueOnce(true)  // "Delete local branches?" → yes
      .mockResolvedValueOnce(true); // "Force delete?" → yes

    await runDel(projectDir, 'TASK-FORCE');
    expect(git.branchExistsLocally(repoDir, 'feature/unmerged')).toBe(false);
  });
});

// ─── --del: unmerged commits → keep branch ────────────────────────────────────

describe('wksp task delete — unmerged commits → keep branch', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('del-keep');
    repoDir    = makeTempDir('repo-del-keep');
    makeGitRepo(repoDir);
    addRepo(projectDir, repoDir, false);
  });
  afterEach(() => {
    try { git.deleteBranch(repoDir, 'feature/keep-unmerged', true); } catch {}
    cleanup(projectDir, repoDir);
  });

  test('keeps branch when user declines force delete', async () => {
    const { wtPath } = await createTaskWithWorktree(projectDir, repoDir, 'TASK-KEEP', 'feature/keep-unmerged');
    fs.writeFileSync(path.join(wtPath, 'work.txt'), 'work');
    execSync('git add .', { cwd: wtPath, stdio: 'pipe' });
    execSync('git commit -m "unmerged"', { cwd: wtPath, stdio: 'pipe' });

    prompts.confirm
      .mockResolvedValueOnce(true)   // "Confirm?" → yes
      .mockResolvedValueOnce(true)   // "Delete local branches?" → yes
      .mockResolvedValueOnce(false); // "Force delete?" → no

    await runDel(projectDir, 'TASK-KEEP');
    expect(git.branchExistsLocally(repoDir, 'feature/keep-unmerged')).toBe(true);
  });
});
