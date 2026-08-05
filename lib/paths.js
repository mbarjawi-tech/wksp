'use strict';
const path = require('path');

function toPosix(p) {
  const resolved = path.resolve(p);
  if (process.platform === 'win32') {
    const m = resolved.match(/^([A-Za-z]):(.*)/);
    if (m) return '/' + m[1].toLowerCase() + m[2].replace(/\\/g, '/');
  }
  return resolved;
}

function normalizePath(p) {
  p = p.trim();
  if (process.platform === 'win32' && /^\/[a-zA-Z]\//.test(p)) {
    p = p[1].toUpperCase() + ':' + p.slice(2);
  }
  return path.resolve(p);
}

// Containment test for the teardown guards: true when `child` IS `parent` or sits
// anywhere under it.
//
// path.relative does the platform-correct comparison for free — case-insensitive on
// win32, case-sensitive elsewhere — and unlike comparing the two strings with
// startsWith it can't be fooled by a sibling that shares a prefix: …/tasks/foo-bar
// relative to …/tasks/foo is "../foo-bar", which is outside. Only a leading ".."
// SEGMENT means outside (a real directory named "..foo" is inside), and a different
// Windows drive makes relative() hand back an absolute path.
function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  if (rel === '')             return true;   // the same directory
  if (path.isAbsolute(rel))   return false;  // different root / drive letter
  return rel.split(path.sep)[0] !== '..';
}

// True when both paths name the same directory, with the same platform-correct
// casing rules as isInside.
function samePath(a, b) {
  return path.relative(path.resolve(a), path.resolve(b)) === '';
}

module.exports = { toPosix, normalizePath, isInside, samePath };
