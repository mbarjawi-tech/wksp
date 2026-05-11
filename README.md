# wksp

Workspace CLI for Claude Code — manage multi-repo development with git worktrees.

Each **project** groups a set of repos. Each **task** (a ticket, a feature, a bug fix) gets its own set of git worktrees — one per repo — so you can work on multiple tasks simultaneously without branch-switching.

## Testing

```bash
npm install   # installs Jest (dev dependency)
npm test      # run all 63 tests
```

Tests are split into two groups:

**Unit** (`tests/unit/`) — pure logic, no git, no network, runs in milliseconds:
- `paths.test.js` — Windows ↔ POSIX path conversion
- `config.test.js` — global/project config, `cloneRoot→reposRoot` migration, `findProjectDir` walk-up
- `repos.test.js` — `repos.txt` parsing, add, remove, duplicate detection

**Integration** (`tests/integration/`) — real temporary git repos, ~60 s total:
- `git.test.js` — all git operations: branch detection, worktree create/remove, branch delete (safe + force), staleness count, default branch resolution
- `worktrees.test.js` — worktree discovery: empty dirs, corrupted `.git` files, real worktrees with metadata
- `task-del.test.js` — `wksp task --del` behaviour: cancellation, keep vs delete branches, unmerged-commit guard

## Install

Navigate to the `wksp` folder on your machine, then run:

```bash
npm link
```

This registers `wksp` as a global command by creating a symlink to this folder. Because it's a symlink (not a copy), any edits you make to the source files here take effect immediately — no reinstall needed.

## Uninstall

```bash
npm unlink -g wksp
```

This removes the global `wksp` command. It does not delete the source folder or any of your workspace projects.

## Quick start

```bash
# 1. Create a project
wksp init monarch

# 2. Register repos
cd monarch
wksp repo /c/development/api
wksp repo /c/development/monarch-front-end
wksp repo /c/development/tinyeye-docs --shared   # read-only reference, no worktree ever

# 3. Start a task — prompts for branches, creates worktrees, launches Claude
wksp task MONA-1234
```

On `wksp task`, you're prompted once per repo for a branch name. Press **Enter** to use the repo's current branch, or type **`s`** to skip worktree creation and use that repo as shared for this task. If the branch name is new (doesn't exist locally or remotely), a follow-up prompt asks which branch to base it on — press **Enter** to accept the repo's default branch. Claude launches with all worktrees (and shared repos) added via `--add-dir`.

## Shared vs worktree — when to use which

**Use `--shared`** (project level, in `repos.txt`) for repos you only ever read from — documentation, design systems, reference data. The original repo folder is used directly in every task, no branch management needed.

**Use a worktree** (the default for non-shared repos) when you need to make changes on a branch. Since each task gets its own worktree, multiple tasks can be open on different branches at the same time.

**Conflict: branch already checked out.** If you need to use a repo on its current default branch for a specific task (e.g. you don't need changes there), but that branch is already checked out in the base repo — switch the worktree to shared for that task:

```bash
wksp task MONA-1234 --to-shared marketplace
```

To go the other way — convert a task-shared repo back to a worktree:

```bash
wksp task MONA-1234 --to-worktree marketplace
```

These changes are per-task only and don't affect `repos.txt`.

## Commands

| Command | Description |
|---|---|
| `wksp init [name]` | Create a new project |
| `wksp repo <path-or-url>` | Register a repo (`--shared`, `--remove`) |
| `wksp task <id>` | Create or resume a task |
| `wksp task <id> --del` | Tear down worktrees and delete the task folder (prompts whether to delete local branches) |
| `wksp task <id> --to-shared <repo>` | Remove worktree for a repo and use the shared path instead (this task only) |
| `wksp task <id> --to-worktree <repo>` | Create a worktree for a repo that was shared in this task |
| `wksp list` | List all tasks in the current project |
| `wksp status` | Show live branch status for the current task |
| `wksp cleanup --stale <path>` | Prune stale worktree refs from a base repo (`-r` for subdirs) |
| `wksp delete` | Delete the entire project and all its worktrees |
| `wksp config set <key> <val>` | Set a global config value (e.g. `reposRoot`) |
| `wksp config get [key]` | Show global config |

## How tasks work

**New task** — prompts for a branch per repo. If the branch doesn't exist yet, a follow-up asks which branch to base it on (defaults to the repo's default branch). Creates a git worktree for each repo, generates a `<project>--<task>.code-workspace` file for VS Code, then launches Claude.

**Resume task** — detects any repos added to `repos.txt` since last run, creates missing worktrees, then launches. Existing worktrees are never re-branched — whatever branch they're on is respected.

**Startup summary** — printed before Claude launches. Shows each repo's live branch, type (worktree or shared), and a staleness warning if the branch is behind `origin/main` (or the repo's default branch):

```
────────────────────────────────────────────
  wksp · monarch / MONA-1234
────────────────────────────────────────────
  Repos:

    api                  feature/MONA-1234   (worktree)  ⚠ 3 commits behind main
    monarch-front-end    feature/MONA-1234   (worktree)
    tinyeye-docs         main                (shared)
────────────────────────────────────────────
```

The staleness count uses locally cached remote refs — no network fetch is performed at launch.

## Global config (`~/.wksp`)

```json
{ "reposRoot": "/c/development" }
```

`reposRoot` is where GitHub URLs get cloned when you run `wksp repo <github-url>`. Prompted automatically on first use — not needed for local paths.

## Project structure

```
monarch/
├── .wksp              ← project marker + config
├── repos.txt          ← registered repos
├── CLAUDE.md          ← project-wide conventions for Claude
└── tasks/
    └── MONA-1234/
        ├── CLAUDE.md                        ← task-specific context for Claude
        ├── monarch--MONA-1234.code-workspace ← VS Code multi-root workspace
        ├── task-shared.txt                  ← repos using shared path for this task (if any)
        └── worktrees/
            ├── api/            ← git worktree on feature/MONA-1234
            └── monarch-front-end/
```

See [guide.html](guide.html) for the full reference including file formats, detailed flows, and CLAUDE.md templates.
