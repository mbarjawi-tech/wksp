# Changelog

All notable changes to this project will be documented here. Follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and [Semantic Versioning](https://semver.org/).

---

## [2.9.0] — 2026-07-22

### Added

- `wksp task finish <id>` (alias: `done`) — an explicit way to close out a merged task. Finishing used to be undefined, and the obvious move backfires: `gh pr merge --delete-branch` run from inside a task worktree merges the PR remotely but then fails locally, because gh tries to check out the default branch and the base repo already holds it. `finish` cleans up from the wksp side instead: it fetches each base repo and verifies the task's branches are merged into the default branch (warning and asking first if any are not — a squash- or rebase-merged PR legitimately shows as unmerged), then runs the normal archive path with branch deletion defaulted (`--keep-branches` opts out), and finally fast-forwards each base repo's default branch — only when that repo is clean and already on it, otherwise it prints the `git pull --ff-only` command and leaves the repo alone. `--force` archives despite uncommitted changes, `--reason <text>` records why (default "finished"), and `--yes`/`-y` skips the confirmations for scripts. Omitting the id drops into the same picker as resume/delete/archive, and partial names match. New task `CLAUDE.md` files now also teach the AI the safe merge pattern — `gh pr merge --repo <owner>/<repo>`, which never touches the local checkout — and to suggest `wksp task finish` once the PR lands

### Fixed

- `wksp task rename` now migrates the task's Claude session history to match the new name. Claude keys transcripts by the task's absolute folder path, so renaming a task used to orphan all of its history — `wksp task resume` and the last-activity column in `wksp status` would then find nothing. Rename now detects the sessions under the old key and, after printing exactly what it will move and asking (default Yes), re-keys the directory under `~/.claude/projects` — touching only this task's two encoded dirs. `--no-migrate-sessions` skips the move (printing the manual command); `--yes`/`-y` auto-confirms for scripts/CI. If a directory already exists under the new key the two are merged: non-colliding sessions are moved across and `memory/` is merged file-by-file preferring the newer copy, never overwriting existing history. If the move can't complete — the folder is locked, or a collision leaves entries behind — rename warns clearly that the affected chat history is still under the old key and may be lost, and prints where it is so you can recover it. The `# Work Log:` heading in `WORKLOG.md` is now renamed too, matching the existing `## Task:` rewrite in `CLAUDE.md`

---

## [2.8.0] — 2026-07-17

### Added

- The **hub** is now a first-class wksp concept — a reserved, worktree-less planning task that holds a project's feature backlog, cross-cutting design, and open decisions. `wksp init` auto-creates a `hub` task (opt out with `wksp init --no-hub`) and its project `CLAUDE.md` now ships a `## wksp vocabulary` block plus a conditional pointer to the hub. Add a hub to an existing project with `wksp task create hub`, which explains what the hub is and asks before creating it; the name is reserved (you can't create a normal task called `hub`), and `delete`/`rename` of the hub warn first. Scaffolding only — no schema bump and no forced backfill, so existing projects are untouched until they opt in

### Fixed

- `wksp export` now includes the task's `WORKLOG.md` in the bundle (`task.worklogMd`), and `wksp import` restores it. Previously the work log was left behind on export and the imported task started with an empty `WORKLOG.md` — the running record of the work was silently lost on handoff. Bundles from older wksp versions (no `worklogMd` field) still import fine: the schema migration backfills an empty `WORKLOG.md` as before

---

## [2.7.0] — 2026-07-07

### Added

- `wksp task resume|delete|archive` no longer needs the full task name. Omit the id to pick from a numbered list of live tasks (sorted by most-recent activity, with worktree count and a relative date), or pass part of a name — e.g. `wksp task resume isa` — and a unique substring match is used; multiple matches drop into the picker, and an exact name always wins. Line-based prompt only, no new dependencies

---

## [2.6.0] — 2026-06-15

### Added

- Each new task now gets a `WORKLOG.md` file — Claude appends a brief entry after each meaningful set of changes, providing a running record of what was done and why
- `wksp migrate` schema 2 → 3: adds a `## Work log` instruction to existing task `CLAUDE.md` files and creates `WORKLOG.md` for tasks that don't have one
- `wksp migrate --repair`: re-applies every migration step even when the project is already stamped at the current schema. Backfills per-task artifacts (e.g. `WORKLOG.md`) that are missing because a task was created by an older wksp or brought in via `wksp import`. Idempotent — only fills in what is missing

### Fixed

- `wksp import` now runs schema migrations on the imported task instead of just stamping the project at the current version. Previously an imported task could be missing the artifacts of its stamped schema (e.g. `WORKLOG.md`), and `wksp migrate` would then report "already up to date" and never create them

---

## [2.5.0] — 2026-06-02

### Removed

- v1 positional syntax for `wksp task` — `wksp task <id>`, `wksp task <id> --del`, `--archive`, `--unarchive`, `--rename`, `--to-shared`, `--to-worktree`, `--to-exclude` no longer work; use the v2 verb-first subcommands (`wksp task create/resume/delete/archive/unarchive/rename/repo`)
- v1 positional syntax for `wksp repo` — `wksp repo <path>` and `wksp repo <path> --remove` no longer work; use `wksp repo add` / `wksp repo remove`
- `wksp cleanup --stale <path>` and `-r` flag no longer work; use `wksp cleanup <path>` and `--recursive`

---

## [2.4.0] — 2026-06-02

### Added

