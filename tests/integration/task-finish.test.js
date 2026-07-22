'use strict';
const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { makeTempDir, makeGitRepo, makeGitRepoWithRemote, makeProject, cleanup } = require('../helpers');
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

const prompts = require('../../lib/prompts');
const config  = require('../../lib/config');
const taskCmd = require('../../lib/commands/task');

beforeEach(() => {
  jest.spyOn(process, 'exit').mockImplementation(code => { throw new Error(`process.exit(${code})`); });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  prompts.ask.mockReset();
  prompts.confirm.mockReset();
});
afterEach(() => jest.restoreAllMocks());

async function runTask(projectDir, ...args) {
  config.findProjectDir.mockReturnValue(projectDir);
  await taskCmd.run(args);
}

function gitCmd(cwd, cmd) {
  return execSync(`git ${cmd}`, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

describe('wksp task finish — merged happy path with remote', () => {
  let projectDir, repoDir, originDir, cloneDir;
  beforeEach(() => {
    projectDir = makeProject('fin-merged');
    ({ repoDir, originDir } = makeGitRepoWithRemote());
    addRepo(projectDir, repoDir, false);
  });
  afterEach(() => {
    try { git.deleteBranch(repoDir, 'feature/fin', true); } catch {}
    cleanup(projectDir, repoDir, originDir, cloneDir);
  });

  test('archives, deletes the merged branch, and fast-forwards the base repo', async () => {
    // The default branch depends on the local git default (main or master).
    const def = git.defaultBranch(repoDir);

    prompts.ask.mockResolvedValueOnce('feature/fin');
    await runTask(projectDir, 'create', 'TASK-FIN');

    // Commit work in the worktree and push the feature branch.
    const wtPath = path.join(projectDir, 'tasks', 'TASK-FIN', WORKTREES_DIR, path.basename(repoDir));
    fs.writeFileSync(path.join(wtPath, 'work.txt'), 'feature work');
    gitCmd(wtPath, 'add .');
    gitCmd(wtPath, 'commit -m "feature commit"');
    gitCmd(wtPath, 'push -u origin feature/fin');

    // Simulate the PR merge on the remote: clone origin elsewhere, merge into the
    // default branch, push it back.
    cloneDir = makeTempDir('fin-clone');
    gitCmd(process.cwd(), `clone "${originDir}" "${cloneDir}"`);
    gitCmd(cloneDir, 'config user.email "test@wksp.test"');
    gitCmd(cloneDir, 'config user.name "wksp test"');
    gitCmd(cloneDir, 'fetch origin');
    gitCmd(cloneDir, 'merge --no-ff origin/feature/fin -m "merge feature"');
    gitCmd(cloneDir, `push origin HEAD:${def}`);
    const expectedDef = gitCmd(cloneDir, 'rev-parse HEAD');

    prompts.confirm.mockResolvedValueOnce(true); // archive confirm (merged → no warn confirm)
    await runTask(projectDir, 'finish', 'TASK-FIN');

    // Task archived, worktree gone
    expect(fs.existsSync(path.join(projectDir, 'tasks', 'TASK-FIN'))).toBe(false);
    const archivedDir = path.join(projectDir, 'archived-tasks', 'TASK-FIN');
    expect(fs.existsSync(archivedDir)).toBe(true);
    expect(fs.existsSync(wtPath)).toBe(false);

    // Branch deleted from base repo
    expect(git.branchExistsLocally(repoDir, 'feature/fin')).toBe(false);

    // Manifest records deletion and the default reason
    const manifest = archive.readManifest(archivedDir);
    expect(manifest.repos[0].branchKeptInBaseRepo).toBe(false);
    expect(manifest.reason).toBe('finished');

    // Base repo default branch fast-forwarded to the merged sha (was clean, on default)
    expect(git.revParse(repoDir, def)).toBe(expectedDef);
  });
});

describe('wksp task finish — unmerged branch', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('fin-unmerged');
    repoDir    = makeTempDir('repo-fin-unmerged');
    makeGitRepo(repoDir);
    addRepo(projectDir, repoDir, false);
  });
  afterEach(() => {
    try { git.deleteBranch(repoDir, 'feature/unm', true); } catch {}
    cleanup(projectDir, repoDir);
  });

  test('warns and cancels when the first confirm is declined', async () => {
    prompts.ask.mockResolvedValueOnce('feature/unm');
    await runTask(projectDir, 'create', 'TASK-UNM');

    const wtPath = path.join(projectDir, 'tasks', 'TASK-UNM', WORKTREES_DIR, path.basename(repoDir));
    fs.writeFileSync(path.join(wtPath, 'wip.txt'), 'ahead of main');
    gitCmd(wtPath, 'add .');
    gitCmd(wtPath, 'commit -m "wip commit"');

    prompts.confirm.mockResolvedValueOnce(false); // decline the "finish anyway?" warning
    await runTask(projectDir, 'finish', 'TASK-UNM');

    // Nothing happened — still live, branch still present
    expect(fs.existsSync(path.join(projectDir, 'tasks', 'TASK-UNM'))).toBe(true);
    expect(git.branchExistsLocally(repoDir, 'feature/unm')).toBe(true);
  });

  test('confirming twice proceeds and force-deletes the unmerged branch', async () => {
    prompts.ask.mockResolvedValueOnce('feature/unm');
    await runTask(projectDir, 'create', 'TASK-UNM2');

    const wtPath = path.join(projectDir, 'tasks', 'TASK-UNM2', WORKTREES_DIR, path.basename(repoDir));
    fs.writeFileSync(path.join(wtPath, 'wip.txt'), 'ahead of main');
    gitCmd(wtPath, 'add .');
    gitCmd(wtPath, 'commit -m "wip commit"');

    prompts.confirm
      .mockResolvedValueOnce(true)   // finish anyway?
      .mockResolvedValueOnce(true);  // archive confirm
    await runTask(projectDir, 'finish', 'TASK-UNM2');

    expect(fs.existsSync(path.join(projectDir, 'archived-tasks', 'TASK-UNM2'))).toBe(true);
    // -d would refuse this unmerged branch; forceDeleteBranches makes it a -D
    expect(git.branchExistsLocally(repoDir, 'feature/unm')).toBe(false);
  });
});

