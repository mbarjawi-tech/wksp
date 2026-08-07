'use strict';
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { toPosix, normalizePath, isInside, samePath,
        isFilesystemRoot, unsafeProjectDirReason,
        canonicalPath, samePathCanonical,
        isInsideEitherForm, samePathEitherForm } = require('../../lib/paths');

afterEach(() => jest.restoreAllMocks());

describe('toPosix', () => {
  test('converts Windows backslash path to POSIX', () => {
    if (process.platform !== 'win32') return;
    expect(toPosix('C:\\foo\\bar')).toBe('/c/foo/bar');
  });

  test('lowercases the drive letter (path casing preserved)', () => {
    if (process.platform !== 'win32') return;
    // toPosix lowercases only the drive letter, not the rest of the path
    expect(toPosix('D:\\Projects\\wksp')).toBe('/d/Projects/wksp');
  });

  test('converts forward-slash Windows path', () => {
    if (process.platform !== 'win32') return;
    expect(toPosix('C:/foo/bar')).toBe('/c/foo/bar');
  });

  test('handles paths with spaces', () => {
    if (process.platform !== 'win32') return;
    expect(toPosix('C:\\My Projects\\wksp')).toBe('/c/My Projects/wksp');
  });

  test('resolves relative path before converting', () => {
    const result = toPosix('.');
    // The /c/ drive-letter shape only exists on win32; elsewhere toPosix hands
    // back path.resolve() untouched, which is already an absolute POSIX path.
    if (process.platform === 'win32') expect(result).toMatch(/^\/[a-z]\//);
    else expect(path.isAbsolute(result)).toBe(true);
  });
});

describe('normalizePath', () => {
  test('converts POSIX-style /c/ path to Windows absolute on win32', () => {
    if (process.platform !== 'win32') return;
    const result = normalizePath('/c/foo/bar');
    expect(result).toBe('C:\\foo\\bar');
  });

  test('resolves a Windows path to absolute', () => {
    if (process.platform !== 'win32') return;
    const result = normalizePath('C:\\foo\\bar');
    expect(result).toBe('C:\\foo\\bar');
  });

  test('trims whitespace', () => {
    const result = normalizePath('  ' + process.cwd() + '  ');
    expect(result).toBe(path.resolve(process.cwd()));
  });

  test('round-trips with toPosix', () => {
    const original = process.cwd();
    const posix = toPosix(original);
    const back  = normalizePath(posix);
    expect(back).toBe(path.resolve(original));
  });
});

describe('isInside', () => {
  const root = path.resolve(path.join('project', 'tasks'));
  const foo  = path.join(root, 'foo');

  test('a directory is inside itself', () => {
    expect(isInside(foo, foo)).toBe(true);
  });

  test('a nested path is inside', () => {
    expect(isInside(path.join(foo, 'worktrees', 'wksp', 'lib'), foo)).toBe(true);
  });

  test('a sibling that shares the prefix is NOT inside', () => {
    // The edge a startsWith() check gets wrong: tasks/foo-bar is not in tasks/foo,
    // so tearing down "foo" must not be refused because a shell sits in "foo-bar".
    expect(isInside(path.join(root, 'foo-bar'), foo)).toBe(false);
    expect(isInside(path.join(root, 'foo-bar', 'worktrees', 'wksp'), foo)).toBe(false);
    expect(isInside(path.join(root, 'foobar'), foo)).toBe(false);
  });

  test('a parent is not inside its child', () => {
    expect(isInside(root, foo)).toBe(false);
  });

  test('a directory whose name starts with .. is still inside', () => {
    // path.relative() returns "..foo" here — a leading ".." SEGMENT means outside,
    // a leading ".." substring does not.
    expect(isInside(path.join(foo, '..foo'), foo)).toBe(true);
  });

  test('casing is ignored on win32 and honoured elsewhere', () => {
    if (process.platform === 'win32') {
      expect(isInside('C:\\Project\\Tasks\\Foo\\wt', 'c:\\project\\tasks\\foo')).toBe(true);
    } else {
      expect(isInside('/project/tasks/Foo/wt', '/project/tasks/foo')).toBe(false);
    }
  });

  test('a different drive is outside', () => {
    if (process.platform !== 'win32') return;
    expect(isInside('D:\\project\\tasks\\foo\\wt', 'C:\\project\\tasks\\foo')).toBe(false);
  });
});

describe('samePath', () => {
  test('true for the same directory written differently', () => {
    expect(samePath(path.join('a', 'b'), path.join('a', 'c', '..', 'b'))).toBe(true);
  });

  test('false for a child', () => {
    expect(samePath(path.resolve('a'), path.resolve('a', 'b'))).toBe(false);
  });

  test('case-insensitive on win32 only', () => {
    if (process.platform === 'win32') expect(samePath('C:\\A\\B', 'c:\\a\\b')).toBe(true);
    else                              expect(samePath('/A/B', '/a/b')).toBe(false);
  });
});

// ─── canonicalisation (PLANNING #25) ──────────────────────────────────────────
//
// These drive the helpers with an EXPLICIT short/long pair rather than asking the
// filesystem for one, so the behaviour stays pinned on a volume with 8.3 generation
// switched off, and on Linux and macOS where it never existed. The realpath call is
// stubbed; nothing here touches disk. tests/integration/short-paths.test.js does the
// same thing against a real 8.3 name and real git.
//
// Every test uses its own fabricated paths on purpose. Each one stubs
// fs.realpathSync.native wholesale — the stub answers for EVERY path, not just the
// fixture it was written for — so giving each test distinct paths is what stops one
// test's stub answering another test's question. (canonicalPath itself holds no state
// between calls: it is deliberately not memoised, pinned by the test below.)
describe('canonicalPath and the two flavours of path comparison', () => {
  const ROOT = path.parse(process.cwd()).root;
  const fake = (...segs) => path.join(ROOT, ...segs);

  // Map resolved path → canonical path, the way fs.realpathSync.native would for an
  // 8.3 short name. Anything not in the map is ENOENT, which is the normal case for a
  // path wksp has not created yet.
  function stubRealpath(map) {
    const answer = p => {
      const hit = map[path.resolve(p)];
      if (hit) return hit;
      const err = new Error(`ENOENT: no such file or directory, lstat '${p}'`);
      err.code = 'ENOENT';
      throw err;
    };
    jest.spyOn(fs.realpathSync, 'native').mockImplementation(answer);
    return answer;
  }

  test('expands a short component that path.resolve leaves alone', () => {
    const short = fake('cp-expand', 'SHORTN~1');
    const long  = fake('cp-expand', 'shortname-is-long');
    stubRealpath({ [short]: long });

    expect(path.resolve(short)).toBe(short);   // path.resolve cannot do this
    expect(canonicalPath(short)).toBe(long);
    expect(canonicalPath(long)).toBe(long);    // already canonical, ENOENT → itself
  });

  test('a path that does not exist yet canonicalises through its nearest real ancestor', () => {
    // wksp reasons about worktree directories BEFORE it creates them, so this is the
    // common case, not an error case.
    const short = fake('cp-unborn', 'SHORTN~1');
    const long  = fake('cp-unborn', 'shortname-is-long');
    stubRealpath({ [short]: long });

    expect(canonicalPath(path.join(short, 'tasks', 'T1', 'worktrees', 'repo')))
      .toBe(path.join(long, 'tasks', 'T1', 'worktrees', 'repo'));
  });

  test('never throws — an unresolvable path degrades to path.resolve', () => {
    stubRealpath({});
    const p = fake('cp-nothing', 'here', 'at', 'all');
    expect(() => canonicalPath(p)).not.toThrow();
    expect(canonicalPath(p)).toBe(path.resolve(p));
  });

  test('falls back to fs.realpathSync when the native implementation fails', () => {
    // The documented chain is native → JS → the un-canonicalised path. Only native
    // expands 8.3 names, but the JS one still follows symlinks, so it is worth having —
    // for native failing for some OTHER reason than the path not being there, which is
    // why the stub below throws a plain Error: an ENOENT from native is rethrown rather
    // than retried, since the JS implementation cannot do better with it.
    const short = fake('cp-fallback', 'SHORTN~1');
    const long  = fake('cp-fallback', 'shortname-is-long');
    jest.spyOn(fs.realpathSync, 'native').mockImplementation(() => { throw new Error('nope'); });
    jest.spyOn(fs, 'realpathSync').mockImplementation(p =>
      (path.resolve(p) === short ? long : (() => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; })()));

    expect(canonicalPath(short)).toBe(long);
  });

  // The reason canonicalPath is not memoised, pinned so nobody "optimises" it back.
  // Windows RECYCLES 8.3 aliases: delete the directory that owns WKSP-P~1 and the next
  // similarly-named one is handed WKSP-P~1 in turn. A cached answer would therefore
  // stop being merely stale and start naming a DIFFERENT directory — the exact class
  // of wrong answer this change exists to remove. (Found the hard way: an earlier draft
  // cached, and tests/integration/short-paths.test.js failed because two consecutive
  // temp directories were assigned the same alias.)
  test('re-resolves every time, because Windows reuses 8.3 aliases', () => {
    const alias = fake('cp-recycled', 'RECYCL~1');
    const first  = fake('cp-recycled', 'recycled-name-one');
    const second = fake('cp-recycled', 'recycled-name-two');

    stubRealpath({ [alias]: first });
    expect(canonicalPath(alias)).toBe(first);

    // The directory is deleted and a new one takes the same alias.
    jest.restoreAllMocks();
    stubRealpath({ [alias]: second });
    expect(canonicalPath(alias)).toBe(second);
  });

  describe('lookups compare canonical forms', () => {
    test('a literal match short-circuits, so no realpath call is made at all', () => {
      // The fast path cannot change an answer — two paths that resolve to one string
      // canonicalise to one answer — and it is what keeps `wksp repo add` from
      // realpath-ing entries a string comparison already settled. One entry naming an
      // unreachable UNC share costs seconds per call, so "did we call it" is the
      // property worth pinning, not just the boolean.
      // realpathOf is the only route to either realpath implementation, and it always
      // tries .native first — so "native was never called" is "no realpath happened".
      const native = jest.spyOn(fs.realpathSync, 'native').mockImplementation(() => {
        throw new Error('canonicalPath was reached for two paths that already match');
      });
      const p = fake('cmp-fast', 'SHORTN~1');

      expect(samePathCanonical(p, path.join(p, 'sub', '..'))).toBe(true);
      expect(samePathEitherForm(p, p)).toBe(true);
      expect(native).not.toHaveBeenCalled();
    });

    test('samePathCanonical matches two spellings of one directory, samePath does not', () => {
      const short = fake('cmp-look', 'SHORTN~1');
      const long  = fake('cmp-look', 'shortname-is-long');
      stubRealpath({ [short]: long });

      expect(samePath(short, long)).toBe(false);            // unchanged: literal
      expect(samePathCanonical(short, long)).toBe(true);    // the lookup answer
    });

    test('samePathCanonical still says no to two genuinely different directories', () => {
      const a = fake('cmp-diff', 'AAAAAA~1');
      const b = fake('cmp-diff', 'BBBBBB~1');
      stubRealpath({ [a]: fake('cmp-diff', 'aaa-long'), [b]: fake('cmp-diff', 'bbb-long') });
      expect(samePathCanonical(a, b)).toBe(false);
    });
  });

  // Scoped to CONTAINMENT on purpose: that is the comparison where the two forms can
  // genuinely disagree. samePathEitherForm is samePathCanonical with a literal fast
  // path, asserted alongside only because guard call sites read the two as a pair.
  describe('the containment guard matches if EITHER form matches', () => {
    test('the canonical form catches a short name the literal comparison misses', () => {
      const short = fake('cmp-guard-short', 'SHORTN~1');
      const long  = fake('cmp-guard-short', 'shortname-is-long');
      stubRealpath({ [short]: long });
      const cwdInsideByLongName = path.join(long, 'tasks', 'T1', 'worktrees', 'repo');

      // This is the fail-open: the shell reports the long name, wksp holds the short
      // one, and the literal containment check says "not inside" — so a teardown that
      // must refuse would go ahead.
      expect(isInside(cwdInsideByLongName, short)).toBe(false);
      expect(isInsideEitherForm(cwdInsideByLongName, short)).toBe(true);
      expect(samePathEitherForm(short, long)).toBe(true);
    });

    test('the LITERAL form catches a junction whose canonical target is elsewhere', () => {
      // The reason isInsideEitherForm is not just the canonical form — and the one place
      // that argument holds, since it needs the two forms to disagree. `taskDir/worktrees/repo`
      // is a junction to a directory outside the task; by canonical name the cwd is
      // nowhere near what is about to be deleted, but by the only name the user and
      // `git worktree remove` will use, it is squarely inside it. Comparing canonical
      // forms alone would make the guard MISS this.
      const taskDir  = fake('cmp-guard-junction', 'task');
      const junction = path.join(taskDir, 'worktrees', 'repo');
      const cwd      = path.join(junction, 'lib');
      stubRealpath({
        [taskDir]:  taskDir,
        [junction]: fake('cmp-guard-junction', 'somewhere-else'),
        [cwd]:      fake('cmp-guard-junction', 'somewhere-else', 'lib'),
      });

      expect(isInside(canonicalPath(cwd), canonicalPath(taskDir))).toBe(false); // canonical-only would miss it
      expect(isInsideEitherForm(cwd, taskDir)).toBe(true);
    });

    test('a sibling is still outside — eagerness does not mean matching everything', () => {
      const root = fake('cmp-guard-sib', 'tasks');
      stubRealpath({});
      expect(isInsideEitherForm(path.join(root, 'foo-bar'), path.join(root, 'foo'))).toBe(false);
      expect(samePathEitherForm(path.join(root, 'foo'), path.join(root, 'foo-bar'))).toBe(false);
    });
  });
});

