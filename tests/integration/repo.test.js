'use strict';
const fs   = require('fs');
const path = require('path');
const { makeTempDir, makeGitRepo, makeProject, cleanup } = require('../helpers');
const git = require('../../lib/git');
const { WORKTREES_DIR } = require('../../lib/worktrees');

jest.mock('../../lib/prompts', () => ({
  open: jest.fn(), close: jest.fn(), ask: jest.fn(), confirm: jest.fn(),
}));

jest.mock('../../lib/providers/claude', () => ({
  name: 'claude', instructionFile: 'CLAUDE.md',
  launch: jest.fn(), sessions: { findLast: jest.fn().mockReturnValue(null) },
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

// Real guards, except that probeRemovable can be made to report a lock — there is no
// portable way to hold a directory open from inside the test process (mirrors
// tests/integration/task-teardown-safety.test.js).
jest.mock('../../lib/teardown-guard', () => {
  const actual = jest.requireActual('../../lib/teardown-guard');
  return { ...actual, probeRemovable: jest.fn(actual.probeRemovable) };
});

const prompts  = require('../../lib/prompts');
const config   = require('../../lib/config');
const guard    = require('../../lib/teardown-guard');
const repoCmd  = require('../../lib/commands/repo');

let logLines, errorLines;
beforeEach(() => {
  logLines = [];
  errorLines = [];
  jest.spyOn(console, 'log').mockImplementation((...args)  => logLines.push(args.join(' ')));
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation((...args) => errorLines.push(args.join(' ')));
  jest.spyOn(process, 'exit').mockImplementation(code => {
    throw new Error(`process.exit(${code})`);
  });
  prompts.ask.mockReset();
  prompts.confirm.mockReset();
  prompts.open.mockReset();
  prompts.close.mockReset();
  guard.probeRemovable.mockClear();
  guard.probeRemovable.mockImplementation(jest.requireActual('../../lib/teardown-guard').probeRemovable);
});
afterEach(() => jest.restoreAllMocks());

async function runRepo(projectDir, ...args) {
  config.findProjectDir.mockReturnValue(projectDir);
  await repoCmd.run(args);
}

// A task folder with one real worktree on the given repo, built without going
// through the task-create prompts (mirrors task-teardown-safety.test.js).
function makeTaskWithWorktree(projectDir, repoDir, taskId, branch) {
  const taskDir = path.join(projectDir, 'tasks', taskId);
  fs.mkdirSync(path.join(taskDir, WORKTREES_DIR), { recursive: true });
  const wtPath = path.join(taskDir, WORKTREES_DIR, path.basename(repoDir));
  git.addWorktree(repoDir, wtPath, branch);
  return { taskDir, wtPath };
}

// ─── wksp repo add ───────────────────────────────────────────────────────────

describe('wksp repo add', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('repo-add-1');
    repoDir    = makeTempDir('repo-add-src');
    makeGitRepo(repoDir);
  });
  afterEach(() => cleanup(projectDir, repoDir));

  test('adds a local path to repos.txt', async () => {
    await runRepo(projectDir, 'add', repoDir);
    const reposTxt = fs.readFileSync(path.join(projectDir, 'repos.txt'), 'utf8');
    expect(reposTxt).toContain(path.basename(repoDir));
    expect(logLines.some(l => l.includes('Added to repos.txt'))).toBe(true);
  });

  test('adds with --shared flag', async () => {
    await runRepo(projectDir, 'add', repoDir, '--shared');
    const reposTxt = fs.readFileSync(path.join(projectDir, 'repos.txt'), 'utf8');
    expect(reposTxt).toMatch(/--shared/);
    expect(logLines.some(l => l.includes('--shared'))).toBe(true);
  });

  test('adds with --optional flag and prints the pull-in hint', async () => {
    await runRepo(projectDir, 'add', repoDir, '--optional');
    const reposTxt = fs.readFileSync(path.join(projectDir, 'repos.txt'), 'utf8');
    expect(reposTxt).toMatch(/--optional/);
    expect(logLines.some(l => l.includes('(--optional)'))).toBe(true);
    expect(logLines.some(l => l.includes(`wksp task repo <task-id> ${path.basename(repoDir)} worktree`))).toBe(true);
  });

  test('exits 1 when no path given', async () => {
    await expect(runRepo(projectDir, 'add')).rejects.toThrow('process.exit(1)');
  });

  test('throws when adding a duplicate repo', async () => {
    await runRepo(projectDir, 'add', repoDir);
    await expect(runRepo(projectDir, 'add', repoDir)).rejects.toThrow('already registered');
  });
});

