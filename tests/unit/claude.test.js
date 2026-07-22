'use strict';
const fs   = require('fs');
const path = require('path');
const { makeTempDir, cleanup } = require('../helpers');
const {
  encodeProjectPath, sessionDirsFor, migrateSessionDir,
} = require('../../lib/claude');

// Build a fake encoded session dir with the given entries.
//   files: { 'name.jsonl': 'contents', ... }
//   subdirs: ['uuid-dir', ...]  (created empty)
//   memory: { 'a.md': 'contents', ... }  (created under memory/)
function seedSessionDir(dir, { files = {}, subdirs = [], memory = null } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
  for (const sub of subdirs) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  if (memory) {
    const memDir = path.join(dir, 'memory');
    fs.mkdirSync(memDir, { recursive: true });
    for (const [name, body] of Object.entries(memory)) {
      fs.writeFileSync(path.join(memDir, name), body);
    }
  }
}

describe('sessionDirsFor', () => {
  let base;
  beforeEach(() => { base = makeTempDir('claude-base'); });
  afterEach(() => cleanup(base));

  test('encodes both task dirs under <base>/projects', () => {
    const oldTask = path.join('C:', 'ws', 'proj', 'tasks', 'old');
    const newTask = path.join('C:', 'ws', 'proj', 'tasks', 'new');
    const { from, to } = sessionDirsFor(oldTask, newTask, base);
    expect(from).toBe(path.join(base, 'projects', encodeProjectPath(oldTask)));
    expect(to).toBe(path.join(base, 'projects', encodeProjectPath(newTask)));
  });

  test('counts .jsonl sessions under the source and detects an existing target', () => {
    const oldTask = path.join(makeTempDir('old-task'));
    const newTask = path.join(makeTempDir('new-task'));
    const dirs = sessionDirsFor(oldTask, newTask, base);
    seedSessionDir(dirs.from, { files: { 'a.jsonl': '{}', 'b.jsonl': '{}', 'notes.txt': 'x' } });
    fs.mkdirSync(dirs.to, { recursive: true });

    const result = sessionDirsFor(oldTask, newTask, base);
    expect(result.sessionCount).toBe(2);
    expect(result.targetExists).toBe(true);
    cleanup(oldTask, newTask);
  });

  test('no source → zero sessions, no target', () => {
    const oldTask = path.join('C:', 'nope', 'old');
    const newTask = path.join('C:', 'nope', 'new');
    const { sessionCount, targetExists } = sessionDirsFor(oldTask, newTask, base);
    expect(sessionCount).toBe(0);
    expect(targetExists).toBe(false);
  });
});

