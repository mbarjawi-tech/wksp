# Reference

## Global flags

| Flag | Description |
|---|---|
| `--version`, `-v` | Print the installed version and exit. |
| `--help`, `-h` | Print usage for a command and exit. Supported on all commands. |

---

## Commands

### `wksp init [name]`

Create a new project. Scaffolds `.wksp`, `repos.txt`, `CLAUDE.md`, and `tasks/`. Prompts for `reposRoot` if not already set (skippable — you can add it later with `wksp config set`).

```bash
wksp init acme
```

---

### `wksp repo <subcommand> <path-or-url>`

Register and manage repos within the current project.

- **Local path** — added directly to `repos.txt`.
- **GitHub URL** — cloned into `reposRoot` (skipped if already cloned), then the local path is added.

```bash
wksp repo add /c/dev/backend
wksp repo add https://github.com/your-org/frontend
wksp repo add /c/dev/company-docs --shared
wksp repo remove /c/dev/old-service

# Register the same repo twice — each gets its own worktree on a different branch
wksp repo add /c/dev/malachite --as malachite-b
wksp repo remove /c/dev/malachite --as malachite-b
```

| Subcommand | Description |
|---|---|
| `add <path-or-url>` | Register a repo. Use `--shared` to always use the original path (no worktree). Use `--as <alias>` to register the same repo twice under a different name. |
| `remove <path-or-url>` | Remove from `repos.txt`. Warns if orphaned worktrees exist. When the same repo is registered more than once, `--as <alias>` is required to identify which entry to remove. |

---

### `wksp task <subcommand> <id>`

Manage task workspaces.

```bash
wksp task create PROJ-1234      # create new task, prompt for branches, launch Claude
wksp task resume PROJ-1234      # resume existing task, launch Claude
wksp task delete PROJ-1234      # tear down worktrees and delete task folder
wksp task rename PROJ-1234 PROJ-5678   # rename task in place
wksp task archive PROJ-1234     # remove worktrees, move to archived-tasks/
wksp task unarchive PROJ-1234   # restore an archived task
wksp task repo PROJ-1234 backend share    # switch repo to shared path for this task
wksp task repo PROJ-1234 backend worktree # create/restore a worktree for a repo
wksp task repo PROJ-1234 backend exclude  # exclude a repo from this task
wksp task repo PROJ-1234                  # interactive: pick repo then mode
```

`create` — prompts for a branch per repo, creates worktrees, generates a VS Code `.code-workspace` file (printed to stdout), then launches Claude.

`resume` — scans existing worktrees, detects any new repos added since last run (prompts for branches for those), then launches Claude.

#### Branch prompt options

For each non-shared repo you are asked:

```
Branch for backend [main, s=shared, x=exclude]:
```

