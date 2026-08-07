'use strict';
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execSync } = require('child_process');

function makeTempDir(prefix = 'wksp-test') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
}

// Creates an initialised git repo with one commit on `main`.
function makeGitRepo(dir) {
  try {
    execSync('git init -b main', { cwd: dir, stdio: 'pipe' });
  } catch {
    execSync('git init', { cwd: dir, stdio: 'pipe' });
    execSync('git symbolic-ref HEAD refs/heads/main', { cwd: dir, stdio: 'pipe' });
  }
  execSync('git config user.email "test@wksp.test"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "wksp test"', { cwd: dir, stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  execSync('git add .', { cwd: dir, stdio: 'pipe' });
  execSync('git commit -m "init"', { cwd: dir, stdio: 'pipe' });
}

// Creates a bare "origin" and a clone that has pushed main to it, so
// remote tracking refs exist (refs/remotes/origin/main etc.)
function makeGitRepoWithRemote() {
  const originDir = makeTempDir('origin');
  execSync('git init --bare', { cwd: originDir, stdio: 'pipe' });

  const repoDir = makeTempDir('repo');
  execSync(`git clone "${originDir}" "${repoDir}"`, { stdio: 'pipe' });
  execSync('git config user.email "test@wksp.test"', { cwd: repoDir, stdio: 'pipe' });
  execSync('git config user.name "wksp test"', { cwd: repoDir, stdio: 'pipe' });

  fs.writeFileSync(path.join(repoDir, 'README.md'), '# test\n');
  execSync('git add .', { cwd: repoDir, stdio: 'pipe' });
  execSync('git commit -m "init"', { cwd: repoDir, stdio: 'pipe' });
  execSync('git push origin HEAD', { cwd: repoDir, stdio: 'pipe' });

  // Make refs/remotes/origin/HEAD point at main/master
  const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: repoDir, encoding: 'utf8', stdio: 'pipe' }).trim();
  try {
    execSync(`git remote set-head origin ${branch}`, { cwd: repoDir, stdio: 'pipe' });
  } catch {}

  return { repoDir, originDir };
}

// Makes a full wksp project directory structure (no real git repos registered).
function makeProject(name = 'test-project') {
  const projectDir = makeTempDir(`wksp-project-${name}`);
  fs.mkdirSync(path.join(projectDir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.wksp'), JSON.stringify({ name }) + '\n');
  fs.writeFileSync(path.join(projectDir, 'repos.txt'), [
    '# Workspace repos',
    '# Format: <path> [--shared]',
    '',
  ].join('\n'));
  return projectDir;
}

function cleanup(...dirs) {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
}

// The 8.3 short name of an EXISTING directory ("C:\Users\RUNNER~1\...") — a second,
// equally valid name Windows gives any path component over 8 characters or containing
// a space, and the one %TEMP% is served under on the GitHub Windows runner.
//
// Returns null when this machine will not produce one, which callers must treat as
// "skip this test", never as a failure: 8.3 generation is a per-volume NTFS setting
// (NtfsDisable8dot3NameCreation) that is routinely switched off, and it only applies
// to Windows in the first place.
//
// Deliberately NOT used by makeTempDir — the point of these tests is that production
// code copes with both spellings, so the suite must be able to hand it a short one.
function shortPathOf(dir) {
  if (process.platform !== 'win32') return null;
  let out;
  try {
    // cmd's %~sI is the only shell-level way to ask for the short form.
    out = execSync(`for %I in ("${dir}") do @echo %~sI`,
      { shell: 'cmd.exe', encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
  if (!out) return null;
  // Identical means the volume generated no alias — nothing to test with.
  return out.toLowerCase() === path.resolve(dir).toLowerCase() ? null : out;
}

module.exports = { makeTempDir, makeGitRepo, makeGitRepoWithRemote, makeProject, cleanup, shortPathOf };
