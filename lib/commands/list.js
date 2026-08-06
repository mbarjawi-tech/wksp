'use strict';
const fs   = require('fs');
const path = require('path');
const config = require('../config');
const { discoverWorktrees } = require('../worktrees');
const archive = require('../archive');
const { printJson, failJson } = require('../out');

function listDir(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name);
}

// A stranded probe (a worktree an interrupted run left renamed aside) is reported by
// discoverWorktrees so it is never invisible — but it is NOT a live worktree, and its
// `worktreeDir` doesn't exist while it sits aside. Counting it as one inflates every
// number this command prints, so it is split out and named for what it is.
function splitWorktrees(wts) {
  return {
    live:     wts.filter(w => !w.strandedProbe),
    stranded: wts.filter(w =>  w.strandedProbe),
  };
}

// One rendering of that fact, used by both views: `--all` spells the unit out, the default
// table has a "Worktrees" header instead, but the "renamed aside" suffix reads identically.
function strandedSuffix(stranded) {
  return stranded.length ? ` (+${stranded.length} renamed aside)` : '';
}

function worktreeCount(wts) {
  const { live, stranded } = splitWorktrees(wts);
  return `${live.length} worktree${live.length === 1 ? '' : 's'}${strandedSuffix(stranded)}`;
}

function formatDate(iso) {
  if (!iso) return 'unknown';
  try { return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
  catch { return 'unknown'; }
}

// Machine-readable task inventory: the first thing an agent needs to orient itself
// in a project it didn't create. Honors --archived / --all like the text output.
function printJsonList(projectName, projectDir, liveNames, archivedNames, { showLive, showArchived }) {
  const tasks = [];
  if (showLive) {
    for (const id of liveNames) {
      const taskDir = path.join(projectDir, 'tasks', id);
      let worktrees = [];
      try { worktrees = discoverWorktrees(taskDir); } catch {}
      const { live, stranded } = splitWorktrees(worktrees);
      const task = {
        id, status: 'live',
        dir: taskDir.replace(/\\/g, '/'),
        worktrees: live.map(w => ({ name: w.folderName, branch: w.currentBranch || null })),
      };
      // Additive, and only when there is something to say: an agent reading this needs to
      // know a worktree is sitting aside, but it must not appear in `worktrees` as though
      // it were live at a path that currently does not exist.
      if (stranded.length) {
        task.strandedProbes = stranded.map(w => ({ name: w.folderName, at: w.strandedPath.replace(/\\/g, '/') }));
      }
      tasks.push(task);
    }
  }
  if (showArchived) {
    for (const id of archivedNames) {
      const m = archive.readManifest(archive.archivedTaskDir(projectDir, id));
      tasks.push({
        id, status: 'archived',
        dir: archive.archivedTaskDir(projectDir, id).replace(/\\/g, '/'),
        archivedAt: (m && m.archivedAt) || null,
        reason:     (m && m.reason) || null,
      });
    }
  }
  printJson({
    ok: true,
    project: { name: projectName, dir: projectDir.replace(/\\/g, '/') },
    tasks,
  });
}

async function run(args) {
  const flags = new Set(args.filter(a => a.startsWith('--')));
  const showArchived = flags.has('--archived') || flags.has('--all');
  const showLive     = !flags.has('--archived') || flags.has('--all');
  const asJson       = flags.has('--json');

  const projectDir = config.findProjectDir();
  if (!projectDir) {
    if (asJson) failJson('not inside a wksp project');
    console.error('  Error: not inside a wksp project');
    config.printNoProjectHint();
    process.exit(1);
  }

  const projectCfg  = config.readProjectConfig(projectDir);
  const projectName = projectCfg.name || path.basename(projectDir);

  const liveNames     = listDir(path.join(projectDir, 'tasks')).sort();
  const archivedNames = listDir(path.join(projectDir, archive.ARCHIVED_DIR)).sort();

  if (asJson) return printJsonList(projectName, projectDir, liveNames, archivedNames, { showLive, showArchived });

  if (!liveNames.length && !archivedNames.length) {
    console.log('\n  No tasks yet. Run: wksp task <id>\n'); return;
  }

  console.log(`\n  Project: ${projectName}\n`);

  if (flags.has('--all')) {
    const nameW = Math.max(...[...liveNames, ...archivedNames].map(n => n.length), 4) + 2;
    console.log(`  ${'Task'.padEnd(nameW)}${'Status'.padEnd(12)}Detail`);
    console.log(`  ${'─'.repeat(nameW - 1)} ${'─'.repeat(11)} ${'─'.repeat(20)}`);
    for (const name of liveNames) {
      const wts = discoverWorktrees(path.join(projectDir, 'tasks', name));
      console.log(`  ${name.padEnd(nameW)}${'live'.padEnd(12)}${worktreeCount(wts)}`);
    }
    for (const name of archivedNames) {
      const m = archive.readManifest(archive.archivedTaskDir(projectDir, name));
      console.log(`  ${name.padEnd(nameW)}${'archived'.padEnd(12)}archived ${formatDate(m && m.archivedAt)}`);
    }
    console.log('');
    return;
  }

  if (showLive) {
    if (!liveNames.length) {
      console.log('  No live tasks.');
    } else {
      console.log(`  ${'Task'.padEnd(32)} Worktrees`);
      console.log(`  ${'─'.repeat(32)} ${'─'.repeat(9)}`);
      for (const name of liveNames) {
        const wts = discoverWorktrees(path.join(projectDir, 'tasks', name));
        const { live, stranded } = splitWorktrees(wts);
        console.log(`  ${name.padEnd(32)} ${live.length}${strandedSuffix(stranded)}`);
      }
    }
    if (archivedNames.length) {
      console.log(`\n  ${archivedNames.length} archived task${archivedNames.length === 1 ? '' : 's'} — run \`wksp list --archived\``);
    }
    console.log('');
    return;
  }

  // --archived only
  if (!archivedNames.length) {
    console.log('  No archived tasks.\n'); return;
  }
  console.log(`  ${'Task'.padEnd(32)} Archived`);
  console.log(`  ${'─'.repeat(32)} ${'─'.repeat(12)}`);
  for (const name of archivedNames) {
    const m = archive.readManifest(archive.archivedTaskDir(projectDir, name));
    console.log(`  ${name.padEnd(32)} ${formatDate(m && m.archivedAt)}`);
  }
  console.log('');
}

module.exports = { run };
