'use strict';
const fs   = require('fs');
const path = require('path');
const { open, close, ask, askRequired } = require('../prompts');
const config = require('../config');
const { projectClaudeMd } = require('../templates');
const { scaffoldHub } = require('../hub');

async function run(args) {
  const noHub   = args.includes('--no-hub');
  const nameArg = args.find(a => !a.startsWith('-'));

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
    console.log('\n  reposRoot is the directory where GitHub repos will be cloned.');
    console.log('  Only needed if you plan to register repos by GitHub URL (e.g. github.com/org/repo).');
    console.log('  Local paths (e.g. /c/dev/myrepo) don\'t need this — press Enter to skip.');
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

  if (!noHub) {
    scaffoldHub(projectDir, name);
    console.log(`  ✓  ${name}/tasks/hub/  (planning task, no worktree)`);
  }

  config.writeProjectConfig(projectDir, { name, schemaVersion: config.CURRENT_SCHEMA_VERSION });
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

  const hubLine = noHub
    ? 'Add a planning hub anytime with:    wksp task create hub'
    : 'Project planning lives in the hub:  wksp task resume hub';

  console.log(`
  ──────────────────────────────────────────
  Done! Next steps:

    cd ${name}
    wksp repo add <path-or-github-url>
    wksp task create <task-id>

  ${hubLine}
  ──────────────────────────────────────────
`);
}

module.exports = { run };
