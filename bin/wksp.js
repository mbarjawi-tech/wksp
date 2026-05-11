#!/usr/bin/env node
'use strict';

const [,, cmd, ...rest] = process.argv;

const COMMANDS = {
  init:    () => require('../lib/commands/init'),
  repo:    () => require('../lib/commands/repo'),
  task:    () => require('../lib/commands/task'),
  cleanup: () => require('../lib/commands/cleanup'),
  list:    () => require('../lib/commands/list'),
  status:  () => require('../lib/commands/status'),
  delete:  () => require('../lib/commands/delete'),
  config:  () => require('../lib/commands/configCmd'),
};

function printHelp() {
  console.log(`
  wksp — workspace CLI for Claude Code

  Commands:
    wksp init [name]                 Create a new project
    wksp repo <url-or-path>          Register a repo
      --shared                         Never create a worktree; always use original path
      --remove                         Remove from repos.txt
    wksp task <id>                       Create or resume a task
      --del                              Tear down worktrees and delete task folder
      --to-shared <repo>                 Remove worktree for a repo; use shared path instead (this task only)
      --to-worktree <repo>               Create a worktree for a repo that was shared in this task
    wksp cleanup --stale <path>        Prune stale worktree refs from a base repo
      -r                                 Scan first-level subdirectories too
    wksp list                          List all tasks in current project
    wksp status                        Show current task repo/branch status
    wksp delete                        Delete entire project (destructive, requires confirmation)
    wksp config set <key> <value>      Set a global config value (e.g. reposRoot)
    wksp config get [key]              Show global config
`);
}

if (!cmd || cmd === '--help' || cmd === '-h') { printHelp(); process.exit(0); }

const loader = COMMANDS[cmd];
if (!loader) {
  console.error(`  Error: unknown command "${cmd}"`);
  printHelp();
  process.exit(1);
}

loader().run(rest).catch(err => {
  console.error('\n  Fatal:', err.message || err);
  if (process.env.WKSP_DEBUG) console.error(err.stack);
  process.exit(1);
});
