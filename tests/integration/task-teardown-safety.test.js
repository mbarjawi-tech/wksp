'use strict';
// Teardown safety: delete / archive / finish must refuse while a shell sits inside the
// task, must fail before destroying rather than after, and must never skip a documented
// step in silence. See PLANNING #20 — reproduced for real on 2026-08-04, where
// `git worktree remove` deleted a worktree's contents, failed on the locked directory,
// and the retry then archived the task while quietly skipping branch deletion and the
// base-repo fast-forward.
const fs   = require('fs');
const path = require('path');
const { makeTempDir, makeGitRepo, makeProject, cleanup } = require('../helpers');
const { addRepo } = require('../../lib/repos');
const git = require('../../lib/git');
const { WORKTREES_DIR } = require('../../lib/worktrees');
const archive = require('../../lib/archive');

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

jest.mock('../../lib/forge', () => ({ prMergeState: jest.fn(() => ({ state: 'unknown' })) }));

// Real guards, except that probeRemovable can be made to report a lock — there is no
// portable way to hold a directory open from inside the test process.
jest.mock('../../lib/teardown-guard', () => {
  const actual = jest.requireActual('../../lib/teardown-guard');
  return { ...actual, probeRemovable: jest.fn(actual.probeRemovable) };
});

const prompts = require('../../lib/prompts');
const config  = require('../../lib/config');
const forge   = require('../../lib/forge');
const guard   = require('../../lib/teardown-guard');
const taskCmd = require('../../lib/commands/task');

// A degraded teardown sets process.exitCode so the shell sees a failure. Keep that out
// of Jest's own exit code.
let priorExitCode;

beforeEach(() => {
  priorExitCode = process.exitCode;
  jest.spyOn(process, 'exit').mockImplementation(code => { throw new Error(`process.exit(${code})`); });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  prompts.ask.mockReset();
  prompts.confirm.mockReset();
  forge.prMergeState.mockReset();
  forge.prMergeState.mockReturnValue({ state: 'unknown' });
  guard.probeRemovable.mockClear();
  guard.probeRemovable.mockImplementation(jest.requireActual('../../lib/teardown-guard').probeRemovable);
});
afterEach(() => {
  jest.restoreAllMocks();
  process.exitCode = priorExitCode;
});

const textOf = spy => spy.mock.calls.map(c => c.map(String).join(' ')).join('\n');
const logged   = () => textOf(console.log);
const warned   = () => textOf(console.warn);
const errored  = () => textOf(console.error);

async function runTask(projectDir, ...args) {
  config.findProjectDir.mockReturnValue(projectDir);
  await taskCmd.run(args);
}

// A task folder with one real worktree, built without going through the prompts.
function makeTask(projectDir, repoDir, taskId, branch) {
  const taskDir = path.join(projectDir, 'tasks', taskId);
  fs.mkdirSync(path.join(taskDir, WORKTREES_DIR), { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'CLAUDE.md'), `## Task: ${taskId}\n`);
  const wtPath = path.join(taskDir, WORKTREES_DIR, path.basename(repoDir));
  git.addWorktree(repoDir, wtPath, branch);
  return { taskDir, wtPath };
}

// The state the incident left behind: the worktree directory is still there but its
// .git file is gone, so discoverWorktrees reports it corrupted and nothing can be read
// from it. The base repo still registers the path (until `git worktree prune`), which
// is the only place the branch name survives.
function gutWorktree(wtPath) {
  fs.rmSync(path.join(wtPath, '.git'), { force: true });
}

// ─── 1. preflight refusal: cwd inside the task ────────────────────────────────

