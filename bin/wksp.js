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
};

function printHelp() {
  console.log(`
  wksp — workspace CLI for Claude Code

  Commands:
    wksp init [name]                 Create a new project
    wksp repo <url-or-path>          Register a repo
      --shared                         Never create a worktree; always use original path
      --remove                         Remove from repos.txt
    wksp task <id>                   Create or resume a task
      --del                            Tear down worktrees and delete task folder
      --to-shared <repo>               Use shared path for a repo in this task
      --to-worktree <repo>             Create a worktree for a repo that was shared in this task
      --to-exclude <repo>              Exclude a repo from this task
      --rename <new-id>                Rename the task
      --archive                        Archive the task
      --unarchive                      Restore an archived task
    wksp cleanup --stale <path>      Prune stale worktree refs from a base repo
      -r                               Scan first-level subdirectories too
    wksp list [--archived] [--all]   List tasks in current project
    wksp status [<task-id>]          Show task repo/branch status
    wksp delete                      Delete entire project (destructive, requires confirmation)
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

loader().run(rest).catch(err => {
  console.error('\n  Fatal:', err.message || err);
  if (process.env.WKSP_DEBUG) console.error(err.stack);
  process.exit(1);
});
