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

// Returns { normalized, removed } — `removed` is how many repos.txt lines went, which is
// normally 1 and is only ever more for a registry written before addRepo started
// rejecting canonical duplicates.
function removeRepo(projectDir, rawPath) {
  const normalized = normalizePath(rawPath);
  const entries    = readRepos(projectDir);
  // Same reason as addRepo: a repo registered under one spelling must be removable by
  // the other, or `wksp repo remove` throws "Repo not found" after it has already torn
  // the orphaned worktrees down.
  //
  // EVERY canonical match goes, not just the first. Two entries naming one directory can
  // only come from a registry written before the duplicate check above was canonical, but
  // there they have to be removed together: handleRemove tears down the worktrees of every
  // task worktree pointing at this directory — i.e. both entries' — so removing one line
  // would leave a repo still registered with its worktrees already gone, while the command
  // printed that it had removed it. (Such a pair was never usable anyway: both entries
  // share a folderName, so a task would try to create two worktrees at the same path.)
  const kept    = entries.filter(e => !samePathCanonical(e.normalized, normalized));
  const removed = entries.length - kept.length;

  if (!removed) throw new Error(`Repo not found in repos.txt: ${rawPath}`);

  writeRepos(projectDir, kept);
  return { normalized, removed };
}

module.exports = { readRepos, writeRepos, addRepo, removeRepo, REPOS_FILE, REPOS_HEADER };