describe('teardown refuses while the shell is inside the task', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('td-cwd');
    repoDir    = makeTempDir('repo-td-cwd');
    makeGitRepo(repoDir);
    addRepo(projectDir, repoDir, false);
  });
  afterEach(() => {
    try { git.deleteBranch(repoDir, 'feature/inside', true); } catch {}
    cleanup(projectDir, repoDir);
  });

  test('delete refuses and removes nothing when the cwd is inside a worktree', async () => {
    const { taskDir, wtPath } = makeTask(projectDir, repoDir, 'TASK-CWD', 'feature/inside');
    jest.spyOn(process, 'cwd').mockReturnValue(wtPath);

    await expect(runTask(projectDir, 'delete', 'TASK-CWD', '--yes', '--delete-branches'))
      .rejects.toThrow('process.exit(1)');

    // Nothing touched: folder, worktree and branch all still there.
    expect(fs.existsSync(taskDir)).toBe(true);
    expect(fs.existsSync(path.join(wtPath, '.git'))).toBe(true);
    expect(fs.existsSync(path.join(wtPath, 'README.md'))).toBe(true);
    expect(git.branchExistsLocally(repoDir, 'feature/inside')).toBe(true);
    expect(git.findWorktreeEntry(repoDir, wtPath)).toEqual({ branch: 'feature/inside' });

    expect(errored()).toContain('Cannot tear down TASK-CWD');
    expect(errored()).toContain('cd out of the task folder');
    expect(errored()).toContain(projectDir);
    // The refusal is up front — the lock probe never ran, so nothing was even renamed.
    expect(guard.probeRemovable).not.toHaveBeenCalled();
  });

  test('delete refuses when the cwd is the task folder itself', async () => {
    const { taskDir } = makeTask(projectDir, repoDir, 'TASK-CWD2', 'feature/inside');
    jest.spyOn(process, 'cwd').mockReturnValue(taskDir);

    await expect(runTask(projectDir, 'delete', 'TASK-CWD2', '--yes'))
      .rejects.toThrow('process.exit(1)');
    expect(fs.existsSync(taskDir)).toBe(true);
    expect(errored()).toContain('Cannot tear down TASK-CWD2');
  });

  test('archive refuses and archives nothing', async () => {
    const { taskDir, wtPath } = makeTask(projectDir, repoDir, 'TASK-CWD3', 'feature/inside');
    jest.spyOn(process, 'cwd').mockReturnValue(path.join(wtPath, 'nested', 'deeper'));

    await expect(runTask(projectDir, 'archive', 'TASK-CWD3', '--yes'))
      .rejects.toThrow('process.exit(1)');

    expect(fs.existsSync(taskDir)).toBe(true);
    expect(fs.existsSync(wtPath)).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'archived-tasks', 'TASK-CWD3'))).toBe(false);
    expect(fs.existsSync(path.join(taskDir, archive.MANIFEST_FILE))).toBe(false);
    expect(git.branchExistsLocally(repoDir, 'feature/inside')).toBe(true);
  });

  test('finish refuses before it fetches, verifies or archives anything', async () => {
    const { taskDir, wtPath } = makeTask(projectDir, repoDir, 'TASK-CWD4', 'feature/inside');
    jest.spyOn(process, 'cwd').mockReturnValue(wtPath);

    await expect(runTask(projectDir, 'finish', 'TASK-CWD4', '--yes'))
      .rejects.toThrow('process.exit(1)');

    expect(fs.existsSync(taskDir)).toBe(true);
    expect(fs.existsSync(wtPath)).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'archived-tasks', 'TASK-CWD4'))).toBe(false);
    expect(git.branchExistsLocally(repoDir, 'feature/inside')).toBe(true);
    expect(forge.prMergeState).not.toHaveBeenCalled();
    expect(errored()).toContain('Cannot tear down TASK-CWD4');
  });
});

// ─── 2. containment edge: tasks/foo vs tasks/foo-bar ──────────────────────────

describe('the containment check distinguishes tasks/foo from tasks/foo-bar', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('td-sibling');
    repoDir    = makeTempDir('repo-td-sibling');
    makeGitRepo(repoDir);
    addRepo(projectDir, repoDir, false);
  });
  afterEach(() => {
    for (const b of ['feature/foo', 'feature/foo-bar']) { try { git.deleteBranch(repoDir, b, true); } catch {} }
    cleanup(projectDir, repoDir);
  });

  test('a shell in tasks/foo-bar does not block deleting tasks/foo', async () => {
    const foo    = makeTask(projectDir, repoDir, 'foo',     'feature/foo');
    const fooBar = makeTask(projectDir, repoDir, 'foo-bar', 'feature/foo-bar');
    jest.spyOn(process, 'cwd').mockReturnValue(fooBar.wtPath);

    await runTask(projectDir, 'delete', 'foo', '--yes', '--delete-branches');

    expect(fs.existsSync(foo.taskDir)).toBe(false);
    expect(git.branchExistsLocally(repoDir, 'feature/foo')).toBe(false);
    // The sibling the shell is actually in is untouched.
    expect(fs.existsSync(fooBar.wtPath)).toBe(true);
    expect(git.branchExistsLocally(repoDir, 'feature/foo-bar')).toBe(true);
    expect(errored()).not.toContain('Cannot tear down');
  });

  test('a shell in tasks/foo-bar does block deleting tasks/foo-bar', async () => {
    const fooBar = makeTask(projectDir, repoDir, 'foo-bar', 'feature/foo-bar');
    jest.spyOn(process, 'cwd').mockReturnValue(fooBar.wtPath);

    await expect(runTask(projectDir, 'delete', 'foo-bar', '--yes')).rejects.toThrow('process.exit(1)');
    expect(fs.existsSync(fooBar.taskDir)).toBe(true);
  });
});

