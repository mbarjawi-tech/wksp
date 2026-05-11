'use strict';
const { spawnSync } = require('child_process');
const { toPosix } = require('./paths');

function launch(dirs, cwd) {
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
