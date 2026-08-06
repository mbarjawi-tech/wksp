'use strict';
const fs   = require('fs');
const path = require('path');
const config = require('../config');
const { getProvider } = require('../providers');
const { open, close, confirm, confirmDefaultYes } = require('../prompts');
const { handleOpen, resolveTaskId, parseOpenArgs } = require('./task');
const { withJsonStdout, failJson } = require('../out');
const { splitArgs } = require('../args');
const templates = require('../templates');

const OPEN_VALUE_FLAGS = ['--branch', '--base', '--shared', '--exclude', '--goal'];

// The unified entry point. No args → a planning session at the project root
// (the root is the planning hub; sessions key off the root path, so typing the
// AI tool's own command there lands in the same history). With an id →
// create/resume that task, with the same partial-name matching as `wksp task`.
//
// The headless flags of `wksp task create` work here too, so a planning session can
// spin a task up without leaving the root: `wksp start <id> --json` makes sure the
// task exists and prints its brief.

async function startRoot(projectDir, projectName) {
  console.log(`\n  wksp · ${projectName} — planning session at the project root`);
  if (fs.existsSync(path.join(projectDir, 'PLANNING.md'))) {
    console.log('  Backlog and open decisions live in PLANNING.md.');
  }
  if (fs.existsSync(path.join(projectDir, templates.GUIDANCE_FILE))) {
    console.log(`  Delegation, PR review, stacked PRs and settings: ${templates.GUIDANCE_FILE}.`);
  }

  const provider = getProvider(projectDir);
  const { autoResume = true } = config.readConfig(projectDir);
  const lastSession = provider.sessions ? provider.sessions.findLast(projectDir) : null;
  let resumeId = null;
  if (lastSession) {
    const date = new Date(lastSession.mtime).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    if (autoResume) {
      console.log(`\n  Resuming last session (${date})...`);
      resumeId = lastSession.id;
    } else {
      open();
      const yes = await confirm(`\n  Resume last session (${date})?`);
      close();
      if (yes) resumeId = lastSession.id;
    }
  }

  provider.launch([projectDir], projectDir, resumeId);
}

async function startTask(projectDir, projectName, taskId, opts) {
  // Exact or unique-partial live-task match → resume; ambiguous → picker (or an
  // error when we can't ask); no match → create a task under exactly the typed name.
  const resolved = await resolveTaskId(projectDir, 'resume', taskId, {
    nonInteractive: opts.yes,
    json:           opts.json,
  });
  if (!resolved) return; // picker cancelled / nothing to act on

  if (fs.existsSync(path.join(projectDir, 'tasks', resolved))) {
    return handleOpen(projectDir, projectName, resolved, 'resume', opts);
  }

  if (!opts.yes) {
    open();
    const yes = await confirmDefaultYes(`  No task "${taskId}" yet — create it?`);
    close();
    if (!yes) { console.log('  Cancelled.'); return; }
  }
  return handleOpen(projectDir, projectName, taskId, 'create', opts);
}

async function run(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
  wksp start [task-id]

  No arguments:  launch a planning session at the project root, resuming the
                 last root session. The root is the planning hub — PLANNING.md
                 holds the backlog and open decisions; tasks hold the code.
  With an id:    resume that task (partial names match, like wksp task resume),
                 or offer to create it when nothing matches.

  With an id, every headless flag of \`wksp task create\` applies — so a planning
  session can set a task up without leaving the root:

    wksp start <id> --json                  Ensure the task exists; print its brief as JSON
    wksp start <id> --no-launch             Same, as readable text
    wksp start <id> --goal "<one line>"     Record the task's goal while creating it

  See \`wksp task --help\` for the full flag set (--yes, --branch, --base,
  --shared, --exclude, --dry-run).
`);
    process.exit(0);
  }

  const projectDir = config.findProjectDir();
  if (!projectDir) {
    console.error('  Error: not inside a wksp project');
    config.printNoProjectHint();
    process.exit(1);
  }
  const projectCfg  = config.readProjectConfig(projectDir);
  const projectName = projectCfg.name || path.basename(projectDir);

  const normalized = args.map(a => (a === '-y' ? '--yes' : a));
  const opts = parseOpenArgs(normalized);
  // splitArgs consumes each value flag's argument, so the task id is whatever
  // positional is left — `wksp start --branch feat/x my-task` reads correctly.
  const { positionals } = splitArgs(normalized, OPEN_VALUE_FLAGS);
  const taskId = positionals.find(a => !a.startsWith('-'));

  if (!taskId) {
    // Root planning is a session, not a task — the headless flags have nothing to act on.
    if (opts.json) failJson('wksp start needs a task id when --json is used (root planning is a session, not a document)');
    return startRoot(projectDir, projectName);
  }

  if (opts.json) return withJsonStdout(() => startTask(projectDir, projectName, taskId, opts));
  return startTask(projectDir, projectName, taskId, opts);
}

module.exports = { run };