describe('migrateSessionDir', () => {
  let base;
  beforeEach(() => { base = makeTempDir('claude-migrate'); });
  afterEach(() => cleanup(base));

  test('clean move when the target does not exist', () => {
    const from = path.join(base, 'projects', 'FROM');
    const to   = path.join(base, 'projects', 'TO');
    seedSessionDir(from, {
      files:   { 'a.jsonl': 'one', 'b.jsonl': 'two' },
      subdirs: ['11111111-uuid'],
      memory:  { 'MEMORY.md': 'index' },
    });

    const res = migrateSessionDir(from, to);

    expect(res.moved).toBe(true);
    expect(res.merged).toBe(false);
    expect(res.sessionCount).toBe(2);
    expect(res.warnings).toEqual([]);
    expect(fs.existsSync(from)).toBe(false);
    expect(fs.readFileSync(path.join(to, 'a.jsonl'), 'utf8')).toBe('one');
    expect(fs.existsSync(path.join(to, '11111111-uuid'))).toBe(true);
    expect(fs.readFileSync(path.join(to, 'memory', 'MEMORY.md'), 'utf8')).toBe('index');
  });

  test('merges into an existing target: moves non-colliding, skips colliding, keeps target', () => {
    const from = path.join(base, 'projects', 'FROM');
    const to   = path.join(base, 'projects', 'TO');
    seedSessionDir(from, {
      files:   { 'shared.jsonl': 'SOURCE', 'onlysrc.jsonl': 'fresh' },
      subdirs: ['src-uuid'],
    });
    seedSessionDir(to, {
      files:   { 'shared.jsonl': 'TARGET', 'onlydst.jsonl': 'kept' },
      subdirs: ['dst-uuid'],
    });

    const res = migrateSessionDir(from, to);

    expect(res.merged).toBe(true);
    expect(res.moved).toBe(false);
    // Non-colliding session moved across.
    expect(fs.readFileSync(path.join(to, 'onlysrc.jsonl'), 'utf8')).toBe('fresh');
    expect(fs.existsSync(path.join(to, 'src-uuid'))).toBe(true);
    // Target entries untouched.
    expect(fs.readFileSync(path.join(to, 'onlydst.jsonl'), 'utf8')).toBe('kept');
    expect(fs.existsSync(path.join(to, 'dst-uuid'))).toBe(true);
    // Collision: target file preserved, source skipped with a warning.
    expect(fs.readFileSync(path.join(to, 'shared.jsonl'), 'utf8')).toBe('TARGET');
    expect(res.warnings.some(w => w.includes('shared.jsonl'))).toBe(true);
    // Source drained of what moved, but the collided file remains behind.
    expect(fs.existsSync(path.join(from, 'shared.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(from, 'onlysrc.jsonl'))).toBe(false);
  });

  test('memory/ merge prefers the newer file and never deletes a target file', () => {
    const from = path.join(base, 'projects', 'FROM');
    const to   = path.join(base, 'projects', 'TO');
    seedSessionDir(from, { memory: { 'a.md': 'SRC-NEW', 'b.md': 'SRC-OLD', 'onlysrc.md': 'brand-new' } });
    seedSessionDir(to,   { memory: { 'a.md': 'DST-OLD', 'b.md': 'DST-NEW', 'onlydst.md': 'keep-me' } });

    // a.md: source newer → source wins. b.md: target newer → target wins.
    const older = new Date('2020-01-01T00:00:00Z');
    const newer = new Date('2026-01-01T00:00:00Z');
    fs.utimesSync(path.join(from, 'memory', 'a.md'), newer, newer);
    fs.utimesSync(path.join(to,   'memory', 'a.md'), older, older);
    fs.utimesSync(path.join(from, 'memory', 'b.md'), older, older);
    fs.utimesSync(path.join(to,   'memory', 'b.md'), newer, newer);

    migrateSessionDir(from, to);

    expect(fs.readFileSync(path.join(to, 'memory', 'a.md'), 'utf8')).toBe('SRC-NEW');
    expect(fs.readFileSync(path.join(to, 'memory', 'b.md'), 'utf8')).toBe('DST-NEW');
    expect(fs.readFileSync(path.join(to, 'memory', 'onlysrc.md'), 'utf8')).toBe('brand-new');
    expect(fs.readFileSync(path.join(to, 'memory', 'onlydst.md'), 'utf8')).toBe('keep-me');
  });

  test('no source is a no-op', () => {
    const from = path.join(base, 'projects', 'MISSING');
    const to   = path.join(base, 'projects', 'TO');
    const res = migrateSessionDir(from, to);
    expect(res).toEqual({ moved: false, merged: false, sessionCount: 0, warnings: [] });
    expect(fs.existsSync(to)).toBe(false);
  });

  test('best-effort: a failing move becomes a warning, not a throw', () => {
    const from = path.join(base, 'projects', 'FROM');
    const to   = path.join(base, 'projects', 'TO');
    seedSessionDir(from, { files: { 'a.jsonl': 'x' } });

    const spy = jest.spyOn(fs, 'renameSync').mockImplementation(() => {
      const err = new Error('locked'); err.code = 'EPERM'; throw err;
    });
    let res;
    expect(() => { res = migrateSessionDir(from, to); }).not.toThrow();
    spy.mockRestore();

    expect(res.moved).toBe(false);
    expect(res.warnings.length).toBeGreaterThan(0);
    expect(fs.existsSync(from)).toBe(true); // source left intact on failure
  });
});
