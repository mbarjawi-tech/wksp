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

  test('bumps schemaVersion to current without touching repos.txt', async () => {
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

  test('bumps schemaVersion to current', async () => {
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

// ─── schema 2 → 3 (.gitignore update) ────────────────────────────────────────

describe('schema 2 → 3 — adds .wksp-cache/ to .gitignore', () => {
  let projectDir;
  beforeEach(() => {
    projectDir = makeProject('mig-23');
    // Start at schema 2 (skips 0→1 and 1→2)
    config.setProjectConfig(projectDir, 'schemaVersion', 2);
  });
  afterEach(() => cleanup(projectDir));

  test('adds .wksp-cache/ to .gitignore when not present', async () => {
    fs.writeFileSync(path.join(projectDir, '.gitignore'), '.claude/settings.local.json\n');

    await runMigrate(projectDir);

    const gi = fs.readFileSync(path.join(projectDir, '.gitignore'), 'utf8');
    expect(gi).toContain('.wksp-cache/');
    expect(config.readProjectConfig(projectDir).schemaVersion).toBe(config.CURRENT_SCHEMA_VERSION);
  });

  test('does not duplicate .wksp-cache/ if already present', async () => {
    fs.writeFileSync(path.join(projectDir, '.gitignore'), '.claude/settings.local.json\n.wksp-cache/\n');

    await runMigrate(projectDir);

    const gi = fs.readFileSync(path.join(projectDir, '.gitignore'), 'utf8');
    const count = (gi.match(/\.wksp-cache\//g) || []).length;
    expect(count).toBe(1);
  });

  test('creates .gitignore when missing and adds entry', async () => {
    const giPath = path.join(projectDir, '.gitignore');
    if (fs.existsSync(giPath)) fs.unlinkSync(giPath);

    await runMigrate(projectDir);

    const gi = fs.readFileSync(giPath, 'utf8');
    expect(gi).toContain('.wksp-cache/');
  });

  test('dry-run does not modify .gitignore', async () => {
    const original = '.claude/settings.local.json\n';
    fs.writeFileSync(path.join(projectDir, '.gitignore'), original);

    await runMigrate(projectDir, '--dry-run');

    expect(fs.readFileSync(path.join(projectDir, '.gitignore'), 'utf8')).toBe(original);
    expect(config.readProjectConfig(projectDir).schemaVersion).toBe(2);
  });

  test('prints what was changed', async () => {
    fs.writeFileSync(path.join(projectDir, '.gitignore'), '');

    await runMigrate(projectDir);

    expect(logLines.some(l => l.includes('.wksp-cache/'))).toBe(true);
  });
});

// ─── not inside a project ─────────────────────────────────────────────────────

describe('not inside a project', () => {
  test('exits 1', async () => {
    config.findProjectDir.mockReturnValue(null);
    await expect(migrateCmd.run([])).rejects.toThrow('process.exit(1)');
  });
});
