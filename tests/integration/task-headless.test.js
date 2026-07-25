'use strict';
const fs   = require('fs');
const path = require('path');
const { makeTempDir, makeGitRepo, makeProject, cleanup } = require('../helpers');
const { addRepo } = require('../../lib/repos');
const git = require('../../lib/git');

jest.mock('../../lib/prompts', () => ({
  open: jest.fn(), close: jest.fn(), ask: jest.fn(),
  confirm: jest.fn(), confirmDefaultYes: jest.fn(),
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
    readConfig:        jest.fn().mockReturnValue({ autoResume: false }),
  };
});

const prompts  = require('../../lib/prompts');
const claude   = require('../../lib/providers/claude');
const config   = require('../../lib/config');
const taskCmd  = require('../../lib/commands/task');
const startCmd = require('../../lib/commands/start');
const listCmd  = require('../../lib/commands/list');

let logLines, stdout;
beforeEach(() => {
  logLines = [];
  stdout   = [];
  jest.spyOn(console, 'log').mockImplementation((...a) => logLines.push(a.join(' ')));
  jest.spyOn(console, 'warn').mockImplementation((...a) => logLines.push(a.join(' ')));
  jest.spyOn(console, 'error').mockImplementation((...a) => logLines.push(a.join(' ')));
  jest.spyOn(process.stdout, 'write').mockImplementation(s => { stdout.push(s); return true; });
  jest.spyOn(process, 'exit').mockImplementation(code => { throw new Error(`process.exit(${code})`); });
  prompts.ask.mockReset();
  prompts.confirm.mockReset();
  prompts.confirmDefaultYes.mockReset();
  claude.launch.mockReset();
});
afterEach(() => jest.restoreAllMocks());

const out  = () => logLines.join('\n');
const json = () => JSON.parse(stdout.join(''));

async function runTask(projectDir, ...args) {
  config.findProjectDir.mockReturnValue(projectDir);
  await taskCmd.run(args);
}
async function runStart(projectDir, ...args) {
  config.findProjectDir.mockReturnValue(projectDir);
  await startCmd.run(args);
}
async function runList(projectDir, ...args) {
  config.findProjectDir.mockReturnValue(projectDir);
  await listCmd.run(args);
}

// ─── the two axes: prompting and launching ───────────────────────────────────

describe('headless create — prompting and launching are separate', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('headless');
    repoDir    = makeTempDir('repo-headless');
    makeGitRepo(repoDir);
    addRepo(projectDir, repoDir, false);
  });
  afterEach(() => cleanup(projectDir, repoDir));

  const wtDir = id => path.join(projectDir, 'tasks', id, 'worktrees', path.basename(repoDir));

  test('--yes answers the prompts but still launches', async () => {
    await runTask(projectDir, 'create', 'T-YES', '--yes');
    expect(prompts.ask).not.toHaveBeenCalled();
    expect(claude.launch).toHaveBeenCalledTimes(1);
    expect(git.currentBranch(wtDir('T-YES'))).toBe('T-YES');
  });

  test('--no-launch sets the task up and prints the brief instead of launching', async () => {
    await runTask(projectDir, 'create', 'T-NL', '--yes', '--no-launch');
    expect(claude.launch).not.toHaveBeenCalled();
    expect(fs.existsSync(wtDir('T-NL'))).toBe(true);
    expect(out()).toContain('task brief');
    expect(out()).toContain('Task folder:');
  });

  test('--branch answers the prompt but does not suppress the launch', async () => {
    await runTask(projectDir, 'create', 'T-BRONLY', '--branch', 'feat/j');
    expect(prompts.ask).not.toHaveBeenCalled();
    expect(claude.launch).toHaveBeenCalledTimes(1);
  });

  test('--json implies both, and puts nothing but JSON on stdout', async () => {
    await runTask(projectDir, 'create', 'T-JSON2', '--branch', 'feat/j2', '--json');

    expect(prompts.ask).not.toHaveBeenCalled();
    expect(claude.launch).not.toHaveBeenCalled();

    const doc = json();
    expect(doc.ok).toBe(true);
    expect(doc.task.id).toBe('T-JSON2');
    expect(doc.task.created).toBe(true);
    expect(doc.launched).toBe(false);
    expect(doc.repos[0]).toMatchObject({ mode: 'worktree', branch: 'feat/j2', created: true });
    // Everything human-readable was diverted away from stdout.
    expect(stdout.join('')).toBe(JSON.stringify(doc, null, 2) + '\n');
  });

  test('a repo the flags do not cover is still prompted for when --yes is absent', async () => {
    const second = makeTempDir('repo-headless-2');
    makeGitRepo(second);
    addRepo(projectDir, second, false);
    prompts.ask.mockResolvedValueOnce('x'); // exclude the second repo

    await runTask(projectDir, 'create', 'T-MIX', `--branch`, `${path.basename(repoDir)}=feat/m`, '--no-launch');

    expect(prompts.ask).toHaveBeenCalledTimes(1);
    const sets = JSON.parse(fs.readFileSync(path.join(projectDir, 'tasks', 'T-MIX', 'task.json'), 'utf8'));
    expect(sets.excluded).toEqual([path.basename(second)]);
    cleanup(second);
  });

  test('the bare --branch form covers every repo, so nothing is prompted', async () => {
    const second = makeTempDir('repo-headless-3');
    makeGitRepo(second);
    addRepo(projectDir, second, false);

    await runTask(projectDir, 'create', 'T-ALL', '--branch', 'feat/all', '--no-launch');

    expect(prompts.ask).not.toHaveBeenCalled();
    expect(git.currentBranch(wtDir('T-ALL'))).toBe('feat/all');
    cleanup(second);
  });
});

