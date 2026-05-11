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
  const env = { ...process.env, CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1' };
  const result = spawnSync(parts.join(' '), [], { stdio: 'inherit', cwd, shell, env });
  process.exit(result.status ?? 0);
}

module.exports = { launch };
