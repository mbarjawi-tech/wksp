'use strict';
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const config      = require('../config');
const git         = require('../git');
const { readRepos }          = require('../repos');
const { readTaskSets }       = require('../task-state');
const { discoverWorktrees }  = require('../worktrees');
const { archivedTaskDir, liveTaskDir } = require('../archive');
const { getProvider } = require('../providers');
const { open, close, confirm } = require('../prompts');
const { BUNDLE_VERSION, writeBundle, defaultBundleFileName } = require('../bundle');

async function run(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
  wksp export <task-id> [--out <file>] [--with-session]

  Bundle a task for handoff to a teammate or a new machine.

  Options:
    --out <file>      Output path (default: ./<project>--<task-id>.wksp-bundle)
    --with-session    Include the Claude session transcript
`);
    process.exit(0);
  }

  const withSession = args.includes('--with-session');
  const outIdx      = args.indexOf('--out');
  const outArg      = outIdx !== -1 ? args[outIdx + 1] : null;
  const posArgs     = args.filter(a => !a.startsWith('-'));
  const taskId      = posArgs[0];

  if (!taskId) {
    console.error('  Usage: wksp export <task-id> [--out <file>] [--with-session]');
    process.exit(1);
  }

  // Find project
  const projectDir = config.findProjectDir();
  if (!projectDir) {
    console.error('  Error: not inside a wksp project.');
    process.exit(1);
  }
  const { name: projectName = path.basename(projectDir) } = config.readProjectConfig(projectDir);

  // Check task exists and is not archived
  const taskDir     = liveTaskDir(projectDir, taskId);
  const archivedDir = archivedTaskDir(projectDir, taskId);

  if (fs.existsSync(archivedDir)) {
    console.error(`  Error: "${taskId}" is archived. Unarchive it first, then export.`);
    process.exit(1);
  }
  if (!fs.existsSync(taskDir)) {
    console.error(`  Error: task "${taskId}" not found in this project.`);
    process.exit(1);
  }

  // Read project repos and task state
  const allRepos    = readRepos(projectDir);
  const { taskSharedSet, taskExcludedSet } = readTaskSets(taskDir);
  const wts         = discoverWorktrees(taskDir);
  const wtByFolder  = new Map(wts.map(wt => [wt.folderName, wt]));

  // Build project-level repos array
  const bundleRepos = allRepos.map(repo => {
    const remoteUrl = git.getRemoteUrl(repo.normalized);
    return {
      folderName:     repo.folderName,
      remoteUrl,
      localPath:      repo.normalized,
      isSharedRepo:   repo.shared,
      isOptionalRepo: repo.optional,   // additive field — no bundle version bump
      hasRemote:      remoteUrl !== null,
    };
  });

  // Check for duplicate folderNames (shouldn't happen, but spec calls for it)
  const folderNames = bundleRepos.map(r => r.folderName);
  const dupName = folderNames.find((n, i) => folderNames.indexOf(n) !== i);
  if (dupName) {
    console.error(`  Error: Duplicate folder name "${dupName}" — cannot export.`);
    process.exit(1);
  }

  // Collect errors and warnings
  const errors   = [];
  const warnings = [];

  // Build task repos array, checking worktrees
  const taskRepos = [];
  for (const repo of allRepos) {
    const { folderName } = repo;

    if (taskExcludedSet.has(folderName)) {
      taskRepos.push({ folderName, branch: null, baseBranch: null, tipSha: null, remoteUrl: null, status: 'excluded' });
      continue;
    }

    const isShared = repo.shared || taskSharedSet.has(folderName);
    if (isShared) {
      const remoteUrl = git.getRemoteUrl(repo.normalized);
      const branch    = git.currentBranch(repo.normalized);
      const tipSha    = git.revParse(repo.normalized, 'HEAD');
      taskRepos.push({ folderName, branch, baseBranch: null, tipSha, remoteUrl, status: 'shared' });
      continue;
    }

    // Worktree repo
    const wt = wtByFolder.get(folderName);
    if (!wt || wt.corrupted) {
      warnings.push(`  ⚠  "${folderName}" worktree is missing or corrupted — skipping branch checks.`);
      taskRepos.push({ folderName, branch: null, baseBranch: null, tipSha: null, remoteUrl: null, status: 'worktree' });
      continue;
    }

    const branch     = wt.currentBranch;
    const tipSha     = git.revParse(wt.worktreeDir, 'HEAD');
    const remoteUrl  = git.getRemoteUrl(repo.normalized);
    const baseBranch = git.defaultBranch(repo.normalized);

    // Check uncommitted changes
    const changed = git.getChangedFiles(wt.worktreeDir);
    if (changed) {
      errors.push(`  Error: ${folderName} has uncommitted changes. Commit or stash before exporting.`);
    }

    // Check unpushed commits (only for repos with a remote)
    if (remoteUrl && branch) {
      const unpushed = git.countUnpushed(wt.worktreeDir, branch);
      if (unpushed === null) {
        errors.push(
          `  Error: ${folderName} / ${branch} has not been pushed to origin.\n` +
          `         Push before exporting so the importer can fetch the branch.`
        );
      } else if (unpushed > 0) {
        errors.push(
          `  Error: ${folderName} / ${branch} has ${unpushed} unpushed commit(s).\n` +
          `         Push before exporting so the importer can fetch the branch.`
        );
      }
    }

    taskRepos.push({ folderName, branch, baseBranch, tipSha, remoteUrl, status: 'worktree' });
  }

  // Warn about repos with no remote
  for (const r of bundleRepos) {
    if (!r.hasRemote) {
      warnings.push(
        `  ⚠  "${r.folderName}" has no git remote. The importer will need to\n` +
        `     provide a local path for this repo manually.`
      );
    }
  }

  // Print warnings
  for (const w of warnings) console.log(w);

  // Abort on errors
  if (errors.length > 0) {
    for (const e of errors) console.error('\n' + e);
    process.exit(1);
  }

  // Capture session
  let session = null;
  if (withSession) {
    const provider    = getProvider(projectDir);
    const sessions    = provider.sessions;
    const lastSession = sessions ? sessions.findLast(taskDir) : null;
    const jsonl       = lastSession ? sessions.readTranscript(taskDir, lastSession.id) : null;
    if (!lastSession || jsonl === null) {
      console.log(`  ⚠  No Claude session found for ${taskId} — exporting without session.`);
    } else {
      const sizeMB = Buffer.byteLength(jsonl, 'utf8') / (1024 * 1024);
      if (sizeMB > 10) {
        console.log(`  ⚠  Session file is ${sizeMB.toFixed(1)} MB.`);
        open();
        const ok = await confirm('  Include it anyway?');
        close();
        if (!ok) { console.log('  Session not included.'); }
        else { session = { id: lastSession.id, jsonl, provider: provider.name }; }
      } else {
        session = { id: lastSession.id, jsonl, provider: provider.name };
        console.log(`  Session: ${lastSession.id}.jsonl  (${sizeMB.toFixed(2)} MB)`);
      }
    }
  }

  // Read the task instruction file and WORKLOG.md. AGENTS.md is canonical; fall
  // back to CLAUDE.md for tasks that predate the v4 conversion. `claudeMd` keeps
  // carrying the same meaningful content so older wksp versions can still import
  // the bundle (they would otherwise restore a CLAUDE.md that is just the
  // "@AGENTS.md" include line). `agentsMd` is additive — no BUNDLE_VERSION bump.
  const agentsMdPath = path.join(taskDir, 'AGENTS.md');
  const agentsMd     = fs.existsSync(agentsMdPath) ? fs.readFileSync(agentsMdPath, 'utf8') : '';
  const claudeMdPath = path.join(taskDir, 'CLAUDE.md');
  const claudeMd     = agentsMd ||
    (fs.existsSync(claudeMdPath) ? fs.readFileSync(claudeMdPath, 'utf8') : '');
  const worklogPath  = path.join(taskDir, 'WORKLOG.md');
  const worklogMd    = fs.existsSync(worklogPath) ? fs.readFileSync(worklogPath, 'utf8') : '';

  // Build bundle (reuse taskSharedSet/taskExcludedSet already read above)
  const bundle = {
    bundleVersion: BUNDLE_VERSION,
    exportedAt:    new Date().toISOString(),
    exportedBy:    { machine: os.hostname() },
    project: {
      name:          projectName,
      schemaVersion: config.readProjectConfig(projectDir).schemaVersion || 0,
    },
    repos: bundleRepos,
    task: {
      id:       taskId,
      agentsMd,
      claudeMd,
      worklogMd,
      shared:   [...taskSharedSet],
      excluded: [...taskExcludedSet],
      repos:    taskRepos,
    },
    session,
  };

  // Determine output path
  const outFile = outArg
    ? path.resolve(outArg)
    : path.join(process.cwd(), defaultBundleFileName(projectName, taskId));

  writeBundle(outFile, bundle);

  const sizeKB = (fs.statSync(outFile).size / 1024).toFixed(0);
  console.log(`\n  ✓  ${taskId} exported → ${path.basename(outFile)}  (${sizeKB} KB)`);
  console.log(`     Share this file. They run: wksp import ${path.basename(outFile)}\n`);
}

module.exports = { run };