// ─── dispositions ────────────────────────────────────────────────────────────

describe('headless create — dispositions', () => {
  let projectDir, apiDir, webDir;
  beforeEach(() => {
    projectDir = makeProject('headless-disp');
    apiDir = makeTempDir('api');  makeGitRepo(apiDir);
    webDir = makeTempDir('web');  makeGitRepo(webDir);
    addRepo(projectDir, apiDir, false);
    addRepo(projectDir, webDir, false);
  });
  afterEach(() => cleanup(projectDir, apiDir, webDir));

  const api = () => path.basename(apiDir);
  const web = () => path.basename(webDir);

  test('--shared and --exclude land in task.json with no worktrees', async () => {
    await runTask(projectDir, 'create', 'T-D', '--shared', api(), '--exclude', web(), '--json');

    const doc = json();
    expect(doc.repos.find(r => r.name === api()).mode).toBe('shared');
    expect(doc.repos.find(r => r.name === web()).mode).toBe('excluded');
    const sets = JSON.parse(fs.readFileSync(path.join(projectDir, 'tasks', 'T-D', 'task.json'), 'utf8'));
    expect(sets).toEqual({ shared: [api()], excluded: [web()] });
    expect(fs.readdirSync(path.join(projectDir, 'tasks', 'T-D', 'worktrees'))).toEqual([]);
  });

  test('--base decides where a new branch starts', async () => {
    git.tryRun(`git -C "${apiDir}" branch develop`);
    git.tryRun(`git -C "${apiDir}" commit --allow-empty -m second`);

    await runTask(projectDir, 'create', 'T-B', '--branch', `${api()}=feat/b`, '--base', `${api()}=develop`,
      '--exclude', web(), '--no-launch');

    const wt = path.join(projectDir, 'tasks', 'T-B', 'worktrees', api());
    // Branched off develop, so the later commit on main is not an ancestor of HEAD.
    expect(git.isAncestor(wt, 'develop', 'HEAD')).toBe(true);
    expect(git.revParse(wt, 'HEAD')).toBe(git.revParse(apiDir, 'develop'));
  });

  test('--goal fills the Goal line in the task instruction file', async () => {
    await runTask(projectDir, 'create', 'T-G', '--yes', '--exclude', api(), '--exclude', web(), '--no-launch',
      '--goal', 'make the widget spin');

    const agents = fs.readFileSync(path.join(projectDir, 'tasks', 'T-G', 'AGENTS.md'), 'utf8');
    expect(agents).toContain('## Goal: make the widget spin');
    expect(agents).not.toContain('(describe the task here)');
  });

  test('an --optional repo is pulled in when a flag names it explicitly', async () => {
    const optDir = makeTempDir('opt');
    makeGitRepo(optDir);
    addRepo(projectDir, optDir, { optional: true });

    await runTask(projectDir, 'create', 'T-O', '--branch', `${path.basename(optDir)}=feat/o`,
      '--exclude', api(), '--exclude', web(), '--json');

    expect(json().repos.find(r => r.name === path.basename(optDir))).toMatchObject({
      mode: 'worktree', branch: 'feat/o',
    });
    cleanup(optDir);
  });
});

// ─── validate before mutating ────────────────────────────────────────────────

