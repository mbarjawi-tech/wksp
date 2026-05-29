'use strict';
const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
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

jest.mock('../../lib/claude', () => ({
  launch:           jest.fn(),
  findLastSession:  jest.fn().mockReturnValue(null),
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

describe('--archive: happy path', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('arch-1');
    repoDir    = makeTempDir('repo-arch-1');
    makeGitRepo(repoDir);
    addRepo(projectDir, repoDir, false);
  });
  afterEach(() => {
    try { git.deleteBranch(repoDir, 'feature/archived', true); } catch {}
    cleanup(projectDir, repoDir);
  });

  test('removes worktrees, writes manifest, moves folder to archived-tasks/', async () => {
    prompts.ask.mockResolvedValueOnce('feature/archived');
    await runTask(projectDir, 'TASK-A');

    const wtPath = path.join(projectDir, 'tasks', 'TASK-A', WORKTREES_DIR, path.basename(repoDir));
    expect(fs.existsSync(wtPath)).toBe(true);

    prompts.confirm.mockResolvedValueOnce(true); // Confirm archive
    await runTask(projectDir, 'TASK-A', '--archive');

    expect(fs.existsSync(path.join(projectDir, 'tasks', 'TASK-A'))).toBe(false);
    const archivedDir = path.join(projectDir, 'archived-tasks', 'TASK-A');
    expect(fs.existsSync(archivedDir)).toBe(true);

    const manifest = archive.readManifest(archivedDir);
    expect(manifest).not.toBeNull();
    expect(manifest.taskId).toBe('TASK-A');
    expect(manifest.repos).toHaveLength(1);
    const entry = manifest.repos[0];
    expect(entry.status).toBe('worktree');
    expect(entry.branch).toBe('feature/archived');
    expect(entry.tipSha).toMatch(/^[0-9a-f]{40}$/);
    expect(entry.branchKeptInBaseRepo).toBe(true);

    // Branch should still exist in the base repo
    expect(git.branchExistsLocally(repoDir, 'feature/archived')).toBe(true);
  });
});

describe('--archive --delete-branches', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('arch-del');
    repoDir    = makeTempDir('repo-arch-del');
    makeGitRepo(repoDir);
    addRepo(projectDir, repoDir, false);
  });
  afterEach(() => cleanup(projectDir, repoDir));

  test('removes branches from base repos in addition to worktrees', async () => {
    prompts.ask.mockResolvedValueOnce('feature/to-delete');
    await runTask(projectDir, 'TASK-DEL');

    prompts.confirm.mockResolvedValueOnce(true);
    await runTask(projectDir, 'TASK-DEL', '--archive', '--delete-branches');

    expect(git.branchExistsLocally(repoDir, 'feature/to-delete')).toBe(false);

    const manifest = archive.readManifest(path.join(projectDir, 'archived-tasks', 'TASK-DEL'));
    expect(manifest.repos[0].branchKeptInBaseRepo).toBe(false);
  });
});

describe('--archive refuses with uncommitted changes unless --force', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('arch-uncommit');
    repoDir    = makeTempDir('repo-arch-uncommit');
    makeGitRepo(repoDir);
    addRepo(projectDir, repoDir, false);
  });
  afterEach(() => {
    try { git.deleteBranch(repoDir, 'feature/dirty', true); } catch {}
    cleanup(projectDir, repoDir);
  });

  test('errors out when there are uncommitted changes and no --force', async () => {
    prompts.ask.mockResolvedValueOnce('feature/dirty');
    await runTask(projectDir, 'TASK-DIRTY');

    const wtPath = path.join(projectDir, 'tasks', 'TASK-DIRTY', WORKTREES_DIR, path.basename(repoDir));
    fs.writeFileSync(path.join(wtPath, 'dirty.txt'), 'wip');

    await expect(runTask(projectDir, 'TASK-DIRTY', '--archive')).rejects.toThrow(/process\.exit/);
    expect(fs.existsSync(path.join(projectDir, 'tasks', 'TASK-DIRTY'))).toBe(true);
  });

  test('proceeds with --force, recording the uncommitted flag in the manifest', async () => {
    prompts.ask.mockResolvedValueOnce('feature/dirty');
    await runTask(projectDir, 'TASK-DIRTY-FORCE');

    const wtPath = path.join(projectDir, 'tasks', 'TASK-DIRTY-FORCE', WORKTREES_DIR, path.basename(repoDir));
    fs.writeFileSync(path.join(wtPath, 'dirty.txt'), 'wip');

    prompts.confirm.mockResolvedValueOnce(true);
    await runTask(projectDir, 'TASK-DIRTY-FORCE', '--archive', '--force');

    const manifest = archive.readManifest(path.join(projectDir, 'archived-tasks', 'TASK-DIRTY-FORCE'));
    expect(manifest.repos[0].uncommittedAtArchive).toBe(true);
  });
});

