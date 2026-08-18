'use strict';
// A branch can exist on origin and not exist in your clone — the normal state of a
// branch a colleague pushed after your last fetch. `git worktree add <path> <branch>`
// resolves LOCAL refs only, so wksp asking the *server* whether the branch exists and
// then handing git the name died on `fatal: invalid reference`, part-way through
// building a task. These cover the fetch, and the partial state that failure left.
const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { makeTempDir, makeGitRepoWithRemote, makeProject, cleanup } = require('../helpers');
const { addRepo } = require('../../lib/repos');
const git = require('../../lib/git');

jest.mock('../../lib/prompts', () => ({
  open: jest.fn(), close: jest.fn(), ask: jest.fn(),
  confirm: jest.fn(), confirmDefaultYes: jest.fn(),
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
    readGlobalConfig:  jest.fn().mockReturnValue({ autoResume: false }),
    readConfig:        jest.fn().mockReturnValue({ autoResume: false }),
  };
});

const config    = require('../../lib/config');
const taskCmd   = require('../../lib/commands/task');
const statusCmd = require('../../lib/commands/status');

let logLines;
beforeEach(() => {
  logLines = [];
  jest.spyOn(console, 'log').mockImplementation((...a) => logLines.push(a.join(' ')));
  jest.spyOn(console, 'warn').mockImplementation((...a) => logLines.push(a.join(' ')));
  jest.spyOn(console, 'error').mockImplementation((...a) => logLines.push(a.join(' ')));
  jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  jest.spyOn(process, 'exit').mockImplementation(code => { throw new Error(`process.exit(${code})`); });
});
afterEach(() => jest.restoreAllMocks());

const out = () => logLines.join('\n');

async function runTask(projectDir, ...args) {
  config.findProjectDir.mockReturnValue(projectDir);
  await taskCmd.run(args);
}
async function runStatus(projectDir, ...args) {
  config.findProjectDir.mockReturnValue(projectDir);
  await statusCmd.run(args);
}

// Push a branch to `origin` from a throwaway second clone, so `repoDir` — which was
// cloned earlier — has no ref for it. This is the whole scenario in one function.
function pushBranchBehindOurBack(originDir, branch) {
  const other = makeTempDir('other-clone');
  execSync(`git clone "${originDir}" "${other}"`, { stdio: 'pipe' });
  execSync('git config user.email "other@wksp.test"', { cwd: other, stdio: 'pipe' });
  execSync('git config user.name "other"', { cwd: other, stdio: 'pipe' });
  execSync(`git checkout -b "${branch}"`, { cwd: other, stdio: 'pipe' });
  fs.writeFileSync(path.join(other, 'theirs.txt'), 'their work\n');
  execSync('git add .', { cwd: other, stdio: 'pipe' });
  execSync('git commit -m "their work"', { cwd: other, stdio: 'pipe' });
  execSync(`git push origin "${branch}"`, { cwd: other, stdio: 'pipe' });
  const sha = execSync('git rev-parse HEAD', { cwd: other, encoding: 'utf8', stdio: 'pipe' }).trim();
  cleanup(other);
  return sha;
}