describe('headless create — validates before creating anything', () => {
  let projectDir, apiDir;
  beforeEach(() => {
    projectDir = makeProject('headless-val');
    apiDir     = makeTempDir('api-val');
    makeGitRepo(apiDir);
    addRepo(projectDir, apiDir, false);
  });
  afterEach(() => cleanup(projectDir, apiDir));

  test('an unknown repo name errors and leaves no task folder behind', async () => {
    await expect(runTask(projectDir, 'create', 'T-BAD', '--branch', 'nope=feat/x', '--yes'))
      .rejects.toThrow('process.exit(1)');

    expect(fs.existsSync(path.join(projectDir, 'tasks', 'T-BAD'))).toBe(false);
    expect(out()).toContain('not registered in repos.txt');
    expect(claude.launch).not.toHaveBeenCalled();
  });

  test('a branch already checked out elsewhere errors with the flag that fixes it', async () => {
    await runTask(projectDir, 'create', 'T-FIRST', '--branch', 'feat/shared-name', '--no-launch');

    await expect(runTask(projectDir, 'create', 'T-SECOND', '--branch', 'feat/shared-name', '--yes'))
      .rejects.toThrow('process.exit(1)');

    expect(fs.existsSync(path.join(projectDir, 'tasks', 'T-SECOND'))).toBe(false);
    expect(out()).toContain('already checked out in');
    expect(out()).toContain('--branch');
  });

  test('a repo missing on disk errors instead of being silently skipped', async () => {
    const gone = path.join(projectDir, 'not-there');
    addRepo(projectDir, gone, false);

    await expect(runTask(projectDir, 'create', 'T-GONE', '--yes'))
      .rejects.toThrow('process.exit(1)');

    expect(fs.existsSync(path.join(projectDir, 'tasks', 'T-GONE'))).toBe(false);
    expect(out()).toContain('not found on disk');
  });

  test('--json reports the failure as JSON, not prose', async () => {
    await expect(runTask(projectDir, 'create', 'T-JBAD', '--branch', 'nope=feat/x', '--json'))
      .rejects.toThrow('process.exit(1)');

    const doc = json();
    expect(doc.ok).toBe(false);
    expect(doc.error).toMatch(/cannot set up task "T-JBAD"/);
    expect(doc.details[0]).toMatch(/not registered/);
  });

  test('creating a task that already exists is a JSON error too', async () => {
    await runTask(projectDir, 'create', 'T-DUP', '--yes', '--no-launch');
    await expect(runTask(projectDir, 'create', 'T-DUP', '--json')).rejects.toThrow('process.exit(1)');
    expect(json()).toMatchObject({ ok: false, error: expect.stringContaining('already exists') });
  });
});

// ─── dry run ─────────────────────────────────────────────────────────────────

describe('--dry-run', () => {
  let projectDir, apiDir;
  beforeEach(() => {
    projectDir = makeProject('headless-dry');
    apiDir     = makeTempDir('api-dry');
    makeGitRepo(apiDir);
    addRepo(projectDir, apiDir, false);
  });
  afterEach(() => cleanup(projectDir, apiDir));

  test('prints the plan and creates nothing', async () => {
    await runTask(projectDir, 'create', 'T-DRY', '--branch', 'feat/d', '--dry-run');

    expect(out()).toContain('create plan');
    expect(out()).toMatch(/worktree\s+feat\/d/);
    expect(out()).toContain('nothing created');
    expect(fs.existsSync(path.join(projectDir, 'tasks', 'T-DRY'))).toBe(false);
    expect(claude.launch).not.toHaveBeenCalled();
  });

  test('--dry-run --json emits the plan as data', async () => {
    await runTask(projectDir, 'create', 'T-DRYJ', '--branch', 'feat/d', '--dry-run', '--json');

    const doc = json();
    expect(doc).toMatchObject({ ok: true, dryRun: true, task: { id: 'T-DRYJ', exists: false } });
    expect(doc.plan[0]).toMatchObject({ mode: 'worktree', branch: 'feat/d', newBranch: true });
    expect(fs.existsSync(path.join(projectDir, 'tasks', 'T-DRYJ'))).toBe(false);
  });

  test('names the repos that would be prompted for', async () => {
    await runTask(projectDir, 'create', 'T-DRYP', '--dry-run');
    // --dry-run implies --yes, so nothing is left to prompt for
    expect(out()).not.toContain('would be prompted');
  });
});

// ─── brief ───────────────────────────────────────────────────────────────────

