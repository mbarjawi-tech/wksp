'use strict';
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execSync } = require('child_process');

const { makeTempDir, makeGitRepoWithRemote, makeProject, cleanup } = require('../helpers');
const { addRepo, readRepos } = require('../../lib/repos');
const git  = require('../../lib/git');
const { WORKTREES_DIR } = require('../../lib/worktrees');
const { readTaskSets } = require('../../lib/task-state');
const { BUNDLE_VERSION, writeBundle } = require('../../lib/bundle');

// ─── Module mocks ────────────────────────────────────────────────────────────

jest.mock('../../lib/prompts', () => ({
  open:    jest.fn(),
  close:   jest.fn(),
  ask:     jest.fn(),
  confirm: jest.fn(),
}));

jest.mock('../../lib/providers/claude', () => {
  const actual = jest.requireActual('../../lib/providers/claude');
  return {
    ...actual,
    launch: jest.fn(),
    // Stub session lookup; keep the real placeTranscript so import writes the
    // transcript into the (os.homedir-spied) fake ~/.claude.
    sessions: { ...actual.sessions, findLast: jest.fn().mockReturnValue(null) },
  };
});

jest.mock('../../lib/config', () => {
  const actual = jest.requireActual('../../lib/config');
  return {
    ...actual,
    findProjectDir:    jest.fn().mockReturnValue(null),
    readProjectConfig: jest.fn(),
    readConfig:        jest.fn().mockReturnValue({}),
    writeProjectConfig: jest.fn().mockImplementation((dir, data) => {
      actual.writeProjectConfig(dir, data);
    }),
  };
});

const prompts   = require('../../lib/prompts');
const config    = require('../../lib/config');
const importCmd = require('../../lib/commands/importCmd');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function gitCmd(cwd, cmd) {
  return execSync(`git ${cmd}`, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

// Build a minimal valid bundle
function makeBundle(opts = {}) {
  const projectName = opts.projectName || 'test-proj';
  const taskId      = opts.taskId      || 'TASK-1';
  const repos       = opts.repos       || [];
  const taskRepos   = opts.taskRepos   || [];
  const task = {
    id:       taskId,
    claudeMd: `## Task: ${taskId}\n`,
    // undefined is dropped by JSON.stringify — omitting worklogMd mimics a pre-2.8.0 bundle
    worklogMd: opts.worklogMd,
    shared:   opts.shared   || [],
    excluded: opts.excluded || [],
    repos:    taskRepos,
  };
  // agentsMd is the new canonical field; when present it takes precedence over claudeMd
  if (opts.agentsMd !== undefined) {
    task.agentsMd = opts.agentsMd;
  }
  return {
    bundleVersion: BUNDLE_VERSION,
    exportedAt:    new Date().toISOString(),
    exportedBy:    { machine: 'test-machine' },
    project: { name: projectName, schemaVersion: 2 },
    repos,
    task,
    session: opts.session || null,
  };
}

async function runImport(bundlePath, ...promptAnswers) {
  let idx = 0;
  prompts.ask.mockImplementation(() => Promise.resolve(promptAnswers[idx++] || ''));
  prompts.confirm.mockImplementation(() => Promise.resolve(true));
  await importCmd.run([bundlePath]);
}

// ─── beforeEach / afterEach ───────────────────────────────────────────────────

beforeEach(() => {
  jest.spyOn(process, 'exit').mockImplementation(code => {
    throw new Error(`process.exit(${code})`);
  });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  prompts.ask.mockReset();
  prompts.confirm.mockReset();
  config.findProjectDir.mockReturnValue(null);
  config.readProjectConfig.mockReturnValue({ name: 'test-proj', schemaVersion: 2 });
  config.readConfig.mockReturnValue({});
});
afterEach(() => jest.restoreAllMocks());

// ─── Invalid bundle file ──────────────────────────────────────────────────────

describe('import — invalid bundle file', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTempDir('imp-invalid'); });
  afterEach(() => cleanup(tmpDir));

  test('exits 1 when file does not exist', async () => {
    await expect(importCmd.run([path.join(tmpDir, 'nonexistent.wksp-bundle')]))
      .rejects.toThrow('process.exit(1)');
    const errCalls = console.error.mock.calls.map(a => a.join(' ')).join('\n');
    expect(errCalls).toMatch(/not found/i);
  });

  test('exits 1 when file is not valid JSON', async () => {
    const f = path.join(tmpDir, 'bad.wksp-bundle');
    fs.writeFileSync(f, 'not json');
    await expect(importCmd.run([f])).rejects.toThrow();
  });

  test('exits 1 when bundle has no project field', async () => {
    const f = path.join(tmpDir, 'noproject.wksp-bundle');
    fs.writeFileSync(f, JSON.stringify({ bundleVersion: 1, task: { id: 'X' } }));
    await expect(importCmd.run([f])).rejects.toThrow();
  });
});

