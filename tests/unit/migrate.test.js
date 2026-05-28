'use strict';
const fs   = require('fs');
const path = require('path');
const { makeTempDir, cleanup } = require('../helpers');
const { stripAlias, migrate0to1, migrate1to2 } = require('../../lib/commands/migrate');
const { TASK_CONFIG_FILE, LEGACY_SHARED_FILE, LEGACY_EXCLUDED_FILE } = require('../../lib/task-state');

// ─── stripAlias ───────────────────────────────────────────────────────────────

describe('stripAlias', () => {
  test('strips --as <alias> from a line', () => {
    const { cleaned, changed } = stripAlias('C:/dev/malachite  --as malachite-b');
    expect(cleaned).toBe('C:/dev/malachite');
    expect(changed).toBe(true);
  });

  test('leaves a plain path unchanged', () => {
    const { cleaned, changed } = stripAlias('C:/dev/backend');
    expect(cleaned).toBe('C:/dev/backend');
    expect(changed).toBe(false);
  });

  test('preserves --shared when --as is also present', () => {
    const { cleaned } = stripAlias('C:/dev/docs  --shared  --as ref-docs');
    expect(cleaned).toBe('C:/dev/docs  --shared');
  });

  test('preserves --shared when --as comes before it (edge case)', () => {
    const { cleaned } = stripAlias('C:/dev/docs  --as ref-docs  --shared');
    // After stripping --as ref-docs the --shared remains
    expect(cleaned).toContain('--shared');
    expect(cleaned).not.toContain('--as');
  });
});

// ─── migrate0to1 ─────────────────────────────────────────────────────────────

describe('migrate0to1', () => {
  let projectDir;

  function writeRepos(content) {
    fs.writeFileSync(path.join(projectDir, 'repos.txt'), content);
  }
  function readRepos() {
    return fs.readFileSync(path.join(projectDir, 'repos.txt'), 'utf8');
  }

  beforeEach(() => {
    projectDir = makeTempDir('wksp-migrate');
  });
  afterEach(() => cleanup(projectDir));

  test('returns empty aliasLines when repos.txt has no --as entries', () => {
    writeRepos('C:/dev/backend\nC:/dev/frontend  --shared\n');
    const { aliasLines, reposChanged } = migrate0to1(projectDir, false);
    expect(aliasLines).toHaveLength(0);
    expect(reposChanged).toBe(false);
  });

  test('detects --as entries and strips them', () => {
    writeRepos([
      '# Workspace repos',
      'C:/dev/malachite',
      'C:/dev/malachite  --as malachite-b',
      '',
    ].join('\n'));

    const { aliasLines } = migrate0to1(projectDir, false);
    expect(aliasLines).toHaveLength(1);
    expect(aliasLines[0]).toContain('--as malachite-b');

    const after = readRepos();
    expect(after).not.toContain('--as');
    expect(after).toContain('C:/dev/malachite');
  });

  test('strips legacy header comment referencing [--as <alias>]', () => {
    writeRepos('# Format: <path> [--shared] [--as <alias>]\nC:/dev/backend\n');
    migrate0to1(projectDir, false);
    expect(readRepos()).not.toContain('[--as <alias>]');
    expect(readRepos()).toContain('# Format: <path> [--shared]');
  });

  test('dry-run does not write files', () => {
    const original = 'C:/dev/malachite  --as malachite-b\n';
    writeRepos(original);
    migrate0to1(projectDir, true);
    expect(readRepos()).toBe(original);
  });

  test('no repos.txt — returns no aliasLines and does not error', () => {
    // Don't create repos.txt
    const { aliasLines, reposChanged } = migrate0to1(projectDir, false);
    expect(aliasLines).toHaveLength(0);
    expect(reposChanged).toBe(false);
  });

  test('preserves --shared on lines that also had --as', () => {
    writeRepos('C:/dev/docs  --shared  --as ref-docs\n');
    migrate0to1(projectDir, false);
    const after = readRepos();
    expect(after).toContain('--shared');
    expect(after).not.toContain('--as');
  });
});

// ─── migrate1to2 ─────────────────────────────────────────────────────────────

