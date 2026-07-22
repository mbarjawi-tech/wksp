'use strict';

// The `none` provider: a baseline-tier provider that launches no AI tool. Used
// when the user has no supported tool installed (auto-selected at `wksp init`) or
// explicitly sets `aiProvider: none`. It has no `sessions` capability, so every
// session feature degrades through the same null guards a custom provider hits.
//
// `instructionFile` is 'AGENTS.md' — the canonical file scaffolding writes, which
// remains valuable as plain conventions docs regardless of which tool reads it.

function launch(dirs, cwd) {
  console.log(`\n  Task ready at ${cwd}`);
  console.log(`  No AI tool is configured (aiProvider: none).`);
  console.log(`  Open the folder or the .code-workspace file yourself, or enable a tool:`);
  console.log(`    wksp config set aiProvider <name> --global   (or add a custom provider — see wksp providers)\n`);
  process.exit(0);
}

module.exports = {
  name: 'none',
  instructionFile: 'AGENTS.md',
  launch,
};
