'use strict';
const fs   = require('fs');
const path = require('path');
const { makeTempDir, cleanup } = require('../helpers');
const { isCwdInside, ensureCwdOutside, probeRemovable } = require('../../lib/teardown-guard');

// process.cwd() is spied rather than actually chdir'd: the point of these guards is a
// directory that is about to be deleted, and chdir'ing the Jest process into one is
// how you lose the test run.

describe('isCwdInside', () => {
  let dir;
  beforeEach(() => { dir = makeTempDir('guard-cwd'); });
  afterEach(()  => { jest.restoreAllMocks(); cleanup(dir); });

  test('true when the cwd is the directory itself', () => {
    jest.spyOn(process, 'cwd').mockReturnValue(dir);
    expect(isCwdInside(dir)).toBe(true);
  });

  test('true when the cwd is nested inside', () => {
    const nested = path.join(dir, 'worktrees', 'wksp');
    fs.mkdirSync(nested, { recursive: true });
    jest.spyOn(process, 'cwd').mockReturnValue(nested);
    expect(isCwdInside(dir)).toBe(true);
  });

  test('false for a sibling that shares the name prefix', () => {
    const sibling = dir + '-bar';
    fs.mkdirSync(sibling, { recursive: true });
    jest.spyOn(process, 'cwd').mockReturnValue(sibling);
    try   { expect(isCwdInside(dir)).toBe(false); }
    finally { cleanup(sibling); }
  });

  test('false when process.cwd() throws (deleted cwd)', () => {
    jest.spyOn(process, 'cwd').mockImplementation(() => { throw new Error('ENOENT'); });
    expect(isCwdInside(dir)).toBe(false);
  });
});

describe('ensureCwdOutside', () => {
  let dir, safe;
  beforeEach(() => { dir = makeTempDir('guard-esc'); safe = makeTempDir('guard-safe'); });
  afterEach(()  => { jest.restoreAllMocks(); cleanup(dir, safe); });

  test('does nothing and succeeds when the cwd is already outside', () => {
    const chdir = jest.spyOn(process, 'chdir').mockImplementation(() => {});
    jest.spyOn(process, 'cwd').mockReturnValue(safe);
    expect(ensureCwdOutside(dir, safe)).toBe(true);
    expect(chdir).not.toHaveBeenCalled();
  });

  test('chdirs to the safe directory when the cwd is inside', () => {
    const chdir = jest.spyOn(process, 'chdir').mockImplementation(() => {});
    jest.spyOn(process, 'cwd').mockReturnValue(dir);
    expect(ensureCwdOutside(dir, safe)).toBe(true);
    expect(chdir).toHaveBeenCalledWith(safe);
  });

  test('reports failure when even the safe directory is unreachable', () => {
    jest.spyOn(process, 'chdir').mockImplementation(() => { throw new Error('ENOENT'); });
    jest.spyOn(process, 'cwd').mockReturnValue(dir);
    expect(ensureCwdOutside(dir, safe)).toBe(false);
  });
});

describe('probeRemovable', () => {
  let parent;
  beforeEach(() => { parent = makeTempDir('guard-probe'); });
  afterEach(()  => cleanup(parent));

  test('succeeds for a free directory and leaves it exactly where it was', () => {
    const dir = path.join(parent, 'wt');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'file.txt'), 'keep me');

    expect(probeRemovable(dir, parent)).toEqual({ ok: true });
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'file.txt'), 'utf8')).toBe('keep me');
    // No probe folder left behind.
    expect(fs.readdirSync(parent)).toEqual(['wt']);
  });

  test('succeeds trivially for a directory that does not exist', () => {
    expect(probeRemovable(path.join(parent, 'gone'), parent)).toEqual({ ok: true });
  });

  test('reports the error code when the rename fails', () => {
    const dir = path.join(parent, 'wt');
    fs.mkdirSync(dir);
    const err = Object.assign(new Error('resource busy'), { code: 'EBUSY' });
    jest.spyOn(fs, 'renameSync').mockImplementation(() => { throw err; });
    try {
      expect(probeRemovable(dir, parent)).toEqual({ ok: false, code: 'EBUSY', message: 'resource busy' });
    } finally { jest.restoreAllMocks(); }
    expect(fs.existsSync(dir)).toBe(true);
  });

  test('names the stranded folder when it cannot be renamed back', () => {
    const dir = path.join(parent, 'wt');
    fs.mkdirSync(dir);
    const realRename = fs.renameSync;
    let calls = 0;
    jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (++calls === 1) return realRename(from, to);   // moves away successfully
      throw Object.assign(new Error('denied'), { code: 'EPERM' }); // and can't move back
    });
    let result;
    try { result = probeRemovable(dir, parent); }
    finally { jest.restoreAllMocks(); }

    expect(result.ok).toBe(false);
    expect(result.stranded).toBeTruthy();
    expect(fs.existsSync(result.stranded)).toBe(true);
    fs.renameSync(result.stranded, dir); // what the printed instructions tell the user to do
  });
});
