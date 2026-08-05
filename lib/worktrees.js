'use strict';
const fs   = require('fs');
const path = require('path');
const git  = require('./git');
const { readRepos } = require('./repos');
const { scanStrandedProbes } = require('./teardown-guard');

const WORKTREES_DIR = 'worktrees';

function parseGitFile(worktreeDir) {
  const content = fs.readFileSync(path.join(worktreeDir, '.git'), 'utf8').trim();
  if (!content.startsWith('gitdir: ')) return null;
  const gitdirPath = content.slice(8).trim();
  return gitdirPath.replace(/[/\\]\.git[/\\]worktrees[/\\][^/\\]+$/, '');
}

// Neither half of a stranded probe is allowed to be silent: a recovery changes what the
// caller is looking at, and declining to recover explains why the task looks wrong. The
// first version of this destructured only the failures and threw the recoveries away,
// so a recovery was invisible in every command that could perform one.
//
// Printed on stderr, so `wksp list --json` keeps a parseable stdout.
function reportProbes(taskDir, recovered, stranded, recover) {
  const taskId = path.basename(taskDir);
  for (const folderName of recovered) {
    console.warn(`  ⚠  Put "${folderName}" back in ${taskId} — an earlier run had left it renamed aside next to worktrees/.`);
  }
  // A probe this caller asked to recover and could not is refused with full detail by
  // the caller itself (refuseIfStrandedProbes and the equivalents in `repo remove` and
  // the project-wide `delete`), so saying anything here would only duplicate it.
  if (recover) return;
  for (const sp of stranded) {
    console.warn(`  ⚠  "${sp.folderName}" in ${taskId} was left renamed aside by an interrupted run — this command only reports it.`);
    // Name the concrete move, the way refuseIfStrandedProbes and `repo remove` do: the exit
    // from this state is a five-second rename, and a notice that only points at a teardown
    // sends a user whose task is otherwise fine towards a destructive command.
    console.warn(`     Put it back by hand:\n       ${sp.strandedPath}\n         →  ${sp.targetPath}`);
    console.warn(`     Or let wksp do it: wksp start ${taskId} — as does any teardown (wksp task archive ${taskId} / delete / finish).`);
  }
}

// The single choke point every command uses to enumerate a task's worktrees, which
// makes it the right place to notice a worktree probe a crashed run left stranded (see
// lib/teardown-guard.js#scanStrandedProbes). Every caller — list/status/brief as well as
// delete/archive/finish/repo — gets a `strandedProbe` entry for it, so it is never
// silently invisible and never swept up unnoticed by a later bulk delete of the task
// folder.
//
// `report: false` silences the notices for a call that is plumbing rather than the
// command itself — task-id resolution enumerates every task before the real command
// runs, and its read-only pass would otherwise print "this command only reports it"
// immediately before a teardown recovered the probe anyway. The command's own call
// still reports, so nothing is hidden.
//
// `recover: true` additionally puts it back, and belongs to callers that already write to
// the task: the teardowns that were going to move or delete the worktree anyway, and
// create/resume, whose whole job is to make the task ready to work in (it creates
// worktrees and writes task.json and the .code-workspace). A read-oriented command must
// not mutate the filesystem just by looking. scanStrandedProbes explains why that split
// matters.
function discoverWorktrees(taskDir, { recover = false, report = true } = {}) {
  const { recovered, stranded: strandedProbes } = scanStrandedProbes(taskDir, WORKTREES_DIR, { recover });
  if (report) reportProbes(taskDir, recovered, strandedProbes, recover);

  const worktreesDir = path.join(taskDir, WORKTREES_DIR);
  const entries = fs.existsSync(worktreesDir)
    ? fs.readdirSync(worktreesDir, { withFileTypes: true }).filter(d => d.isDirectory())
    : [];

  const result = entries.map(d => {
    const folderName  = d.name;
    const worktreeDir = path.join(worktreesDir, folderName);
    try {
      const baseRepo = parseGitFile(worktreeDir);
      if (!baseRepo) {
        return { folderName, worktreeDir, baseRepo: null, currentBranch: null, corrupted: true, error: 'malformed .git file' };
      }
      return { folderName, worktreeDir, baseRepo, currentBranch: git.currentBranch(worktreeDir), corrupted: false };
    } catch (e) {
      return { folderName, worktreeDir, baseRepo: null, currentBranch: null, corrupted: true, error: e.message };
    }
  });

  for (const sp of strandedProbes) {
    result.push({
      folderName:  sp.folderName,
      worktreeDir: sp.targetPath,
      baseRepo:    null,
      currentBranch: null,
      corrupted:   true,
      strandedProbe: true,
      strandedPath: sp.strandedPath,
      error: sp.attempted
        ? `stranded worktree probe could not be recovered (${sp.code || sp.message}) — currently at ${sp.strandedPath}`
        : `worktree renamed aside by an interrupted run, not moved back — currently at ${sp.strandedPath}`,
    });
  }

  return result;
}

// Which registered base repo still has a worktree at `worktreeDir`, and on what
// branch: { baseRepo, branch } or null.
//
// The point is the case discoverWorktrees can't answer — a worktree whose .git file
// is gone, so its base repo is unknown. Every registered repo is asked instead, and
// the base repo keeps the registration until `git worktree prune`, so this recovers
// the branch of a worktree that was destroyed mid-teardown well enough to name it in
// a warning. Deliberately used for REPORTING only: nothing verified that branch
// merged, so no code path deletes it off the back of this.
function findWorktreeRegistration(projectDir, worktreeDir) {
  for (const repo of readRepos(projectDir)) {
    const entry = git.findWorktreeEntry(repo.normalized, worktreeDir);
    if (entry) return { baseRepo: repo.normalized, branch: entry.branch };
  }
  return null;
}

module.exports = { discoverWorktrees, parseGitFile, findWorktreeRegistration, WORKTREES_DIR };