describe('--unarchive: light path (present-local)', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('un-light');
    repoDir    = makeTempDir('repo-un-light');
    makeGitRepo(repoDir);
    addRepo(projectDir, repoDir, false);
  });
  afterEach(() => {
    try { git.deleteBranch(repoDir, 'feature/back', true); } catch {}
    cleanup(projectDir, repoDir);
  });

  test('round-trips: archive then unarchive recreates the worktree on the same branch', async () => {
    prompts.ask.mockResolvedValueOnce('feature/back');
    await runTask(projectDir, 'TASK-BACK');

    prompts.confirm.mockResolvedValueOnce(true);
    await runTask(projectDir, 'TASK-BACK', '--archive');
    expect(fs.existsSync(path.join(projectDir, 'tasks', 'TASK-BACK'))).toBe(false);

    // No confirm needed for light path (everything present-local)
    await runTask(projectDir, 'TASK-BACK', '--unarchive');

    const wtPath = path.join(projectDir, 'tasks', 'TASK-BACK', WORKTREES_DIR, path.basename(repoDir));
    expect(fs.existsSync(wtPath)).toBe(true);
    expect(git.currentBranch(wtPath)).toBe('feature/back');
    expect(fs.existsSync(path.join(projectDir, 'archived-tasks', 'TASK-BACK'))).toBe(false);
  });
});

describe('--unarchive --dry-run', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('un-dry');
    repoDir    = makeTempDir('repo-un-dry');
    makeGitRepo(repoDir);
    addRepo(projectDir, repoDir, false);
  });
  afterEach(() => {
    try { git.deleteBranch(repoDir, 'feature/dry', true); } catch {}
    cleanup(projectDir, repoDir);
  });

  test('prints the plan but does not move the folder', async () => {
    prompts.ask.mockResolvedValueOnce('feature/dry');
    await runTask(projectDir, 'TASK-DRY');

    prompts.confirm.mockResolvedValueOnce(true);
    await runTask(projectDir, 'TASK-DRY', '--archive');

    await runTask(projectDir, 'TASK-DRY', '--unarchive', '--dry-run');

    expect(fs.existsSync(path.join(projectDir, 'archived-tasks', 'TASK-DRY'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'tasks', 'TASK-DRY'))).toBe(false);
  });
});

describe('--unarchive: merged case', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('un-merged');
    repoDir    = makeTempDir('repo-un-merged');
    makeGitRepo(repoDir);
    addRepo(projectDir, repoDir, false);
  });
  afterEach(() => cleanup(projectDir, repoDir));

  test('when archived branch was merged and deleted, unarchive marks repo as task-shared (main is checked out in base repo)', async () => {
    prompts.ask.mockResolvedValueOnce('feature/merged-work');
    await runTask(projectDir, 'TASK-MERGED');

    const wtPath = path.join(projectDir, 'tasks', 'TASK-MERGED', WORKTREES_DIR, path.basename(repoDir));
    fs.writeFileSync(path.join(wtPath, 'work.txt'), 'feature work');
    gitCmd(wtPath, 'add .');
    gitCmd(wtPath, 'commit -m "feature commit"');

    prompts.confirm.mockResolvedValueOnce(true);
    await runTask(projectDir, 'TASK-MERGED', '--archive');

    // Merge the work into main and delete the feature branch
    gitCmd(repoDir, 'merge --no-ff feature/merged-work -m "merge feature"');
    gitCmd(repoDir, 'branch -D feature/merged-work');

    prompts.confirm.mockResolvedValueOnce(true); // confirm preview
    await runTask(projectDir, 'TASK-MERGED', '--unarchive');

    // The branch is merged into main, and main is checked out in base repo
    // → conflict resolution converts this to task-shared instead of creating a worktree on main
    const jsonFile = path.join(projectDir, 'tasks', 'TASK-MERGED', 'task.json');
    expect(fs.existsSync(jsonFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(jsonFile, 'utf8')).shared).toContain(path.basename(repoDir));

    // No new worktree directory should have been created
    const newWtPath = path.join(projectDir, 'tasks', 'TASK-MERGED', WORKTREES_DIR, path.basename(repoDir));
    expect(fs.existsSync(newWtPath)).toBe(false);
  });
});

describe('--unarchive: drift — new repo added since archive', () => {
  let projectDir, repoA, repoB;
  beforeEach(() => {
    projectDir = makeProject('un-drift');
    repoA = makeTempDir('repo-a');
    repoB = makeTempDir('repo-b');
    makeGitRepo(repoA);
    makeGitRepo(repoB);
    addRepo(projectDir, repoA, false);
  });
  afterEach(() => {
    try { git.deleteBranch(repoA, 'feature/drift', true); } catch {}
    cleanup(projectDir, repoA, repoB);
  });

  test('newly-added repo is deferred to next launch (prompt action)', async () => {
    prompts.ask.mockResolvedValueOnce('feature/drift');
    await runTask(projectDir, 'TASK-DRIFT');

    prompts.confirm.mockResolvedValueOnce(true);
    await runTask(projectDir, 'TASK-DRIFT', '--archive');

    addRepo(projectDir, repoB, false);

    prompts.confirm.mockResolvedValueOnce(true); // unarchive preview confirm (drift is "interesting")
    await runTask(projectDir, 'TASK-DRIFT', '--unarchive');

    // repoA worktree restored
    const wtA = path.join(projectDir, 'tasks', 'TASK-DRIFT', WORKTREES_DIR, path.basename(repoA));
    expect(fs.existsSync(wtA)).toBe(true);
    // repoB not yet — will be prompted on next `wksp task <id>`
    const wtB = path.join(projectDir, 'tasks', 'TASK-DRIFT', WORKTREES_DIR, path.basename(repoB));
    expect(fs.existsSync(wtB)).toBe(false);
  });
});