// ─── wksp repo remove ────────────────────────────────────────────────────────

describe('wksp repo remove', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('repo-remove-1');
    repoDir    = makeTempDir('repo-remove-src');
    makeGitRepo(repoDir);
  });
  afterEach(() => cleanup(projectDir, repoDir));

  test('removes a repo from repos.txt', async () => {
    await runRepo(projectDir, 'add', repoDir);
    await runRepo(projectDir, 'remove', repoDir);
    const reposTxt = fs.readFileSync(path.join(projectDir, 'repos.txt'), 'utf8');
    expect(reposTxt).not.toContain(repoDir.replace(/\\/g, '/'));
    expect(logLines.some(l => l.includes('Removed from repos.txt'))).toBe(true);
  });

  test('exits 1 when no path given', async () => {
    await expect(runRepo(projectDir, 'remove')).rejects.toThrow('process.exit(1)');
  });
});

// ─── wksp repo remove — teardown-safety guards (IMPORTANT 5) ─────────────────
// `repo remove` tears down orphaned worktrees across every task registered against
// the repo, via the same `git.removeWorktree` this PR made safe elsewhere — so it
// needs the same cwd/lock guards, or it reproduces the exact bug they fix.

describe('wksp repo remove — teardown safety', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('repo-remove-safety');
    repoDir    = makeTempDir('repo-remove-safety-src');
    makeGitRepo(repoDir);
  });
  afterEach(() => {
    try { git.deleteBranch(repoDir, 'feature/orphan', true); } catch {}
    cleanup(projectDir, repoDir);
  });

  test('refuses and removes nothing when the shell is inside an orphaned worktree', async () => {
    await runRepo(projectDir, 'add', repoDir);
    const { taskDir, wtPath } = makeTaskWithWorktree(projectDir, repoDir, 'TASK-ORPHAN-CWD', 'feature/orphan');
    prompts.confirm.mockResolvedValueOnce(true); // "Remove these worktrees too?"
    jest.spyOn(process, 'cwd').mockReturnValue(wtPath);

    await expect(runRepo(projectDir, 'remove', repoDir)).rejects.toThrow('process.exit(1)');

    expect(fs.existsSync(path.join(wtPath, '.git'))).toBe(true);
    expect(fs.existsSync(taskDir)).toBe(true);
    expect(git.branchExistsLocally(repoDir, 'feature/orphan')).toBe(true);
    expect(errorLines.join('\n')).toContain('your shell is inside');
    // repos.txt is untouched too — the refusal happens before removeRepo runs.
    const reposTxt = fs.readFileSync(path.join(projectDir, 'repos.txt'), 'utf8');
    expect(reposTxt).toContain(path.basename(repoDir));
  });

  test('refuses and removes nothing when the orphaned worktree is locked', async () => {
    await runRepo(projectDir, 'add', repoDir);
    const { taskDir, wtPath } = makeTaskWithWorktree(projectDir, repoDir, 'TASK-ORPHAN-LOCK', 'feature/orphan');
    prompts.confirm.mockResolvedValueOnce(true);
    guard.probeRemovable.mockReturnValue({ ok: false, code: 'EPERM', message: 'denied' });

    await expect(runRepo(projectDir, 'remove', repoDir)).rejects.toThrow('process.exit(1)');

    expect(fs.existsSync(path.join(wtPath, '.git'))).toBe(true);
    expect(fs.existsSync(taskDir)).toBe(true);
    expect(git.branchExistsLocally(repoDir, 'feature/orphan')).toBe(true);
    expect(errorLines.join('\n')).toContain('is locked (EPERM)');
    const reposTxt = fs.readFileSync(path.join(projectDir, 'repos.txt'), 'utf8');
    expect(reposTxt).toContain(path.basename(repoDir));
  });

  // REQUIRED 2 (round 2): a stranded probe has `baseRepo: null` while it sits aside, so
  // the `normalizePath(wt.baseRepo) !== normalized` filter skipped it with no warning and
  // it never reached `orphaned` — and then `repos.removeRepo` ran unconditionally. That is
  // the worst possible order: findWorktreeRegistration recovers a wrecked worktree's
  // branch name by walking repos.txt, so deregistering the repo while the probe is
  // stranded makes the branch name permanently unrecoverable.
  test('refuses, and keeps the repo registered, when a task has an unrecoverable stranded probe', async () => {
    await runRepo(projectDir, 'add', repoDir);
    const { taskDir, wtPath } = makeTaskWithWorktree(projectDir, repoDir, 'TASK-ORPHAN-STRANDED', 'feature/orphan');
    const folderName   = path.basename(wtPath);
    const strandedPath = path.join(taskDir, `.wksp-probe-${folderName}`);
    fs.renameSync(wtPath, strandedPath); // the crash: renamed aside, never renamed back

    // The recovery target is occupied, so the automatic rename-back cannot land — the one
    // state where `repo remove` has to refuse rather than carry on.
    fs.mkdirSync(wtPath, { recursive: true });
    fs.writeFileSync(path.join(wtPath, 'placeholder.txt'), 'x');

    await expect(runRepo(projectDir, 'remove', repoDir)).rejects.toThrow('process.exit(1)');

    // The trail is intact: the probe is where it was, and repos.txt still names the base
    // repo that `git worktree list` can be asked for the branch.
    expect(fs.existsSync(strandedPath)).toBe(true);
    expect(git.branchExistsLocally(repoDir, 'feature/orphan')).toBe(true);
    const reposTxt = fs.readFileSync(path.join(projectDir, 'repos.txt'), 'utf8');
    expect(reposTxt).toContain(path.basename(repoDir));
    // Said so out loud, rather than skipping it silently as the old filter did.
    const errs = errorLines.join('\n');
    expect(errs).toContain('stranded');
    expect(errs).toContain(`TASK-ORPHAN-STRANDED/${folderName}`);
    expect(errs).toContain(`re-run: wksp repo remove ${repoDir}`);
    // Never got as far as asking about worktrees — the refusal precedes the prompt.
    expect(prompts.confirm).not.toHaveBeenCalled();
  });

  test('a recoverable stranded probe is put back, then removed like any other worktree', async () => {
    await runRepo(projectDir, 'add', repoDir);
    const { taskDir, wtPath } = makeTaskWithWorktree(projectDir, repoDir, 'TASK-ORPHAN-STRANDED-OK', 'feature/orphan');
    const strandedPath = path.join(taskDir, `.wksp-probe-${path.basename(wtPath)}`);
    fs.renameSync(wtPath, strandedPath);
    prompts.confirm.mockResolvedValueOnce(true); // "Remove these worktrees too?"

    await runRepo(projectDir, 'remove', repoDir);

    // Put back, matched against this repo, and torn down through git — so no stale
    // registration is left behind in the base repo.
    expect(fs.existsSync(strandedPath)).toBe(false);
    expect(fs.existsSync(wtPath)).toBe(false);
    expect(git.findWorktreeEntry(repoDir, wtPath)).toBeNull();
    const reposTxt = fs.readFileSync(path.join(projectDir, 'repos.txt'), 'utf8');
    expect(reposTxt).not.toContain(repoDir.replace(/\\/g, '/'));
  });

  test('still removes a clean, unlocked orphaned worktree as before', async () => {
    await runRepo(projectDir, 'add', repoDir);
    const { taskDir, wtPath } = makeTaskWithWorktree(projectDir, repoDir, 'TASK-ORPHAN-OK', 'feature/orphan');
    prompts.confirm.mockResolvedValueOnce(true);

    await runRepo(projectDir, 'remove', repoDir);

    expect(fs.existsSync(wtPath)).toBe(false);
    expect(fs.existsSync(taskDir)).toBe(true); // repo remove only tears down the worktree, not the task
    const reposTxt = fs.readFileSync(path.join(projectDir, 'repos.txt'), 'utf8');
    expect(reposTxt).not.toContain(repoDir.replace(/\\/g, '/'));
  });
});

// ─── wksp repo list ──────────────────────────────────────────────────────────

describe('wksp repo list', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('repo-list-1');
    repoDir    = makeTempDir('repo-list-src');
    makeGitRepo(repoDir);
  });
  afterEach(() => cleanup(projectDir, repoDir));

  test('lists registered repos', async () => {
    await runRepo(projectDir, 'add', repoDir);
    logLines = [];
    await runRepo(projectDir, 'list');
    const out = logLines.join('\n');
    expect(out).toContain(path.basename(repoDir));
  });

  test('shows --shared flag for shared repos', async () => {
    await runRepo(projectDir, 'add', repoDir, '--shared');
    logLines = [];
    await runRepo(projectDir, 'list');
    const out = logLines.join('\n');
    expect(out).toContain('--shared');
  });

  test('shows --optional flag for optional repos', async () => {
    await runRepo(projectDir, 'add', repoDir, '--optional');
    logLines = [];
    await runRepo(projectDir, 'list');
    const out = logLines.join('\n');
    expect(out).toContain('--optional');
  });

  test('prints helpful message when no repos are registered', async () => {
    await runRepo(projectDir, 'list');
    const out = logLines.join('\n');
    expect(out).toContain('No repos registered');
  });
});

