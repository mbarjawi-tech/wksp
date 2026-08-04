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

// Stub the forge check so integration tests never shell out to a real `gh` or the
// network. Default 'unknown' = the tier degrades silently (today's behavior);
// individual tests override the return value.
jest.mock('../../lib/forge', () => ({
  prMergeState: jest.fn(() => ({ state: 'unknown' })),
}));

const prompts = require('../../lib/prompts');
const config  = require('../../lib/config');
const forge   = require('../../lib/forge');
const taskCmd = require('../../lib/commands/task');

beforeEach(() => {
  jest.spyOn(process, 'exit').mockImplementation(code => { throw new Error(`process.exit(${code})`); });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  prompts.ask.mockReset();
  prompts.confirm.mockReset();
  forge.prMergeState.mockReset();
  forge.prMergeState.mockReturnValue({ state: 'unknown' });
});

function loggedText() {
  return console.log.mock.calls.map(c => c.map(String).join(' ')).join('\n');
}
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

describe('wksp task finish — forge-confirmed merge (squash/rebase)', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('fin-forge-merged');
    repoDir    = makeTempDir('repo-fin-forge-merged');
    makeGitRepo(repoDir);
    addRepo(projectDir, repoDir, false);
  });
  afterEach(() => {
    try { git.deleteBranch(repoDir, 'feature/sq', true); } catch {}
    cleanup(projectDir, repoDir);
  });

  test('ancestry fails but gh reports a MERGED PR → no warning, positive line, branch deleted', async () => {
    prompts.ask.mockResolvedValueOnce('feature/sq');
    await runTask(projectDir, 'create', 'TASK-SQ');

    // Extra commit → the branch tip is NOT an ancestor of the default branch,
    // exactly as a squash-/rebase-merged branch looks. Ancestry (tier 1) fails.
    const wtPath = path.join(projectDir, 'tasks', 'TASK-SQ', WORKTREES_DIR, path.basename(repoDir));
    fs.writeFileSync(path.join(wtPath, 'work.txt'), 'squashed work');
    gitCmd(wtPath, 'add .');
    gitCmd(wtPath, 'commit -m "work"');

    // Tier 2: the forge says it merged.
    forge.prMergeState.mockReturnValue({ state: 'merged', pr: { number: 46 } });

    prompts.confirm.mockResolvedValueOnce(true); // only the archive confirm — no warning confirm
    await runTask(projectDir, 'finish', 'TASK-SQ');

    // The forge tier fired (ancestry had failed).
    expect(forge.prMergeState).toHaveBeenCalledTimes(1);
    const [calledRepo, calledBranch] = forge.prMergeState.mock.calls[0];
    expect(calledRepo.replace(/\\/g, '/')).toBe(repoDir.replace(/\\/g, '/'));
    expect(calledBranch).toBe('feature/sq');

    // Positive confirmation, and NOT the warning.
    const out = loggedText();
    expect(out).toContain('PR #46');
    expect(out).toContain('confirmed on GitHub');
    expect(out).not.toContain("Couldn't confirm");

    // Exactly one confirm (archive) — the "finish anyway?" warning never showed.
    expect(prompts.confirm).toHaveBeenCalledTimes(1);

    // Archived and the (unmerged-by-git) branch force-deleted.
    expect(fs.existsSync(path.join(projectDir, 'archived-tasks', 'TASK-SQ'))).toBe(true);
    expect(git.branchExistsLocally(repoDir, 'feature/sq')).toBe(false);
  });
});

describe('wksp task finish — inconclusive forge result', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('fin-forge-unknown');
    repoDir    = makeTempDir('repo-fin-forge-unknown');
    makeGitRepo(repoDir);
    addRepo(projectDir, repoDir, false);
  });
  afterEach(() => {
    try { git.deleteBranch(repoDir, 'feature/unk', true); } catch {}
    cleanup(projectDir, repoDir);
  });

  test('ancestry fails and gh is inconclusive → reworded warning, not the old flat headline', async () => {
    prompts.ask.mockResolvedValueOnce('feature/unk');
    await runTask(projectDir, 'create', 'TASK-UNK');

    const wtPath = path.join(projectDir, 'tasks', 'TASK-UNK', WORKTREES_DIR, path.basename(repoDir));
    fs.writeFileSync(path.join(wtPath, 'wip.txt'), 'ahead of main');
    gitCmd(wtPath, 'add .');
    gitCmd(wtPath, 'commit -m "wip"');

    forge.prMergeState.mockReturnValue({ state: 'unknown' });

    prompts.confirm.mockResolvedValueOnce(false); // decline the reworded warning
    await runTask(projectDir, 'finish', 'TASK-UNK');

    const out = loggedText();
    expect(out).toContain("Couldn't confirm");
    expect(out).not.toContain('Not merged into the default branch');

    // Declined → nothing torn down.
    expect(fs.existsSync(path.join(projectDir, 'tasks', 'TASK-UNK'))).toBe(true);
    expect(git.branchExistsLocally(repoDir, 'feature/unk')).toBe(true);
  });
});

