# Reference

## Global flags

| Flag | Description |
|---|---|
| `--version`, `-v` | Print the installed version and exit. |
| `--help`, `-h` | Print usage for a command and exit. Supported on all commands. |

---

## Commands

### `wksp init [name]`

Create a new project. Scaffolds `.wksp`, `repos.txt`, `tasks/`, and the planning surface at the root: `AGENTS.md` (project conventions — canonical instruction file), `CLAUDE.md` (a one-line `@AGENTS.md` include for Claude), `PLANNING.md` (feature backlog + open decisions), and `WORKLOG.md`. Prompts for `reposRoot` if not already set (skippable — you can add it later with `wksp config set`).

```bash
wksp init acme
```

---

### `wksp start [task-id]`

The unified entry point.

```bash
wksp start                     # planning session at the project root
wksp start PROJ-1234           # create or resume a task (partial names match)
wksp start PROJ-1234 --json    # ensure the task exists; print its brief, launch nothing
```

With **no arguments**, launches the AI tool at the project root and resumes the last root session. The root is the [planning hub](#the-root-is-the-planning-hub): `PLANNING.md` holds the backlog and open decisions, no repos are checked out there. Typing the AI tool's own command at the root lands in the same session history — sessions key off the root path either way.

With an **id**, resumes that task (partial names match, exactly like `wksp task resume`); if nothing matches, offers to create a task with that name (default Yes).

With an **id and any headless flag** (`--json`, `--no-launch`, `--yes`, `--branch`, …), passes them straight to `wksp task create` / `resume` — so a planning session can set a task up without leaving the root. `--yes` also skips the "create it?" confirmation. See [Headless wksp](/headless). `--json` requires an id: root planning is a session, not a document.

#### The root is the planning hub

The project root replaces the pre-3.0 reserved `hub` task as the planning surface:

- `PLANNING.md` — the living overview: feature backlog, open decisions, research pointers. Scaffolded by `wksp init`; kept deliberately out of `AGENTS.md` so backlog content doesn't ride into every task session's context.
- Root `WORKLOG.md` — running record of planning work, same conventions as task worklogs.
- The root `AGENTS.md` ships a docs-structure rule: `PLANNING.md` stays readable in one pass; sections graduate to files under `docs/` when they outgrow a screenful; everything that moves out leaves a one-line link behind.
- Planning is personal-by-default: root planning files are not part of `wksp export` (which stays per-task).

It's scaffolding, not schema: wksp never depends on these files existing.

---

### `wksp repo <subcommand> <path-or-url>`

Register and manage repos within the current project.

- **Local path** — added directly to `repos.txt`.
- **GitHub URL** — cloned into `reposRoot` (skipped if already cloned), then the local path is added.

```bash
wksp repo add /c/dev/backend
wksp repo add https://github.com/your-org/frontend
wksp repo add /c/dev/company-docs --shared
wksp repo add /c/dev/scratch-tools --optional
wksp repo remove /c/dev/old-service
```

| Subcommand | Description |
|---|---|
| `list` | List all registered repos and their flags. |
| `add <path-or-url>` | Register a repo. Use `--shared` to always use the original path (no worktree). Use `--optional` for a repo only some tasks need — tasks exclude it silently instead of prompting; pull it in with `wksp task repo <id> <repo> worktree`. |
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
wksp task repo PROJ-1234 infra worktree --branch feat/tz   # no branch prompt
wksp task brief PROJ-1234       # print what's needed to work in the task, without launching
```

`create` — prompts for a branch per repo, creates worktrees, generates a VS Code `.code-workspace` file (printed to stdout), then launches the AI tool. Repos registered `--optional` are skipped silently — they start excluded, and the launch summary shows them as `(optional)`.

`resume` — scans existing worktrees, detects any new repos added since last run (prompts for branches for those; `--optional` repos are recorded as excluded without a prompt), then launches the AI tool.

Both take headless flags, so a session at the project root can set a task up and work in it without launching a second one — see [Headless wksp](/headless):

```bash
wksp task create PROJ-1234 --goal "Fix timezone drift" --branch feat/tz --json
wksp task create PROJ-1234 --branch feat/tz --dry-run     # show the plan, create nothing
wksp task create PROJ-1234 -y --branch feat/tz            # no questions, then launch as usual
```

A headless run validates the whole plan before touching anything: an unknown repo name, a missing repo path, a branch already checked out in another worktree, or two repos claiming one folder name is an error naming the flag that fixes it — and the task is left uncreated.

`rename` — renames the task folder, repairs worktrees, renames the `.code-workspace` file, and updates the `## Task:` / `# Work Log:` headings. Because Claude keys session transcripts by the task's folder path, rename also offers to move that history under the new key so `resume` and `status` keep finding it — it shows what it will move and asks (default Yes). Use `--no-migrate-sessions` to skip the move, or `--yes` / `-y` to auto-confirm.

`brief` — prints everything needed to work in a task without launching a session: the task folder, its instruction file and work log, the project's `AGENTS.md` / `PLANNING.md`, each repo with its mode and branch, and the working rules. `--json` emits the same document machine-readably — the same shape `create --json` and `resume --json` return. Read-only; it changes nothing.

`finish` (alias: `done`) — the post-merge completion verb. Fetches each base repo and verifies the task's branches are merged, in tiers, most-authoritative first. First it checks git ancestry, which catches true merge-commits and fast-forwards. A squash- or rebase-merged PR is a *new* commit on the default branch, so its branch tip is never an ancestor — git alone can't tell that apart from an abandoned branch. So when ancestry comes up empty, finish asks GitHub: if `gh` is on PATH and the base repo's `origin` is a GitHub remote, it queries the branch's PR and, on a merged PR, prints `✓ <branch> merged — PR #N (confirmed on GitHub)` and proceeds. `gh` is optional and feature-detected — missing, offline, erroring, or a non-GitHub remote all degrade silently. Only if nothing confirms the merge does finish warn (`⚠ Couldn't confirm <branch> is merged — a squash-/rebase-merged PR looks exactly like this even when it merged; verify the PR`) and ask before continuing. It then archives the task exactly like `archive` but with branch deletion defaulted (`--keep-branches` opts out), and finally fast-forwards each base repo's default branch — only when that repo is clean and already sitting on it; otherwise it prints the `git pull --ff-only` command and leaves the repo alone. Merge PRs from inside a task with `gh pr merge <pr> --repo <owner>/<repo>` — the `--repo` flag keeps gh from trying to check out the default branch locally, which fails inside a worktree.

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

Repos registered with `--optional` never reach this prompt — they start excluded. Pull one into a task with `wksp task repo <id> <repo> worktree` (answer `s` at the branch prompt to use it shared instead).

#### Flags

| Subcommand | Flag | Description |
|---|---|---|
| `create`, `resume` | `--json` | Emit the task brief as JSON on stdout. Implies `--yes` + `--no-launch`. |
| `create`, `resume` | `--no-launch` | Set the task up and print its brief as text; don't launch the AI tool. |
| `create`, `resume` | `--yes`, `-y` | Never ask: repos with no flag take their defaults. |
| `create`, `resume` | `--dry-run` | Show the plan and create nothing. Implies `--yes` + `--no-launch`. |
| `create`, `resume` | `--branch <repo>=<branch>` | Branch for one repo (repeatable). Bare `--branch <branch>` applies to every repo. |
| `create`, `resume` | `--base <repo>=<branch>` | Where a branch that doesn't exist yet starts. Also `--base <branch>`. |
| `create`, `resume` | `--shared <repo>` | Use the base repo path for this task, no worktree (repeatable). |
| `create`, `resume` | `--exclude <repo>` | Leave the repo out of this task (repeatable). |
| `create`, `resume` | `--goal <text>` | Fill in the `## Goal:` line of the task's `AGENTS.md`. |
| `brief` | `--json` | Machine-readable brief (same shape as `create --json`). |
| `repo` | `--branch <branch>` | Branch for `worktree` mode — skips the branch prompt, so this verb works headlessly. |
| `repo` | `--base <branch>` | Base for a branch that doesn't exist yet. |
| `repo` | `--yes`, `-y` | Don't ask. Refuses to discard uncommitted work rather than removing a dirty worktree to switch modes. |
| `delete` | `--delete-branches` | Also delete local branches when tearing down. |
| `delete` | `--yes`, `-y` | Don't ask. Never discards uncommitted changes and never force-deletes unmerged branches — it keeps the task and says why. |
| `archive` | `--delete-branches` | Delete local branches during archive. |
| `archive` | `--force` | Archive even when uncommitted changes exist. |
| `archive` | `--yes`, `-y` | Skip the confirmation. |
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
wksp list --json      # machine-readable inventory (honors --archived / --all)
```

`--json` emits `{ ok, project, tasks[] }`, where each task carries its `id`, `status` (`live` or `archived`), absolute `dir`, and either its `worktrees` (name + branch) or its `archivedAt` / `reason`.

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
| `--repair` | Re-apply every step even when the project is already stamped current. Use when a project or task is missing an artifact it should have (common for tasks created by an older wksp or brought in via `wksp import`). Every step is idempotent — it fills in what's missing and never duplicates. |

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
# Format: <path> [--shared] [--optional]
# Any path format is accepted (Windows backslash, forward slash, POSIX)

C:/dev/backend
C:/dev/frontend
C:/dev/company-docs  --shared
C:/dev/scratch-tools  --optional
```

`--shared` — never gets a worktree; every task uses the original path directly.

`--optional` — excluded from tasks by default: creating or resuming a task records it as excluded silently instead of prompting. Pull it into a task with `wksp task repo <id> <repo> worktree`.

### `tasks/<id>/task.json`

Records which repos use a shared path or are excluded from the task. Both keys are optional and omitted when their list is empty.

```json
{
  "shared": ["company-docs"],
  "excluded": ["legacy-service"]
}
```

`shared` — repos using the base path directly (no worktree), by folder name. Written when the user types `s` at the branch prompt or runs `wksp task repo … share`.

`excluded` — repos excluded from the task entirely, by folder name. Written when the user types `x` at the branch prompt or runs `wksp task repo … exclude`. Repos registered `--optional` are recorded here automatically (and silently) the first time the task launches.

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
    "agentsMd": "## Task: PROJ-1234\n...",
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

## Instruction-file templates

`AGENTS.md` is the **canonical** instruction file everywhere. Because the `claude` provider reads `CLAUDE.md`, wksp writes a companion `CLAUDE.md` next to every `AGENTS.md` containing exactly one line — `@AGENTS.md` — so Claude includes the canonical file. (No symlinks: they need elevation on Windows.) Edit `AGENTS.md`; never put content in the include stub.

### Project-level `AGENTS.md` (generated by `wksp init`)

```markdown
## Project: acme

## wksp vocabulary (so AI and I mean the same thing)

- **project** — this workspace: a folder grouping related repos under one idea.
- **repo** — a git repository registered in `repos.txt`.
- **task** — a unit of work inside the project, with its own worktree, `WORKLOG.md`, and `AGENTS.md`.

## The project root is the planning hub

Sessions at the project root are for planning: the feature backlog, cross-cutting design,
open decisions, and how tasks relate. Don't edit repo code here — repos are checked out
inside tasks, not at the root. When a discussion turns into implementation work, suggest
`wksp task create <id>` (or `wksp start <id>`) and continue there.

- **`PLANNING.md`** is the living overview: the feature backlog, open decisions, and
  research pointers.

## Docs structure

- `PLANNING.md` must stay readable in one pass — it is always loaded.
- New topics start as sections in `PLANNING.md`; graduate a section to its own file
  under `docs/` when it outgrows a screenful; everything that moves out leaves a
  one-line link behind — `PLANNING.md` is the index.

## Delegating work to a task (from here, headless)

1. `wksp task create <id> --goal "<one line>" --branch <branch> --json`
2. Work inside the repo paths that brief lists. Read `tasks/<id>/AGENTS.md` first.
3. Record what you did in `tasks/<id>/WORKLOG.md`, not here.
4. `wksp task brief <id>` reprints the context; `wksp task finish <id> --yes` closes it out.

## What belongs here vs. in a task

| Here (project root) | In `tasks/<id>/` |
|---|---|
| `PLANNING.md` — backlog, open decisions | `AGENTS.md` — that task's goal and scope |
| `WORKLOG.md` — what was decided, and why | `WORKLOG.md` — what was actually changed |

- If it stays true after the task is archived, it belongs here.
- A decision graduates upward exactly once: task keeps the detail, root keeps the conclusion.
- Never put backlog content in this file — it is loaded into every task session.

## Cross-cutting conventions
<!-- fill in: backend, frontend, branch naming, test commands... -->

## Conflict policy
This file defines project-wide conventions. Tasks each have their own AGENTS.md.
```

The delegation and information-boundary sections are what make hub-driven work sustainable — see [Headless wksp](/headless) for the full rules. Existing projects get them from the schema 4 → 5 migration, which inserts the block without rewriting anything you've written (see the [migration guide](/migration#v3-0-0-v3-1-0-headless-delegation-schema-4-5)).

### `PLANNING.md` (generated by `wksp init`)

```markdown
# Planning — acme

The living overview of the *acme* project: feature backlog, open decisions, research
pointers. Keep it readable in one pass.

## Feature backlog
<!-- numbered candidate features / work items, newest thinking wins -->

## Open decisions
<!-- decisions not yet made, with the context needed to make them -->
```

### Task-level `AGENTS.md` (generated by `wksp task create` / `wksp start <id>`)

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
The project-level AGENTS.md defines shared conventions. This file adds task-specific context only.
If anything here contradicts the project-level AGENTS.md, flag the contradiction
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
