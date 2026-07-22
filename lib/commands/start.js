'use strict';
const fs   = require('fs');
const path = require('path');
const config = require('../config');
const { getProvider } = require('../providers');
const { open, close, confirm, confirmDefaultYes } = require('../prompts');
const { handleOpen, resolveTaskId } = require('./task');

// The unified entry point. No args → a planning session at the project root
// (the root is the planning hub; sessions key off the root path, so typing the
// AI tool's own command there lands in the same history). With an id →
// create/resume that task, with the same partial-name matching as `wksp task`.

async function startRoot(projectDir, projectName) {
  console.log(`\n  wksp · ${projectName} — planning session at the project root`);
  if (fs.existsSync(path.join(projectDir, 'PLANNING.md'))) {
    console.log('  Backlog and open decisions live in PLANNING.md.');
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

async function run(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
  wksp start [task-id]

  No arguments:  launch a planning session at the project root, resuming the
                 last root session. The root is the planning hub — PLANNING.md
                 holds the backlog and open decisions; tasks hold the code.
  With an id:    resume that task (partial names match, like wksp task resume),
                 or offer to create it when nothing matches.
`);
    process.exit(0);
  }

  const projectDir = config.findProjectDir();
  if (!projectDir) { console.error('  Error: not inside a wksp project'); process.exit(1); }
  const projectCfg  = config.readProjectConfig(projectDir);
  const projectName = projectCfg.name || path.basename(projectDir);

  const taskId = args.find(a => !a.startsWith('-'));
  if (!taskId) return startRoot(projectDir, projectName);

  // Exact or unique-partial live-task match → resume; ambiguous → picker;
  // no match → offer to create a task under exactly the typed name.
  const resolved = await resolveTaskId(projectDir, 'resume', taskId);
  if (!resolved) return; // picker cancelled / nothing to act on

  if (fs.existsSync(path.join(projectDir, 'tasks', resolved))) {
    return handleOpen(projectDir, projectName, resolved, 'resume');
  }

  open();
  const yes = await confirmDefaultYes(`  No task "${taskId}" yet — create it?`);
  close();
  if (!yes) { console.log('  Cancelled.'); return; }
  return handleOpen(projectDir, projectName, taskId, 'create');
}

module.exports = { run };
