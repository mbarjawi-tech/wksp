'use strict';
const path = require('path');
const { toPosix, normalizePath, isInside, samePath } = require('../../lib/paths');

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
    expect(result).toMatch(/^\/[a-z]\//);
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
