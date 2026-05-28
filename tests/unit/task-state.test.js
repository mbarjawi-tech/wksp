'use strict';
const fs   = require('fs');
const path = require('path');
const { makeTempDir, cleanup } = require('../helpers');
const { readTaskSets, writeTaskSets, TASK_CONFIG_FILE, LEGACY_SHARED_FILE, LEGACY_EXCLUDED_FILE } = require('../../lib/task-state');

let taskDir;
beforeEach(() => { taskDir = makeTempDir('task-state-test'); });
afterEach(() => cleanup(taskDir));

// ─── readTaskSets ─────────────────────────────────────────────────────────────

describe('readTaskSets — task.json present', () => {
  test('reads shared and excluded arrays', () => {
    fs.writeFileSync(path.join(taskDir, TASK_CONFIG_FILE), JSON.stringify({
      shared: ['backend'],
      excluded: ['docs'],
    }));
    const { taskSharedSet, taskExcludedSet } = readTaskSets(taskDir);
    expect([...taskSharedSet]).toEqual(['backend']);
    expect([...taskExcludedSet]).toEqual(['docs']);
  });

  test('handles missing shared key gracefully', () => {
    fs.writeFileSync(path.join(taskDir, TASK_CONFIG_FILE), JSON.stringify({ excluded: ['docs'] }));
    const { taskSharedSet, taskExcludedSet } = readTaskSets(taskDir);
    expect(taskSharedSet.size).toBe(0);
    expect([...taskExcludedSet]).toEqual(['docs']);
  });

  test('handles missing excluded key gracefully', () => {
    fs.writeFileSync(path.join(taskDir, TASK_CONFIG_FILE), JSON.stringify({ shared: ['backend'] }));
    const { taskSharedSet, taskExcludedSet } = readTaskSets(taskDir);
    expect([...taskSharedSet]).toEqual(['backend']);
    expect(taskExcludedSet.size).toBe(0);
  });

  test('handles empty object', () => {
    fs.writeFileSync(path.join(taskDir, TASK_CONFIG_FILE), JSON.stringify({}));
    const { taskSharedSet, taskExcludedSet } = readTaskSets(taskDir);
    expect(taskSharedSet.size).toBe(0);
    expect(taskExcludedSet.size).toBe(0);
  });

  test('handles malformed JSON without throwing — returns empty sets', () => {
    fs.writeFileSync(path.join(taskDir, TASK_CONFIG_FILE), 'NOT JSON');
    const { taskSharedSet, taskExcludedSet } = readTaskSets(taskDir);
    expect(taskSharedSet.size).toBe(0);
    expect(taskExcludedSet.size).toBe(0);
  });
});

describe('readTaskSets — no task.json, falls back to legacy .txt files', () => {
  test('reads task-shared.txt', () => {
    fs.writeFileSync(path.join(taskDir, LEGACY_SHARED_FILE), 'backend\nfrontend\n');
    const { taskSharedSet } = readTaskSets(taskDir);
    expect(taskSharedSet.has('backend')).toBe(true);
    expect(taskSharedSet.has('frontend')).toBe(true);
  });

  test('reads task-excluded.txt', () => {
    fs.writeFileSync(path.join(taskDir, LEGACY_EXCLUDED_FILE), 'docs\n');
    const { taskExcludedSet } = readTaskSets(taskDir);
    expect(taskExcludedSet.has('docs')).toBe(true);
  });

  test('returns empty sets when no files exist', () => {
    const { taskSharedSet, taskExcludedSet } = readTaskSets(taskDir);
    expect(taskSharedSet.size).toBe(0);
    expect(taskExcludedSet.size).toBe(0);
  });

  test('prefers task.json over legacy files', () => {
    fs.writeFileSync(path.join(taskDir, TASK_CONFIG_FILE), JSON.stringify({ shared: ['api'] }));
    fs.writeFileSync(path.join(taskDir, LEGACY_SHARED_FILE), 'backend\n');
    const { taskSharedSet } = readTaskSets(taskDir);
    // task.json wins
    expect(taskSharedSet.has('api')).toBe(true);
    expect(taskSharedSet.has('backend')).toBe(false);
  });
});

// ─── writeTaskSets ────────────────────────────────────────────────────────────

describe('writeTaskSets', () => {
  test('writes task.json with shared and excluded', () => {
    writeTaskSets(taskDir, new Set(['backend']), new Set(['docs']));
    const data = JSON.parse(fs.readFileSync(path.join(taskDir, TASK_CONFIG_FILE), 'utf8'));
    expect(data.shared).toEqual(['backend']);
    expect(data.excluded).toEqual(['docs']);
  });

  test('omits shared key when set is empty', () => {
    writeTaskSets(taskDir, new Set(), new Set(['docs']));
    const data = JSON.parse(fs.readFileSync(path.join(taskDir, TASK_CONFIG_FILE), 'utf8'));
    expect(data.shared).toBeUndefined();
    expect(data.excluded).toEqual(['docs']);
  });

  test('omits excluded key when set is empty', () => {
    writeTaskSets(taskDir, new Set(['backend']), new Set());
    const data = JSON.parse(fs.readFileSync(path.join(taskDir, TASK_CONFIG_FILE), 'utf8'));
    expect(data.shared).toEqual(['backend']);
    expect(data.excluded).toBeUndefined();
  });

  test('deletes task.json when both sets are empty', () => {
    // First write something
    writeTaskSets(taskDir, new Set(['backend']), new Set());
    expect(fs.existsSync(path.join(taskDir, TASK_CONFIG_FILE))).toBe(true);
    // Now clear
    writeTaskSets(taskDir, new Set(), new Set());
    expect(fs.existsSync(path.join(taskDir, TASK_CONFIG_FILE))).toBe(false);
  });

  test('removes legacy .txt files after writing task.json', () => {
    fs.writeFileSync(path.join(taskDir, LEGACY_SHARED_FILE),   'backend\n');
    fs.writeFileSync(path.join(taskDir, LEGACY_EXCLUDED_FILE), 'docs\n');
    writeTaskSets(taskDir, new Set(['backend']), new Set(['docs']));
    expect(fs.existsSync(path.join(taskDir, LEGACY_SHARED_FILE))).toBe(false);
    expect(fs.existsSync(path.join(taskDir, LEGACY_EXCLUDED_FILE))).toBe(false);
  });

  test('removes legacy .txt files even when both sets are empty', () => {
    fs.writeFileSync(path.join(taskDir, LEGACY_SHARED_FILE),   'backend\n');
    fs.writeFileSync(path.join(taskDir, LEGACY_EXCLUDED_FILE), 'docs\n');
    writeTaskSets(taskDir, new Set(), new Set());
    expect(fs.existsSync(path.join(taskDir, LEGACY_SHARED_FILE))).toBe(false);
    expect(fs.existsSync(path.join(taskDir, LEGACY_EXCLUDED_FILE))).toBe(false);
  });

  test('round-trip: written data is readable back', () => {
    const shared   = new Set(['backend', 'api']);
    const excluded = new Set(['docs']);
    writeTaskSets(taskDir, shared, excluded);
    const { taskSharedSet, taskExcludedSet } = readTaskSets(taskDir);
    expect([...taskSharedSet].sort()).toEqual([...shared].sort());
    expect([...taskExcludedSet]).toEqual([...excluded]);
  });
});
