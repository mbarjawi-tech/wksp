#!/usr/bin/env node
'use strict';

const [,, cmd, ...rest] = process.argv;

if (cmd === '--version' || cmd === '-v') {
  console.log(require('../package.json').version);
  process.exit(0);
}

const COMMANDS = {
  init:    () => require('../lib/commands/init'),
  repo:    () => require('../lib/commands/repo'),
  task:    () => require('../lib/commands/task'),
  cleanup: () => require('../lib/commands/cleanup'),
  list:    () => require('../lib/commands/list'),
  status:  () => require('../lib/commands/status'),
  delete:  () => require('../lib/commands/delete'),
  config:  () => require('../lib/commands/configCmd'),
  migrate: () => require('../lib/commands/migrate'),
};

function printHelp() {
  console.log(`
  wksp — workspace CLI for Claude Code

  Commands:
    wksp init [name]                 Create a new project
    wksp repo add <path-or-url>      Register a repo
      --shared                         Never create a worktree; always use original path
    wksp repo remove <path-or-url>   Remove a repo from repos.txt
    wksp task create <id>            Create a new task workspace
    wksp task resume <id>            Resume an existing task
    wksp task delete <id>            Tear down worktrees and delete task folder
    wksp task rename <id> <new-id>   Rename a task in place
    wksp task archive <id>           Archive the task
    wksp task unarchive <id>         Restore an archived task
    wksp task repo <id> [repo] [mode]  Switch a repo's mode (share/worktree/exclude)
    wksp cleanup --stale <path>      Prune stale worktree refs from a base repo
      -r                               Scan first-level subdirectories too
    wksp list [--archived] [--all]   List tasks in current project
    wksp status [<task-id>]          Show task repo/branch status
    wksp delete                      Delete entire project (destructive, requires confirmation)
    wksp migrate [--dry-run]         Apply pending project schema migrations
    wksp config set <key> <value>    Set a config value
      --global                         Write to global config (~/.wksp)
    wksp config get [key]            Show config (merged global + project)
      --global                         Show only global config

  Config keys:
    reposRoot    Directory where GitHub repos are cloned (only needed for GitHub URLs)
    autoResume   true/false — auto-resume last Claude session on wksp task (default: true)

  Debug:
    WKSP_DEBUG=1   Print full stack traces on errors

  Version:
    wksp --version
`);
}

if (!cmd || cmd === '--help' || cmd === '-h') { printHelp(); process.exit(0); }

const loader = COMMANDS[cmd];
if (!loader) {
  console.error(`  Error: unknown command "${cmd}"`);
  printHelp();
  process.exit(1);
}

// Warn if the project's schema is outdated (skip for migrate itself and global-only commands).
if (cmd !== 'migrate' && cmd !== 'init') {
  const config = require('../lib/config');
  const projectDir = config.findProjectDir();
  if (projectDir) {
    const { schemaVersion = 0 } = config.readProjectConfig(projectDir);
    if (schemaVersion < config.CURRENT_SCHEMA_VERSION) {
      console.warn('\n  ⚠  This project was created with an older version of wksp.');
      console.warn('     Run `wksp migrate` to update it.\n');
    }
  }
}

loader().run(rest).catch(err => {
  console.error('\n  Fatal:', err.message || err);
  if (process.env.WKSP_DEBUG) console.error(err.stack);
  process.exit(1);
});
