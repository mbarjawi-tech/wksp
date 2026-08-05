'use strict';
// The project-wide `wksp delete` has the exact same class of risk this PR fixes for
// `wksp task delete` / `archive` / `finish`: it calls `git.removeWorktree` directly
// per task (IMPORTANT 5) and then `fs.rmSync(task.taskDir, { recursive: true, force:
// true })` (BLOCKER 2) — so a shell inside a worktree, a lock on one, or a worktree
// probe stranded by a crashed run must all be caught before either of those, not
// after.
const fs   = require('fs');
const path = require('path');
const { makeTempDir, makeGitRepo, makeProject, cleanup } = require('../helpers');
const { addRepo } = require('../../lib/repos');
const git = require('../../lib/git');
const { WORKTREES_DIR } = require('../../lib/worktrees');

jest.mock('../../lib/prompts', () => ({
  open: jest.fn(), close: jest.fn(), ask: jest.fn(), confirm: jest.fn(), confirmTyped: jest.fn(),
}));

jest.mock('../../lib/config', () => {
  const actual = jest.requireActual('../../lib/config');
  return {
    ...actual,
    findProjectDir:    jest.fn(),
    readProjectConfig: jest.fn().mockReturnValue({ name: 'test-project' }),
  };
});

// Real guards, except that probeRemovable can be made to report a lock — there is no
// portable way to hold a directory open from inside the test process (mirrors
// tests/integration/task-teardown-safety.test.js).
jest.mock('../../lib/teardown-guard', () => {
  const actual = jest.requireActual('../../lib/teardown-guard');
  return { ...actual, probeRemovable: jest.fn(actual.probeRemovable) };
});

const prompts   = require('../../lib/prompts');
const config    = require('../../lib/config');
const guard     = require('../../lib/teardown-guard');
const deleteCmd = require('../../lib/commands/delete');

let errorLines, logLines, warnLines;
beforeEach(() => {
  errorLines = [];
  logLines = [];
  warnLines = [];
  jest.spyOn(console, 'log').mockImplementation((...args) => logLines.push(args.join(' ')));
  jest.spyOn(console, 'warn').mockImplementation((...args) => warnLines.push(args.join(' ')));
  jest.spyOn(console, 'error').mockImplementation((...args) => errorLines.push(args.join(' ')));
  jest.spyOn(process, 'exit').mockImplementation(code => { throw new Error(`process.exit(${code})`); });
  prompts.ask.mockReset();
  prompts.confirm.mockReset();
  prompts.confirmTyped.mockReset();
  guard.probeRemovable.mockClear();
  guard.probeRemovable.mockImplementation(jest.requireActual('../../lib/teardown-guard').probeRemovable);
});
afterEach(() => jest.restoreAllMocks());

async function runDelete(projectDir) {
  config.findProjectDir.mockReturnValue(projectDir);
  prompts.confirmTyped.mockResolvedValueOnce(true); // "Type <project> to confirm"
  await deleteCmd.run();
}

function makeTaskWithWorktree(projectDir, repoDir, taskId, branch) {
  const taskDir = path.join(projectDir, 'tasks', taskId);
  fs.mkdirSync(path.join(taskDir, WORKTREES_DIR), { recursive: true });
  const wtPath = path.join(taskDir, WORKTREES_DIR, path.basename(repoDir));
  git.addWorktree(repoDir, wtPath, branch);
  return { taskDir, wtPath };
}

