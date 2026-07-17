'use strict';
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const config   = require('../config');
const git      = require('../git');
const { readRepos, addRepo } = require('../repos');
const { writeTaskSets }   = require('../task-state');
const { WORKTREES_DIR }   = require('../worktrees');
const { open, close, ask, confirm } = require('../prompts');
const { normalizePath, toPosix } = require('../paths');
const { encodeProjectPath }   = require('../claude');
const { readBundle }          = require('../bundle');
const { applyMigrations }     = require('./migrate');
const { projectClaudeMd }     = require('../templates');

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function printBundleSummary(bundle) {
  const { project, task, exportedAt, exportedBy, session } = bundle;
  const machine = exportedBy && exportedBy.machine ? `  (machine: ${exportedBy.machine})` : '';
  console.log(`\n  Bundle:   ${project.name} / ${task.id}`);
  console.log(`  Exported: ${formatDate(exportedAt)}${machine}`);
  const repoSummary = task.repos
    .filter(r => r.status !== 'excluded')
    .map(r => `${r.folderName} (${r.status}${r.branch ? ' · ' + r.branch : ''})`)
    .join(', ');
  console.log(`  Repos:    ${repoSummary || '(none)'}`);
  console.log(`  Session:  ${session ? session.id : 'not included'}\n`);
}

// Resolve a single repo for Mode 1 (new project).
// Returns { folderName, localPath, remoteUrl, isSharedRepo, toClone, skipped }
async function resolveRepoNew(bundleRepo, effectiveCfg) {
  const { folderName, remoteUrl, isSharedRepo, hasRemote } = bundleRepo;
  const { reposRoot } = effectiveCfg;

  if (hasRemote && reposRoot) {
    const candidate = path.join(normalizePath(reposRoot), folderName);
    if (fs.existsSync(candidate)) {
      // Verify it's the same remote
      const existingUrl = git.getRemoteUrl(candidate);
      if (existingUrl === remoteUrl) {
        console.log(`  ✓  ${folderName}  found at ${candidate}`);
        return { folderName, localPath: candidate, remoteUrl, isSharedRepo, toClone: false, skipped: false };
      }
    }
    // Clone into reposRoot
    if (!fs.existsSync(normalizePath(reposRoot))) {
      console.error(`  Error: reposRoot "${reposRoot}" does not exist. Create it or run: wksp config set reposRoot <path>`);
      process.exit(1);
    }
    const answer = await ask(`  Clone ${remoteUrl}\n  into ${candidate}? [Y/n]: `);
    if (answer.toLowerCase() === 'n') {
      console.log(`  ↳ Skipping ${folderName} — it will be excluded from the task.`);
      console.log(`    (Add it later with: wksp task repo <task-id> ${folderName} worktree)`);
      return { folderName, localPath: null, remoteUrl, isSharedRepo, toClone: false, skipped: true };
    }
    return { folderName, localPath: candidate, remoteUrl, isSharedRepo, toClone: true, skipped: false };
  }

  if (hasRemote && !reposRoot) {
    // Prompt A
    console.log(`\n  "${folderName}" — ${remoteUrl}`);
    console.log(`    [1] Clone into a folder (enter path)`);
    console.log(`    [2] Point to an existing local checkout`);
    console.log(`    [3] Skip this repo`);
    const choice = await ask('  Choice [1]: ') || '1';
    if (choice === '3') {
      console.log(`    ↳ ${folderName} will be excluded from the task.`);
      return { folderName, localPath: null, remoteUrl, isSharedRepo, toClone: false, skipped: true };
    }
    if (choice === '2') {
      const p = await ask('    Existing path: ');
      const resolved = normalizePath(p);
      if (!fs.existsSync(resolved)) {
        console.error(`    Error: path does not exist: ${resolved}`);
        process.exit(1);
      }
      return { folderName, localPath: resolved, remoteUrl, isSharedRepo, toClone: false, skipped: false };
    }
    // choice 1: clone
    const defaultPath = path.join(toPosix(process.cwd()), folderName);
    const clonePath   = normalizePath(await ask(`    Clone to [${defaultPath}]: `) || defaultPath);
    return { folderName, localPath: clonePath, remoteUrl, isSharedRepo, toClone: true, skipped: false };
  }

  // No remote — Prompt B
  console.log(`\n  "${folderName}" — no git remote`);
  console.log(`    This repo was local-only on the exporting machine. It cannot be cloned.`);
  console.log(`    [1] Point to an existing local checkout`);
  console.log(`    [2] Skip this repo`);
  const choice = await ask('  Choice [1]: ') || '1';
  if (choice === '2') {
    console.log(`    ↳ ${folderName} will be excluded from the task.`);
    return { folderName, localPath: null, remoteUrl: null, isSharedRepo, toClone: false, skipped: true };
  }
  const p = await ask('    Local path: ');
  const resolved = normalizePath(p);
  if (!fs.existsSync(resolved)) {
    console.error(`    Error: path does not exist: ${resolved}`);
    process.exit(1);
  }
  return { folderName, localPath: resolved, remoteUrl: null, isSharedRepo, toClone: false, skipped: false };
}

