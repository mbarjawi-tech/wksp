'use strict';
const fs   = require('fs');
const path = require('path');
const { makeTempDir, cleanup } = require('../helpers');
const { isCwdInside, ensureCwdOutside, probeRemovable, scanStrandedProbes } = require('../../lib/teardown-guard');

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

  test('the probe name is deterministic — encodes the worktree folder name, not pid/random', () => {
    const dir = path.join(parent, 'my-worktree');
    fs.mkdirSync(dir);
    const seenTargets = [];
    const realRename = fs.renameSync;
    jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => { seenTargets.push(to); return realRename(from, to); });
    try { probeRemovable(dir, parent); } finally { jest.restoreAllMocks(); }
    // The rename-away target (first call) must be exactly this — a later run (e.g.
    // scanStrandedProbes after a crash) has to be able to reconstruct the same
    // path from the worktree's folder name alone, which a pid+random name could not.
    expect(seenTargets[0]).toBe(path.join(parent, '.wksp-probe-my-worktree'));
  });

  test('reports locked (not removable) when a probe path already exists', () => {
    const dir = path.join(parent, 'wt');
    fs.mkdirSync(dir);
    fs.mkdirSync(path.join(parent, '.wksp-probe-wt')); // simulate an earlier, still-stranded probe
    const result = probeRemovable(dir, parent);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('EEXIST');
    // Nothing was touched — the real worktree is exactly where it was.
    expect(fs.existsSync(dir)).toBe(true);
  });

  // The race the opt-in split exists to prevent, from the losing side: another run put
  // the folder back between our two renames, so the rename-back hits ENOENT on a probe
  // path that is gone. Reporting `stranded` there would be a false "locked" verdict
  // naming a path that no longer exists.
  test('treats ENOENT-with-the-directory-back as success, not a stranded probe', () => {
    const dir = path.join(parent, 'wt');
    fs.mkdirSync(dir);
    const realRename = fs.renameSync;
    let calls = 0;
    jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (++calls === 1) {
        realRename(from, to);
        realRename(to, from);  // a concurrent recovery puts it back for us
        return;
      }
      throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
    });
    let result;
    try { result = probeRemovable(dir, parent); }
    finally { jest.restoreAllMocks(); }

    expect(result).toEqual({ ok: true });
    expect(fs.existsSync(dir)).toBe(true);
  });

  test('still reports stranded on ENOENT when the directory really is gone', () => {
    const dir = path.join(parent, 'wt');
    fs.mkdirSync(dir);
    const realRename = fs.renameSync;
    let calls = 0;
    jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (++calls === 1) return realRename(from, to);
      throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
    });
    let result;
    try { result = probeRemovable(dir, parent); }
    finally { jest.restoreAllMocks(); }

    expect(result.ok).toBe(false);
    expect(result.stranded).toBe(path.join(parent, '.wksp-probe-wt'));
    fs.renameSync(result.stranded, dir);
  });
});