describe('wksp task finish — open PR (forge says unmerged)', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('fin-forge-open');
    repoDir    = makeTempDir('repo-fin-forge-open');
    makeGitRepo(repoDir);
    addRepo(projectDir, repoDir, false);
  });
  afterEach(() => {
    try { git.deleteBranch(repoDir, 'feature/open', true); } catch {}
    cleanup(projectDir, repoDir);
  });

  test('ancestry fails and gh reports an OPEN PR → "PR #N is still open", not the hedge', async () => {
    prompts.ask.mockResolvedValueOnce('feature/open');
    await runTask(projectDir, 'create', 'TASK-OPEN');

    const wtPath = path.join(projectDir, 'tasks', 'TASK-OPEN', WORKTREES_DIR, path.basename(repoDir));
    fs.writeFileSync(path.join(wtPath, 'wip.txt'), 'ahead of main');
    gitCmd(wtPath, 'add .');
    gitCmd(wtPath, 'commit -m "wip"');

    forge.prMergeState.mockReturnValue({ state: 'unmerged', pr: { number: 12 } });

    prompts.confirm.mockResolvedValueOnce(false); // decline the warning
    await runTask(projectDir, 'finish', 'TASK-OPEN');

    const out = loggedText();
    expect(out).toContain('PR #12 is still open');
    expect(out).not.toContain('looks exactly like this'); // the squash-merge hedge line

    // Declined → nothing torn down, branch still present.
    expect(fs.existsSync(path.join(projectDir, 'tasks', 'TASK-OPEN'))).toBe(true);
    expect(git.branchExistsLocally(repoDir, 'feature/open')).toBe(true);
  });
});

