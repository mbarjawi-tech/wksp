'use strict';
const fs   = require('fs');
const path = require('path');
const { open, close, ask, askRequired } = require('../prompts');
const config = require('../config');

function projectClaudeMd(name) {
  return `## Project: ${name}

## Cross-cutting conventions
<!-- fill in: backend, frontend, branch naming, test commands... -->

## Conflict policy
This file defines project-wide conventions. Tasks each have their own CLAUDE.md.
If you notice a contradiction between this file and a task's CLAUDE.md,
flag it immediately and ask for clarification before proceeding.
`;
}

async function run(args) {
  const nameArg = args[0];

  console.log('\n┌──────────────────────────────────────┐');
  console.log('│   wksp init                           │');
  console.log('└──────────────────────────────────────┘\n');

  open();
  const name       = nameArg || await askRequired('  Project name: ');
  const projectDir = path.resolve(process.cwd(), name);

  if (fs.existsSync(projectDir)) {
    console.error(`\n  Error: "${name}" already exists at ${projectDir}\n`);
    close(); process.exit(1);
  }

  const globalCfg = config.readGlobalConfig();
  if (!globalCfg.reposRoot) {
    console.log('\n  reposRoot is where GitHub repos get cloned (only needed for GitHub URLs).');
    console.log('  Skip with Enter and set later: wksp config set reposRoot <path>');
    const cr = await ask('  reposRoot (blank to skip): ');
    if (cr) {
      config.setGlobalConfig('reposRoot', cr);
      console.log(`  ✓  ~/.wksp: reposRoot = ${cr}`);
    }
  }
  close();

  fs.mkdirSync(path.join(projectDir, 'tasks'), { recursive: true });
  console.log(`\n  Creating project "${name}" ...\n`);
  console.log(`  ✓  ${name}/`);
  console.log(`  ✓  ${name}/tasks/`);

  config.writeProjectConfig(projectDir, { name });
  console.log(`  ✓  .wksp`);

  fs.writeFileSync(path.join(projectDir, 'repos.txt'), [
    '# Workspace repos',
    '# Format: <path> [--shared]',
    '# --shared: use original path in every task, never create a worktree',
    '',
  ].join('\n'));
  console.log(`  ✓  repos.txt`);

  fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), projectClaudeMd(name));
  console.log(`  ✓  CLAUDE.md`);

  fs.writeFileSync(path.join(projectDir, '.gitignore'), '.claude/settings.local.json\n');
  console.log(`  ✓  .gitignore`);

  console.log(`
  ──────────────────────────────────────────
  Done! Next steps:

    cd ${name}
    wksp repo <path-or-github-url>
    wksp task <task-id>
  ──────────────────────────────────────────
`);
}

module.exports = { run };