describe('migrate1to2', () => {
  let projectDir;

  function makeTaskDir(name, { shared = [], excluded = [] } = {}) {
    const td = path.join(projectDir, 'tasks', name);
    fs.mkdirSync(td, { recursive: true });
    if (shared.length)   fs.writeFileSync(path.join(td, LEGACY_SHARED_FILE),   shared.join('\n') + '\n');
    if (excluded.length) fs.writeFileSync(path.join(td, LEGACY_EXCLUDED_FILE), excluded.join('\n') + '\n');
    return td;
  }

  beforeEach(() => { projectDir = makeTempDir('wksp-m1to2'); });
  afterEach(() => cleanup(projectDir));

  test('converts task-shared.txt + task-excluded.txt to task.json', () => {
    const td = makeTaskDir('TASK-1', { shared: ['backend'], excluded: ['docs'] });
    migrate1to2(projectDir, false);
    const data = JSON.parse(fs.readFileSync(path.join(td, TASK_CONFIG_FILE), 'utf8'));
    expect(data.shared).toEqual(['backend']);
    expect(data.excluded).toEqual(['docs']);
  });

  test('removes legacy .txt files after writing', () => {
    const td = makeTaskDir('TASK-2', { shared: ['backend'] });
    migrate1to2(projectDir, false);
    expect(fs.existsSync(path.join(td, LEGACY_SHARED_FILE))).toBe(false);
    expect(fs.existsSync(path.join(td, LEGACY_EXCLUDED_FILE))).toBe(false);
  });

  test('dry-run does not write task.json or remove .txt files', () => {
    const td = makeTaskDir('TASK-3', { shared: ['backend'] });
    migrate1to2(projectDir, true);
    expect(fs.existsSync(path.join(td, TASK_CONFIG_FILE))).toBe(false);
    expect(fs.existsSync(path.join(td, LEGACY_SHARED_FILE))).toBe(true);
  });

  test('skips task dirs that already have task.json', () => {
    const td = makeTaskDir('TASK-4', { shared: ['backend'] });
    fs.writeFileSync(path.join(td, TASK_CONFIG_FILE), JSON.stringify({ shared: ['existing'] }));
    migrate1to2(projectDir, false);
    // task.json should be untouched (still has 'existing', not 'backend')
    const data = JSON.parse(fs.readFileSync(path.join(td, TASK_CONFIG_FILE), 'utf8'));
    expect(data.shared).toEqual(['existing']);
  });

  test('skips task dirs with no .txt files', () => {
    const td = path.join(projectDir, 'tasks', 'TASK-5');
    fs.mkdirSync(td, { recursive: true });
    const { converted } = migrate1to2(projectDir, false);
    expect(converted).toHaveLength(0);
    expect(fs.existsSync(path.join(td, TASK_CONFIG_FILE))).toBe(false);
  });

  test('handles tasks dir not existing — returns empty converted', () => {
    // No tasks/ dir created
    const { converted } = migrate1to2(projectDir, false);
    expect(converted).toHaveLength(0);
  });

  test('converts tasks in archived-tasks/ as well', () => {
    const archivedDir = path.join(projectDir, 'archived-tasks', 'OLD-1');
    fs.mkdirSync(archivedDir, { recursive: true });
    fs.writeFileSync(path.join(archivedDir, LEGACY_SHARED_FILE), 'backend\n');
    migrate1to2(projectDir, false);
    expect(fs.existsSync(path.join(archivedDir, TASK_CONFIG_FILE))).toBe(true);
    expect(fs.existsSync(path.join(archivedDir, LEGACY_SHARED_FILE))).toBe(false);
  });

  test('returns list of converted task dirs', () => {
    makeTaskDir('TASK-A', { shared: ['api'] });
    makeTaskDir('TASK-B', { excluded: ['docs'] });
    const { converted } = migrate1to2(projectDir, false);
    expect(converted).toHaveLength(2);
    const labels = converted.map(c => c.label);
    expect(labels.some(l => l.includes('TASK-A'))).toBe(true);
    expect(labels.some(l => l.includes('TASK-B'))).toBe(true);
  });
});