// ─── 3. fail before destroying: a locked worktree ─────────────────────────────

describe('teardown fails before destroying when a worktree is locked', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('td-lock');
    repoDir    = makeTempDir('repo-td-lock');
    makeGitRepo(repoDir);
    addRepo(projectDir, repoDir, false);
  });
  afterEach(() => {
    try { git.deleteBranch(repoDir, 'feature/locked', true); } catch {}
    cleanup(projectDir, repoDir);
  });

  test('delete stops with the worktree still intact', async () => {
    const { taskDir, wtPath } = makeTask(projectDir, repoDir, 'TASK-LOCK', 'feature/locked');
    guard.probeRemovable.mockReturnValue({ ok: false, code: 'EPERM', message: 'denied' });

    await expect(runTask(projectDir, 'delete', 'TASK-LOCK', '--yes', '--delete-branches'))
      .rejects.toThrow('process.exit(1)');

    expect(fs.existsSync(taskDir)).toBe(true);
    expect(fs.existsSync(path.join(wtPath, '.git'))).toBe(true);
    expect(git.branchExistsLocally(repoDir, 'feature/locked')).toBe(true);
    expect(errored()).toContain('is locked (EPERM)');
    expect(errored()).toContain('Nothing was touched');
  });

  test('archive stops before writing a manifest', async () => {
    const { taskDir, wtPath } = makeTask(projectDir, repoDir, 'TASK-LOCK2', 'feature/locked');
    guard.probeRemovable.mockReturnValue({ ok: false, code: 'EBUSY', message: 'busy' });

    await expect(runTask(projectDir, 'archive', 'TASK-LOCK2', '--yes'))
      .rejects.toThrow('process.exit(1)');

    expect(fs.existsSync(path.join(taskDir, archive.MANIFEST_FILE))).toBe(false);
    expect(fs.existsSync(path.join(wtPath, '.git'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'archived-tasks', 'TASK-LOCK2'))).toBe(false);
    expect(errored()).toContain('re-run: wksp task archive TASK-LOCK2');
  });
});

// ─── 4. never silently skip: an unreadable worktree ──────────────────────────

