'use strict';
const fs   = require('fs');
const path = require('path');
const { makeProject, cleanup } = require('../helpers');

jest.mock('../../lib/prompts', () => ({
  open: jest.fn(), close: jest.fn(), ask: jest.fn(), confirm: jest.fn(),
}));

jest.mock('../../lib/config', () => {
  const actual = jest.requireActual('../../lib/config');
  return { ...actual, findProjectDir: jest.fn() };
});

const config     = require('../../lib/config');
const migrateCmd = require('../../lib/commands/migrate');

let logLines, warnLines;
beforeEach(() => {
  logLines  = [];
  warnLines = [];
  jest.spyOn(console, 'log').mockImplementation((...a)  => logLines.push(a.join(' ')));
  jest.spyOn(console, 'warn').mockImplementation((...a) => warnLines.push(a.join(' ')));
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(process, 'exit').mockImplementation(code => {
    throw new Error(`process.exit(${code})`);
  });
});
afterEach(() => jest.restoreAllMocks());

async function runMigrate(projectDir, ...args) {
  config.findProjectDir.mockReturnValue(projectDir);
  await migrateCmd.run(args);
}

// ─── already up to date ───────────────────────────────────────────────────────

describe('project already at current schema', () => {
  let projectDir;
  beforeEach(() => { projectDir = makeProject('mig-uptodate'); });
  afterEach(() => cleanup(projectDir));

  test('prints "already up to date" and makes no changes', async () => {
    // makeProject writes a .wksp without schemaVersion — set it to current
    config.setProjectConfig(projectDir, 'schemaVersion', config.CURRENT_SCHEMA_VERSION);

    await runMigrate(projectDir);

    expect(logLines.some(l => l.includes('Already up to date'))).toBe(true);
    // .wksp unchanged
    const wksp = config.readProjectConfig(projectDir);
    expect(wksp.schemaVersion).toBe(config.CURRENT_SCHEMA_VERSION);
  });
});

// ─── schema 0 → 1 (no alias entries) ─────────────────────────────────────────

describe('schema 0 → 1 — clean repos.txt', () => {
  let projectDir;
  beforeEach(() => { projectDir = makeProject('mig-clean'); });
  afterEach(() => cleanup(projectDir));

  test('bumps schemaVersion without touching repos.txt', async () => {
    const reposBefore = fs.readFileSync(path.join(projectDir, 'repos.txt'), 'utf8');

    await runMigrate(projectDir);

    expect(config.readProjectConfig(projectDir).schemaVersion).toBe(config.CURRENT_SCHEMA_VERSION);
    // repos.txt content unchanged
    expect(fs.readFileSync(path.join(projectDir, 'repos.txt'), 'utf8')).toBe(reposBefore);
    expect(logLines.some(l => l.includes('Migration complete'))).toBe(true);
  });
});

// ─── schema 0 → 1 (alias entries present) ────────────────────────────────────

describe('schema 0 → 1 — repos.txt has --as entries', () => {
  let projectDir;
  beforeEach(() => {
    projectDir = makeProject('mig-alias');
    fs.writeFileSync(path.join(projectDir, 'repos.txt'), [
      '# Workspace repos',
      '# Format: <path> [--shared] [--as <alias>]',
      '',
      'C:/dev/backend',
      'C:/dev/malachite',
      'C:/dev/malachite  --as malachite-b',
      '',
    ].join('\n'));
  });
  afterEach(() => cleanup(projectDir));

  test('strips alias entries and writes schemaVersion', async () => {
    await runMigrate(projectDir);

    const repos = fs.readFileSync(path.join(projectDir, 'repos.txt'), 'utf8');
    expect(repos).not.toContain('--as');
    expect(repos).toContain('C:/dev/malachite');
    expect(repos).toContain('C:/dev/backend');
    expect(repos).not.toContain('[--as <alias>]');

    expect(config.readProjectConfig(projectDir).schemaVersion).toBe(config.CURRENT_SCHEMA_VERSION);
  });

  test('prints details about each stripped alias', async () => {
    await runMigrate(projectDir);
    const out = logLines.join('\n');
    expect(out).toMatch(/malachite-b/);
    expect(out).toMatch(/before:/);
    expect(out).toMatch(/after:/);
  });
});

// ─── dry-run ─────────────────────────────────────────────────────────────────

