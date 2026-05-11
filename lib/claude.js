'use strict';
const { execSync, spawnSync } = require('child_process');
const { toPosix } = require('./paths');

function launch(dirs, cwd) {
  process.stdin.resume();
  if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(false);

  // stty sane resets echo + line-buffering flags that readline leaves in a bad state.
  // process.env.SHELL is a UNIX path (/usr/bin/bash) that Windows Node.js can't
  // resolve — use the bare name 'bash' so it's looked up via the Windows PATH,
  // where Git for Windows registers bash.exe. Only attempt when SHELL is set (i.e.
  // we're inside a Unix-like shell environment such as MINGW64).
  if (process.stdin.isTTY && process.env.SHELL) {
    try { execSync('stty sane', { stdio: 'inherit', shell: 'bash' }); } catch {}
  }

  const parts = ['claude'];
  for (const dir of dirs) {
    parts.push(`--add-dir "${toPosix(dir)}"`);
  }

  // Use bash (via PATH lookup) in Unix-like environments; fall back to the system
  // default (cmd.exe on Windows) everywhere else.
  const shell = process.env.SHELL ? 'bash' : true;
  const result = spawnSync(parts.join(' '), [], { stdio: 'inherit', cwd, shell });
  process.exit(result.status ?? 0);
}

module.exports = { launch };
