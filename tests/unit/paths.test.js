'use strict';
const path = require('path');
const os   = require('os');
const { toPosix, normalizePath, isInside, samePath,
        isFilesystemRoot, unsafeProjectDirReason } = require('../../lib/paths');

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
});