function printImportPlan(projectDir, bundle, resolvedRepos, mode) {
  const { task } = bundle;
  console.log('\n  ── Import plan ─────────────────────────────────────────');
  if (mode === 1) console.log(`  Create project:  ${projectDir}`);
  else            console.log(`  Add to project:  ${projectDir}`);

  const toRegister = resolvedRepos.filter(r => !r.skipped && !r.alreadyInProject);
  if (toRegister.length > 0) {
    console.log(`  Register repos:  ${toRegister.map(r => r.folderName).join(', ')}`);
  }
  const toClone = resolvedRepos.filter(r => r.toClone);
  if (toClone.length > 0) {
    for (const r of toClone) console.log(`  Clone:           ${r.folderName} → ${r.localPath}`);
  }

  console.log(`  Task:            ${task.id}`);
  for (const tr of task.repos) {
    if (tr.status === 'excluded') continue;
    const resolved = resolvedRepos.find(r => r.folderName === tr.folderName || r.originalFolderName === tr.folderName);
    if (resolved && resolved.skipped) {
      console.log(`    ${tr.folderName.padEnd(20)} (skipped → excluded)`);
    } else {
      const label = tr.status === 'shared' ? 'shared' : `worktree · ${tr.branch || '?'}`;
      console.log(`    ${tr.folderName.padEnd(20)} ${label}`);
    }
  }
  if (bundle.session) console.log(`  Session:         included`);
  else                console.log(`  Session:         not included`);
  console.log('  ────────────────────────────────────────────────────────');
}

// Write session file to ~/.claude/projects/<encoded>/<id>.jsonl
function placeSession(taskDir, session) {
  const encoded  = encodeProjectPath(taskDir);
  const sessDir  = path.join(os.homedir(), '.claude', 'projects', encoded);
  fs.mkdirSync(sessDir, { recursive: true });
  fs.writeFileSync(path.join(sessDir, `${session.id}.jsonl`), session.jsonl, 'utf8');
}

function writeWorkspaceFile(taskDir, projectName, taskId, resolvedRepos, bundle) {
  const folders = [];
  for (const tr of bundle.task.repos) {
    if (tr.status === 'excluded') continue;
    const resolved = resolvedRepos.find(r => r.folderName === tr.folderName || r.originalFolderName === tr.folderName);
    if (!resolved || resolved.skipped) continue;
    if (tr.status === 'shared') {
      const repoPath = (resolved.effectivePath || resolved.localPath);
      if (repoPath) folders.push({ path: toPosix(repoPath), name: tr.folderName });
    } else {
      folders.push({ path: `${WORKTREES_DIR}/${tr.folderName}`, name: tr.folderName });
    }
  }
  const filename = `${projectName}--${taskId}.code-workspace`;
  fs.writeFileSync(path.join(taskDir, filename), JSON.stringify({ folders }, null, 2) + '\n');
  return filename;
}

