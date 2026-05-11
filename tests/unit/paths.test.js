'use strict';
const path = require('path');
const { toPosix, normalizePath } = require('../../lib/paths');

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
