'use strict';
const fs   = require('fs');
const path = require('path');
const { makeTempDir, cleanup } = require('../helpers');
const { stripAlias, migrate0to1 } = require('../../lib/commands/migrate');

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
