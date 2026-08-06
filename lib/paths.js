'use strict';
const path = require('path');
const os   = require('os');

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

// True at the top of a filesystem: "/" on posix, "C:\" or a UNC share root on win32.
// path.dirname is the portable test — a root is the only path it maps to itself.
function isFilesystemRoot(p) {
  const resolved = path.resolve(p);
  return path.dirname(resolved) === resolved;
}

// The two locations no wksp command may ever treat as a project folder, in one place so
// the guards in init/delete/migrate cannot drift apart. Returns a human-readable reason,
// or null when the path is fine.
//
// The home directory is on the list because the global config is `~/.wksp` and a project
// marker is also `.wksp` — the same filename. Creating a project at the home directory
// would overwrite the global config with a project marker, and "migrating" it would write
// project fields (schemaVersion) into the global config. A project *inside* the home
// directory (~/projects/foo) is perfectly normal and not affected.
function unsafeProjectDirReason(p) {
  if (samePath(p, os.homedir())) {
    return 'it is your home directory, where wksp keeps its global config (~/.wksp — the same filename as a project marker)';
  }
  if (isFilesystemRoot(p)) return 'it is a filesystem root';
  return null;
}

module.exports = { toPosix, normalizePath, isInside, samePath, isFilesystemRoot, unsafeProjectDirReason };
