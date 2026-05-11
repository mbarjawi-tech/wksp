'use strict';
const { spawnSync } = require('child_process');
const { toPosix }  = require('./paths');

function launch(dirs, cwd) {
  // readline leaves stdin paused and possibly in raw mode; fully restore before handing off
  process.stdin.resume();
  if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(false);
  const parts = ['claude'];
  for (const dir of dirs) {
    const p = toPosix(dir);
    parts.push(`--add-dir "${p}"`);
  }
  const result = spawnSync(parts.join(' '), [], { stdio: 'inherit', cwd, shell: true });
  process.exit(result.status ?? 0);
}

module.exports = { launch };