async function executeImport(projectDir, projectName, bundle, resolvedRepos, mode) {
  const { task } = bundle;
  const taskDir  = path.join(projectDir, 'tasks', task.id);

  // --- Project scaffolding (Mode 1 only) ---
  if (mode === 1) {
    fs.mkdirSync(path.join(projectDir, 'tasks'), { recursive: true });
    config.writeProjectConfig(projectDir, {
      name: projectName,
      schemaVersion: config.CURRENT_SCHEMA_VERSION,
    });
    fs.writeFileSync(path.join(projectDir, 'repos.txt'), [
      '# Workspace repos',
      '# Format: <path> [--shared]',
      '# --shared: use original path in every task, never create a worktree',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), projectClaudeMd(projectName));
    fs.writeFileSync(path.join(projectDir, '.gitignore'), '.claude/settings.local.json\n');
    console.log(`\n  ✓  Project created: ${projectDir}`);
  }

  // --- Clone + register repos ---
  for (const r of resolvedRepos) {
    if (r.skipped) continue;

    // Clone if needed
    if (r.toClone) {
      console.log(`  Cloning ${r.remoteUrl} → ${r.localPath} ...`);
      git.clone(r.remoteUrl, r.localPath);
      console.log(`  ✓  Cloned ${r.folderName}`);
    }

    // Register in repos.txt (skip if already registered — Mode 2)
    if (!r.alreadyInProject) {
      const currentRepos = readRepos(projectDir);
      if (!currentRepos.some(e => e.normalized === normalizePath(r.localPath))) {
        addRepo(projectDir, r.localPath, r.isSharedRepo);
      }
    }
  }

  // Fetch remote refs for all repos with remotes
  for (const r of resolvedRepos) {
    if (r.skipped || !r.remoteUrl) continue;
    const localPath = r.localPath;
    if (localPath && fs.existsSync(localPath)) {
      try { git.fetchOrigin(localPath); } catch {}
    }
  }

  // --- Create task dir ---
  fs.mkdirSync(path.join(taskDir, WORKTREES_DIR), { recursive: true });

  // Write CLAUDE.md
  if (task.claudeMd) {
    fs.writeFileSync(path.join(taskDir, 'CLAUDE.md'), task.claudeMd);
  }

  // Write WORKLOG.md. Absent from bundles made by wksp < 2.8.0 — the schema
  // migrations below backfill an empty one in that case.
  if (task.worklogMd) {
    fs.writeFileSync(path.join(taskDir, 'WORKLOG.md'), task.worklogMd);
  }

  // Build shared/excluded sets for task
  // Start from bundle's shared/excluded, then adjust for skipped repos
  const taskSharedSet   = new Set(task.shared   || []);
  const taskExcludedSet = new Set(task.excluded  || []);

  // Skipped repos get excluded
  for (const r of resolvedRepos) {
    if (r.skipped) {
      taskSharedSet.delete(r.folderName);
      taskExcludedSet.add(r.folderName);
    }
  }

  // --- Create worktrees ---
  let worktreeCount = 0;

  for (const tr of task.repos) {
    if (tr.status !== 'worktree') continue;

    const resolved = resolvedRepos.find(r => r.folderName === tr.folderName || r.originalFolderName === tr.folderName);
    if (!resolved || resolved.skipped) continue;

    const localPath   = resolved.effectivePath || resolved.localPath;
    if (!localPath || !fs.existsSync(localPath)) {
      console.warn(`  ⚠  ${tr.folderName} repo not found on disk — excluding from task.`);
      taskExcludedSet.add(tr.folderName);
      continue;
    }

    const branch    = tr.branch;
    const wtDir     = path.join(taskDir, WORKTREES_DIR, tr.folderName);

    // Check if branch exists after fetch
    const branchExists = branch && (
      git.branchExistsLocally(localPath, branch) ||
      git.branchExistsCached(localPath, branch)
    );

    if (!branchExists && branch) {
      console.warn(`\n  ⚠  Branch "${branch}" not found in ${tr.folderName} (tip SHA: ${tr.tipSha || 'unknown'}).`);
      console.log(`     [1] Create branch from ${tr.baseBranch || 'default branch'}`);
      console.log(`     [2] Skip — exclude this repo from the task`);
      const choice = await ask('  Choice [1]: ') || '1';
      if (choice === '2') {
        taskSharedSet.delete(tr.folderName);
        taskExcludedSet.add(tr.folderName);
        console.log(`  ↳ ${tr.folderName} excluded.`);
        continue;
      }
      // Create branch from baseBranch
      const base = tr.baseBranch || git.defaultBranch(localPath) || 'main';
      git.addWorktree(localPath, wtDir, branch, base);
    } else if (branch) {
      git.addWorktree(localPath, wtDir, branch);
    }
    worktreeCount++;
  }

  // Shared repos: just confirm they're listed as shared in task.json
  for (const tr of task.repos) {
    if (tr.status !== 'shared') continue;
    const resolved = resolvedRepos.find(r => r.folderName === tr.folderName || r.originalFolderName === tr.folderName);
    if (!resolved || resolved.skipped) continue;
    taskSharedSet.add(tr.folderName);
  }

  // Write task.json
  writeTaskSets(taskDir, taskSharedSet, taskExcludedSet);

  // Bring the imported task (and project) up to the current schema. A bundle reflects
  // the schema of whatever wksp produced it, so an imported task can be missing newer
  // per-task artifacts (e.g. WORKLOG.md). Re-run every migration step idempotently
  // rather than just stamping the project current — otherwise `wksp migrate` would
  // later report "already up to date" and never backfill them. Silent: the import
  // summary already reports what was created.
  applyMigrations(projectDir, 0, false, () => {});

  // Write .code-workspace
  const wsFile = writeWorkspaceFile(taskDir, projectName, task.id, resolvedRepos, bundle);
  console.log(`  ✓  ${wsFile}`);

  // Place session
  if (bundle.session) {
    placeSession(taskDir, bundle.session);
    console.log(`  ✓  Session restored: ${bundle.session.id}`);
  }

  // Summary
  const toCloneCount = resolvedRepos.filter(r => r.toClone && !r.skipped).length;
  if (mode === 1 && toCloneCount > 0) {
    console.log(`  ✓  Repos cloned:    ${resolvedRepos.filter(r => r.toClone && !r.skipped).map(r => r.folderName).join(', ')}`);
  }
  console.log(`  ✓  Task restored:   ${task.id}\n`);
  console.log(`  To start working:`);
  console.log(`    cd ${toPosix(projectDir)}`);
  console.log(`    wksp task resume ${task.id}\n`);
}

