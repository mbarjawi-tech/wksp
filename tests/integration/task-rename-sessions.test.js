'use strict';
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { makeTempDir, makeGitRepo, makeProject, cleanup } = require('../helpers');
const { addRepo } = require('../../lib/repos');

jest.mock('../../lib/prompts', () => ({
  open: jest.fn(), close: jest.fn(), ask: jest.fn(),
  confirm: jest.fn(), confirmDefaultYes: jest.fn(),
}));

// Keep the real path-encoding / migration helpers; only stub the launcher so no
// real `claude` process is spawned during `task create`.
jest.mock('../../lib/claude', () => {
  const actual = jest.requireActual('../../lib/claude');
  return { ...actual, launch: jest.fn() };
});

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

const prompts = require('../../lib/prompts');
const config  = require('../../lib/config');
const claude  = require('../../lib/claude');
const taskCmd = require('../../lib/commands/task');

let logLines, homeDir;
beforeEach(() => {
  logLines = [];
  jest.spyOn(console, 'log').mockImplementation((...args) => logLines.push(args.join(' ')));
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(process, 'exit').mockImplementation(code => { throw new Error(`process.exit(${code})`); });
  prompts.ask.mockReset();
  prompts.confirm.mockReset();
  prompts.confirmDefaultYes.mockReset();
  prompts.confirmDefaultYes.mockResolvedValue(true); // default: accept the migration

  // Isolate ~/.claude by pointing os.homedir() at a temp dir. (Setting the
  // USERPROFILE/HOME env is not enough — Node's native os.homedir() doesn't
  // reflect a runtime env change here, so spy the call the code actually makes.)
  homeDir = makeTempDir('fake-home');
  jest.spyOn(os, 'homedir').mockReturnValue(homeDir);
});
afterEach(() => {
  jest.restoreAllMocks();
  cleanup(homeDir);
});

async function runTask(projectDir, ...args) {
  config.findProjectDir.mockReturnValue(projectDir);
  await taskCmd.run(args);
}

// Path to a task's encoded session dir under the fake home.
function sessionDir(taskDir) {
  return path.join(homeDir, '.claude', 'projects', claude.encodeProjectPath(taskDir));
}

// Create a task named `id`, then seed a session transcript under its encoded key.
async function createTaskWithSession(projectDir, id, sessionId = 'sess-1') {
  prompts.ask.mockResolvedValueOnce('feature/branch');
  await runTask(projectDir, 'create', id);
  const dir = sessionDir(path.join(projectDir, 'tasks', id));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), '{"type":"session"}\n');
  return dir;
}

