'use strict';
const { spawnSync } = require('child_process');
const { toPosix }  = require('./paths');

function launch(dirs, cwd) {
  // readline.close() pauses stdin; resume before handing off so Claude gets a live terminal
  process.stdin.resume();
  const parts = ['claude'];
  for (const dir of dirs) {
    const p = toPosix(dir);
    parts.push(`--add-dir "${p}"`);
  }
  return spawnSync(parts.join(' '), [], { stdio: 'inherit', cwd, shell: true });
}

module.exports = { launch };