describe('wksp task brief', () => {
  let projectDir, apiDir;
  beforeEach(async () => {
    projectDir = makeProject('headless-brief');
    apiDir     = makeTempDir('api-brief');
    makeGitRepo(apiDir);
    addRepo(projectDir, apiDir, false);
    await runTask(projectDir, 'create', 'T-BR', '--branch', 'feat/br', '--no-launch');
    logLines = []; stdout = [];
  });
  afterEach(() => cleanup(projectDir, apiDir));

  test('reprints the task context without launching or changing anything', async () => {
    await runTask(projectDir, 'brief', 'T-BR');
    expect(claude.launch).not.toHaveBeenCalled();
    expect(out()).toContain('T-BR — task brief');
    expect(out()).toMatch(new RegExp(`${path.basename(apiDir)}\\s+feat/br\\s+worktree`));
    expect(out()).toContain('wksp start T-BR');
  });

  test('--json returns the same document shape as create --json', async () => {
    await runTask(projectDir, 'brief', 'T-BR', '--json');
    const doc = json();
    expect(doc).toMatchObject({ ok: true, briefVersion: 1, launched: false });
    expect(doc.task.id).toBe('T-BR');
    expect(doc.repos[0]).toMatchObject({ mode: 'worktree', branch: 'feat/br' });
    expect(doc.guidance.length).toBeGreaterThan(0);
  });

  test('a partial name resolves like the other task subcommands', async () => {
    await runTask(projectDir, 'brief', 'BR');
    expect(out()).toContain('T-BR — task brief');
  });

  test('an unknown task is an error, as JSON when asked', async () => {
    await expect(runTask(projectDir, 'brief', 'T-NOPE', '--json')).rejects.toThrow('process.exit(1)');
    expect(json()).toMatchObject({ ok: false, error: expect.stringContaining('not found') });
  });
});

// ─── resume ──────────────────────────────────────────────────────────────────

describe('headless resume', () => {
  let projectDir, apiDir, webDir;
  beforeEach(async () => {
    projectDir = makeProject('headless-resume');
    apiDir = makeTempDir('api-res'); makeGitRepo(apiDir);
    webDir = makeTempDir('web-res'); makeGitRepo(webDir);
    addRepo(projectDir, apiDir, false);
    await runTask(projectDir, 'create', 'T-RS', '--branch', 'feat/rs', '--no-launch');
    logLines = []; stdout = [];
  });
  afterEach(() => cleanup(projectDir, apiDir, webDir));

  test('a repo added since the task was created is set up without prompting', async () => {
    addRepo(projectDir, webDir, false);

    await runTask(projectDir, 'resume', 'T-RS', '--branch', `${path.basename(webDir)}=feat/web`, '--json');

    expect(prompts.ask).not.toHaveBeenCalled();
    const doc = json();
    expect(doc.task.created).toBe(false);
    expect(doc.repos.find(r => r.name === path.basename(webDir))).toMatchObject({
      mode: 'worktree', branch: 'feat/web', created: true,
    });
  });

  test('an existing worktree is left alone, and re-dispositioning it is refused', async () => {
    await expect(runTask(projectDir, 'resume', 'T-RS', '--shared', path.basename(apiDir), '--json'))
      .rejects.toThrow('process.exit(1)');
    expect(json().details[0]).toMatch(/already has a worktree/);
    // The worktree survived the refusal.
    expect(git.currentBranch(path.join(projectDir, 'tasks', 'T-RS', 'worktrees', path.basename(apiDir))))
      .toBe('feat/rs');
  });

  test('resuming a task that does not exist errors', async () => {
    await expect(runTask(projectDir, 'resume', 'T-MISSING', '--json')).rejects.toThrow('process.exit(1)');
    expect(json()).toMatchObject({ ok: false });
  });
});

// ─── wksp start pass-through ─────────────────────────────────────────────────

