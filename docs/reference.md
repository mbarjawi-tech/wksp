# Reference

## Global flags

| Flag | Description |
|---|---|
| `--version`, `-v` | Print the installed version and exit. |
| `--help`, `-h` | Print usage for a command and exit. Supported on all commands. |

---

## Commands

### `wksp init [name]`

Create a new project. Scaffolds `.wksp`, `repos.txt`, `CLAUDE.md`, `tasks/`, and a reserved [`hub`](#the-hub) planning task (pass `--no-hub` to skip it). Prompts for `reposRoot` if not already set (skippable — you can add it later with `wksp config set`).

```bash
wksp init acme
wksp init acme --no-hub   # skip the planning hub (add one later with: wksp task create hub)
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
```

| Subcommand | Description |
|---|---|
| `list` | List all registered repos and their flags. |
| `add <path-or-url>` | Register a repo. Use `--shared` to always use the original path (no worktree). |
| `remove <path-or-url>` | Remove from `repos.txt`. Warns if orphaned worktrees exist. |

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
wksp task finish PROJ-1234      # verify merged, archive + delete branches, ff base repos
wksp task repo PROJ-1234 backend share    # switch repo to shared path for this task
wksp task repo PROJ-1234 backend worktree # create/restore a worktree for a repo
wksp task repo PROJ-1234 backend exclude  # exclude a repo from this task
wksp task repo PROJ-1234                  # interactive: pick repo then mode
```

`create` — prompts for a branch per repo, creates worktrees, generates a VS Code `.code-workspace` file (printed to stdout), then launches Claude.

`resume` — scans existing worktrees, detects any new repos added since last run (prompts for branches for those), then launches Claude.

`rename` — renames the task folder, repairs worktrees, renames the `.code-workspace` file, and updates the `## Task:` / `# Work Log:` headings. Because Claude keys session transcripts by the task's folder path, rename also offers to move that history under the new key so `resume` and `status` keep finding it — it shows what it will move and asks (default Yes). Use `--no-migrate-sessions` to skip the move, or `--yes` / `-y` to auto-confirm.

`finish` (alias: `done`) — the post-merge completion verb. Fetches each base repo and verifies the task's branches are merged into the default branch — a squash- or rebase-merged PR legitimately shows as unmerged, so finish warns and asks before continuing. It then archives the task exactly like `archive` but with branch deletion defaulted (`--keep-branches` opts out), and finally fast-forwards each base repo's default branch — only when that repo is clean and already sitting on it; otherwise it prints the `git pull --ff-only` command and leaves the repo alone. Merge PRs from inside a task with `gh pr merge <pr> --repo <owner>/<repo>` — the `--repo` flag keeps gh from trying to check out the default branch locally, which fails inside a worktree.

#### The hub

`hub` is a **reserved task id** — the project's planning task. It has no worktree; it holds the feature backlog, cross-cutting design, open decisions, and cross-task references (`tasks/hub/CLAUDE.md` + its `WORKLOG.md`).

- `wksp init` creates it automatically (opt out with `wksp init --no-hub`). Add one to an older project with `wksp task create hub` — it explains what the hub is and asks before creating it.
- Because the name is reserved, `wksp task create hub` always makes the planning task (never a normal worktree task); running it when a hub already exists is an error.
- `wksp task delete hub` and `wksp task rename hub …` warn before proceeding, since the hub carries project-wide context that lives nowhere else.
- Need code in the hub for a one-off? Pull a repo in with `wksp task repo hub <repo> worktree` — but real features should get their own task.

It's scaffolding, not schema: existing projects are never forced to have a hub, and a hub-less project stays valid.

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
| `finish` | `--keep-branches` | Keep local branches instead of deleting them. |
| `finish` | `--force` | Finish even when uncommitted changes exist. |
| `finish` | `--reason <text>` | Record a reason in the archive manifest (default: "finished"). |
| `finish` | `--yes`, `-y` | Skip confirmations (scripts/CI). |
| `unarchive` | `--dry-run` | Show restore plan without applying it. |
| `unarchive` | `--fetch` | Fetch remote refs in all base repos before classifying. |
| `unarchive` | `--skip <repo>` | Skip a specific repo during restore. |
| `unarchive` | `--branch <repo>=<branch>` | Override the branch used for a specific repo. |
| `unarchive` | `--shared <repo>` | Restore a specific repo as task-shared instead of a worktree. |

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

### `wksp cleanup [<path>] [--recursive]`

Prune stale git worktree refs from base repos (worktrees that no longer exist on disk). Useful after manually deleting task folders.

```bash
wksp cleanup                            # scan all registered repos in the current project
wksp cleanup /c/dev/backend             # prune a specific repo
wksp cleanup /c/dev --recursive         # prune all git repos inside a directory
```

With no arguments, scans every repo registered in the current project's `repos.txt`. With a path, prunes that specific repo (or its subdirectories when `--recursive` is given).

| Flag | Description |
|---|---|
| `--recursive` | Also scan first-level subdirectories of `<path>` for git repos. |

---

### `wksp delete`

Destroy the entire project: tear down all worktrees for all tasks, then delete the project folder. Prompts for confirmation by typing the project name.

---

### `wksp export <task-id>`

Bundle a task into a portable `.wksp-bundle` file — project config, repo registrations, branch state, and optionally the Claude session transcript. The importer can reconstruct the full task on any machine.

All repos must have their changes committed and pushed before export.

```bash
wksp export PROJ-1234                            # write acme--PROJ-1234.wksp-bundle in cwd
wksp export PROJ-1234 --out ~/Desktop/task.wksp-bundle
wksp export PROJ-1234 --with-session             # include Claude session transcript
```

| Flag | Description |
|---|---|
| `--out <file>` | Output path. Default: `./<project>--<task-id>.wksp-bundle` in the current directory. |
| `--with-session` | Include the most recent Claude session transcript (`.jsonl`) for this task. Opt-in — sessions can be large. |

---

### `wksp import <file>`

Read a `.wksp-bundle` and interactively rebuild the project and task on the current machine. Supports two modes:

- **New project** — scaffolds a fresh project folder, clones repos, and creates the task.
- **Add to existing project** — adds the task to a project already set up locally; reconciles repos by remote URL.

```bash
wksp import acme--PROJ-1234.wksp-bundle
```

All prompts show a default; pressing Enter accepts it. Repos that cannot be resolved can be skipped and added later with `wksp task repo <id> <repo> worktree`.

---

### `wksp migrate`

Detect and apply any pending project schema migrations. Safe to run multiple times — does nothing if the project is already current.

```bash
wksp migrate           # apply all pending migrations
wksp migrate --dry-run # preview changes without writing anything
```

| Flag | Description |
|---|---|
| `--dry-run` | Show what would be changed without writing to disk. |

See the [Migration Guide](/migration) for a full history of what each migration does.

---

### `wksp config set <key> <value>` / `wksp config get [key]` / `wksp config clear <key>`

Read, write, or remove config values. Without `--global`, operates on the current project's `.wksp`. With `--global`, operates on `~/.wksp`.

```bash
wksp config set reposRoot /c/dev/games     # project-level
wksp config set reposRoot /c/dev --global  # global fallback

wksp config set autoResume false           # project-level
wksp config set autoResume true --global   # global fallback

wksp config clear autoResume              # remove project-level override (falls back to global)
wksp config clear reposRoot --global      # remove global value

wksp config get                            # effective values (project overrides global)
wksp config get --global                   # only ~/.wksp
wksp config get reposRoot                  # single key, effective value
```

Project-level values override global ones. If you run `set` without `--global` outside a project directory, wksp saves to the global config automatically. `clear` removes the key entirely — if a global value exists, it becomes effective again.

| Key | Description |
|---|---|
| `reposRoot` | Directory where GitHub URLs are cloned. |
| `autoResume` | `true` (default) to auto-resume the last Claude session; `false` to prompt each time. |
| `aiProvider` | Which AI tool wksp launches. Built-ins: `claude` (default, full session support) and `none` (launches nothing). Custom providers add more names. See [AI Providers](/providers). |
| `customProviders` | Object mapping a provider name to `{ command, instructionFile? }` to launch any CLI tool (baseline tier). See [AI Providers](/providers). |

---

### `wksp providers`

List the AI providers wksp can launch and show which one is configured (the `aiProvider` key). Works inside or outside a project — outside, only global config is consulted.

```bash
wksp providers          # human-readable list, configured provider marked with *
wksp providers --json   # stable machine shape for agent self-checks
```

| Flag | Description |
|---|---|
| `--json` | Emit a machine-readable list: `{ configured, providers: [{ name, builtin, tier, capabilities: { sessions }, instructionFile }] }`. |

See [AI Providers](/providers) for tiers, the `none` provider, and declarative `customProviders`.

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
  "schemaVersion": 2,
  "reposRoot": "/c/dev/acme-repos"
}
```

`schemaVersion` is written by `wksp init` and updated by `wksp migrate`. Projects created before v2.1.0 have no `schemaVersion` field (implicitly version 0).

Presence of this file marks the directory as a wksp project. Commands walk up the directory tree to find it — identical to how `git` finds `.git`. Project-level `reposRoot`, `autoResume`, and `aiProvider` override the global values for that project.

### `<project>/repos.txt`

```
# Format: <path> [--shared]
# Any path format is accepted (Windows backslash, forward slash, POSIX)