describe('wksp task finish --keep-branches', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('fin-keep');
    repoDir    = makeTempDir('repo-fin-keep');
    makeGitRepo(repoDir);
    addRepo(projectDir, repoDir, false);
  });
  afterEach(() => {
    try { git.deleteBranch(repoDir, 'feature/keep', true); } catch {}
    cleanup(projectDir, repoDir);
  });

  test('keeps the branch and records it in the manifest', async () => {
    // Branch has no extra commits → tip == main tip → ancestor → merged (trivially).
    prompts.ask.mockResolvedValueOnce('feature/keep');
    await runTask(projectDir, 'create', 'TASK-KEEP');

    prompts.confirm.mockResolvedValueOnce(true); // archive confirm (merged → no warn)
    await runTask(projectDir, 'finish', 'TASK-KEEP', '--keep-branches');

    expect(fs.existsSync(path.join(projectDir, 'archived-tasks', 'TASK-KEEP'))).toBe(true);
    expect(git.branchExistsLocally(repoDir, 'feature/keep')).toBe(true);

    const manifest = archive.readManifest(path.join(projectDir, 'archived-tasks', 'TASK-KEEP'));
    expect(manifest.repos[0].branchKeptInBaseRepo).toBe(true);
  });
});

describe('wksp task finish — base repo not on default branch', () => {
  let projectDir, repoDir, originDir, cloneDir;
  beforeEach(() => {
    projectDir = makeProject('fin-parked');
    ({ repoDir, originDir } = makeGitRepoWithRemote());
    addRepo(projectDir, repoDir, false);
  });
  afterEach(() => {
    try { git.deleteBranch(repoDir, 'feature/parked', true); } catch {}
    cleanup(projectDir, repoDir, originDir, cloneDir);
  });

  test('prints a hint and leaves the base repo untouched', async () => {
    // No extra commits → feature/parked tip is an ancestor of origin/<default> → merged.
    const def = git.defaultBranch(repoDir);

    prompts.ask.mockResolvedValueOnce('feature/parked');
    await runTask(projectDir, 'create', 'TASK-PARK');

    // Park the base repo on a different branch so ff-only must be skipped.
    gitCmd(repoDir, 'checkout -b parked');

    // Advance origin/<default> from a second clone so a fast-forward would be possible.
    cloneDir = makeTempDir('fin-park-clone');
    gitCmd(process.cwd(), `clone "${originDir}" "${cloneDir}"`);
    gitCmd(cloneDir, 'config user.email "test@wksp.test"');
    gitCmd(cloneDir, 'config user.name "wksp test"');
    fs.writeFileSync(path.join(cloneDir, 'more.txt'), 'more');
    gitCmd(cloneDir, 'add .');
    gitCmd(cloneDir, 'commit -m "advance default"');
    gitCmd(cloneDir, `push origin HEAD:${def}`);

    const defBefore = git.revParse(repoDir, def);

    prompts.confirm.mockResolvedValueOnce(true); // archive confirm
    await runTask(projectDir, 'finish', 'TASK-PARK');

    expect(fs.existsSync(path.join(projectDir, 'archived-tasks', 'TASK-PARK'))).toBe(true);
    // Base repo still parked, local default branch untouched (not fast-forwarded)
    expect(git.currentBranch(repoDir)).toBe('parked');
    expect(git.revParse(repoDir, def)).toBe(defBefore);
  });
});