// ─── Bundle version too new ───────────────────────────────────────────────────

describe('import — bundle version too new', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTempDir('imp-ver'); });
  afterEach(() => cleanup(tmpDir));

  test('throws an error about newer wksp version', async () => {
    const f = path.join(tmpDir, 'future.wksp-bundle');
    fs.writeFileSync(f, JSON.stringify({
      bundleVersion: 99,
      project: { name: 'x', schemaVersion: 2 },
      task: { id: 'X', repos: [] },
    }));
    await expect(importCmd.run([f])).rejects.toThrow();
    // The error may surface as process.exit(1) or a thrown Error from readBundle
  });
});

// ─── Mode 1 happy path — repo found via reposRoot ─────────────────────────────

describe('import — Mode 1, repo found in reposRoot', () => {
  let projectParent, repoDir, originDir, bundleDir;
  beforeEach(() => {
    projectParent = makeTempDir('imp-m1-parent');
    bundleDir     = makeTempDir('imp-m1-bundle');
    ({ repoDir, originDir } = makeGitRepoWithRemote());
  });
  afterEach(() => cleanup(projectParent, repoDir, originDir, bundleDir));

  test('creates project, registers repo, creates worktree on correct branch', async () => {
    const remoteUrl = git.getRemoteUrl(repoDir);
    const repoName  = path.basename(repoDir);

    // Push a feature branch using a temporary worktree, then remove it
    const wtTmp = makeTempDir('imp-m1-wttmp');
    git.addWorktree(repoDir, wtTmp, 'feature/m1-test', 'main');
    gitCmd(wtTmp, 'push origin feature/m1-test');
    git.removeWorktree(repoDir, wtTmp, true);
    git.pruneWorktrees(repoDir);
    cleanup(wtTmp);

    // Configure reposRoot to the parent of the repo
    const reposRoot = path.dirname(repoDir);
    config.readConfig.mockReturnValue({ reposRoot });

    const bundle = makeBundle({
      projectName: 'my-project',
      taskId: 'TASK-M1',
      repos: [{ folderName: repoName, remoteUrl, localPath: repoDir, isSharedRepo: false, isOptionalRepo: true, hasRemote: true }],
      taskRepos: [{ folderName: repoName, branch: 'feature/m1-test', baseBranch: 'main', tipSha: null, remoteUrl, status: 'worktree' }],
    });
    const bundlePath = path.join(bundleDir, 'test.wksp-bundle');
    writeBundle(bundlePath, bundle);

    // Answers: mode=1, project name='', create in=projectParent
    prompts.ask
      .mockResolvedValueOnce('1')            // import mode
      .mockResolvedValueOnce('')             // project name (accept default)
      .mockResolvedValueOnce(projectParent); // create in
    prompts.confirm.mockResolvedValue(true);

    await importCmd.run([bundlePath]);

    const projectDir = path.join(projectParent, 'my-project');
    expect(fs.existsSync(projectDir)).toBe(true);
    expect(fs.existsSync(path.join(projectDir, '.wksp'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'tasks', 'TASK-M1'))).toBe(true);
    const wtDir = path.join(projectDir, 'tasks', 'TASK-M1', WORKTREES_DIR, repoName);
    expect(fs.existsSync(wtDir)).toBe(true);
    const branch = git.currentBranch(wtDir);
    expect(branch).toBe('feature/m1-test');

    // The bundle's isOptionalRepo flag carries through to the registration.
    expect(fs.readFileSync(path.join(projectDir, 'repos.txt'), 'utf8'))
      .toMatch(new RegExp(`${repoName}\\s+--optional`));

    // Imported task must be brought up to the current schema: WORKLOG.md created and
    // AGENTS.md with Work log section (migrations convert legacy claudeMd → AGENTS.md + include).
    const importedTaskDir = path.join(projectDir, 'tasks', 'TASK-M1');
    expect(fs.existsSync(path.join(importedTaskDir, 'WORKLOG.md'))).toBe(true);
    expect(fs.readFileSync(path.join(importedTaskDir, 'AGENTS.md'), 'utf8')).toContain('## Work log');
    expect(fs.readFileSync(path.join(importedTaskDir, 'CLAUDE.md'), 'utf8')).toBe('@AGENTS.md\n');
  });
});

