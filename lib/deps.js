'use strict';
const fs   = require('fs');
const path = require('path');

const CACHE_DIR_NAME = '.wksp-cache';

// ─── path helpers ─────────────────────────────────────────────────────────────

function getCacheDir(projectDir, repoFolderName) {
  return path.join(projectDir, CACHE_DIR_NAME, repoFolderName);
}

// Create <cacheDir>/<dep>/ for each dep in the list. No-op if already present.
function ensureCacheDir(projectDir, repoFolderName, deps) {
  const cacheDir = getCacheDir(projectDir, repoFolderName);
  for (const dep of deps) {
    fs.mkdirSync(path.join(cacheDir, dep), { recursive: true });
  }
}

// ─── link management ─────────────────────────────────────────────────────────

// Create a symlink (Unix) or directory junction (Windows) for each dep.
// Skips if the path already exists (idempotent).
// cacheDir must already exist for the dep (call ensureCacheDir first).
function createDepLinks(worktreeDir, cacheDir, deps) {
  for (const dep of deps) {
    const linkPath   = path.join(worktreeDir, dep);
    const targetPath = path.join(cacheDir, dep);

    // Skip if something already exists at the link path
    try { fs.lstatSync(linkPath); continue; } catch {}

    if (process.platform === 'win32') {
      fs.symlinkSync(targetPath, linkPath, 'junction');
    } else {
      fs.symlinkSync(targetPath, linkPath);
    }
  }
}

// Remove dep symlinks/junctions from a worktree directory.
// Leaves real directories untouched.
function removeDepLinks(worktreeDir, deps) {
  for (const dep of deps) {
    const linkPath = path.join(worktreeDir, dep);
    try {
      const stat = fs.lstatSync(linkPath);
      if (stat.isSymbolicLink()) fs.unlinkSync(linkPath);
      // Real dir → leave it alone (user's own install)
    } catch {
      // Doesn't exist — nothing to do
    }
  }
}

// ─── inspection ──────────────────────────────────────────────────────────────

function isDepLinked(worktreeDir, depName) {
  try { return fs.lstatSync(path.join(worktreeDir, depName)).isSymbolicLink(); }
  catch { return false; }
}

// Returns true when depName exists in the worktree as a real (non-symlink) directory.
// This means the user has their own install and the worktree should be auto-opted-out.
function hasRealDepDir(worktreeDir, depName) {
  try {
    const stat = fs.lstatSync(path.join(worktreeDir, depName));
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch { return false; }
}

module.exports = {
  CACHE_DIR_NAME,
  getCacheDir,
  ensureCacheDir,
  createDepLinks,
  removeDepLinks,
  isDepLinked,
  hasRealDepDir,
};
