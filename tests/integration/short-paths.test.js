'use strict';
// PLANNING #25 — one directory, two names, and the guards that compared them as
// strings.
//
// Windows gives any path component over 8 characters (or containing a space) a second
// 8.3 name: C:\Users\runneradmin and C:\Users\RUNNER~1 are the same directory. The
// GitHub Windows runner serves %TEMP% that way, and so does any machine whose username
// is long enough — which is most of them. git always reports the LONG form, while wksp
// holds whatever spelling it was handed, so every "is this the same directory?" in the
// codebase was a comparison between two spellings of one answer.
//
// The consequence worth testing is not the mismatched strings, it is that
// `wksp repo remove` filtered a worktree out of its own to-do list on that mismatch and
// so never ran the cwd guard over it — deleting a worktree with a live shell inside it,
// silently, which is the failure mode the guard exists to prevent.
//
// These tests build the scenario ON PURPOSE instead of waiting for a runner to supply
// it, and skip when the volume will not produce a short name (8.3 generation is a
// per-volume NTFS setting, and does not exist off Windows at all).
const fs   = require('fs');
const path = require('path');
const { makeTempDir, makeGitRepo, cleanup, shortPathOf } = require('../helpers');
const git = require('../../lib/git');
const { WORKTREES_DIR, discoverWorktrees, findWorktreeRegistration } = require('../../lib/worktrees');
const { isCwdInside } = require('../../lib/teardown-guard');

jest.mock('../../lib/prompts', () => ({
  open: jest.fn(), close: jest.fn(), ask: jest.fn(), confirm: jest.fn(),
}));

jest.mock('../../lib/config', () => {
  const actual = jest.requireActual('../../lib/config');
  return {
    ...actual,
    findProjectDir:    jest.fn(),
    readProjectConfig: jest.fn().mockReturnValue({ name: 'test-project' }),
    readConfig:        jest.fn().mockReturnValue({ autoResume: false }),
  };
});

const prompts = require('../../lib/prompts');
const config  = require('../../lib/config');
const repoCmd = require('../../lib/commands/repo');

// Can this machine hand us a short name at all? Answered once, outside any test, so
// the whole file reports as skipped rather than failing on a volume with
// NtfsDisable8dot3NameCreation set.
const probe          = process.platform === 'win32' ? makeTempDir('wksp-shortpath-probe') : null;
const shortNamesWork = probe ? shortPathOf(probe) !== null : false;
if (probe) cleanup(probe);

const describeShortPaths = shortNamesWork ? describe : describe.skip;