describe('wksp delete — teardown safety', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('delete-safety');
    repoDir    = makeTempDir('delete-safety-repo');
    makeGitRepo(repoDir);
    addRepo(projectDir, repoDir, false);
  });
  afterEach(() => {
    for (const b of ['feature/del-cwd', 'feature/del-lock', 'feature/del-ok', 'feature/del-stranded', 'feature/del-taskcwd']) {
      try { git.deleteBranch(repoDir, b, true); } catch {}
    }
    cleanup(projectDir, repoDir);
  });

  test('refuses and deletes nothing when the shell is inside a worktree', async () => {
    const { taskDir, wtPath } = makeTaskWithWorktree(projectDir, repoDir, 'TASK-DEL-CWD', 'feature/del-cwd');
    jest.spyOn(process, 'cwd').mockReturnValue(wtPath);

    await expect(runDelete(projectDir)).rejects.toThrow('process.exit(1)');

    expect(fs.existsSync(path.join(wtPath, '.git'))).toBe(true);
    expect(fs.existsSync(taskDir)).toBe(true);
    expect(fs.existsSync(projectDir)).toBe(true);
    expect(git.branchExistsLocally(repoDir, 'feature/del-cwd')).toBe(true);
    expect(errorLines.join('\n')).toContain('shell is inside');
  });

  test('refuses and deletes nothing when a worktree is locked', async () => {
    const { taskDir, wtPath } = makeTaskWithWorktree(projectDir, repoDir, 'TASK-DEL-LOCK', 'feature/del-lock');
    guard.probeRemovable.mockReturnValue({ ok: false, code: 'EBUSY', message: 'busy' });

    await expect(runDelete(projectDir)).rejects.toThrow('process.exit(1)');

    expect(fs.existsSync(path.join(wtPath, '.git'))).toBe(true);
    expect(fs.existsSync(taskDir)).toBe(true);
    expect(fs.existsSync(projectDir)).toBe(true);
    expect(git.branchExistsLocally(repoDir, 'feature/del-lock')).toBe(true);
    expect(errorLines.join('\n')).toContain('is locked (EBUSY)');
  });

  // MINOR 4: a shell in tasks/<id>/ itself — not in a worktree — passed every guard,
  // because they all checked the WORKTREE paths, and then the bulk
  // `fs.rmSync(task.taskDir, ...)` failed with a bare `Fatal:`. The process.chdir further
  // down only protects the project folder, long after every task folder is gone.
  test('refuses cleanly when the shell is in the task folder itself, not a worktree', async () => {
    const { taskDir, wtPath } = makeTaskWithWorktree(projectDir, repoDir, 'TASK-DEL-TASKCWD', 'feature/del-taskcwd');
    jest.spyOn(process, 'cwd').mockReturnValue(taskDir);

    await expect(runDelete(projectDir)).rejects.toThrow('process.exit(1)');

    // Refused before the first destructive step: the worktree is intact, so this is not
    // "it failed after gutting the checkout" dressed up as a refusal.
    expect(fs.existsSync(path.join(wtPath, '.git'))).toBe(true);
    expect(fs.existsSync(taskDir)).toBe(true);
    expect(fs.existsSync(projectDir)).toBe(true);
    expect(git.branchExistsLocally(repoDir, 'feature/del-taskcwd')).toBe(true);
    const errs = errorLines.join('\n');
    expect(errs).toContain('shell is inside');
    expect(errs).toContain('re-run: wksp delete');
    // `wksp task delete <id>` would refuse for exactly the same reason — don't send the
    // user round that loop.
    expect(errs).not.toContain('Fix with: wksp task delete');
    // The probe never ran either, so nothing was even renamed to test it.
    expect(guard.probeRemovable).not.toHaveBeenCalled();
  });

  // MINOR 4, second half: the task folder's own rmSync had no catch, so a locked file
  // inside tasks/<id>/ came out as a bare `Fatal:` rather than naming the re-run.
  test('a task folder that cannot be deleted names the command to re-run', async () => {
    makeTaskWithWorktree(projectDir, repoDir, 'TASK-DEL-RM', 'feature/del-ok');
    jest.spyOn(process, 'chdir').mockImplementation(() => {});
    const realRm = fs.rmSync;
    jest.spyOn(fs, 'rmSync').mockImplementation((target, opts) => {
      if (path.basename(target) === 'TASK-DEL-RM') throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return realRm(target, opts);
    });

    await expect(runDelete(projectDir)).rejects.toThrow('process.exit(1)');

    const errs = errorLines.join('\n');
    expect(errs).toContain('Kept tasks/TASK-DEL-RM/');
    expect(errs).toContain('(EBUSY)');
    expect(errs).toContain('re-run: wksp delete');
  });

  test('a recoverable stranded probe is put back and torn down normally, not silently swept up', async () => {
    const { taskDir, wtPath } = makeTaskWithWorktree(projectDir, repoDir, 'TASK-DEL-STRANDED-OK', 'feature/del-stranded');
    const folderName   = path.basename(wtPath);
    const strandedPath = path.join(taskDir, `.wksp-probe-${folderName}`);
    fs.renameSync(wtPath, strandedPath); // reproduce the crash: renamed aside, never renamed back
    jest.spyOn(process, 'chdir').mockImplementation(() => {});

    await runDelete(projectDir);

    // Recovered, discovered, and torn down through the normal `git worktree remove`
    // path — not just folder-deleted along with everything else. Without the
    // recovery fix this worktree would never have been discovered at all, so
    // `git.removeWorktree` would never have run on it and the base repo would be left
    // with a stale, unpruned registration.
    expect(fs.existsSync(projectDir)).toBe(false);
    expect(git.findWorktreeEntry(repoDir, wtPath)).toBeNull();
  });

  test('an unrecoverable stranded probe blocks the whole project delete instead of being swept up', async () => {
    const { taskDir, wtPath } = makeTaskWithWorktree(projectDir, repoDir, 'TASK-DEL-STRANDED', 'feature/del-stranded');
    const folderName   = path.basename(wtPath);
    const strandedPath = path.join(taskDir, `.wksp-probe-${folderName}`);
    fs.renameSync(wtPath, strandedPath); // reproduce the crash: renamed aside, never renamed back

    // The "should never happen" collision: something already occupies the recovery
    // target, so the rename-back cannot land — exercised directly rather than
    // mocking fs, since it is easy to reproduce for real.
    fs.mkdirSync(wtPath, { recursive: true });
    fs.writeFileSync(path.join(wtPath, 'placeholder.txt'), 'x');

    await expect(runDelete(projectDir)).rejects.toThrow('process.exit(1)');

    // Refused — the task folder (and the stray probe inside it) both survive, rather
    // than being silently rm -rf'd as part of the project-wide delete.
    expect(fs.existsSync(taskDir)).toBe(true);
    expect(fs.existsSync(strandedPath)).toBe(true);
    expect(fs.existsSync(projectDir)).toBe(true);
    expect(git.branchExistsLocally(repoDir, 'feature/del-stranded')).toBe(true);
    expect(errorLines.join('\n')).toContain('stranded');
  });

  // MINOR 3: the per-task discovery ran with `recover: true` during enumeration — i.e.
  // BEFORE confirmTyped — so a user who mistyped the project name and cancelled had still
  // had directories renamed under them, and had been told `⚠ Put "<repo>" back`, for a
  // command that never ran.
  test('cancelling at the confirm leaves a stranded probe exactly where it was', async () => {
    const { taskDir, wtPath } = makeTaskWithWorktree(projectDir, repoDir, 'TASK-DEL-CANCEL', 'feature/del-stranded');
    const folderName   = path.basename(wtPath);
    const strandedPath = path.join(taskDir, `.wksp-probe-${folderName}`);
    fs.renameSync(wtPath, strandedPath);

    config.findProjectDir.mockReturnValue(projectDir);
    prompts.confirmTyped.mockResolvedValueOnce(false); // mistyped the project name
    await deleteCmd.run();

    // A cancelled command mutates nothing — and says nothing about having moved anything.
    expect(fs.existsSync(strandedPath)).toBe(true);
    expect(fs.existsSync(wtPath)).toBe(false);
    expect(fs.existsSync(projectDir)).toBe(true);
    expect(warnLines.join('\n')).not.toContain(`Put "${folderName}" back`);
    expect(logLines.join('\n')).toContain('Cancelled.');
  });

  // MINOR 3, second half: refuseTaskCwd fired inside the per-task loop, so a shell sitting
  // in the LAST task blocked the run only after every earlier task had already been
  // deleted — one blocker turned into a half-deleted project. It is a pre-loop now, the
  // way lib/commands/repo.js checks every worktree before it removes any.
  test('a cwd blocker in a later task refuses before any earlier task is deleted', async () => {
    const a = makeTaskWithWorktree(projectDir, repoDir, 'TASK-DEL-A', 'feature/del-ok');
    const b = makeTaskWithWorktree(projectDir, repoDir, 'TASK-DEL-B', 'feature/del-cwd');
    jest.spyOn(process, 'cwd').mockReturnValue(b.taskDir);

    await expect(runDelete(projectDir)).rejects.toThrow('process.exit(1)');

    // The earlier task never even started being deleted.
    expect(logLines.join('\n')).not.toContain('Deleting task: TASK-DEL-A');
    expect(fs.existsSync(a.taskDir)).toBe(true);
    expect(fs.existsSync(path.join(a.wtPath, '.git'))).toBe(true);
    expect(fs.existsSync(b.taskDir)).toBe(true);
    expect(fs.existsSync(projectDir)).toBe(true);
    expect(errorLines.join('\n')).toContain('shell is inside');
    // Nothing was renamed to test it, either.
    expect(guard.probeRemovable).not.toHaveBeenCalled();
  });

  test('still deletes everything cleanly when nothing is locked or in the way', async () => {
    const { wtPath } = makeTaskWithWorktree(projectDir, repoDir, 'TASK-DEL-OK', 'feature/del-ok');
    jest.spyOn(process, 'cwd').mockReturnValue(makeTempDir('delete-safety-elsewhere'));
    jest.spyOn(process, 'chdir').mockImplementation(() => {});

    await runDelete(projectDir);

    // `wksp delete` (project-wide) only ever tore down worktrees and folders, never
    // branches — that is unchanged, so the branch surviving here is expected, not a
    // regression the new guards introduced.
    expect(fs.existsSync(wtPath)).toBe(false);
    expect(fs.existsSync(projectDir)).toBe(false);
    expect(errorLines).toEqual([]);
  });
});
