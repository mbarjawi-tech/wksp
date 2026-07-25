'use strict';
const fs   = require('fs');
const git  = require('./git');

// Non-interactive repo dispositions for `wksp task create` / `resume`.
//
// The interactive path asks a question per repo and acts on each answer as it
// arrives. A headless run can't ask, so it does the opposite: decide everything
// first, validate the whole plan, and only then touch the filesystem. Anything the
// prompt would have resolved — an unknown repo, a branch already checked out
// somewhere else, two repos claiming one folder name — becomes an error naming the
// flag that fixes it, and the task is left uncreated.

// Default branch name for a repo with no --branch flag: the task id, matching the
// default the interactive prompt offers.
function defaultBranchName(repo, taskId) {
  return repo.alias ? repo.alias : taskId;
}

// Decide each pending repo's mode / branch / base and validate the result.
//   allRepos  — every registered repo (flag targets are validated against this)
//   pending   — repos with no disposition yet in this task (the ones being decided)
//   usedNames — worktree folder names already taken in this task
//   opts      — { branch: {map, fallback}, base: {map, fallback}, shared: Set, exclude: Set }
// Returns { items, errors }; `items` is only meaningful when `errors` is empty.
function planRepos({ allRepos, pending, taskId, usedNames = new Set(), opts }) {
  const errors = [];
  const byName = new Map(allRepos.map(r => [r.folderName, r]));
  const pendingNames = new Set(pending.map(r => r.folderName));
  const available = allRepos.map(r => r.folderName).join(', ') || '(none)';

  // Every repo a flag names must be registered, and must still be undecided —
  // re-dispositioning a repo that already has a worktree is `wksp task repo`'s job.
  const referenced = new Map(); // name → flag that referenced it
  for (const name of opts.branch.map.keys())  referenced.set(name, '--branch');
  for (const name of opts.base.map.keys())    referenced.set(name, '--base');
  for (const name of opts.shared)             referenced.set(name, '--shared');
  for (const name of opts.exclude)            referenced.set(name, '--exclude');

  for (const [name, flag] of referenced) {
    const repo = byName.get(name);
    if (!repo) {
      errors.push({
        message: `${flag} names "${name}", which is not registered in repos.txt`,
        hint:    `Registered repos: ${available}`,
      });
      continue;
    }
    if (usedNames.has(name)) {
      errors.push({
        message: `"${name}" already has a worktree in this task, so ${flag} can't apply`,
        hint:    `Change an existing repo's mode with: wksp task repo <id> ${name} <share|worktree|exclude>`,
      });
      continue;
    }
    if (repo.shared && flag !== '--exclude' && flag !== '--shared') {
      errors.push({
        message: `"${name}" is registered --shared in repos.txt, so it never gets a worktree`,
        hint:    `Drop ${flag} for it, or give this one task a worktree afterwards: wksp task repo <id> ${name} worktree`,
      });
    }
  }

  const claimed = new Set(usedNames);
  const items   = [];

  for (const repo of pending) {
    const name = repo.folderName;

    if (opts.exclude.has(name)) { items.push({ repo, name, mode: 'excluded' }); continue; }
    if (opts.shared.has(name))  { items.push({ repo, name, mode: 'shared'   }); continue; }

    // A worktree is the default, so everything a worktree needs must hold.
    if (!fs.existsSync(repo.normalized)) {
      errors.push({
        message: `repo not found on disk: ${repo.normalized}`,
        hint:    `Fix the path in repos.txt, or leave it out of this task with: --exclude ${name}`,
      });
      continue;
    }
    if (claimed.has(name)) {
      errors.push({
        message: `two registered repos both want the folder name "${name}"`,
        hint:    `A headless run can't pick a new name — exclude one of them with: --exclude ${name}`,
      });
      continue;
    }
    claimed.add(name);

    const branch   = opts.branch.map.get(name) || opts.branch.fallback || defaultBranchName(repo, taskId);
    const conflict = git.findCheckedOutBranch(repo.normalized, branch);
    if (conflict) {
      errors.push({
        message: `"${branch}" is already checked out in ${conflict}`,
        hint:    `Pick another branch with --branch ${name}=<branch>, or use --shared ${name} / --exclude ${name}`,
      });
      continue;
    }

    const isNewBranch = !git.branchExistsLocally(repo.normalized, branch) &&
                        !git.branchExistsCached(repo.normalized, branch) &&
                        !git.branchExistsRemotely(repo.normalized, branch);
    const baseBranch  = isNewBranch
      ? (opts.base.map.get(name) || opts.base.fallback || git.defaultBranch(repo.normalized) || 'main')
      : null;

    items.push({ repo, name, mode: 'worktree', branch, baseBranch, isNewBranch });
  }

  return { items, errors };
}

// Human-readable plan, shared by --dry-run and the pre-create summary.
function renderPlan(items, { projectName, taskId, exists }) {
  const verb  = exists ? 'resume' : 'create';
  const lines = [`\n  wksp · ${projectName} / ${taskId} — ${verb} plan`, ''];
  if (!items.length) {
    lines.push('    (no repos to set up)');
    return lines;
  }
  const nameW = Math.max(...items.map(i => i.name.length)) + 2;
  for (const item of items) {
    if (item.mode === 'excluded') { lines.push(`    ${item.name.padEnd(nameW)} excluded`); continue; }
    if (item.mode === 'shared')   { lines.push(`    ${item.name.padEnd(nameW)} shared     (no worktree)`); continue; }
    const origin = item.isNewBranch ? `  (new branch off ${item.baseBranch})` : '';
    lines.push(`    ${item.name.padEnd(nameW)} worktree   ${item.branch}${origin}`);
  }
  return lines;
}

// Errors as printable lines, each with the flag that resolves it.
function renderErrors(errors) {
  const lines = ['\n  Cannot set this task up without asking:'];
  for (const e of errors) {
    lines.push(`    ✗  ${e.message}`);
    if (e.hint) lines.push(`       ${e.hint}`);
  }
  return lines;
}

module.exports = { planRepos, renderPlan, renderErrors, defaultBranchName };