describe('an unreadable worktree makes the run report exactly what it skipped', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('td-degraded');
    repoDir    = makeTempDir('repo-td-degraded');
    makeGitRepo(repoDir);
    addRepo(projectDir, repoDir, false);
  });
  afterEach(() => {
    try { git.deleteBranch(repoDir, 'feature/gutted', true); } catch {}
    cleanup(projectDir, repoDir);
  });

  test('delete --delete-branches names the branch it did not delete, and fails', async () => {
    const { taskDir, wtPath } = makeTask(projectDir, repoDir, 'TASK-DEG', 'feature/gutted');
    gutWorktree(wtPath);

    await runTask(projectDir, 'delete', 'TASK-DEG', '--yes', '--delete-branches');

    expect(warned()).toContain('could not be torn down');
    expect(warned()).toContain('local branch NOT deleted: feature/gutted');
    expect(warned()).toContain(`git -C "${repoDir}" worktree prune`);
    expect(warned()).toContain(`git -C "${repoDir}" branch -D "feature/gutted"`);
    expect(process.exitCode).toBe(1);

    // The folder still comes away, and the branch really is still there.
    expect(fs.existsSync(taskDir)).toBe(false);
    expect(git.branchExistsLocally(repoDir, 'feature/gutted')).toBe(true);
  });

  test('delete without --delete-branches does not claim a branch step was skipped', async () => {
    const { wtPath } = makeTask(projectDir, repoDir, 'TASK-DEG2', 'feature/gutted');
    gutWorktree(wtPath);

    await runTask(projectDir, 'delete', 'TASK-DEG2', '--yes');

    expect(warned()).toContain('could not be torn down');
    expect(warned()).not.toContain('local branch NOT deleted');
    expect(process.exitCode).toBe(1);
  });

  test('an interactive yes to branch deletion still counts as a skipped branch step', async () => {
    // Two repos, one readable and one gutted: the prompt only offers the readable
    // branch, so the report has to key off the answer rather than the --delete-branches
    // flag to tell the truth about the gutted one.
    const repoB = makeTempDir('repo-td-degraded-b');
    makeGitRepo(repoB);
    addRepo(projectDir, repoB, false);
    try {
      const taskDir = path.join(projectDir, 'tasks', 'TASK-DEG6');
      fs.mkdirSync(path.join(taskDir, WORKTREES_DIR), { recursive: true });
      const wtA = path.join(taskDir, WORKTREES_DIR, path.basename(repoDir));
      const wtB = path.join(taskDir, WORKTREES_DIR, path.basename(repoB));
      git.addWorktree(repoDir, wtA, 'feature/gutted');   // readable
      git.addWorktree(repoB,   wtB, 'feature/b');        // about to be gutted
      gutWorktree(wtB);

      prompts.confirm
        .mockResolvedValueOnce(true)   // "Confirm?"
        .mockResolvedValueOnce(true);  // "Delete local branches (feature/gutted)?"

      await runTask(projectDir, 'delete', 'TASK-DEG6');

      expect(git.branchExistsLocally(repoDir, 'feature/gutted')).toBe(false); // the readable one went
      expect(warned()).toContain('local branch NOT deleted: feature/b');      // the gutted one didn't
      expect(git.branchExistsLocally(repoB, 'feature/b')).toBe(true);
      expect(process.exitCode).toBe(1);
    } finally { cleanup(repoB); }
  });

  test('archive says so instead of reporting plain success', async () => {
    const { wtPath } = makeTask(projectDir, repoDir, 'TASK-DEG3', 'feature/gutted');
    gutWorktree(wtPath);

    await runTask(projectDir, 'archive', 'TASK-DEG3', '--yes', '--delete-branches');

    expect(logged()).toContain('⚠  Archived TASK-DEG3 — with unfinished teardown.');
    expect(logged()).not.toContain('✓  Archived TASK-DEG3.');
    expect(warned()).toContain('local branch NOT deleted: feature/gutted');
    expect(process.exitCode).toBe(1);

    // Archived, with the corruption on the record — and the branch untouched.
    const manifest = archive.readManifest(path.join(projectDir, 'archived-tasks', 'TASK-DEG3'));
    expect(manifest.repos[0].note).toMatch(/corrupted at archive/);
    expect(manifest.repos[0].recoveredBranch).toBe('feature/gutted');
    expect(git.branchExistsLocally(repoDir, 'feature/gutted')).toBe(true);
  });

  test('finish --no-archive reports the same gaps through the delete path', async () => {
    const { taskDir, wtPath } = makeTask(projectDir, repoDir, 'TASK-DEG5', 'feature/gutted');
    gutWorktree(wtPath);

    await runTask(projectDir, 'finish', 'TASK-DEG5', '--no-archive', '--yes');

    expect(warned()).toContain('local branch NOT deleted: feature/gutted');
    expect(warned()).toContain('base repo NOT fast-forwarded');
    expect(warned()).toContain('is NOT fully finished');
    expect(process.exitCode).toBe(1);
    expect(fs.existsSync(taskDir)).toBe(false);
    expect(git.branchExistsLocally(repoDir, 'feature/gutted')).toBe(true);
  });

  test('finish reports the unverified branch, the skipped fast-forward, and does not claim success', async () => {
    const { wtPath } = makeTask(projectDir, repoDir, 'TASK-DEG4', 'feature/gutted');
    gutWorktree(wtPath);

    await runTask(projectDir, 'finish', 'TASK-DEG4', '--yes');

    expect(warned()).toContain('could not be read, so their branches were NOT');
    expect(warned()).toContain('base repo NOT fast-forwarded');
    expect(warned()).toContain(`git -C "${repoDir}" pull --ff-only`);
    expect(warned()).toContain('is NOT fully finished');
    expect(logged()).not.toContain('All branches merged');
    expect(process.exitCode).toBe(1);
    expect(git.branchExistsLocally(repoDir, 'feature/gutted')).toBe(true);
  });
});

