'use strict';
const { toPosix } = require('../paths');
const { spawnShell } = require('./spawn');

// Build a baseline-tier provider object from a declarative `customProviders` entry
// ({ command, instructionFile? }). No `sessions` capability — custom providers are
// launch-only, so resume always starts fresh (the resumeId argument is ignored).
//
// `command` is a template string with two optional placeholders, formatted exactly
// like the claude provider formats its --add-dir arguments (posix-style, quoted):
//   {dirs} → every context dir, space-joined, each double-quoted
//   {cwd}  → the task dir, double-quoted
// A missing placeholder just means that data isn't passed to the command.
function buildCustomProvider(name, entry) {
  const instructionFile = (entry && typeof entry.instructionFile === 'string')
    ? entry.instructionFile
    : 'CLAUDE.md';

  function launch(dirs, cwd) {
    const dirsStr = dirs.map(d => `"${toPosix(d)}"`).join(' ');
    const cmdString = entry.command
      .replace(/\{dirs\}/g, dirsStr)
      .replace(/\{cwd\}/g, `"${toPosix(cwd)}"`);
    const result = spawnShell(cmdString, cwd);
    process.exit(result.status ?? 0);
  }

  return { name, instructionFile, launch, builtin: false };
}

module.exports = { buildCustomProvider };