describe('wksp start with headless flags', () => {
  let projectDir, apiDir;
  beforeEach(() => {
    projectDir = makeProject('headless-start');
    apiDir     = makeTempDir('api-start');
    makeGitRepo(apiDir);
    addRepo(projectDir, apiDir, false);
  });
  afterEach(() => cleanup(projectDir, apiDir));

  test('creates the task without the "create it?" confirmation and prints the brief', async () => {
    await runStart(projectDir, 'T-NEW', '--branch', 'feat/s', '--json');

    expect(prompts.confirmDefaultYes).not.toHaveBeenCalled();
    expect(claude.launch).not.toHaveBeenCalled();
    const doc = json();
    expect(doc.task.id).toBe('T-NEW');
    expect(doc.task.created).toBe(true);
  });

  test('the task id is found even when a value flag comes first', async () => {
    await runStart(projectDir, '--branch', 'feat/order', '--json', 'T-ORDER');
    expect(json().task.id).toBe('T-ORDER');
  });

  test('resumes an existing task and reports created: false', async () => {
    await runTask(projectDir, 'create', 'T-HERE', '--branch', 'feat/h', '--no-launch');
    logLines = []; stdout = [];

    await runStart(projectDir, 'T-HERE', '--json');
    expect(json()).toMatchObject({ ok: true, task: { id: 'T-HERE', created: false } });
  });

  test('an ambiguous partial name errors instead of opening the picker', async () => {
    await runTask(projectDir, 'create', 'T-ONE', '--yes', '--exclude', path.basename(apiDir), '--no-launch');
    await runTask(projectDir, 'create', 'T-TWO', '--yes', '--exclude', path.basename(apiDir), '--no-launch');
    logLines = []; stdout = [];

    await expect(runStart(projectDir, 'T-', '--json')).rejects.toThrow('process.exit(1)');
    const doc = json();
    expect(doc.error).toMatch(/matches 2 tasks/);
    expect(doc.details.sort()).toEqual(['T-ONE', 'T-TWO']);
  });

  test('root planning has no brief to emit, so --json says so', async () => {
    await expect(runStart(projectDir, '--json')).rejects.toThrow('process.exit(1)');
    expect(json()).toMatchObject({ ok: false, error: expect.stringContaining('needs a task id') });
    expect(claude.launch).not.toHaveBeenCalled();
  });
});

// ─── teardown ────────────────────────────────────────────────────────────────

describe('wksp task delete --yes', () => {
  let projectDir, apiDir;
  beforeEach(async () => {
    projectDir = makeProject('headless-del');
    apiDir     = makeTempDir('api-del');
    makeGitRepo(apiDir);
    addRepo(projectDir, apiDir, false);
    await runTask(projectDir, 'create', 'T-DEL', '--branch', 'feat/del', '--no-launch');
    logLines = []; stdout = [];
  });
  afterEach(() => cleanup(projectDir, apiDir));

  test('tears the task down without asking', async () => {
    await runTask(projectDir, 'delete', 'T-DEL', '--yes');

    expect(prompts.confirm).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(projectDir, 'tasks', 'T-DEL'))).toBe(false);
    // The branch is kept unless --delete-branches asks for it.
    expect(git.branchExistsLocally(apiDir, 'feat/del')).toBe(true);
  });

  test('--delete-branches removes the branch too', async () => {
    await runTask(projectDir, 'delete', 'T-DEL', '--yes', '--delete-branches');
    expect(git.branchExistsLocally(apiDir, 'feat/del')).toBe(false);
  });

  test('refuses to discard uncommitted work and keeps the task', async () => {
    const wt = path.join(projectDir, 'tasks', 'T-DEL', 'worktrees', path.basename(apiDir));
    fs.writeFileSync(path.join(wt, 'scratch.txt'), 'unsaved\n');

    await runTask(projectDir, 'delete', 'T-DEL', '--yes');

    expect(fs.existsSync(path.join(projectDir, 'tasks', 'T-DEL'))).toBe(true);
    expect(out()).toContain('never discards uncommitted work');
    expect(fs.existsSync(path.join(wt, 'scratch.txt'))).toBe(true);
  });
});

// ─── repo participation, headless ────────────────────────────────────────────