// ─── Mode 1 — repo cloned when not present in reposRoot ──────────────────────

describe('import — Mode 1, clone repo (reposRoot configured, repo absent)', () => {
  let projectParent, reposRoot, repoDir, originDir, bundleDir;
  beforeEach(() => {
    projectParent = makeTempDir('imp-clone-parent');
    reposRoot     = makeTempDir('imp-clone-repos');
    bundleDir     = makeTempDir('imp-clone-bundle');
    ({ repoDir, originDir } = makeGitRepoWithRemote());
  });
  afterEach(() => cleanup(projectParent, reposRoot, repoDir, originDir, bundleDir));

  test('clones the repo into reposRoot and registers it', async () => {
    const remoteUrl = git.getRemoteUrl(repoDir);
    const repoName  = path.basename(repoDir);

    // Push a feature branch using a temporary worktree, then remove it
    const wtTmp = makeTempDir('imp-clone-wttmp');
    git.addWorktree(repoDir, wtTmp, 'feature/clone-test', 'main');
    gitCmd(wtTmp, 'push origin feature/clone-test');
    git.removeWorktree(repoDir, wtTmp, true);
    git.pruneWorktrees(repoDir);
    cleanup(wtTmp);

    config.readConfig.mockReturnValue({ reposRoot });

    const bundle = makeBundle({
      projectName: 'clone-project',
      taskId: 'TASK-CL',
      repos: [{ folderName: repoName, remoteUrl, localPath: '/old/path', isSharedRepo: false, hasRemote: true }],
      taskRepos: [{ folderName: repoName, branch: 'feature/clone-test', baseBranch: 'main', tipSha: null, remoteUrl, status: 'worktree' }],
    });
    const bundlePath = path.join(bundleDir, 'test.wksp-bundle');
    writeBundle(bundlePath, bundle);

    // Answers: mode=1, project name='', create in=projectParent, confirm clone=''(Y)
    prompts.ask
      .mockResolvedValueOnce('1')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce(projectParent)
      .mockResolvedValueOnce('');  // confirm clone [Y/n]
    prompts.confirm.mockResolvedValue(true);

    await importCmd.run([bundlePath]);

    const clonedPath = path.join(reposRoot, repoName);
    expect(fs.existsSync(clonedPath)).toBe(true);
    const projectDir = path.join(projectParent, 'clone-project');
    const repos = readRepos(projectDir);
    expect(repos.some(r => r.folderName === repoName)).toBe(true);
  });
});

// ─── Mode 2 — task added to existing project ─────────────────────────────────

describe('import — Mode 2, existing project', () => {
  let projectDir, repoDir, originDir, bundleDir;
  beforeEach(() => {
    projectDir = makeProject('imp-m2-proj');
    bundleDir  = makeTempDir('imp-m2-bundle');
    ({ repoDir, originDir } = makeGitRepoWithRemote());
    addRepo(projectDir, repoDir, false);
  });
  afterEach(() => cleanup(projectDir, repoDir, originDir, bundleDir));

  test('creates task with worktree on correct branch', async () => {
    const remoteUrl = git.getRemoteUrl(repoDir);
    const repoName  = path.basename(repoDir);

    // Push a feature branch using a temporary worktree, then remove it
    const wtTmp = makeTempDir('imp-m2-wttmp');
    git.addWorktree(repoDir, wtTmp, 'feature/m2-test', 'main');
    gitCmd(wtTmp, 'push origin feature/m2-test');
    git.removeWorktree(repoDir, wtTmp, true);
    git.pruneWorktrees(repoDir);
    cleanup(wtTmp);

    config.findProjectDir.mockReturnValue(projectDir);
    config.readProjectConfig.mockReturnValue({ name: 'imp-m2-proj', schemaVersion: 2 });
    config.readConfig.mockReturnValue({});

    const bundle = makeBundle({
      projectName: 'imp-m2-proj',
      taskId: 'TASK-M2',
      repos: [{ folderName: repoName, remoteUrl, localPath: repoDir, isSharedRepo: false, hasRemote: true }],
      taskRepos: [{ folderName: repoName, branch: 'feature/m2-test', baseBranch: 'main', tipSha: null, remoteUrl, status: 'worktree' }],
    });
    const bundlePath = path.join(bundleDir, 'test.wksp-bundle');
    writeBundle(bundlePath, bundle);

    prompts.ask
      .mockResolvedValueOnce('2');  // import mode: existing project
    prompts.confirm.mockResolvedValue(true);

    await importCmd.run([bundlePath]);

    const taskDir = path.join(projectDir, 'tasks', 'TASK-M2');
    expect(fs.existsSync(taskDir)).toBe(true);
    const wtDir = path.join(taskDir, WORKTREES_DIR, repoName);
    expect(fs.existsSync(wtDir)).toBe(true);
    expect(git.currentBranch(wtDir)).toBe('feature/m2-test');
  });
});

