'use strict';
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { toPosix } = require('./paths');

// Encode a Windows path to Claude's project-directory naming convention:
// C:\workspaces\monarch\tasks\map-revamp → C--workspaces-monarch-tasks-map-revamp
function encodeProjectPath(dir) {
  return path.resolve(dir)
    .replace(/^([A-Za-z]):[\\\/]/, (_, d) => `${d.toUpperCase()}--`)
    .replace(/[\\\/]/g, '-');
}

function findLastSession(taskDir) {
  const dir = path.join(os.homedir(), '.claude', 'projects', encodeProjectPath(taskDir));
  if (!fs.existsSync(dir)) return null;
  const latest = fs.readdirSync(dir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => {
      try {
        const stat = fs.statSync(path.join(dir, f));
        return stat.isFile() ? { id: f.slice(0, -6), mtime: stat.mtimeMs } : null;
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime)[0];
  return latest || null;
}

function launch(dirs, cwd, resumeId = null) {
  const parts = ['claude'];
  if (resumeId) parts.push(`--resume ${resumeId}`);
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

module.exports = { launch, findLastSession };