describe('addWorktree — a branch on origin that was never fetched', () => {
  let repoDir, originDir, wtDir;
  beforeEach(() => {
    ({ repoDir, originDir } = makeGitRepoWithRemote());
    wtDir = path.join(makeTempDir('wt-parent'), 'wt');
  });
  afterEach(() => cleanup(repoDir, originDir, path.dirname(wtDir)));

  test('checks the branch out instead of failing on `invalid reference`', () => {
    const sha = pushBranchBehindOurBack(originDir, 'feat/theirs');
    // Precondition: the server has it, we do not.
    expect(git.branchExistsRemotely(repoDir, 'feat/theirs')).toBe(true);
    expect(git.branchExistsCached(repoDir, 'feat/theirs')).toBe(false);
    expect(git.branchExistsLocally(repoDir, 'feat/theirs')).toBe(false);

    git.addWorktree(repoDir, wtDir, 'feat/theirs', null, 'pipe');

    // Their commit, not a fresh branch off main that merely shares the name.
    expect(git.revParse(wtDir, 'HEAD')).toBe(sha);
    expect(fs.existsSync(path.join(wtDir, 'theirs.txt'))).toBe(true);
    expect(git.currentBranch(wtDir)).toBe('feat/theirs');
  });

  test('still creates a genuinely new branch when the name exists nowhere', () => {
    git.addWorktree(repoDir, wtDir, 'feat/brand-new', 'main', 'pipe');
    expect(git.currentBranch(wtDir)).toBe('feat/brand-new');
    expect(fs.existsSync(path.join(wtDir, 'theirs.txt'))).toBe(false);
  });

  test('still uses an existing local branch', () => {
    execSync('git branch feat/mine', { cwd: repoDir, stdio: 'pipe' });
    git.addWorktree(repoDir, wtDir, 'feat/mine', null, 'pipe');
    expect(git.currentBranch(wtDir)).toBe('feat/mine');
  });
});

describe('a setup run that stops part-way leaves recoverable state', () => {
  let projectDir, repoA, originA, repoB, originB;
  beforeEach(() => {
    projectDir = makeProject('partial');
    ({ repoDir: repoA, originDir: originA } = makeGitRepoWithRemote());
    ({ repoDir: repoB, originDir: originB } = makeGitRepoWithRemote());
    addRepo(projectDir, repoB, false);   // decided first
    addRepo(projectDir, repoA, false);   // fails second
  });
  afterEach(() => cleanup(projectDir, repoA, originA, repoB, originB));

  const nameA = () => path.basename(repoA);
  const nameB = () => path.basename(repoB);
  const taskJson = id => {
    const p = path.join(projectDir, 'tasks', id, 'task.json');
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
  };

  test('a decision made before the failure is persisted, not discarded', async () => {
    // `bad..name` is rejected by git itself, so the run dies after repoB is decided.
    await expect(runTask(projectDir, 'create', 't1',
      '--shared', nameB(), '--branch', `${nameA()}=bad..name`, '--no-launch'))
      .rejects.toThrow('process.exit(1)');

    expect(taskJson('t1')).toEqual({ shared: [nameB()] });
    expect(out()).toMatch(/has been saved, and nothing was undone/);
    expect(out()).toMatch(/wksp start t1/);
  });

  test('re-running finishes the task without re-asking what was already answered', async () => {
    await expect(runTask(projectDir, 'create', 't2',
      '--shared', nameB(), '--branch', `${nameA()}=bad..name`, '--no-launch'))
      .rejects.toThrow('process.exit(1)');

    await runTask(projectDir, 'resume', 't2', '--branch', `${nameA()}=feat/ok`, '--no-launch');

    expect(taskJson('t2')).toEqual({ shared: [nameB()] });
    const wt = path.join(projectDir, 'tasks', 't2', 'worktrees', nameA());
    expect(git.currentBranch(wt)).toBe('feat/ok');
  });

  test('status names a repo the task never decided on, instead of showing it blank', async () => {
    await expect(runTask(projectDir, 'create', 't3',
      '--shared', nameB(), '--branch', `${nameA()}=bad..name`, '--no-launch'))
      .rejects.toThrow('process.exit(1)');

    logLines = [];
    await runStatus(projectDir, 't3');
    expect(out()).toMatch(/\(not set up\)/);
    expect(out()).toMatch(new RegExp(`Not set up in this task: ${nameA()}`));
    expect(out()).toMatch(/wksp start t3/);
    // The one that WAS decided reads as shared, not as another blank row.
    expect(out()).toMatch(/shared — this task/);
  });

  test('`task repo <id> <repo> share` can decide a repo that has no worktree', async () => {
    await expect(runTask(projectDir, 'create', 't4',
      '--shared', nameB(), '--branch', `${nameA()}=bad..name`, '--no-launch'))
      .rejects.toThrow('process.exit(1)');

    await runTask(projectDir, 'repo', 't4', nameA(), 'share');

    expect(taskJson('t4').shared.sort()).toEqual([nameA(), nameB()].sort());
  });
});