// ─── 5. recovery from a half-archived task ───────────────────────────────────

describe('an archive interrupted after writing its manifest can be finished', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('td-recover');
    repoDir    = makeTempDir('repo-td-recover');
    makeGitRepo(repoDir);
    addRepo(projectDir, repoDir, false);
  });
  afterEach(() => {
    try { git.deleteBranch(repoDir, 'feature/half', true); } catch {}
    cleanup(projectDir, repoDir);
  });

  test('re-running archive re-uses the manifest instead of writing an empty one', async () => {
    const { taskDir, wtPath } = makeTask(projectDir, repoDir, 'TASK-HALF', 'feature/half');

    // Reproduce the half-state: worktrees removed and the manifest written into the
    // live task folder, but the folder never moved (the rename hit the same lock).
    const { entries } = archive.captureState(projectDir, 'TASK-HALF', 'test-project');
    archive.writeManifest(taskDir, {
      schemaVersion: archive.SCHEMA_VERSION,
      archivedAt: new Date().toISOString(),
      taskId: 'TASK-HALF', projectName: 'test-project', reason: 'finished', repos: entries,
    });
    git.removeWorktree(repoDir, wtPath);
    expect(fs.existsSync(wtPath)).toBe(false);

    await runTask(projectDir, 'archive', 'TASK-HALF', '--yes');

    expect(logged()).toContain('Recovering an interrupted archive of TASK-HALF');
    expect(fs.existsSync(taskDir)).toBe(false);

    // The record survives with the branch and tip sha captured while it was intact —
    // re-capturing at this point would have produced branch: null, tipSha: null.
    const manifest = archive.readManifest(path.join(projectDir, 'archived-tasks', 'TASK-HALF'));
    expect(manifest.repos[0].branch).toBe('feature/half');
    expect(manifest.repos[0].tipSha).toMatch(/^[0-9a-f]{40}$/);
    expect(process.exitCode).not.toBe(1);
  });
});

// ─── 6. the happy path is unchanged ──────────────────────────────────────────

describe('the guards do not disturb a normal teardown', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('td-happy');
    repoDir    = makeTempDir('repo-td-happy');
    makeGitRepo(repoDir);
    addRepo(projectDir, repoDir, false);
  });
  afterEach(() => {
    for (const b of ['feature/happy-del', 'feature/happy-arch']) { try { git.deleteBranch(repoDir, b, true); } catch {} }
    cleanup(projectDir, repoDir);
  });

  test('delete removes the worktree, the branch and the folder, and succeeds', async () => {
    const { taskDir, wtPath } = makeTask(projectDir, repoDir, 'HAPPY-DEL', 'feature/happy-del');

    await runTask(projectDir, 'delete', 'HAPPY-DEL', '--yes', '--delete-branches');

    expect(fs.existsSync(taskDir)).toBe(false);
    expect(fs.existsSync(wtPath)).toBe(false);
    expect(git.branchExistsLocally(repoDir, 'feature/happy-del')).toBe(false);
    expect(warned()).not.toContain('could not be torn down');
    expect(process.exitCode).not.toBe(1);
    // The lock probe ran and put the worktree back before git removed it for real.
    expect(guard.probeRemovable).toHaveBeenCalled();
  });

  test('archive still reports plain success and keeps the branch', async () => {
    const { taskDir } = makeTask(projectDir, repoDir, 'HAPPY-ARCH', 'feature/happy-arch');

    await runTask(projectDir, 'archive', 'HAPPY-ARCH', '--yes');

    expect(logged()).toContain('✓  Archived HAPPY-ARCH.');
    expect(fs.existsSync(taskDir)).toBe(false);
    const manifest = archive.readManifest(path.join(projectDir, 'archived-tasks', 'HAPPY-ARCH'));
    expect(manifest.repos[0].branch).toBe('feature/happy-arch');
    expect(manifest.repos[0].branchKeptInBaseRepo).toBe(true);
    expect(git.branchExistsLocally(repoDir, 'feature/happy-arch')).toBe(true);
    expect(process.exitCode).not.toBe(1);
  });
});
