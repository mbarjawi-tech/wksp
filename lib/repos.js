'use strict';
const fs   = require('fs');
const path = require('path');
const { normalizePath } = require('./paths');

const REPOS_FILE = 'repos.txt';

function readRepos(projectDir) {
  const filePath = path.join(projectDir, REPOS_FILE);
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(l => {
      const shared = / +--shared$/.test(l);
      const raw    = l.replace(/ +--shared$/, '').trim();
      return { raw, normalized: normalizePath(raw), shared };
    });
}

function writeRepos(projectDir, entries) {
  const lines = [
    '# Workspace repos',
    '# Format: <path> [--shared]',
    '# --shared: use original path in every task, never create a worktree',
    '',
    ...entries.map(e => e.shared ? `${e.raw}  --shared` : e.raw),
    '',
  ];
  fs.writeFileSync(path.join(projectDir, REPOS_FILE), lines.join('\n'));
}

function addRepo(projectDir, rawPath, shared) {
  const entries    = readRepos(projectDir);
  const normalized = normalizePath(rawPath);
  if (entries.some(e => e.normalized === normalized)) {
    throw new Error(`Repo already registered: ${rawPath}`);
  }
  entries.push({ raw: rawPath, normalized, shared: !!shared });
  writeRepos(projectDir, entries);
}

function removeRepo(projectDir, rawPath) {
  const normalized = normalizePath(rawPath);
  const entries    = readRepos(projectDir);
  const idx        = entries.findIndex(e => e.normalized === normalized);
  if (idx === -1) throw new Error(`Repo not found in repos.txt: ${rawPath}`);
  entries.splice(idx, 1);
  writeRepos(projectDir, entries);
  return normalized;
}

module.exports = { readRepos, writeRepos, addRepo, removeRepo, REPOS_FILE };
