'use strict';
const fs   = require('fs');
const path = require('path');
const config = require('../config');
const { discoverWorktrees } = require('../worktrees');

async function run() {
  const projectDir = config.findProjectDir();
  if (!projectDir) { console.error('  Error: not inside a wksp project'); process.exit(1); }

  const projectCfg  = config.readProjectConfig(projectDir);
  const projectName = projectCfg.name || path.basename(projectDir);
  const tasksDir    = path.join(projectDir, 'tasks');

  if (!fs.existsSync(tasksDir)) { console.log('\n  No tasks yet. Run: wksp task <id>\n'); return; }

  const taskNames = fs.readdirSync(tasksDir, { withFileTypes: true })
    .filter(e => e.isDirectory()).map(e => e.name);

  if (!taskNames.length) { console.log('\n  No tasks yet. Run: wksp task <id>\n'); return; }

  console.log(`\n  Project: ${projectName}\n`);
  console.log(`  ${'Task'.padEnd(32)} Worktrees`);
  console.log(`  ${'─'.repeat(32)} ${'─'.repeat(9)}`);

  for (const name of taskNames.sort()) {
    const wts = discoverWorktrees(path.join(tasksDir, name));
    console.log(`  ${name.padEnd(32)} ${wts.length}`);
  }
  console.log();
}

module.exports = { run };