describe('wksp task finish — mid-stack PR (merged into its parent branch)', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('fin-forge-midstack');
    repoDir    = makeTempDir('repo-fin-forge-midstack');
    makeGitRepo(repoDir);
    addRepo(projectDir, repoDir, false);
  });
  afterEach(() => {
    try { git.deleteBranch(repoDir, 'feat/b', true); } catch {}
    cleanup(projectDir, repoDir);
  });

  // The bug this covers: GitHub reports a stack member's PR as MERGED once it lands on
  // the member below it. Treating that as "merged" let finish delete the branch and
  // archive the task while the work had never reached the default branch.
  test('reports "merged into <parent> — not yet on <default>" and does NOT claim a clean merge', async () => {
    prompts.ask.mockResolvedValueOnce('feat/b');
    await runTask(projectDir, 'create', 'TASK-STACK');

    const wtPath = path.join(projectDir, 'tasks', 'TASK-STACK', WORKTREES_DIR, path.basename(repoDir));
    fs.writeFileSync(path.join(wtPath, 'b.txt'), 'member b');
    gitCmd(wtPath, 'add .');
    gitCmd(wtPath, 'commit -m "member b"');

    forge.prMergeState.mockReturnValue({
      state: 'mergedToNonDefault',
      pr: { number: 18, mergedAt: '2026-08-03T09:00:00Z', baseRefName: 'feat/a' },
    });

    prompts.confirm.mockResolvedValueOnce(false); // decline the warning
    await runTask(projectDir, 'finish', 'TASK-STACK');

    const out = loggedText();
    expect(out).toContain('merged into feat/a');
    expect(out).toContain('not yet on');
    expect(out).toContain('PR #18');
    // Never the positive verdict, and never the squash hedge — this one is definite.
    expect(out).not.toContain('confirmed on GitHub');
    expect(out).not.toContain('All branches merged');
    expect(out).not.toContain('looks exactly like this');

    // Declined → nothing torn down, branch intact.
    expect(fs.existsSync(path.join(projectDir, 'tasks', 'TASK-STACK'))).toBe(true);
    expect(git.branchExistsLocally(repoDir, 'feat/b')).toBe(true);
  });

  test('the default branch is passed to the forge check', async () => {
    prompts.ask.mockResolvedValueOnce('feat/b');
    await runTask(projectDir, 'create', 'TASK-STACK2');

    const wtPath = path.join(projectDir, 'tasks', 'TASK-STACK2', WORKTREES_DIR, path.basename(repoDir));
    fs.writeFileSync(path.join(wtPath, 'b.txt'), 'member b');
    gitCmd(wtPath, 'add .');
    gitCmd(wtPath, 'commit -m "member b"');

    forge.prMergeState.mockReturnValue({ state: 'unknown' });
    prompts.confirm.mockResolvedValueOnce(false);
    await runTask(projectDir, 'finish', 'TASK-STACK2');

    const [, , deps] = forge.prMergeState.mock.calls[0];
    expect(deps).toBeDefined();
    expect(deps.defaultBranch).toBe('main');
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

    prompts.confirm.mockResolvedValueOnce(true); // "Delete ... permanently (no archive kept)?"
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

  // ─── data safety: a dirty worktree must not be destroyed silently (mirrors the
  // archive path's up-front refusal). Trivially-merged branch (no extra commits) →
  // no "finish anyway?" prompt, so the noArchive branch is reached directly.

  test('dirty worktree + no --force refuses up-front and preserves the task', async () => {
    const errs = [];
    jest.spyOn(console, 'error').mockImplementation((...a) => errs.push(a.join(' ')));

    prompts.ask.mockResolvedValueOnce('feature/na');
    await runTask(projectDir, 'create', 'TASK-DIRTY');

    const wtPath = path.join(projectDir, 'tasks', 'TASK-DIRTY', WORKTREES_DIR, path.basename(repoDir));
    fs.writeFileSync(path.join(wtPath, 'README.md'), '# uncommitted local change\n'); // dirty

    // Refuses before touching anything → process.exit(1) (mocked to throw).
    await expect(runTask(projectDir, 'finish', 'TASK-DIRTY', '--no-archive'))
      .rejects.toThrow('process.exit(1)');

    // Nothing torn down, never reached the delete confirm.
    expect(fs.existsSync(path.join(projectDir, 'tasks', 'TASK-DIRTY'))).toBe(true);
    expect(fs.existsSync(wtPath)).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'archived-tasks', 'TASK-DIRTY'))).toBe(false);
    expect(prompts.confirm).not.toHaveBeenCalled();
    expect(errs.some(l => l.includes('Cannot finish --no-archive'))).toBe(true);
  });

  test('--yes does not override the refusal — nothing is discarded', async () => {
    prompts.ask.mockResolvedValueOnce('feature/na');
    await runTask(projectDir, 'create', 'TASK-DIRTY-Y');

    const wtPath = path.join(projectDir, 'tasks', 'TASK-DIRTY-Y', WORKTREES_DIR, path.basename(repoDir));
    fs.writeFileSync(path.join(wtPath, 'README.md'), '# uncommitted local change\n'); // dirty

    // --yes is not a --force: it still refuses rather than throwing work away.
    await expect(runTask(projectDir, 'finish', 'TASK-DIRTY-Y', '--no-archive', '--yes'))
      .rejects.toThrow('process.exit(1)');

    expect(fs.existsSync(path.join(projectDir, 'tasks', 'TASK-DIRTY-Y'))).toBe(true);
    expect(fs.existsSync(wtPath)).toBe(true);
    expect(fs.readFileSync(path.join(wtPath, 'README.md'), 'utf8')).toContain('uncommitted local change');
    expect(fs.existsSync(path.join(projectDir, 'archived-tasks', 'TASK-DIRTY-Y'))).toBe(false);
  });

  test('--force is the escape hatch — discards the dirty worktree and deletes', async () => {
    prompts.ask.mockResolvedValueOnce('feature/na');
    await runTask(projectDir, 'create', 'TASK-DIRTY-F');

    const wtPath = path.join(projectDir, 'tasks', 'TASK-DIRTY-F', WORKTREES_DIR, path.basename(repoDir));
    fs.writeFileSync(path.join(wtPath, 'README.md'), '# uncommitted local change\n'); // dirty

    prompts.confirm.mockResolvedValueOnce(true); // "Delete ... permanently?" — still confirmed
    await runTask(projectDir, 'finish', 'TASK-DIRTY-F', '--no-archive', '--force');

    // Deleted outright despite the dirty worktree.
    expect(fs.existsSync(path.join(projectDir, 'tasks', 'TASK-DIRTY-F'))).toBe(false);
    expect(fs.existsSync(wtPath)).toBe(false);
    expect(fs.existsSync(path.join(projectDir, 'archived-tasks', 'TASK-DIRTY-F'))).toBe(false);
    expect(git.branchExistsLocally(repoDir, 'feature/na')).toBe(false);
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
