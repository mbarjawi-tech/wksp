'use strict';
const { execSync, spawnSync } = require('child_process');
const { toPosix } = require('./paths');

function launch(dirs, cwd) {
  process.stdin.resume();
  if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(false);

  // Node's setRawMode(false) doesn't fully restore echo/mode flags in MinTTY/MINGW64.
  // stty sane resets all terminal attributes (echo, line buffering, special chars).
  // Only attempt if we have a proper shell (SHELL is set by bash/zsh, not cmd.exe).
  if (process.stdin.isTTY && process.env.SHELL) {
    try { execSync('stty sane', { stdio: 'inherit', shell: process.env.SHELL }); } catch {}
  }

  const parts = ['claude'];
  for (const dir of dirs) {
    parts.push(`--add-dir "${toPosix(dir)}"`);
  }

  // Use the user's shell (bash in MINGW64) rather than cmd.exe for a cleaner
  // terminal handoff — avoids the extra shell layer that can confuse TTY state.
  const shell = process.env.SHELL || true;
  const result = spawnSync(parts.join(' '), [], { stdio: 'inherit', cwd, shell });
  process.exit(result.status ?? 0);
}

module.exports = { launch };
