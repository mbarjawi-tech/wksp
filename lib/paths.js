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

module.exports = { toPosix, normalizePath };