describe('wksp task rename — session-history migration', () => {
  let projectDir, repoDir;
  beforeEach(() => {
    projectDir = makeProject('rename-sessions');
    repoDir    = makeTempDir('repo-rename-sessions');
    makeGitRepo(repoDir);
    addRepo(projectDir, repoDir, false);
  });
  afterEach(() => cleanup(projectDir, repoDir));

  test('migrates the encoded session dir so history resolves under the new key', async () => {
    const oldDir = await createTaskWithSession(projectDir, 'OLD-SESS');

    await runTask(projectDir, 'rename', 'OLD-SESS', 'NEW-SESS');

    const newTaskDir = path.join(projectDir, 'tasks', 'NEW-SESS');
    const newDir = sessionDir(newTaskDir);
    expect(fs.existsSync(oldDir)).toBe(false);
    expect(fs.existsSync(path.join(newDir, 'sess-1.jsonl'))).toBe(true);
    // resume / status resolve history under the new key.
    expect(claude.findLastSession(newTaskDir)).toMatchObject({ id: 'sess-1' });
  });

  test('declining leaves the source intact and prints the manual move command', async () => {
    prompts.confirmDefaultYes.mockResolvedValue(false);
    const oldDir = await createTaskWithSession(projectDir, 'OLD-DECL');

    await runTask(projectDir, 'rename', 'OLD-DECL', 'NEW-DECL');

    const newDir = sessionDir(path.join(projectDir, 'tasks', 'NEW-DECL'));
    expect(fs.existsSync(path.join(oldDir, 'sess-1.jsonl'))).toBe(true);
    expect(fs.existsSync(newDir)).toBe(false);
    expect(logLines.some(l => l.includes(oldDir) && l.includes(newDir))).toBe(true);
  });

  test('--no-migrate-sessions skips the move and never prompts', async () => {
    const oldDir = await createTaskWithSession(projectDir, 'OLD-SKIP');

    await runTask(projectDir, 'rename', 'OLD-SKIP', 'NEW-SKIP', '--no-migrate-sessions');

    const newDir = sessionDir(path.join(projectDir, 'tasks', 'NEW-SKIP'));
    expect(fs.existsSync(path.join(oldDir, 'sess-1.jsonl'))).toBe(true);
    expect(fs.existsSync(newDir)).toBe(false);
    expect(prompts.confirmDefaultYes).not.toHaveBeenCalled();
    expect(logLines.some(l => l.includes('left under the old key'))).toBe(true);
  });

  test('--yes auto-confirms the move without prompting', async () => {
    const oldDir = await createTaskWithSession(projectDir, 'OLD-YES');

    await runTask(projectDir, 'rename', 'OLD-YES', 'NEW-YES', '--yes');

    const newDir = sessionDir(path.join(projectDir, 'tasks', 'NEW-YES'));
    expect(prompts.confirmDefaultYes).not.toHaveBeenCalled();
    expect(fs.existsSync(oldDir)).toBe(false);
    expect(fs.existsSync(path.join(newDir, 'sess-1.jsonl'))).toBe(true);
  });

  test('-y is accepted as shorthand for --yes', async () => {
    const oldDir = await createTaskWithSession(projectDir, 'OLD-SHORT');

    await runTask(projectDir, 'rename', 'OLD-SHORT', 'NEW-SHORT', '-y');

    const newDir = sessionDir(path.join(projectDir, 'tasks', 'NEW-SHORT'));
    expect(prompts.confirmDefaultYes).not.toHaveBeenCalled();
    expect(fs.existsSync(oldDir)).toBe(false);
    expect(fs.existsSync(path.join(newDir, 'sess-1.jsonl'))).toBe(true);
  });

  test('renames the WORKLOG.md title heading', async () => {
    await createTaskWithSession(projectDir, 'OLD-WL');
    const worklog = path.join(projectDir, 'tasks', 'OLD-WL', 'WORKLOG.md');
    fs.writeFileSync(worklog, '# Work Log: OLD-WL\n\n- 2026-07-18: seeded\n');

    await runTask(projectDir, 'rename', 'OLD-WL', 'NEW-WL');

    const renamed = fs.readFileSync(path.join(projectDir, 'tasks', 'NEW-WL', 'WORKLOG.md'), 'utf8');
    expect(renamed).toContain('# Work Log: NEW-WL');
    expect(renamed).not.toContain('# Work Log: OLD-WL');
  });

  test('no session history under the old key → silent no-op (no prompt)', async () => {
    prompts.ask.mockResolvedValueOnce('feature/branch');
    await runTask(projectDir, 'create', 'OLD-NONE'); // no session seeded

    await runTask(projectDir, 'rename', 'OLD-NONE', 'NEW-NONE');

    expect(prompts.confirmDefaultYes).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(projectDir, 'tasks', 'NEW-NONE'))).toBe(true);
  });

  test('warns that chat history may be lost when a collision leaves history behind', async () => {
    const oldDir = await createTaskWithSession(projectDir, 'OLD-COL');
    fs.writeFileSync(path.join(oldDir, 'sess-2.jsonl'), '{"type":"session"}\n'); // non-colliding

    // Pre-seed the NEW key with a colliding sess-1.jsonl so the merge can't move it.
    const newDir = sessionDir(path.join(projectDir, 'tasks', 'NEW-COL'));
    fs.mkdirSync(newDir, { recursive: true });
    fs.writeFileSync(path.join(newDir, 'sess-1.jsonl'), 'TARGET-KEPT');

    await runTask(projectDir, 'rename', 'OLD-COL', 'NEW-COL');

    // Non-colliding session moved; colliding target preserved; source retains the clash.
    expect(fs.existsSync(path.join(newDir, 'sess-2.jsonl'))).toBe(true);
    expect(fs.readFileSync(path.join(newDir, 'sess-1.jsonl'), 'utf8')).toBe('TARGET-KEPT');
    expect(fs.existsSync(path.join(oldDir, 'sess-1.jsonl'))).toBe(true);

    // The user is warned loudly, with the paths to recover the stranded history.
    const joined = logLines.join('\n');
    expect(joined).toMatch(/you may lose it/i);
    expect(joined).toContain(oldDir);
  });
});
