'use strict';
const fs   = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { open, close, ask, askRequired } = require('../prompts');
const config = require('../config');
const { projectAgentsMd, planningMd, writeInstructionFiles, AGENTS_FILE, CLAUDE_FILE } = require('../templates');

// Best-effort check for the `claude` CLI on PATH. Must never break init — a thrown
// spawn error (offline, missing shell util) is treated as "not found".
function claudeOnPath() {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const res = spawnSync(cmd, ['claude'], { stdio: 'ignore' });
    return res.status === 0;
  } catch {
    return false;
  }
}

async function run(args) {
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

  config.writeProjectConfig(projectDir, { name, schemaVersion: config.CURRENT_SCHEMA_VERSION });
  console.log(`  ✓  .wksp`);

  fs.writeFileSync(path.join(projectDir, 'repos.txt'), [
    '# Workspace repos',
    '# Format: <path> [--shared]',
    '# --shared: use original path in every task, never create a worktree',
    '',
  ].join('\n'));
  console.log(`  ✓  repos.txt`);

  writeInstructionFiles(projectDir, projectAgentsMd(name));
  console.log(`  ✓  ${AGENTS_FILE}  (+ ${CLAUDE_FILE} include)`);

  fs.writeFileSync(path.join(projectDir, 'PLANNING.md'), planningMd(name));
  console.log(`  ✓  PLANNING.md  (backlog + open decisions — the root is the planning hub)`);

  fs.writeFileSync(path.join(projectDir, 'WORKLOG.md'), `# Work Log: ${name}\n`);
  console.log(`  ✓  WORKLOG.md`);

  fs.writeFileSync(path.join(projectDir, '.gitignore'), '.claude/settings.local.json\n');
  console.log(`  ✓  .gitignore`);

  // Auto-detect the AI tool. If no aiProvider is configured (global or project)
  // and claude isn't on PATH, pin the project to the `none` provider so launches
  // fail soft (print the task path) instead of dying on a cryptic spawn error.
  // claude present → leave it absent (absent already means claude).
  const effectiveCfg = config.readConfig(projectDir);
  if (!effectiveCfg.aiProvider && !claudeOnPath()) {
    config.setProjectConfig(projectDir, 'aiProvider', 'none');
    console.log(`\n  No supported AI tool detected — launches will just print the task path.`);
    console.log(`  Set aiProvider or add a custom provider to change this (see: wksp providers).`);
  }

  console.log(`
  ──────────────────────────────────────────
  Done! Next steps:

    cd ${name}
    wksp repo add <path-or-github-url>
    wksp task create <task-id>

  Plan at the project root anytime with:  wksp start
  ──────────────────────────────────────────
`);
}

module.exports = { run };