describe('wksp task repo <id> <repo> worktree --branch', () => {
  let projectDir, apiDir, optDir;
  beforeEach(async () => {
    projectDir = makeProject('headless-repo');
    apiDir = makeTempDir('api-repo'); makeGitRepo(apiDir);
    optDir = makeTempDir('opt-repo'); makeGitRepo(optDir);
    addRepo(projectDir, apiDir, false);
    addRepo(projectDir, optDir, { optional: true });
    await runTask(projectDir, 'create', 'T-RP', '--branch', 'feat/rp', '--no-launch');
    logLines = []; stdout = [];
  });
  afterEach(() => cleanup(projectDir, apiDir, optDir));

  const wt = name => path.join(projectDir, 'tasks', 'T-RP', 'worktrees', name);

  test('pulls an optional repo in without prompting for the branch', async () => {
    await runTask(projectDir, 'repo', 'T-RP', path.basename(optDir), 'worktree', '--branch', 'feat/opt');

    expect(prompts.ask).not.toHaveBeenCalled();
    expect(git.currentBranch(wt(path.basename(optDir)))).toBe('feat/opt');

    // It is no longer excluded — asserted through the brief, since task.json is
    // removed entirely once both disposition sets are empty.
    stdout = [];
    await runTask(projectDir, 'brief', 'T-RP', '--json');
    expect(json().repos.find(r => r.name === path.basename(optDir)))
      .toMatchObject({ mode: 'worktree', branch: 'feat/opt' });
  });

  test('--base decides where a new branch starts', async () => {
    git.tryRun(`git -C "${optDir}" branch develop`);
    git.tryRun(`git -C "${optDir}" commit --allow-empty -m second`);

    await runTask(projectDir, 'repo', 'T-RP', path.basename(optDir), 'worktree',
      '--branch', 'feat/based', '--base', 'develop');

    const dir = wt(path.basename(optDir));
    expect(git.revParse(dir, 'HEAD')).toBe(git.revParse(optDir, 'develop'));
  });

  test('a branch already checked out in that repo is refused, creating nothing', async () => {
    // Another task holds feat/dup in the same base repo. (A branch name reused
    // across *different* repos is fine — that's wksp's normal pattern — so the
    // conflict has to come from the same repo.)
    await runTask(projectDir, 'create', 'T-OTHER',
      '--branch', `${path.basename(optDir)}=feat/dup`, '--exclude', path.basename(apiDir), '--no-launch');
    logLines = [];

    await expect(runTask(projectDir, 'repo', 'T-RP', path.basename(optDir), 'worktree',
      '--branch', 'feat/dup')).rejects.toThrow('process.exit(1)');

    expect(out()).toContain('already checked out in');
    expect(fs.existsSync(wt(path.basename(optDir)))).toBe(false);
  });

  test('without --branch it still prompts, exactly as before', async () => {
    prompts.ask.mockResolvedValueOnce('feat/prompted');
    await runTask(projectDir, 'repo', 'T-RP', path.basename(optDir), 'worktree');
    expect(prompts.ask).toHaveBeenCalled();
    expect(git.currentBranch(wt(path.basename(optDir)))).toBe('feat/prompted');
  });

  test('--yes refuses to discard uncommitted work when switching to share', async () => {
    fs.writeFileSync(path.join(wt(path.basename(apiDir)), 'scratch.txt'), 'unsaved\n');

    await expect(runTask(projectDir, 'repo', 'T-RP', path.basename(apiDir), 'share', '--yes'))
      .rejects.toThrow('process.exit(1)');

    expect(out()).toContain('never discards uncommitted work');
    expect(fs.existsSync(path.join(wt(path.basename(apiDir)), 'scratch.txt'))).toBe(true);
    expect(prompts.confirm).not.toHaveBeenCalled();
  });

  test('a repos.txt --shared repo can still be given a task worktree explicitly', async () => {
    const sharedDir = makeTempDir('shared-repo');
    makeGitRepo(sharedDir);
    addRepo(projectDir, sharedDir, { shared: true });

    await runTask(projectDir, 'repo', 'T-RP', path.basename(sharedDir), 'worktree', '--branch', 'feat/sh');

    expect(git.currentBranch(wt(path.basename(sharedDir)))).toBe('feat/sh');
    cleanup(sharedDir);
  });
});

// ─── inventory ───────────────────────────────────────────────────────────────

describe('wksp list --json', () => {
  let projectDir, apiDir;
  beforeEach(async () => {
    projectDir = makeProject('headless-list');
    apiDir     = makeTempDir('api-list');
    makeGitRepo(apiDir);
    addRepo(projectDir, apiDir, false);
    await runTask(projectDir, 'create', 'T-L1', '--branch', 'feat/l1', '--no-launch');
    logLines = []; stdout = [];
  });
  afterEach(() => cleanup(projectDir, apiDir));

  test('lists live tasks with their worktree branches', async () => {
    await runList(projectDir, '--json');
    const doc = json();
    expect(doc.ok).toBe(true);
    expect(doc.project.name).toBe('test-project');
    expect(doc.tasks).toEqual([{
      id: 'T-L1', status: 'live',
      dir: expect.stringContaining('T-L1'),
      worktrees: [{ name: path.basename(apiDir), branch: 'feat/l1' }],
    }]);
  });

  test('an empty project returns an empty list rather than prose', async () => {
    const empty = makeProject('headless-list-empty');
    await runList(empty, '--json');
    expect(json().tasks).toEqual([]);
    cleanup(empty);
  });
});
