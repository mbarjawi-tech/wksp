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

    expect(config.readProjectConfig(projectDir).schemaVersion).toBe(1);
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

    expect(config.readProjectConfig(projectDir).schemaVersion).toBe(1);
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

// ─── not inside a project ─────────────────────────────────────────────────────

describe('not inside a project', () => {
  test('exits 1', async () => {
    config.findProjectDir.mockReturnValue(null);
    await expect(migrateCmd.run([])).rejects.toThrow('process.exit(1)');
  });
});