describe('wksp task finish --yes', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('fin-yes');
    repoDir    = makeTempDir('repo-fin-yes');
    makeGitRepo(repoDir);
    addRepo(projectDir, repoDir, false);
  });
  afterEach(() => {
    try { git.deleteBranch(repoDir, 'feature/yes', true); } catch {}
    cleanup(projectDir, repoDir);
  });

  test('skips all prompts, even when the branch is unmerged', async () => {
    prompts.ask.mockResolvedValueOnce('feature/yes');
    await runTask(projectDir, 'create', 'TASK-Y');

    const wtPath = path.join(projectDir, 'tasks', 'TASK-Y', WORKTREES_DIR, path.basename(repoDir));
    fs.writeFileSync(path.join(wtPath, 'wip.txt'), 'ahead of main');
    gitCmd(wtPath, 'add .');
    gitCmd(wtPath, 'commit -m "wip commit"');

    await runTask(projectDir, 'finish', 'TASK-Y', '--yes');

    expect(prompts.confirm).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(projectDir, 'archived-tasks', 'TASK-Y'))).toBe(true);
  });
});

describe('wksp task finish --no-archive', () => {
  let projectDir, repoDir, originDir, cloneDir;
  beforeEach(() => {
    projectDir = makeProject('fin-noarchive');
    ({ repoDir, originDir } = makeGitRepoWithRemote());
    addRepo(projectDir, repoDir, false);
  });
  afterEach(() => {
    try { git.deleteBranch(repoDir, 'feature/na', true); } catch {}
    cleanup(projectDir, repoDir, originDir, cloneDir);
  });

  test('deletes the task instead of archiving, still fast-forwards the base repo', async () => {
    const def = git.defaultBranch(repoDir);

    prompts.ask.mockResolvedValueOnce('feature/na');
    await runTask(projectDir, 'create', 'TASK-NA');

    const wtPath = path.join(projectDir, 'tasks', 'TASK-NA', WORKTREES_DIR, path.basename(repoDir));
    fs.writeFileSync(path.join(wtPath, 'work.txt'), 'feature work');
    gitCmd(wtPath, 'add .');
    gitCmd(wtPath, 'commit -m "feature commit"');
    gitCmd(wtPath, 'push -u origin feature/na');

    // Merge the feature into the default branch on the remote.
    cloneDir = makeTempDir('fin-na-clone');
    gitCmd(process.cwd(), `clone "${originDir}" "${cloneDir}"`);
    gitCmd(cloneDir, 'config user.email "test@wksp.test"');
    gitCmd(cloneDir, 'config user.name "wksp test"');
    gitCmd(cloneDir, 'fetch origin');
    gitCmd(cloneDir, 'merge --no-ff origin/feature/na -m "merge feature"');
    gitCmd(cloneDir, `push origin HEAD:${def}`);
    const expectedDef = gitCmd(cloneDir, 'rev-parse HEAD');

    prompts.confirm.mockResolvedValueOnce(true); // "Delete ... permanently (no archive)?"
    await runTask(projectDir, 'finish', 'TASK-NA', '--no-archive');

    // Task deleted outright — NOT archived
    expect(fs.existsSync(path.join(projectDir, 'tasks', 'TASK-NA'))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, 'archived-tasks', 'TASK-NA'))).toBe(false);
    expect(fs.existsSync(wtPath)).toBe(false);

    // Branch deleted from the base repo
    expect(git.branchExistsLocally(repoDir, 'feature/na')).toBe(false);

    // Base repo default branch still fast-forwarded to the merged sha
    expect(git.revParse(repoDir, def)).toBe(expectedDef);
  });

  test('confirmation prompt states it is irreversible with no archive kept', async () => {
    const logs = [];
    jest.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));

    prompts.ask.mockResolvedValueOnce('feature/na');
    await runTask(projectDir, 'create', 'TASK-NA2');

    prompts.confirm.mockImplementationOnce(async (msg) => {
      // Prompt wording must clearly flag the permanent, no-archive delete.
      expect(msg.toLowerCase()).toContain('permanently');
      expect(msg.toLowerCase()).toContain('no archive');
      return false; // decline — leaves the task in place
    });
    await runTask(projectDir, 'finish', 'TASK-NA2', '--no-archive');

    // Declined → task untouched, no archive created
    expect(fs.existsSync(path.join(projectDir, 'tasks', 'TASK-NA2'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'archived-tasks', 'TASK-NA2'))).toBe(false);
    // Summary lines flag the no-archive, irreversible nature
    expect(logs.some(l => l.includes('NO archive kept'))).toBe(true);
    expect(logs.some(l => l.toLowerCase().includes('irreversible'))).toBe(true);
  });

  test('--delete is an alias for --no-archive', async () => {
    prompts.ask.mockResolvedValueOnce('feature/na');
    await runTask(projectDir, 'create', 'TASK-NA3');

    prompts.confirm.mockResolvedValueOnce(true); // delete confirm (trivially merged → no warn)
    await runTask(projectDir, 'finish', 'TASK-NA3', '--delete');

    expect(fs.existsSync(path.join(projectDir, 'tasks', 'TASK-NA3'))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, 'archived-tasks', 'TASK-NA3'))).toBe(false);
  });
});

describe('wksp task done (alias)', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('fin-alias');
    repoDir    = makeTempDir('repo-fin-alias');
    makeGitRepo(repoDir);
    addRepo(projectDir, repoDir, false);
  });
  afterEach(() => {
    try { git.deleteBranch(repoDir, 'feature/alias', true); } catch {}
    cleanup(projectDir, repoDir);
  });

  test('`done` behaves like `finish`', async () => {
    // Trivially-merged task (no extra commits).
    prompts.ask.mockResolvedValueOnce('feature/alias');
    await runTask(projectDir, 'create', 'TASK-D');

    prompts.confirm.mockResolvedValueOnce(true); // archive confirm
    await runTask(projectDir, 'done', 'TASK-D');

    expect(fs.existsSync(path.join(projectDir, 'archived-tasks', 'TASK-D'))).toBe(true);
    expect(git.branchExistsLocally(repoDir, 'feature/alias')).toBe(false);
  });
});