describe('--dry-run', () => {
  let projectDir;
  beforeEach(() => {
    projectDir = makeProject('mig-dry');
    fs.writeFileSync(path.join(projectDir, 'repos.txt'),
      'C:/dev/malachite  --as malachite-b\n');
  });
  afterEach(() => cleanup(projectDir));

  test('does not modify repos.txt', async () => {
    await runMigrate(projectDir, '--dry-run');
    const repos = fs.readFileSync(path.join(projectDir, 'repos.txt'), 'utf8');
    expect(repos).toContain('--as malachite-b');
  });

  test('does not write schemaVersion', async () => {
    await runMigrate(projectDir, '--dry-run');
    expect(config.readProjectConfig(projectDir).schemaVersion).toBeUndefined();
  });

  test('prints dry-run indicator', async () => {
    await runMigrate(projectDir, '--dry-run');
    expect(logLines.some(l => l.includes('dry run'))).toBe(true);
  });
});

// ─── schema 1 → 2 (task.json consolidation) ──────────────────────────────────

describe('schema 1 → 2 — legacy .txt files present', () => {
  let projectDir;
  beforeEach(() => {
    projectDir = makeProject('mig-1to2');
    // Simulate a schema-v1 project
    config.setProjectConfig(projectDir, 'schemaVersion', 1);
    // Create a live task with legacy files
    const taskDir = path.join(projectDir, 'tasks', 'TASK-1');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'task-shared.txt'), 'backend\n');
    fs.writeFileSync(path.join(taskDir, 'task-excluded.txt'), 'docs\n');
  });
  afterEach(() => cleanup(projectDir));

  test('writes task.json and removes legacy files', async () => {
    await runMigrate(projectDir);
    const taskDir = path.join(projectDir, 'tasks', 'TASK-1');
    expect(fs.existsSync(path.join(taskDir, 'task.json'))).toBe(true);
    expect(fs.existsSync(path.join(taskDir, 'task-shared.txt'))).toBe(false);
    expect(fs.existsSync(path.join(taskDir, 'task-excluded.txt'))).toBe(false);
  });

  test('task.json contains correct shared and excluded values', async () => {
    await runMigrate(projectDir);
    const data = JSON.parse(fs.readFileSync(path.join(projectDir, 'tasks', 'TASK-1', 'task.json'), 'utf8'));
    expect(data.shared).toEqual(['backend']);
    expect(data.excluded).toEqual(['docs']);
  });

  test('bumps schemaVersion to 2', async () => {
    await runMigrate(projectDir);
    expect(config.readProjectConfig(projectDir).schemaVersion).toBe(config.CURRENT_SCHEMA_VERSION);
  });
});

describe('schema 1 → 2 — dry-run', () => {
  let projectDir;
  beforeEach(() => {
    projectDir = makeProject('mig-1to2-dry');
    config.setProjectConfig(projectDir, 'schemaVersion', 1);
    const taskDir = path.join(projectDir, 'tasks', 'TASK-X');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'task-shared.txt'), 'api\n');
  });
  afterEach(() => cleanup(projectDir));

  test('does not write task.json in dry-run', async () => {
    await runMigrate(projectDir, '--dry-run');
    expect(fs.existsSync(path.join(projectDir, 'tasks', 'TASK-X', 'task.json'))).toBe(false);
  });

  test('does not write schemaVersion in dry-run', async () => {
    await runMigrate(projectDir, '--dry-run');
    expect(config.readProjectConfig(projectDir).schemaVersion).toBe(1);
  });

  test('prints dry-run indicator', async () => {
    await runMigrate(projectDir, '--dry-run');
    expect(logLines.some(l => l.includes('dry run'))).toBe(true);
  });
});

// ─── schema 2 → 3 (WORKLOG.md + Work log section) ────────────────────────────

describe('schema 2 → 3 — adds WORKLOG.md and Work log section', () => {
  let projectDir;
  beforeEach(() => {
    projectDir = makeProject('mig-2to3');
    config.setProjectConfig(projectDir, 'schemaVersion', 2);
    const taskDir = path.join(projectDir, 'tasks', 'TASK-WL');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'CLAUDE.md'), '## Task: TASK-WL\n## Goal: test\n');
  });
  afterEach(() => cleanup(projectDir));

  test('creates WORKLOG.md in task dir', async () => {
    await runMigrate(projectDir);
    expect(fs.existsSync(path.join(projectDir, 'tasks', 'TASK-WL', 'WORKLOG.md'))).toBe(true);
  });

  test('appends Work log section to CLAUDE.md', async () => {
    await runMigrate(projectDir);
    const content = fs.readFileSync(path.join(projectDir, 'tasks', 'TASK-WL', 'CLAUDE.md'), 'utf8');
    expect(content).toContain('## Work log');
    expect(content).toContain('WORKLOG.md');
  });

  test('bumps schemaVersion to 3', async () => {
    await runMigrate(projectDir);
    expect(config.readProjectConfig(projectDir).schemaVersion).toBe(config.CURRENT_SCHEMA_VERSION);
  });

  test('does not duplicate Work log section if already present', async () => {
    const taskDir = path.join(projectDir, 'tasks', 'TASK-WL');
    const existing = fs.readFileSync(path.join(taskDir, 'CLAUDE.md'), 'utf8') + '\n## Work log\nalready here\n';
    fs.writeFileSync(path.join(taskDir, 'CLAUDE.md'), existing);

    await runMigrate(projectDir);

    const content = fs.readFileSync(path.join(taskDir, 'CLAUDE.md'), 'utf8');
    expect(content.split('## Work log').length).toBe(2); // exactly one occurrence
  });
});

