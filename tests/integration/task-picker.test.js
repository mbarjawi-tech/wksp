'use strict';
const fs   = require('fs');
const path = require('path');
const { makeProject, cleanup } = require('../helpers');

jest.mock('../../lib/prompts', () => ({
  open: jest.fn(), close: jest.fn(), ask: jest.fn(), confirm: jest.fn(),
}));

jest.mock('../../lib/providers/claude', () => ({
  name: 'claude', instructionFile: 'CLAUDE.md',
  launch: jest.fn(),
  sessions: { findLast: jest.fn().mockReturnValue(null) },
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
const claude  = require('../../lib/providers/claude');
const config  = require('../../lib/config');
const taskCmd = require('../../lib/commands/task');

let logLines;
beforeEach(() => {
  logLines = [];
  jest.spyOn(console, 'log').mockImplementation((...a)  => logLines.push(a.join(' ')));
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation((...a) => logLines.push(a.join(' ')));
  jest.spyOn(process, 'exit').mockImplementation(code => { throw new Error(`process.exit(${code})`); });
  prompts.ask.mockReset();
  prompts.confirm.mockReset();
  prompts.open.mockReset();
  prompts.close.mockReset();
  claude.sessions.findLast.mockReset();
  claude.sessions.findLast.mockReturnValue(null);
});
afterEach(() => jest.restoreAllMocks());

function mkTask(projectDir, id) {
  fs.mkdirSync(path.join(projectDir, 'tasks', id), { recursive: true });
}

// Create a minimal archived task (folder + manifest) under archived-tasks/.
function mkArchivedTask(projectDir, id) {
  const dir = path.join(projectDir, 'archived-tasks', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'archived.json'), JSON.stringify({
    schemaVersion: 1,
    archivedAt: new Date().toISOString(),
    taskId: id,
    projectName: 'test-project',
    reason: null,
    repos: [],
  }, null, 2) + '\n');
  return dir;
}

// Make recency deterministic: map task-dir basename → session mtime (ms).
function setRecency(map) {
  claude.sessions.findLast.mockImplementation(taskDir => {
    const ms = map[path.basename(taskDir)];
    return ms ? { id: 's', mtime: ms } : null;
  });
}

// ─── listLiveTasks ────────────────────────────────────────────────────────────

describe('listLiveTasks', () => {
  let projectDir;
  beforeEach(() => { projectDir = makeProject('pick-list'); });
  afterEach(() => cleanup(projectDir));

  test('returns live tasks sorted by most-recent activity', () => {
    mkTask(projectDir, 'ALPHA');
    mkTask(projectDir, 'BETA');
    mkTask(projectDir, 'GAMMA');
    const now = Date.now();
    setRecency({ GAMMA: now, BETA: now - 1000, ALPHA: now - 2000 });

    const ids = taskCmd.listLiveTasks(projectDir).map(t => t.id);
    expect(ids).toEqual(['GAMMA', 'BETA', 'ALPHA']);
  });

  test('returns [] when there are no tasks', () => {
    expect(taskCmd.listLiveTasks(projectDir)).toEqual([]);
  });
});

// ─── resolveTaskId — with a provided (partial) id ────────────────────────────

describe('resolveTaskId — provided id', () => {
  let projectDir;
  beforeEach(() => {
    projectDir = makeProject('pick-resolve');
    mkTask(projectDir, 'MONA-9348-isa-forms');
    mkTask(projectDir, 'production-new');
  });
  afterEach(() => cleanup(projectDir));

  test('exact match is used without prompting', async () => {
    const id = await taskCmd.resolveTaskId(projectDir, 'resume', 'production-new');
    expect(id).toBe('production-new');
    expect(prompts.open).not.toHaveBeenCalled();
  });

  test('unique substring match resolves and is reported', async () => {
    const id = await taskCmd.resolveTaskId(projectDir, 'resume', 'isa');
    expect(id).toBe('MONA-9348-isa-forms');
    expect(logLines.some(l => l.includes('→ MONA-9348-isa-forms'))).toBe(true);
    expect(prompts.open).not.toHaveBeenCalled();
  });

  test('case-insensitive substring match', async () => {
    const id = await taskCmd.resolveTaskId(projectDir, 'resume', 'ISA');
    expect(id).toBe('MONA-9348-isa-forms');
  });

  test('no match returns the input unchanged (handler errors as before)', async () => {
    const id = await taskCmd.resolveTaskId(projectDir, 'delete', 'nope');
    expect(id).toBe('nope');
    expect(prompts.open).not.toHaveBeenCalled();
  });

  test('multiple matches drop into the picker', async () => {
    mkTask(projectDir, 'feature-a');
    mkTask(projectDir, 'feature-b');
    setRecency({ 'feature-a': Date.now(), 'feature-b': Date.now() - 1000 });
    prompts.ask.mockResolvedValueOnce('2'); // pick the 2nd of the matches

    const id = await taskCmd.resolveTaskId(projectDir, 'resume', 'feature');
    expect(id).toBe('feature-b');
    expect(prompts.open).toHaveBeenCalled();
    expect(prompts.close).toHaveBeenCalled();
  });
});

// ─── resolveTaskId — archived reachability (delete only) ─────────────────────

describe('resolveTaskId — archived tasks are reachable for delete', () => {
  let projectDir;
  beforeEach(() => {
    projectDir = makeProject('pick-archived');
    mkTask(projectDir, 'live-one');
    mkArchivedTask(projectDir, 'MONA-9999-archived-thing');
  });
  afterEach(() => cleanup(projectDir));

  test('delete: a partial matching only an archived task resolves to it', async () => {
    const id = await taskCmd.resolveTaskId(projectDir, 'delete', 'archived-thing');
    expect(id).toBe('MONA-9999-archived-thing');
    expect(logLines.some(l => l.includes('→ MONA-9999-archived-thing (archived)'))).toBe(true);
  });

  test('delete: an exact archived id routes straight through', async () => {
    const id = await taskCmd.resolveTaskId(projectDir, 'delete', 'MONA-9999-archived-thing');
    expect(id).toBe('MONA-9999-archived-thing');
  });

  test('delete: an exact archived id beats a live *partial* superstring', async () => {
    // A live task whose name merely contains the archived id must not shadow the
    // exact archived match for a destructive delete.
    mkTask(projectDir, 'MONA-9999-archived-thing-extra');
    const id = await taskCmd.resolveTaskId(projectDir, 'delete', 'MONA-9999-archived-thing');
    expect(id).toBe('MONA-9999-archived-thing');
  });

  test('delete picker includes archived tasks marked (archived)', async () => {
    // No id → picker over live + archived. Pick the archived one by name fragment.
    prompts.ask.mockResolvedValueOnce('archived-thing');
    const id = await taskCmd.resolveTaskId(projectDir, 'delete', undefined);
    expect(id).toBe('MONA-9999-archived-thing');
    expect(logLines.some(l => l.includes('MONA-9999-archived-thing') && l.includes('(archived)'))).toBe(true);
  });

  test('resume does NOT reach archived tasks (unchanged behavior)', async () => {
    // No live match, resume ignores archived → returns the input unchanged.
    const id = await taskCmd.resolveTaskId(projectDir, 'resume', 'archived-thing');
    expect(id).toBe('archived-thing');
  });

  test('archive does NOT reach archived tasks (unchanged behavior)', async () => {
    const id = await taskCmd.resolveTaskId(projectDir, 'archive', 'archived-thing');
    expect(id).toBe('archived-thing');
  });
});

// ─── resolveTaskId — no id (picker) ──────────────────────────────────────────

describe('resolveTaskId — picker', () => {
  let projectDir;
  beforeEach(() => { projectDir = makeProject('pick-picker'); });
  afterEach(() => cleanup(projectDir));

  test('no tasks → null and a helpful message', async () => {
    const id = await taskCmd.resolveTaskId(projectDir, 'resume', undefined);
    expect(id).toBeNull();
    expect(logLines.some(l => l.includes('No live tasks'))).toBe(true);
  });

  test('numbered selection returns the chosen task', async () => {
    mkTask(projectDir, 'OLD');
    mkTask(projectDir, 'NEW');
    setRecency({ NEW: Date.now(), OLD: Date.now() - 5000 });
    prompts.ask.mockResolvedValueOnce('1'); // first = most recent = NEW

    const id = await taskCmd.resolveTaskId(projectDir, 'resume', undefined);
    expect(id).toBe('NEW');
  });

  test('typing part of a name at the prompt filters to a unique match', async () => {
    mkTask(projectDir, 'MONA-9348-isa-forms');
    mkTask(projectDir, 'production-new');
    prompts.ask.mockResolvedValueOnce('isa');

    const id = await taskCmd.resolveTaskId(projectDir, 'resume', undefined);
    expect(id).toBe('MONA-9348-isa-forms');
  });

  test('out-of-range number reprompts, then accepts a valid one', async () => {
    mkTask(projectDir, 'ONLY');
    prompts.ask.mockResolvedValueOnce('9').mockResolvedValueOnce('1');

    const id = await taskCmd.resolveTaskId(projectDir, 'delete', undefined);
    expect(id).toBe('ONLY');
    expect(logLines.some(l => l.includes('between 1 and 1'))).toBe(true);
  });

  test('empty input cancels the picker', async () => {
    mkTask(projectDir, 'ONLY');
    prompts.ask.mockResolvedValueOnce('');

    const id = await taskCmd.resolveTaskId(projectDir, 'archive', undefined);
    expect(id).toBeNull();
    expect(logLines.some(l => l.includes('Cancelled'))).toBe(true);
  });
});

// ─── run() wiring (via delete, cancelled so it has no side effects) ──────────

describe('wksp task delete — picker wiring', () => {
  let projectDir;
  beforeEach(() => {
    projectDir = makeProject('pick-wire');
    config.findProjectDir.mockReturnValue(projectDir);
    prompts.confirm.mockResolvedValue(false); // never actually delete
  });
  afterEach(() => cleanup(projectDir));

  test('omitting the id picks from the list', async () => {
    mkTask(projectDir, 'TASK-ONE');
    mkTask(projectDir, 'TASK-TWO');
    setRecency({ 'TASK-ONE': Date.now(), 'TASK-TWO': Date.now() - 1000 });
    prompts.ask.mockResolvedValueOnce('1'); // TASK-ONE (most recent)

    await taskCmd.run(['delete']);

    expect(logLines.some(l => l.includes('About to delete task TASK-ONE'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'tasks', 'TASK-ONE'))).toBe(true); // cancelled → still there
  });

  test('a partial name resolves before the handler runs', async () => {
    mkTask(projectDir, 'MONA-9348-isa-forms');
    mkTask(projectDir, 'production-new');

    await taskCmd.run(['delete', 'isa']);

    expect(logLines.some(l => l.includes('About to delete task MONA-9348-isa-forms'))).toBe(true);
  });

  test('delete with no live tasks reports and exits cleanly (no throw)', async () => {
    await expect(taskCmd.run(['delete'])).resolves.toBeUndefined();
    expect(logLines.some(l => l.includes('No live tasks'))).toBe(true);
  });

  test('a partial matching only an archived task routes to the archived-delete handler', async () => {
    mkArchivedTask(projectDir, 'MONA-9999-archived-thing');
    prompts.confirm.mockResolvedValue(false); // decline the archived-delete confirm

    await taskCmd.run(['delete', 'archived-thing']);

    // Reached handleDelArchived (its distinct "About to delete archived task" line)
    expect(logLines.some(l => l.includes('About to delete archived task MONA-9999-archived-thing'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'archived-tasks', 'MONA-9999-archived-thing'))).toBe(true); // declined
  });
});