C:/dev/backend
C:/dev/frontend
C:/dev/company-docs  --shared
```

### `tasks/<id>/task.json`

Records which repos use a shared path or are excluded from the task. Both keys are optional and omitted when their list is empty.

```json
{
  "shared": ["company-docs"],
  "excluded": ["legacy-service"]
}
```

`shared` — repos using the base path directly (no worktree), by folder name. Written when the user types `s` at the branch prompt or runs `wksp task repo … share`.

`excluded` — repos excluded from the task entirely, by folder name. Written when the user types `x` at the branch prompt or runs `wksp task repo … exclude`.

> **Backward compatibility** — Projects with legacy `task-shared.txt` and `task-excluded.txt` files (created before v2.2.0) continue to work without migration. Running `wksp migrate` converts them to `task.json` and removes the old files.

### `<name>--<task-id>.wksp-bundle`

Produced by `wksp export`. A UTF-8 JSON file containing everything needed to reconstruct the project and task on another machine. See [Export / Import](/export-import) for the full field reference.

```json
{
  "bundleVersion": 1,
  "exportedAt": "2026-06-01T19:00:00.000Z",
  "exportedBy": { "machine": "Mutas-lenovo" },
  "project": { "name": "acme", "schemaVersion": 2 },
  "repos": [
    {
      "folderName": "backend",
      "remoteUrl": "https://github.com/org/backend",
      "localPath": "C:/dev/backend",
      "isSharedRepo": false,
      "hasRemote": true
    }
  ],
  "task": {
    "id": "PROJ-1234",
    "claudeMd": "## Task: PROJ-1234\n...",
    "worklogMd": "# Work Log: PROJ-1234\n...",
    "shared": [],
    "excluded": [],
    "repos": [
      {
        "folderName": "backend",
        "branch": "feature/PROJ-1234",
        "baseBranch": "main",
        "tipSha": "abc123def456",
        "remoteUrl": "https://github.com/org/backend",
        "status": "worktree"
      }
    ]
  },
  "session": null
}
```

---

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

## wksp vocabulary (so AI and I mean the same thing)

- **project** — this workspace: a folder grouping related repos under one idea.
- **repo** — a git repository registered in `repos.txt`.
- **task** — a unit of work inside the project, with its own worktree, `WORKLOG.md`, and `CLAUDE.md`.
- **hub** — the project's planning task (no worktree). Holds the feature backlog, cross-cutting design, open decisions, and cross-task references. Here the hub is `tasks/hub/`.

## Cross-cutting conventions
<!-- fill in: backend, frontend, branch naming, test commands... -->

## Where things live

- **The hub** (`tasks/hub/`) — the project's planning task and source of truth for project-wide plans. Consult it when a request touches project-wide design, references another task, or asks "what to work on next." Don't load it for work scoped to a single repo or task.

## Conflict policy
This file defines project-wide conventions. Tasks each have their own CLAUDE.md.
If you notice a contradiction between this file and a task's CLAUDE.md,
flag it immediately and ask for clarification before proceeding.
```

### Hub-level (generated for the reserved `hub` task)

```markdown
## Task: hub

This is the project **hub** — the planning/meta task. It holds the feature backlog,
agreed designs, open decisions, and cross-task references. It normally has **no worktree**.

## Feature backlog
<!-- numbered candidate features / work items -->

## Open decisions
<!-- decisions not yet made, with the context needed to make them -->

## Conflict policy
<!-- same as any task -->

## Work log
<!-- running record; see WORKLOG.md -->
```

### Task-level (generated by `wksp task`)

```markdown
## Task: PROJ-1234
## Goal: (describe the task here)

## Notes
<!-- decisions, constraints, references, links to tickets... -->

## Finishing this task
When the work is merged, clean up from inside the task — never check out the default branch here.
- Merge PRs with `gh pr merge <pr> --repo <owner>/<repo>` (the `--repo` flag keeps gh off the local checkout).
- After the merge lands, suggest `wksp task finish PROJ-1234` — verifies merged, archives, deletes branches, ff base repos.

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