- `wksp export <task-id>` — bundle a task into a portable `.wksp-bundle` file containing project config, repo registrations, branch state, and optionally the Claude session transcript; `--out <file>` to control output path; `--with-session` to include the session
- `wksp import <file>` — read a `.wksp-bundle` and interactively rebuild the project and task; supports creating a new project (Mode 1) or adding the task to an existing project (Mode 2); reconciles repos by remote URL
- `wksp migrate` — detect and apply pending project schema migrations; `--dry-run` flag to preview without writing
- `schemaVersion` field in `.wksp` — written by `wksp init` from v2.2.0 onwards; any wksp command warns and suggests `wksp migrate` when the project schema is outdated
- `wksp repo list` — new subcommand listing all registered repos and their flags
- `wksp cleanup` zero-arg mode — scans all repos registered in the current project (no path required)
- `wksp cleanup --recursive` — prune all first-level subdirectory git repos inside a given path
- `task.json` — replaces `task-shared.txt` + `task-excluded.txt` with a single JSON file per task; existing `.txt` files continue to work (read transparently); `wksp migrate` converts them
- `wksp config clear <key> [--global]` — remove a config key entirely; project-level key reverts to global or built-in default

### Changed

- `wksp cleanup` signature — `--stale` flag is no longer required; new form is `wksp cleanup [<path>] [--recursive]`; old `--stale`/`-r` syntax still works with a deprecation warning
- `CURRENT_SCHEMA_VERSION` bumped from 1 → 2; `wksp migrate` now applies a 1→2 migration that converts legacy `.txt` task files to `task.json`
- `repos.txt` paths are now always written with forward slashes, regardless of how the path was provided or which command registered the repo

### Fixed

- `wksp delete` — no longer crashes with `EBUSY` when run from inside the project folder on Windows; also prints a hint to `cd ..` after the project folder is removed
- `wksp config set` — boolean and numeric values are now stored with their correct JSON type (`false` not `"false"`, `42` not `"42"`); plain strings (e.g. paths) are stored as-is
- `wksp init` next-steps message now shows current v2 syntax (`wksp repo add`, `wksp task create`) instead of old v1 syntax

### Removed

- v1 positional syntax for `wksp repo` (`wksp repo <path>`, `wksp repo <path> --remove`) — use `wksp repo add` / `wksp repo remove` instead
- v1 positional syntax for `wksp task` (`wksp task <id> --del`, `wksp task <id> --archive`, etc.) — use `wksp task delete` / `wksp task archive` etc. instead

---

## [2.1.0] — 2026-05-28

### Added

- `wksp repo add <path-or-url>` — verb-first subcommand for registering a repo (`--shared` flag supported)
- `wksp repo remove <path-or-url>` — verb-first subcommand for removing a repo

### Removed

- `wksp repo --as <alias>` — removed. It allowed registering the same repo twice under a different folder name so two branches could coexist in one task. The correct approach is to check the repo out into two separate physical directories and register each as a distinct path.

### Deprecated

- Old positional syntax (`wksp repo <path>`, `wksp repo <path> --remove`) still works but prints a deprecation warning. Will be removed in v2.2.0.

---

## [1.1.1] — 2026-05-26

### Changed

- `package.json` — added `"license": "MIT"` so npm displays the correct license
- `docs/installation.md` — leads with `npm install -g @mbarjawi-tech/wksp`; moved clone-and-link to a "from source" section for contributors

---

## [1.1.0] — 2026-05-26

### Added

- `wksp --version` / `-v` — print installed version and exit
- Per-command `--help` / `-h` — all commands now accept a help flag
- `wksp task --rename <new-id>` — rename a task in place: renames the folder, workspace file, CLAUDE.md header, and repairs git worktree paths
- `wksp task --to-exclude <repo>` — exclude a repo from a task after creation; reversible with `--to-worktree`
- `wksp repo --as <alias>` — register the same repo twice under different names, each getting its own worktree on a different branch *(removed in v2.1.0)*
- `wksp status [task-id]` — now accepts an optional task-id argument so you can check status from anywhere in the project, not just from inside the task folder
- `.code-workspace` filename is now printed to stdout when a task is created, so you can open it directly
- `wksp config set/get` now support `--global` flag to read/write `~/.wksp` explicitly; project-level values override global

### Changed

- Branch prompt defaults — smarter detection of the repo's default branch
- `wksp config set` outside a project directory now silently saves to global config instead of erroring
- `wksp init` — improved `reposRoot` prompt wording; prompt is skipped if already configured globally
- `wksp --help` output expanded to cover all flags, config keys, and the `WKSP_DEBUG` env var

### Fixed

- Tree diagram whitespace preserved using `<pre>` element in presentation output (#2)

---

## [1.0.0] — 2026-05-01

Initial release.

### Features

- `wksp init` — scaffold a new project with `.wksp`, `repos.txt`, `CLAUDE.md`, and `tasks/`
- `wksp repo` — register local paths or GitHub URLs; `--shared` flag for read-only repos
- `wksp task` — full worktree lifecycle: create, resume, tear down; generates VS Code `.code-workspace` file and launches Claude
- `wksp list` — show live and archived tasks
- `wksp status` — show repo branches and health for the current task
- `wksp cleanup` — prune stale worktree refs from base repos
- `wksp delete` — destroy an entire project with confirmation
- `wksp config` — read/write `reposRoot` and `autoResume` config keys
- Archive/unarchive workflow with branch-state classifier (`present-local`, `merged`, `dangling`, `lost`, etc.)
- Auto-resume last Claude session on `wksp task`
- VitePress documentation site