| Input | What happens |
|---|---|
| Enter | Use the repo's current branch as a worktree. |
| A branch name | Create or check out that branch in a new worktree. If the branch is new, a follow-up asks which branch to base it on (defaults to the repo's default branch). |
| `s` | Use the base repo path directly for this task (task-shared). No worktree created. |
| `x` | Exclude this repo from this task entirely. No worktree, not in workspace, not passed to Claude. |

#### Flags

| Subcommand | Flag | Description |
|---|---|---|
| `delete` | `--delete-branches` | Also delete local branches when tearing down. |
| `archive` | `--delete-branches` | Delete local branches during archive. |
| `archive` | `--force` | Archive even when uncommitted changes exist. |
| `unarchive` | `--dry-run` | Show restore plan without applying it. |
| `unarchive` | `--fetch` | Fetch remote refs in all base repos before classifying. |
| `unarchive` | `--skip <repo>` | Skip a specific repo during restore. |
| `unarchive` | `--branch <repo>=<branch>` | Override the branch used for a specific repo. |
| `unarchive` | `--shared <repo>` | Restore a specific repo as task-shared instead of a worktree. |

> **v1 syntax** (`wksp task <id> --del`, `wksp task <id> --archive`, etc.) still works in v2 but prints a deprecation warning. It will be removed in v2.1.0.

---

### `wksp list`

Show live tasks in the current project. The footer notes the archived task count.

```bash
wksp list             # live tasks only
wksp list --archived  # archived tasks with archive dates
wksp list --all       # both, with a Status column
```

---

### `wksp status [task-id]`

Show a task's repos, their live branches, and types (worktree/shared/excluded). Run from inside a task folder, or pass a task-id from anywhere in the project.

```bash
wksp status            # auto-detects task from cwd
wksp status PROJ-1234  # explicit task-id
```

---

### `wksp cleanup --stale <path>`

Scan a base repo for stale worktree refs (worktrees that no longer exist on disk) and prune them. Useful after manually deleting task folders.

```bash
wksp cleanup --stale /c/dev/backend
wksp cleanup --stale /c/dev -r   # scan all repos in the directory
```

| Flag | Description |
|---|---|
| `-r` | Scan first-level subdirectories of `<path>` for git repos. |

---

### `wksp delete`

Destroy the entire project: tear down all worktrees for all tasks, then delete the project folder. Prompts for confirmation by typing the project name.

---

### `wksp config set <key> <value>` / `wksp config get [key]`

Read or write config values. Without `--global`, writes to the current project's `.wksp`. With `--global`, writes to `~/.wksp`.

```bash
wksp config set reposRoot /c/dev/games     # project-level
wksp config set reposRoot /c/dev --global  # global fallback

wksp config set autoResume false           # project-level
wksp config set autoResume true --global   # global fallback

wksp config get                            # effective values (project overrides global)
wksp config get --global                   # only ~/.wksp
wksp config get reposRoot                  # single key, effective value
```

Project-level values override global ones. If you run `set` without `--global` outside a project directory, wksp saves to the global config automatically.

| Key | Description |
|---|---|
| `reposRoot` | Directory where GitHub URLs are cloned. |
| `autoResume` | `true` (default) to auto-resume the last Claude session; `false` to prompt each time. |

---

## File formats

### `~/.wksp` — global config

```json
{
  "reposRoot": "/c/dev",
  "autoResume": true
}
```

### `<project>/.wksp` — project config

```json
{
  "name": "acme",
  "reposRoot": "/c/dev/acme-repos"
}
```

Presence of this file marks the directory as a wksp project. Commands walk up the directory tree to find it — identical to how `git` finds `.git`. Project-level `reposRoot` and `autoResume` override the global values for that project.

### `<project>/repos.txt`

```
# Format: <path> [--shared] [--as <alias>]
# Any path format is accepted (Windows backslash, forward slash, POSIX)

C:/dev/backend
C:/dev/frontend
C:/dev/company-docs  --shared

# Same repo registered twice — two worktrees, two branches, one task
C:/dev/malachite
C:/dev/malachite  --as malachite-b
```

### `tasks/<id>/task-shared.txt`

One folder name per line (the alias, or `basename` of the repo path when no alias is set). Lists repos that use their original folder for this task instead of a worktree. Created by `--to-shared`; read on every resume.

### `tasks/<id>/task-excluded.txt`

One folder name per line (same convention as `task-shared.txt`). Lists repos excluded from this task entirely. Created at task creation when the user types `x` at the branch prompt; can be cleared with `--to-worktree`.

### `archived-tasks/<id>/archived.json`

Written by `--archive`. Contains everything needed to rehydrate the task:

```json
{
  "version": 1,
  "archivedAt": "2026-05-14T21:00:00.000Z",
  "taskId": "PROJ-1234",
  "repos": [
    {
      "repoPath": "C:/dev/backend",
      "folderName": "backend",
      "branch": "feature/PROJ-1234",
      "tipSha": "abc123...",
      "kind": "worktree"
    }
  ],
  "sharedRepos": ["C:/dev/company-docs"],
  "excludedRepos": []
}
```

`tipSha` allows the unarchive classifier to determine if a missing branch was merged, is in a dangling state, or is truly lost.

---

## CLAUDE.md templates

### Project-level (generated by `wksp init`)

```markdown
## Project: acme

## Cross-cutting conventions
<!-- fill in: backend, frontend, branch naming, test commands... -->

## Conflict policy
This file defines project-wide conventions. Tasks each have their own CLAUDE.md.
If you notice a contradiction between this file and a task's CLAUDE.md,
flag it immediately and ask for clarification before proceeding.
```

### Task-level (generated by `wksp task`)

```markdown
## Task: PROJ-1234
## Goal: (describe the task here)

## Notes
<!-- decisions, constraints, references, links to tickets... -->

## Conflict policy
The project-level CLAUDE.md defines shared conventions. This file adds task-specific context only.
If anything here contradicts the project-level CLAUDE.md, flag the contradiction
and ask for clarification — do not silently resolve it yourself.
```

---

## Startup summary

Printed before Claude launches. Branches are read live from git; staleness uses locally cached remote refs — no network fetch at launch.

```
────────────────────────────────────────────
  wksp · acme / PROJ-1234
────────────────────────────────────────────
  Repos:

    backend              feature/PROJ-1234   (worktree)  ⚠ 3 commits behind main
    frontend             feature/PROJ-1234   (worktree)
    services             main                (shared)
    company-docs         —                   (excluded)
────────────────────────────────────────────
```

---

## Unarchive classifier states

When unarchiving, each repo's branch is classified before worktrees are recreated:

| State | Meaning | Default action |
|---|---|---|
| `present-local` | Branch still exists locally | Restore worktree on same branch |
| `advanced` | Branch exists locally, moved ahead of archived SHA | Restore worktree (show diff count) |
| `remote-only` | Branch deleted locally but exists on remote | Restore worktree (uses remote ref) |
| `merged` | Branch merged into default branch, then deleted | Restore as task-shared (on default branch) |
| `merged-elsewhere` | Tip SHA reachable from default, branch gone | Restore as task-shared |
| `dangling` | Tip SHA in object DB, no branch pointing to it | Restore from SHA (create recovery branch) |
| `lost` | Tip SHA not found in any local object DB | Skip (print warning) |
| `base-missing` | Base repo not on disk at all | Skip (print warning) |
| `new-since-archive` | Repo added to `repos.txt` after archiving | Prompt for branch at restore time |

When all repos are `present-local`, unarchive runs silently. When any repo has a non-trivial state, a preview table is shown and confirmation is requested before applying.
