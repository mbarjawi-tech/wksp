'use strict';
const { spawnSync } = require('child_process');

// Spawn a provider's launch command as a shell string, inheriting stdio so the
// AI tool takes over the terminal. Shared by the claude and custom providers so
// the shell-selection logic lives in exactly one place.
//
// Uses bash (via PATH lookup) in Unix-like environments — detected by SHELL being
// set — and falls back to the system default (cmd.exe on Windows) everywhere else.
// `extraEnv` is merged over process.env (claude needs a CLAUDE_CODE_* flag; custom
// providers pass nothing). Returns the spawnSync result; callers decide the exit.
function spawnShell(cmdString, cwd, extraEnv = {}) {
  const shell = process.env.SHELL ? 'bash' : true;
  const env   = { ...process.env, ...extraEnv };
  return spawnSync(cmdString, [], { stdio: 'inherit', cwd, shell, env });
}

module.exports = { spawnShell };