describe('--del on archived task', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('del-arch');
    repoDir    = makeTempDir('repo-del-arch');
    makeGitRepo(repoDir);
    addRepo(projectDir, repoDir, false);
  });
  afterEach(() => {
    try { git.deleteBranch(repoDir, 'feature/del-arch', true); } catch {}
    cleanup(projectDir, repoDir);
  });

  test('deletes the archived folder without complaining about missing worktrees', async () => {
    prompts.ask.mockResolvedValueOnce('feature/del-arch');
    await runTask(projectDir, 'TASK-DARCH');

    prompts.confirm.mockResolvedValueOnce(true);
    await runTask(projectDir, 'TASK-DARCH', '--archive');

    prompts.confirm.mockResolvedValueOnce(true); // confirm del
    await runTask(projectDir, 'TASK-DARCH', '--del');

    expect(fs.existsSync(path.join(projectDir, 'archived-tasks', 'TASK-DARCH'))).toBe(false);
    // Branch was kept on archive (default) — still there
    expect(git.branchExistsLocally(repoDir, 'feature/del-arch')).toBe(true);
  });

  test('--del --delete-branches removes the kept branches too', async () => {
    prompts.ask.mockResolvedValueOnce('feature/del-arch-2');
    await runTask(projectDir, 'TASK-DARCH-2');

    prompts.confirm.mockResolvedValueOnce(true);
    await runTask(projectDir, 'TASK-DARCH-2', '--archive');

    prompts.confirm.mockResolvedValueOnce(true);
    await runTask(projectDir, 'TASK-DARCH-2', '--del', '--delete-branches');

    expect(fs.existsSync(path.join(projectDir, 'archived-tasks', 'TASK-DARCH-2'))).toBe(false);
    expect(git.branchExistsLocally(repoDir, 'feature/del-arch-2')).toBe(false);
  });
});

describe('shared repo round-trips as shared', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('arch-shared');
    repoDir    = makeTempDir('repo-arch-shared');
    makeGitRepo(repoDir);
    addRepo(projectDir, repoDir, true); // --shared
  });
  afterEach(() => cleanup(projectDir, repoDir));

  test('a project-shared repo gets status:shared in manifest and stays shared on unarchive', async () => {
    await runTask(projectDir, 'TASK-SHARED');

    prompts.confirm.mockResolvedValueOnce(true);
    await runTask(projectDir, 'TASK-SHARED', '--archive');

    const manifest = archive.readManifest(path.join(projectDir, 'archived-tasks', 'TASK-SHARED'));
    expect(manifest.repos[0].status).toBe('shared');

    await runTask(projectDir, 'TASK-SHARED', '--unarchive');
    expect(fs.existsSync(path.join(projectDir, 'tasks', 'TASK-SHARED'))).toBe(true);
  });
});

describe('excluded repo round-trips as excluded', () => {
  let projectDir, repoA;
  beforeEach(() => {
    projectDir = makeProject('arch-excl');
    repoA = makeTempDir('repo-arch-excl');
    makeGitRepo(repoA);
    addRepo(projectDir, repoA, false);
  });
  afterEach(() => cleanup(projectDir, repoA));

  test('a project repo excluded via prompt stays excluded after archive → unarchive', async () => {
    prompts.ask.mockResolvedValueOnce('x');
    await runTask(projectDir, 'TASK-XCL');

    const jsonFile = path.join(projectDir, 'tasks', 'TASK-XCL', 'task.json');
    expect(fs.existsSync(jsonFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(jsonFile, 'utf8')).excluded).toContain(path.basename(repoA));

    prompts.confirm.mockResolvedValueOnce(true);
    await runTask(projectDir, 'TASK-XCL', '--archive');

    const manifest = archive.readManifest(path.join(projectDir, 'archived-tasks', 'TASK-XCL'));
    expect(manifest.repos[0].status).toBe('excluded');

    await runTask(projectDir, 'TASK-XCL', '--unarchive');

    // After unarchive, excluded status restored in task.json
    const jsonAfter = path.join(projectDir, 'tasks', 'TASK-XCL', 'task.json');
    expect(fs.existsSync(jsonAfter)).toBe(true);
    expect(JSON.parse(fs.readFileSync(jsonAfter, 'utf8')).excluded).toContain(path.basename(repoA));
  });
});
