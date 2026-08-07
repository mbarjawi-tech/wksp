'use strict';
const fs   = require('fs');
const path = require('path');
const { normalizePath, samePathCanonical } = require('./paths');

const REPOS_FILE = 'repos.txt';

const REPOS_HEADER = [
  '# Workspace repos',
  '# Format: <path> [--shared] [--optional]',
  '# --shared: use original path in every task, never create a worktree',
  '# --optional: excluded from tasks by default; pull into a task with: wksp task repo <id> <repo> worktree',
];

function readRepos(projectDir) {
  const filePath = path.join(projectDir, REPOS_FILE);
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(l => {
      const shared     = / +--shared\b/.test(l);
      const optional   = / +--optional\b/.test(l);
      const raw        = l.replace(/ +--shared\b/, '').replace(/ +--optional\b/, '').trim();
      const normalized = normalizePath(raw);
      const folderName = path.basename(normalized);
      return { raw, normalized, shared, optional, folderName };
    });
}

function writeRepos(projectDir, entries) {
  const lines = [
    ...REPOS_HEADER,
    '',
    ...entries.map(e => e.raw + (e.shared ? '  --shared' : '') + (e.optional ? '  --optional' : '')),
    '',
  ];
  fs.writeFileSync(path.join(projectDir, REPOS_FILE), lines.join('\n'));
}

// `opts` is { shared, optional }; a plain boolean is accepted as { shared } for
// callers that predate the --optional flag.
function addRepo(projectDir, rawPath, opts) {
  const { shared = false, optional = false } =
    typeof opts === 'boolean' ? { shared: opts } : (opts || {});
  const entries    = readRepos(projectDir);
  const normalized = normalizePath(rawPath);

  // Canonical, like every other "is this the same repo?" question: `C:\Users\RUNNER~1\r`
  // and `C:\Users\runneradmin\r` are one directory, and a raw string comparison would let
  // it be registered twice. What gets WRITTEN is still the normalized spelling the user
  // gave — canonicalisation belongs to the comparison, not to what is stored.
  if (entries.some(e => samePathCanonical(e.normalized, normalized))) {
    throw new Error(`Repo already registered: ${rawPath}`);
  }

  // Store with forward slashes for consistent cross-tool display
  const raw = normalized.replace(/\\/g, '/');
  entries.push({ raw, normalized, shared: !!shared, optional: !!optional, folderName: path.basename(normalized) });
  writeRepos(projectDir, entries);
}

function removeRepo(projectDir, rawPath) {
  const normalized = normalizePath(rawPath);
  const entries    = readRepos(projectDir);
  // Same reason as addRepo: a repo registered under one spelling must be removable by
  // the other, or `wksp repo remove` throws "Repo not found" after it has already torn
  // the orphaned worktrees down.
  const idx        = entries.findIndex(e => samePathCanonical(e.normalized, normalized));

  if (idx === -1) throw new Error(`Repo not found in repos.txt: ${rawPath}`);

  entries.splice(idx, 1);
  writeRepos(projectDir, entries);
  return normalized;
}

module.exports = { readRepos, writeRepos, addRepo, removeRepo, REPOS_FILE, REPOS_HEADER };
