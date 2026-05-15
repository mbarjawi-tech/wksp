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
      const shared     = / +--shared\b/.test(l);
      const aliasMatch = l.match(/ +--as +(\S+)/);
      const alias      = aliasMatch ? aliasMatch[1] : null;
      const raw        = l.replace(/ +--shared\b/, '').replace(/ +--as +\S+/, '').trim();
      const normalized = normalizePath(raw);
      const folderName = alias ?? path.basename(normalized);
      return { raw, normalized, shared, alias, folderName };
    });
}

function writeRepos(projectDir, entries) {
  const lines = [
    '# Workspace repos',
    '# Format: <path> [--shared] [--as <alias>]',
    '# --shared: use original path in every task, never create a worktree',
    '# --as:     register the same repo a second time with a distinct folder name',
    '',
    ...entries.map(e => {
      let line = e.raw;
      if (e.shared) line += '  --shared';
      if (e.alias)  line += `  --as ${e.alias}`;
      return line;
    }),
    '',
  ];
  fs.writeFileSync(path.join(projectDir, REPOS_FILE), lines.join('\n'));
}

function addRepo(projectDir, rawPath, shared, alias) {
  const entries    = readRepos(projectDir);
  const normalized = normalizePath(rawPath);

  if (!alias) {
    if (entries.some(e => e.normalized === normalized)) {
      throw new Error(`Repo already registered: ${rawPath}\n  To register it a second time on a different branch, use: --as <alias>`);
    }
  } else {
    if (!/^[a-zA-Z0-9_-]+$/.test(alias)) {
      throw new Error(`Invalid alias "${alias}" — use letters, digits, hyphens, underscores only`);
    }
    if (entries.some(e => e.folderName === alias)) {
      throw new Error(`Alias "${alias}" is already in use`);
    }
  }

  const folderName = alias ?? path.basename(normalized);
  entries.push({ raw: rawPath, normalized, shared: !!shared, alias: alias || null, folderName });
  writeRepos(projectDir, entries);
}

function removeRepo(projectDir, rawPath, alias) {
  const normalized = normalizePath(rawPath);
  const entries    = readRepos(projectDir);
  const matches    = entries.filter(e => e.normalized === normalized);

  if (matches.length === 0) throw new Error(`Repo not found in repos.txt: ${rawPath}`);

  let idx;
  if (matches.length > 1) {
    if (!alias) throw new Error(`Multiple entries for "${rawPath}" — specify --as <alias> to disambiguate`);
    idx = entries.findIndex(e => e.normalized === normalized && e.alias === alias);
    if (idx === -1) throw new Error(`No entry for "${rawPath}" with alias "${alias}"`);
  } else {
    idx = entries.findIndex(e => e.normalized === normalized);
  }

  entries.splice(idx, 1);
  writeRepos(projectDir, entries);
  return normalized;
}

module.exports = { readRepos, writeRepos, addRepo, removeRepo, REPOS_FILE };