// ─── The .wksp / ~/.wksp filename collision ──────────────────────────────────

// A project marker and the global config are both called `.wksp`. Mode 1 writes a project
// marker, so it must refuse the home directory for the same reason `wksp init` does; Mode
// 2 accepts a hand-typed path, and "a .wksp is present" was never proof of a project.
describe('import — never treats the home directory as a project', () => {
  let bundleDir, fakeHome, errs;
  beforeEach(() => {
    bundleDir = makeTempDir('imp-collide-bundle');
    fakeHome  = makeTempDir('imp-fake-home');
    fs.writeFileSync(path.join(fakeHome, '.wksp'), JSON.stringify({ reposRoot: '/c/dev' }) + '\n');
    jest.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    errs = [];
    console.error.mockImplementation((...a) => errs.push(a.join(' ')));
  });
  afterEach(() => cleanup(bundleDir, fakeHome));

  function writeMinimalBundle() {
    const bundlePath = path.join(bundleDir, 'test.wksp-bundle');
    writeBundle(bundlePath, makeBundle({ projectName: 'collide', taskId: 'TASK-C' }));
    return bundlePath;
  }

  test('Mode 1 refuses to create a project AT the home directory', async () => {
    const bundlePath = writeMinimalBundle();
    prompts.ask
      .mockResolvedValueOnce('1')                  // mode: new project
      .mockResolvedValueOnce('.')                  // project name → resolves to the parent itself
      .mockResolvedValueOnce(fakeHome);            // create in: the home directory
    prompts.confirm.mockResolvedValue(true);

    await expect(importCmd.run([bundlePath])).rejects.toThrow('process.exit(1)');

    // The global config survived — a project marker would have replaced it.
    expect(JSON.parse(fs.readFileSync(path.join(fakeHome, '.wksp'), 'utf8'))).toEqual({ reposRoot: '/c/dev' });
    expect(fs.existsSync(path.join(fakeHome, 'tasks'))).toBe(false);
    expect(errs.join('\n')).toContain('refusing to create a project');
  });

  test('Mode 2 rejects a hand-typed path whose .wksp is really the global config', async () => {
    const bundlePath = writeMinimalBundle();
    config.findProjectDir.mockReturnValue(null);   // not standing in a project
    prompts.ask
      .mockResolvedValueOnce('2')                  // mode: existing project
      .mockResolvedValueOnce(fakeHome);            // path to existing project
    prompts.confirm.mockResolvedValue(true);

    await expect(importCmd.run([bundlePath])).rejects.toThrow('process.exit(1)');

    expect(fs.existsSync(path.join(fakeHome, 'tasks'))).toBe(false);
    expect(errs.join('\n')).toContain('is not a wksp project');
  });

  test('Mode 2 still accepts a real project that lives inside the home directory', async () => {
    const projectDir = path.join(fakeHome, 'projects', 'inside');
    fs.mkdirSync(path.join(projectDir, 'tasks'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.wksp'), JSON.stringify({ name: 'inside', schemaVersion: 2 }) + '\n');
    fs.writeFileSync(path.join(projectDir, 'repos.txt'), '\n');

    const bundlePath = writeMinimalBundle();
    config.findProjectDir.mockReturnValue(null);
    config.readProjectConfig.mockReturnValue({ name: 'inside', schemaVersion: 2 });
    prompts.ask
      .mockResolvedValueOnce('2')
      .mockResolvedValueOnce(projectDir);
    prompts.confirm.mockResolvedValue(true);

    await importCmd.run([bundlePath]);

    expect(fs.existsSync(path.join(projectDir, 'tasks', 'TASK-C'))).toBe(true);
    expect(errs.join('\n')).not.toContain('is not a wksp project');
  });
});

// ─── Mode 2 — task already exists → error ────────────────────────────────────

describe('import — Mode 2, task already exists', () => {
  let projectDir, bundleDir;
  beforeEach(() => {
    projectDir = makeProject('imp-dup');
    bundleDir  = makeTempDir('imp-dup-bundle');
    // Pre-create the task dir
    fs.mkdirSync(path.join(projectDir, 'tasks', 'TASK-DUP', WORKTREES_DIR), { recursive: true });
  });
  afterEach(() => cleanup(projectDir, bundleDir));

  test('exits 1 with task already exists error', async () => {
    config.findProjectDir.mockReturnValue(projectDir);
    config.readProjectConfig.mockReturnValue({ name: 'imp-dup', schemaVersion: 2 });

    const bundle = makeBundle({ projectName: 'imp-dup', taskId: 'TASK-DUP', repos: [], taskRepos: [] });
    const bundlePath = path.join(bundleDir, 'test.wksp-bundle');
    writeBundle(bundlePath, bundle);

    prompts.ask.mockResolvedValueOnce('2'); // existing project mode
    prompts.confirm.mockResolvedValue(true);

    await expect(importCmd.run([bundlePath])).rejects.toThrow('process.exit(1)');
    const errCalls = console.error.mock.calls.map(a => a.join(' ')).join('\n');
    expect(errCalls).toMatch(/already exists/i);
  });
});

// ─── Mode 2 — repo matched by remoteUrl with different folderName ─────────────

describe('import — Mode 2, repo matched by remoteUrl (different folderName)', () => {
  let projectDir, repoDir, originDir, bundleDir;
  beforeEach(() => {
    projectDir = makeProject('imp-remap');
    bundleDir  = makeTempDir('imp-remap-bundle');
    ({ repoDir, originDir } = makeGitRepoWithRemote());
    // Register repo with its real folder name
    addRepo(projectDir, repoDir, false);
  });
  afterEach(() => cleanup(projectDir, repoDir, originDir, bundleDir));

  test('uses existing folderName when remoteUrl matches', async () => {
    const remoteUrl  = git.getRemoteUrl(repoDir);
    const repoName   = path.basename(repoDir);
    const bundleName = 'different-name';

    // Push a feature branch using a temporary worktree, then remove it
    const wtTmp = makeTempDir('imp-remap-wttmp');
    git.addWorktree(repoDir, wtTmp, 'feature/remap', 'main');
    gitCmd(wtTmp, 'push origin feature/remap');
    git.removeWorktree(repoDir, wtTmp, true);
    git.pruneWorktrees(repoDir);
    cleanup(wtTmp);

    config.findProjectDir.mockReturnValue(projectDir);
    config.readProjectConfig.mockReturnValue({ name: 'imp-remap', schemaVersion: 2 });
    config.readConfig.mockReturnValue({});

    // Bundle uses a different folderName but same remoteUrl
    const bundle = makeBundle({
      projectName: 'imp-remap',
      taskId: 'TASK-REMAP',
      repos: [{ folderName: bundleName, remoteUrl, localPath: '/old/path', isSharedRepo: false, hasRemote: true }],
      taskRepos: [{ folderName: bundleName, branch: 'feature/remap', baseBranch: 'main', tipSha: null, remoteUrl, status: 'worktree' }],
    });
    const bundlePath = path.join(bundleDir, 'test.wksp-bundle');
    writeBundle(bundlePath, bundle);

    prompts.ask.mockResolvedValueOnce('2'); // existing project
    prompts.confirm.mockResolvedValue(true);

    await importCmd.run([bundlePath]);

    // The worktree should be created under the existing repo's folderName
    const taskDir = path.join(projectDir, 'tasks', 'TASK-REMAP');
    expect(fs.existsSync(taskDir)).toBe(true);
    const logCalls = console.log.mock.calls.map(a => a.join(' ')).join('\n');
    expect(logCalls).toMatch(/same remote/i);
  });
});

// ─── WORKLOG.md restored from bundle ─────────────────────────────────────────

describe('import — WORKLOG.md', () => {
  let projectDir, bundleDir;
  beforeEach(() => {
    projectDir = makeProject('imp-worklog');
    bundleDir  = makeTempDir('imp-worklog-bundle');
    config.findProjectDir.mockReturnValue(projectDir);
    config.readProjectConfig.mockReturnValue({ name: 'imp-worklog', schemaVersion: 2 });
  });
  afterEach(() => cleanup(projectDir, bundleDir));

  test('restores WORKLOG.md content from the bundle', async () => {
    const worklog = '# Work Log: TASK-WL\n- 2026-07-01: shipped the widget\n- 2026-07-03: fixed the frobnicator\n';
    const bundle = makeBundle({ projectName: 'imp-worklog', taskId: 'TASK-WL', worklogMd: worklog });
    const bundlePath = path.join(bundleDir, 'test.wksp-bundle');
    writeBundle(bundlePath, bundle);

    prompts.ask.mockResolvedValueOnce('2'); // existing project
    prompts.confirm.mockResolvedValue(true);

    await importCmd.run([bundlePath]);

    const worklogPath = path.join(projectDir, 'tasks', 'TASK-WL', 'WORKLOG.md');
    expect(fs.readFileSync(worklogPath, 'utf8')).toBe(worklog);
  });

  test('bundle without worklogMd (pre-2.8.0) gets an empty WORKLOG.md via migration', async () => {
    const bundle = makeBundle({ projectName: 'imp-worklog', taskId: 'TASK-WL2' });
    const bundlePath = path.join(bundleDir, 'test.wksp-bundle');
    writeBundle(bundlePath, bundle);

    prompts.ask.mockResolvedValueOnce('2'); // existing project
    prompts.confirm.mockResolvedValue(true);

    await importCmd.run([bundlePath]);

    const worklogPath = path.join(projectDir, 'tasks', 'TASK-WL2', 'WORKLOG.md');
    expect(fs.readFileSync(worklogPath, 'utf8')).toBe('# Work Log: TASK-WL2\n');
  });
});

// ─── Bundle with agentsMd field ──────────────────────────────────────────────

describe('import — bundle with agentsMd', () => {
  let projectDir, bundleDir;
  beforeEach(() => {
    projectDir = makeProject('imp-agents');
    bundleDir  = makeTempDir('imp-agents-bundle');
    config.findProjectDir.mockReturnValue(projectDir);
    config.readProjectConfig.mockReturnValue({ name: 'imp-agents', schemaVersion: 2 });
  });
  afterEach(() => cleanup(projectDir, bundleDir));

  test('writes AGENTS.md with agentsMd content and CLAUDE.md as the one-line include', async () => {
    const agentsContent = '## Task: X\ncustom agents content\n';
    const bundle = makeBundle({
      projectName: 'imp-agents',
      taskId: 'TASK-AGENTS',
      agentsMd: agentsContent,
    });
    const bundlePath = path.join(bundleDir, 'test.wksp-bundle');
    writeBundle(bundlePath, bundle);

    prompts.ask.mockResolvedValueOnce('2'); // existing project
    prompts.confirm.mockResolvedValue(true);

    await importCmd.run([bundlePath]);

    const taskDir = path.join(projectDir, 'tasks', 'TASK-AGENTS');
    // Migrations may append sections (e.g. ## Work log) to AGENTS.md, so check
    // that the original content is present rather than an exact match.
    const writtenAgentsMd = fs.readFileSync(path.join(taskDir, 'AGENTS.md'), 'utf8');
    expect(writtenAgentsMd).toContain('## Task: X');
    expect(writtenAgentsMd).toContain('custom agents content');
    expect(fs.readFileSync(path.join(taskDir, 'CLAUDE.md'), 'utf8')).toBe('@AGENTS.md\n');
  });
});

// ─── Session placed correctly on import ──────────────────────────────────────

describe('import — session placed correctly', () => {
  let projectDir, bundleDir, tempHome;
  beforeAll(() => { tempHome = makeTempDir('imp-sess-home'); });
  afterAll(() => cleanup(tempHome));

  beforeEach(() => {
    projectDir = makeProject('imp-sess');
    bundleDir  = makeTempDir('imp-sess-bundle');
  });
  afterEach(() => cleanup(projectDir, bundleDir));

  test('places session jsonl in ~/.claude/projects/<encoded>/<id>.jsonl', async () => {
    jest.spyOn(os, 'homedir').mockReturnValue(tempHome);

    const { encodeProjectPath } = require('../../lib/providers/claude');

    config.findProjectDir.mockReturnValue(projectDir);
    config.readProjectConfig.mockReturnValue({ name: 'imp-sess', schemaVersion: 2 });
    config.readConfig.mockReturnValue({});

    const sessionContent = '{"role":"user","content":"hello from session"}\n';
    const bundle = makeBundle({
      projectName: 'imp-sess',
      taskId: 'TASK-SESS',
      repos: [],
      taskRepos: [],
      session: { id: 'sess-abc', jsonl: sessionContent },
    });
    const bundlePath = path.join(bundleDir, 'test.wksp-bundle');
    writeBundle(bundlePath, bundle);

    prompts.ask.mockResolvedValueOnce('2'); // existing project
    prompts.confirm.mockResolvedValue(true);

    await importCmd.run([bundlePath]);

    const taskDir  = path.join(projectDir, 'tasks', 'TASK-SESS');
    const encoded  = encodeProjectPath(taskDir);
    const sessFile = path.join(tempHome, '.claude', 'projects', encoded, 'sess-abc.jsonl');
    expect(fs.existsSync(sessFile)).toBe(true);
    expect(fs.readFileSync(sessFile, 'utf8')).toBe(sessionContent);
  });

  test('a provider-less bundle session is treated as claude and placed', async () => {
    jest.spyOn(os, 'homedir').mockReturnValue(tempHome);
    const { encodeProjectPath } = require('../../lib/providers/claude');

    config.findProjectDir.mockReturnValue(projectDir);
    config.readProjectConfig.mockReturnValue({ name: 'imp-sess', schemaVersion: 2 });
    config.readConfig.mockReturnValue({}); // active provider: claude

    const bundle = makeBundle({
      projectName: 'imp-sess',
      taskId: 'TASK-NOPROV',
      session: { id: 'noprov-1', jsonl: '{"x":1}\n' }, // no provider field (old bundle)
    });
    const bundlePath = path.join(bundleDir, 'noprov.wksp-bundle');
    writeBundle(bundlePath, bundle);

    prompts.ask.mockResolvedValueOnce('2');
    prompts.confirm.mockResolvedValue(true);
    await importCmd.run([bundlePath]);

    const encoded  = encodeProjectPath(path.join(projectDir, 'tasks', 'TASK-NOPROV'));
    expect(fs.existsSync(path.join(tempHome, '.claude', 'projects', encoded, 'noprov-1.jsonl'))).toBe(true);
  });

  test('skips the transcript with a note when the active provider is none', async () => {
    jest.spyOn(os, 'homedir').mockReturnValue(tempHome);
    const logLines = [];
    console.log.mockImplementation((...a) => logLines.push(a.join(' ')));
    const { encodeProjectPath } = require('../../lib/providers/claude');

    config.findProjectDir.mockReturnValue(projectDir);
    config.readProjectConfig.mockReturnValue({ name: 'imp-sess', schemaVersion: 2 });
    config.readConfig.mockReturnValue({ aiProvider: 'none' }); // baseline — can't consume sessions

    const bundle = makeBundle({
      projectName: 'imp-sess',
      taskId: 'TASK-SKIP',
      session: { id: 'skip-1', jsonl: '{"x":1}\n', provider: 'claude' },
    });
    const bundlePath = path.join(bundleDir, 'skip.wksp-bundle');
    writeBundle(bundlePath, bundle);

    prompts.ask.mockResolvedValueOnce('2');
    prompts.confirm.mockResolvedValue(true);
    await importCmd.run([bundlePath]);

    const encoded  = encodeProjectPath(path.join(projectDir, 'tasks', 'TASK-SKIP'));
    expect(fs.existsSync(path.join(tempHome, '.claude', 'projects', encoded, 'skip-1.jsonl'))).toBe(false);
    const text = logLines.join('\n');
    expect(text).toMatch(/came from 'claude'/);
    expect(text).toMatch(/'none' can't consume it; skipped/);
  });
});