describeShortPaths('8.3 short paths name the same directory as their long form', () => {
  let longRoot, shortRoot, projectDir, repoDir, errorLines;

  beforeEach(() => {
    // The root's own name is well over 8 characters, so it is guaranteed an alias.
    longRoot  = makeTempDir('wksp-shortpath-scenario');
    shortRoot = shortPathOf(longRoot);
    // The module-level probe already said this volume generates aliases, so a null here
    // would be a surprise — say so plainly rather than failing on path.join(null, …).
    if (!shortRoot) throw new Error(`no 8.3 alias generated for ${longRoot}`);

    // Everything below addresses the tree through the SHORT root — exactly what
    // os.tmpdir() hands the GitHub Windows runner — while git will report the long one.
    projectDir = path.join(shortRoot, 'project');
    repoDir    = path.join(shortRoot, 'baserepository');
    fs.mkdirSync(path.join(projectDir, 'tasks'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.wksp'), JSON.stringify({ name: 'shortpath' }) + '\n');
    fs.writeFileSync(path.join(projectDir, 'repos.txt'), '# Workspace repos\n\n');
    fs.mkdirSync(repoDir, { recursive: true });
    makeGitRepo(repoDir);

    errorLines = [];
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation((...a) => errorLines.push(a.join(' ')));
    jest.spyOn(process, 'exit').mockImplementation(code => { throw new Error(`process.exit(${code})`); });
    prompts.confirm.mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    cleanup(longRoot);   // the short root is the same directory
  });

  async function runRepo(...args) {
    config.findProjectDir.mockReturnValue(projectDir);
    await repoCmd.run(args);
  }

  function makeTask(taskId, branch) {
    const taskDir = path.join(projectDir, 'tasks', taskId);
    fs.mkdirSync(path.join(taskDir, WORKTREES_DIR), { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'CLAUDE.md'), `## Task: ${taskId}\n`);
    const wtPath = path.join(taskDir, WORKTREES_DIR, path.basename(repoDir));
    git.addWorktree(repoDir, wtPath, branch, null, 'pipe');
    return { taskDir, wtPath };
  }

  // The scenario is only worth anything if the two names really do differ while naming
  // one directory. Note `longRoot` is only "long" relative to `shortRoot` — when TEMP is
  // itself an 8.3 path (the GitHub Windows runner, and the local simulation of it) every
  // path here carries a short component, which is the whole point.
  test('the fixture actually produces two different spellings of one directory', () => {
    expect(shortRoot.toLowerCase()).not.toBe(longRoot.toLowerCase());
    expect(fs.realpathSync.native(shortRoot).toLowerCase())
      .toBe(fs.realpathSync.native(longRoot).toLowerCase());
  });

  // ─── THE FAIL-OPEN ──────────────────────────────────────────────────────────
  // `handleRemove` matches each discovered worktree against the repo being removed
  // before it runs any guard over it. `wt.baseRepo` is read out of the worktree's .git
  // file, so it is git's LONG form; the repo path is the SHORT one repos.txt holds.
  // Compared as strings they differ, the worktree drops out of `orphaned`, and the
  // isCwdInside / probeRemovable guards below never see it — so `repo remove` went
  // ahead with a shell sitting in the worktree it was about to delete, and said nothing.
  test('repo remove still refuses while the shell is inside a worktree found by its short name', async () => {
    await runRepo('add', repoDir);
    const { taskDir, wtPath } = makeTask('TASK-SHORT-CWD', 'feature/short-cwd');
    prompts.confirm.mockResolvedValueOnce(true);          // "Remove these worktrees too?"
    jest.spyOn(process, 'cwd').mockReturnValue(wtPath);

    await expect(runRepo('remove', repoDir)).rejects.toThrow('process.exit(1)');

    expect(errorLines.join('\n')).toContain('your shell is inside');
    // And nothing was touched: worktree, task folder, branch and registration all intact.
    expect(fs.existsSync(path.join(wtPath, '.git'))).toBe(true);
    expect(fs.existsSync(taskDir)).toBe(true);
    expect(git.branchExistsLocally(repoDir, 'feature/short-cwd')).toBe(true);
    expect(fs.readFileSync(path.join(projectDir, 'repos.txt'), 'utf8')).toContain(path.basename(repoDir));
  });

  // The same refusal, with the shell reporting the LONG spelling — the realistic shape,
  // since a shell that walked into the directory normally reports the long name while
  // wksp derived the task path from a short-named root.
  test('repo remove refuses when the shell reports the long spelling of that worktree', async () => {
    await runRepo('add', repoDir);
    const { wtPath } = makeTask('TASK-SHORT-CWD2', 'feature/short-cwd2');
    prompts.confirm.mockResolvedValueOnce(true);
    jest.spyOn(process, 'cwd').mockReturnValue(fs.realpathSync.native(wtPath));

    await expect(runRepo('remove', repoDir)).rejects.toThrow('process.exit(1)');
    expect(errorLines.join('\n')).toContain('your shell is inside');
    expect(fs.existsSync(path.join(wtPath, '.git'))).toBe(true);
  });

  // ─── the guard's own containment check ──────────────────────────────────────
  test('isCwdInside sees a long-form cwd inside a short-form task folder', () => {
    const { taskDir, wtPath } = makeTask('TASK-SHORT-GUARD', 'feature/short-guard');
    const longWt = fs.realpathSync.native(wtPath);
    expect(longWt).not.toBe(wtPath);

    jest.spyOn(process, 'cwd').mockReturnValue(longWt);
    expect(isCwdInside(taskDir)).toBe(true);
    expect(isCwdInside(wtPath)).toBe(true);

    // …and a sibling task is still outside it, so the eagerness has not turned into
    // "refuse everything".
    const other = makeTask('TASK-SHORT-GUARD-2', 'feature/short-guard-2');
    expect(isCwdInside(other.taskDir)).toBe(false);
  });

  // ─── identity lookups against git ───────────────────────────────────────────
  test('findWorktreeEntry matches git\'s long-form registration when asked with the short one', () => {
    const { wtPath } = makeTask('TASK-SHORT-ENTRY', 'feature/short-entry');

    expect(git.findWorktreeEntry(repoDir, wtPath)).toEqual({ branch: 'feature/short-entry' });
    // Both spellings, one answer.
    expect(git.findWorktreeEntry(repoDir, fs.realpathSync.native(wtPath)))
      .toEqual({ branch: 'feature/short-entry' });
  });

  // This is how the branch name of a worktree wrecked mid-teardown is recovered. It
  // walks repos.txt (short spelling) and asks git (long spelling), so it returned null
  // and the run reported "name unrecoverable (no .git file, no registration)".
  test('findWorktreeRegistration recovers the branch of a gutted worktree across spellings', async () => {
    await runRepo('add', repoDir);
    const { wtPath } = makeTask('TASK-SHORT-REG', 'feature/short-reg');
    fs.rmSync(path.join(wtPath, '.git'), { force: true });   // the mid-teardown state

    const wts = discoverWorktrees(path.join(projectDir, 'tasks', 'TASK-SHORT-REG'));
    expect(wts[0].corrupted).toBe(true);
    expect(findWorktreeRegistration(projectDir, wtPath))
      .toEqual({ baseRepo: expect.any(String), branch: 'feature/short-reg' });
  });

  // A repo registered under one spelling has to be removable by the other, or
  // `repos.removeRepo` throws "Repo not found" — after handleRemove has already torn
  // the orphaned worktrees down.
  test('a repo registered by its short name can be removed by its long name', async () => {
    await runRepo('add', repoDir);
    await runRepo('remove', fs.realpathSync.native(repoDir));
    expect(fs.readFileSync(path.join(projectDir, 'repos.txt'), 'utf8'))
      .not.toContain(path.basename(repoDir));
  });

  // Same refusal a repeat of the identical string already got (repo.test.js), rather
  // than two repos.txt entries for one directory.
  test('and it cannot be registered twice under the two spellings', async () => {
    await runRepo('add', repoDir);
    await expect(runRepo('add', fs.realpathSync.native(repoDir))).rejects.toThrow('already registered');
  });
});
