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

module.exports = { makeTempDir, makeGitRepo, makeGitRepoWithRemote, makeProject, cleanup };