// ─── Mode 1: new project ─────────────────────────────────────────────────────

async function importAsNewProject(bundle) {
  const { project, task } = bundle;

  // Project location
  const projectName = (await ask(`  Project name [${project.name}]: `)) || project.name;
  const defaultParent = process.cwd();
  const parentStr  = (await ask(`  Create in [${toPosix(defaultParent)}]: `)) || defaultParent;
  const projectDir = path.join(normalizePath(parentStr), projectName);

  if (fs.existsSync(projectDir)) {
    console.error(`  Error: "${projectDir}" already exists. Choose a different name or location.`);
    process.exit(1);
  }

  // Resolve repos
  const effectiveCfg = config.readConfig();
  const resolvedRepos = [];
  for (const bundleRepo of bundle.repos) {
    const resolved = await resolveRepoNew(bundleRepo, effectiveCfg);
    resolvedRepos.push(resolved);
  }

  // Preview
  printImportPlan(projectDir, bundle, resolvedRepos, 1);
  const ok = await confirm('  Proceed?');
  if (!ok) { console.log('  Aborted.'); return; }

  // Execute
  await executeImport(projectDir, projectName, bundle, resolvedRepos, 1);
}

// ─── Mode 2: existing project ─────────────────────────────────────────────────

async function resolveReposExisting(bundle, projectDir, effectiveCfg) {
  const existingRepos = readRepos(projectDir);

  // Build remote URL map for existing repos
  const byRemote = new Map();
  const byFolder = new Map();
  for (const r of existingRepos) {
    byFolder.set(r.folderName, r);
    const url = git.getRemoteUrl(r.normalized);
    if (url) byRemote.set(url, r);
  }

  const resolved = [];
  for (const bundleRepo of bundle.repos) {
    const { folderName, remoteUrl, isSharedRepo } = bundleRepo;

    // Match by remoteUrl first, then folderName
    let match = (remoteUrl && byRemote.get(remoteUrl)) || byFolder.get(folderName);

    if (match) {
      const effectiveName = match.folderName;
      if (effectiveName !== folderName) {
        console.log(`  ✓  ${folderName} → using existing "${effectiveName}" (same remote)`);
      } else {
        console.log(`  ✓  ${folderName}  already registered`);
      }
      resolved.push({
        folderName:      effectiveName,  // use existing folderName
        localPath:       match.normalized,
        effectivePath:   match.normalized,
        remoteUrl:       bundleRepo.remoteUrl,
        isSharedRepo:    match.shared,
        toClone:         false,
        skipped:         false,
        alreadyInProject: true,
        originalFolderName: folderName,
      });
    } else {
      // Not in existing project — prompt
      const r = await resolveRepoNew(bundleRepo, effectiveCfg);
      r.alreadyInProject = false;
      resolved.push(r);
    }
  }
  return resolved;
}