describe('scanStrandedProbes', () => {
  let taskDir;
  beforeEach(() => {
    taskDir = makeTempDir('guard-recover');
    fs.mkdirSync(path.join(taskDir, 'worktrees'), { recursive: true });
  });
  afterEach(() => cleanup(taskDir));

  test('renames a stranded probe back to worktrees/<name> under recover', () => {
    const stranded = path.join(taskDir, '.wksp-probe-wksp');
    fs.mkdirSync(stranded);
    fs.writeFileSync(path.join(stranded, 'marker.txt'), 'still here');

    const result = scanStrandedProbes(taskDir, 'worktrees', { recover: true });

    expect(result.recovered).toEqual(['wksp']);
    expect(result.stranded).toEqual([]);
    expect(fs.existsSync(stranded)).toBe(false);
    const target = path.join(taskDir, 'worktrees', 'wksp');
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readFileSync(path.join(target, 'marker.txt'), 'utf8')).toBe('still here');
  });

  // The whole point of the opt-in split: merely looking must not move anything.
  test('reports without renaming anything by default', () => {
    const stranded = path.join(taskDir, '.wksp-probe-wksp');
    fs.mkdirSync(stranded);
    const target = path.join(taskDir, 'worktrees', 'wksp');

    const result = scanStrandedProbes(taskDir, 'worktrees');

    expect(result.recovered).toEqual([]);
    expect(result.stranded).toEqual([{
      folderName: 'wksp', strandedPath: stranded, targetPath: target,
      code: null, message: 'not moved back — this command only reports it', attempted: false,
    }]);
    // Untouched: still aside, and the target was never created.
    expect(fs.existsSync(stranded)).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
  });

  test('does nothing when there is no stranded probe', () => {
    fs.mkdirSync(path.join(taskDir, 'worktrees', 'wksp'), { recursive: true });
    expect(scanStrandedProbes(taskDir, 'worktrees', { recover: true })).toEqual({ recovered: [], stranded: [] });
    expect(scanStrandedProbes(taskDir, 'worktrees')).toEqual({ recovered: [], stranded: [] });
  });

  test('reports failure, and never overwrites, when the target already exists', () => {
    const stranded = path.join(taskDir, '.wksp-probe-wksp');
    fs.mkdirSync(stranded);
    fs.writeFileSync(path.join(stranded, 'a.txt'), 'stranded copy');
    const target = path.join(taskDir, 'worktrees', 'wksp');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'b.txt'), 'existing worktree');

    const result = scanStrandedProbes(taskDir, 'worktrees', { recover: true });

    expect(result.recovered).toEqual([]);
    expect(result.stranded).toEqual([{
      folderName: 'wksp', strandedPath: stranded, targetPath: target,
      code: 'EEXIST', message: `${target} already exists`, attempted: true,
    }]);
    // Neither side was touched.
    expect(fs.existsSync(path.join(stranded, 'a.txt'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'b.txt'))).toBe(true);
  });

  test('reports failure with the error code when the rename back fails', () => {
    const stranded = path.join(taskDir, '.wksp-probe-wksp');
    fs.mkdirSync(stranded);
    jest.spyOn(fs, 'renameSync').mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
    let result;
    try { result = scanStrandedProbes(taskDir, 'worktrees', { recover: true }); }
    finally { jest.restoreAllMocks(); }

    expect(result.recovered).toEqual([]);
    expect(result.stranded).toEqual([{
      folderName: 'wksp', strandedPath: stranded,
      targetPath: path.join(taskDir, 'worktrees', 'wksp'),
      code: 'EPERM', message: 'denied', attempted: true,
    }]);
    expect(fs.existsSync(stranded)).toBe(true); // left exactly where it was
  });

  test('ignores directories that do not match the probe prefix', () => {
    fs.mkdirSync(path.join(taskDir, 'some-other-dir'));
    const result = scanStrandedProbes(taskDir, 'worktrees', { recover: true });
    expect(result).toEqual({ recovered: [], stranded: [] });
    expect(fs.existsSync(path.join(taskDir, 'some-other-dir'))).toBe(true);
  });

  test('returns empty when taskDir does not exist', () => {
    const result = scanStrandedProbes(path.join(taskDir, 'missing'), 'worktrees', { recover: true });
    expect(result).toEqual({ recovered: [], stranded: [] });
  });

  // MINOR 3: every read command funnels through discoverWorktrees → here, and none of
  // them catch. An unreadable taskDir must not turn `wksp status` into a bare `Fatal:`.
  test('swallows an unreadable taskDir instead of throwing at the read commands', () => {
    jest.spyOn(fs, 'readdirSync').mockImplementation(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });
    let result;
    try { result = scanStrandedProbes(taskDir, 'worktrees', { recover: true }); }
    finally { jest.restoreAllMocks(); }
    expect(result).toEqual({ recovered: [], stranded: [] });
  });
});