describe('isFilesystemRoot', () => {
  const root = path.parse(process.cwd()).root;

  test('true for the root of the current drive', () => {
    expect(isFilesystemRoot(root)).toBe(true);
  });

  test('false for an ordinary directory', () => {
    expect(isFilesystemRoot(process.cwd())).toBe(false);
    expect(isFilesystemRoot(path.join(root, 'anything'))).toBe(false);
  });

  test('true for a posix root', () => {
    if (process.platform === 'win32') return;
    expect(isFilesystemRoot('/')).toBe(true);
  });
});

// The shared policy behind the init / delete / migrate guards. Kept in one place so the
// three cannot drift: the home directory holds the global config under the very same
// `.wksp` filename a project marker uses.
describe('unsafeProjectDirReason', () => {
  test('names the home directory', () => {
    const fakeHome = path.join(path.parse(process.cwd()).root, 'Users', 'someone');
    jest.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    expect(unsafeProjectDirReason(fakeHome)).toMatch(/home directory/);
  });

  test('names a filesystem root', () => {
    expect(unsafeProjectDirReason(path.parse(process.cwd()).root)).toMatch(/filesystem root/);
  });

  test('null for a project inside the home directory — that is a normal setup', () => {
    const fakeHome = path.join(path.parse(process.cwd()).root, 'Users', 'someone');
    jest.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    expect(unsafeProjectDirReason(path.join(fakeHome, 'projects', 'foo'))).toBeNull();
  });

  test('null for an ordinary directory', () => {
    expect(unsafeProjectDirReason(process.cwd())).toBeNull();
  });

  // The guard is a string comparison against os.homedir(), so a home directory
  // reached under its 8.3 short name used to slip straight past it — and this is the
  // guard standing between `wksp delete` and the user's home directory (PLANNING #21).
  // Any Windows username over 8 characters, or containing a space, has one.
  test('still names the home directory when it is spelled with an 8.3 short name', () => {
    const root      = path.parse(process.cwd()).root;
    const longHome  = path.join(root, 'Users', 'runneradmin');
    const shortHome = path.join(root, 'Users', 'RUNNER~1');
    jest.spyOn(os, 'homedir').mockReturnValue(longHome);
    jest.spyOn(fs.realpathSync, 'native').mockImplementation(p => {
      if (path.resolve(p) === shortHome || path.resolve(p) === longHome) return longHome;
      const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e;
    });

    expect(unsafeProjectDirReason(shortHome)).toMatch(/home directory/);
  });
});