describe('schema 2 → 3 — dry-run', () => {
  let projectDir;
  beforeEach(() => {
    projectDir = makeProject('mig-2to3-dry');
    config.setProjectConfig(projectDir, 'schemaVersion', 2);
    const taskDir = path.join(projectDir, 'tasks', 'TASK-DRY');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'CLAUDE.md'), '## Task: TASK-DRY\n');
  });
  afterEach(() => cleanup(projectDir));

  test('does not create WORKLOG.md in dry-run', async () => {
    await runMigrate(projectDir, '--dry-run');
    expect(fs.existsSync(path.join(projectDir, 'tasks', 'TASK-DRY', 'WORKLOG.md'))).toBe(false);
  });

  test('does not modify CLAUDE.md in dry-run', async () => {
    const before = fs.readFileSync(path.join(projectDir, 'tasks', 'TASK-DRY', 'CLAUDE.md'), 'utf8');
    await runMigrate(projectDir, '--dry-run');
    const after = fs.readFileSync(path.join(projectDir, 'tasks', 'TASK-DRY', 'CLAUDE.md'), 'utf8');
    expect(after).toBe(before);
  });

  test('does not write schemaVersion in dry-run', async () => {
    await runMigrate(projectDir, '--dry-run');
    expect(config.readProjectConfig(projectDir).schemaVersion).toBe(2);
  });
});

// ─── --repair (re-apply steps on an already-current project) ─────────────────

describe('--repair — backfills missing artifacts on a current project', () => {
  let projectDir, taskDir;
  beforeEach(() => {
    projectDir = makeProject('mig-repair');
    // Project is stamped at the current schema, but a task is missing its WORKLOG —
    // exactly the state produced by `wksp import` or a task from an older wksp.
    config.setProjectConfig(projectDir, 'schemaVersion', config.CURRENT_SCHEMA_VERSION);
    taskDir = path.join(projectDir, 'tasks', 'TASK-OLD');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'CLAUDE.md'), '## Task: TASK-OLD\n');
  });
  afterEach(() => cleanup(projectDir));

  test('plain migrate does NOT touch the task (short-circuits)', async () => {
    await runMigrate(projectDir);
    expect(logLines.some(l => l.includes('Already up to date'))).toBe(true);
    expect(fs.existsSync(path.join(taskDir, 'WORKLOG.md'))).toBe(false);
  });

  test('--repair creates the missing WORKLOG.md', async () => {
    await runMigrate(projectDir, '--repair');
    expect(fs.existsSync(path.join(taskDir, 'WORKLOG.md'))).toBe(true);
  });

  test('--repair adds the missing Work log section to CLAUDE.md', async () => {
    await runMigrate(projectDir, '--repair');
    expect(fs.readFileSync(path.join(taskDir, 'CLAUDE.md'), 'utf8')).toContain('## Work log');
  });

  test('--repair leaves schemaVersion at current', async () => {
    await runMigrate(projectDir, '--repair');
    expect(config.readProjectConfig(projectDir).schemaVersion).toBe(config.CURRENT_SCHEMA_VERSION);
  });

  test('--repair is idempotent — re-running does not duplicate anything', async () => {
    await runMigrate(projectDir, '--repair');
    const firstWorklog = fs.readFileSync(path.join(taskDir, 'WORKLOG.md'), 'utf8');
    await runMigrate(projectDir, '--repair');
    expect(fs.readFileSync(path.join(taskDir, 'WORKLOG.md'), 'utf8')).toBe(firstWorklog);
    expect(fs.readFileSync(path.join(taskDir, 'CLAUDE.md'), 'utf8').split('## Work log').length).toBe(2);
  });

  test('--repair --dry-run reports without writing', async () => {
    await runMigrate(projectDir, '--repair', '--dry-run');
    expect(fs.existsSync(path.join(taskDir, 'WORKLOG.md'))).toBe(false);
    expect(logLines.some(l => l.includes('Dry run complete'))).toBe(true);
  });
});

// ─── not inside a project ─────────────────────────────────────────────────────

describe('not inside a project', () => {
  test('exits 1', async () => {
    config.findProjectDir.mockReturnValue(null);
    await expect(migrateCmd.run([])).rejects.toThrow('process.exit(1)');
  });
});