async function importIntoExistingProject(bundle) {
  const { task } = bundle;

  // Locate project
  let projectDir = config.findProjectDir();
  let projectName;

  if (projectDir) {
    const { name } = config.readProjectConfig(projectDir);
    projectName = name || path.basename(projectDir);
    console.log(`  Using current project: ${projectName}  (${projectDir})`);
  } else {
    const p = await ask('  Path to existing project: ');
    projectDir = normalizePath(p);
    if (!fs.existsSync(path.join(projectDir, '.wksp'))) {
      console.error(`  Error: "${projectDir}" is not a wksp project (no .wksp file).`);
      process.exit(1);
    }
    const { name } = config.readProjectConfig(projectDir);
    projectName = name || path.basename(projectDir);
  }

  // Task conflict check
  const taskDir = path.join(projectDir, 'tasks', task.id);
  if (fs.existsSync(taskDir)) {
    console.error(`  Error: task "${task.id}" already exists in this project.`);
    console.error(`         Archive or delete it first, then re-import.`);
    process.exit(1);
  }

  // Repo reconciliation
  const effectiveCfg = config.readConfig(projectDir);
  const resolvedRepos = await resolveReposExisting(bundle, projectDir, effectiveCfg);

  // Preview
  printImportPlan(projectDir, bundle, resolvedRepos, 2);
  const ok = await confirm('  Proceed?');
  if (!ok) { console.log('  Aborted.'); return; }

  // Execute (mode 2 — no project scaffolding)
  await executeImport(projectDir, projectName, bundle, resolvedRepos, 2);
}

// ─── entry point ─────────────────────────────────────────────────────────────

async function run(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
  wksp import <file>

  Restore a task from a .wksp-bundle file.
  Interactively creates a new project or adds the task to an existing one.
`);
    process.exit(0);
  }

  const bundleFile = args.find(a => !a.startsWith('-'));
  if (!bundleFile) {
    console.error('  Usage: wksp import <file>');
    process.exit(1);
  }

  const bundlePath = path.resolve(bundleFile);
  if (!fs.existsSync(bundlePath)) {
    console.error(`  Error: file not found: ${bundlePath}`);
    process.exit(1);
  }

  const bundle = readBundle(bundlePath);
  printBundleSummary(bundle);

  open();

  console.log('  Import as:');
  console.log('    [1] New project        — create a new project folder from scratch');
  console.log('    [2] Existing project   — add this task to a project you already have');
  const modeStr = await ask('  Choice [1]: ');
  const mode = parseInt(modeStr || '1', 10);

  if (mode === 2) {
    await importIntoExistingProject(bundle);
  } else {
    await importAsNewProject(bundle);
  }

  close();
}

module.exports = { run };
