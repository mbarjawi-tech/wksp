# Changelog

All notable changes to this project. Follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and [Semantic Versioning](https://semver.org/).

---

## Unreleased — 2.2.0

### Added

- `wksp migrate` — detect and apply pending project schema migrations; `--dry-run` flag to preview without writing.
- `schemaVersion` field in `.wksp` — written by `wksp init` from v2.2.0 onwards; any wksp command warns and suggests `wksp migrate` when the project schema is outdated.
- **Shared dependency directories** — opt-in `sharedDeps` config key in `.wksp`; wksp creates junctions/symlinks so all worktrees of a repo share a single installed dep cache at `.wksp-cache/`. See [Shared dependency directories](/concepts#shared-dependency-directories).
  - `wksp task repo <id> <repo> own-deps` — switch a worktree to an independent dep install.
  - `wksp task repo <id> <repo> link-deps` — restore shared dep links.
  - Auto-opt-out on resume: if a worktree already has a real dep directory, wksp marks it as own-deps and warns instead of overwriting.
  - `task-own-deps.txt` — per-task file tracking opt-out worktrees; preserved in archive/unarchive cycle (`ownDepsRepos` field in `archived.json`).
- `wksp migrate` schema 1 → 2: adds `.wksp-cache/` to `.gitignore`.
- `wksp init` now adds `.wksp-cache/` to the generated `.gitignore`.

### Removed

- v1 positional syntax for `wksp repo` (`wksp repo <path>`, `wksp repo <path> --remove`) — use `wksp repo add` / `wksp repo remove` instead.
- v1 positional syntax for `wksp task` (`wksp task <id> --del`, `wksp task <id> --archive`, etc.) — use `wksp task delete` / `wksp task archive` etc. instead.

---

## 2.1.0 — 2026-05-28

### Added

- `wksp repo add <path-or-url>` — verb-first subcommand for registering a repo (`--shared` flag supported).
- `wksp repo remove <path-or-url>` — verb-first subcommand for removing a repo.

### Removed

- `wksp repo --as <alias>` — removed. It allowed registering the same repo twice under a different folder name so two branches could coexist in one task. The correct approach is to check the repo out into two separate physical directories and register each as a distinct path.

### Deprecated

- Old positional syntax (`wksp repo <path>`, `wksp repo <path> --remove`) still works but prints a deprecation warning. Will be removed in v2.2.0.

---

## 1.1.1 — 2026-05-26

### Changed

- `package.json` — added `"license": "MIT"` so npm displays the correct license.
- `docs/installation.md` — leads with `npm install -g @mbarjawi-tech/wksp`; moved clone-and-link to a "from source" section for contributors.

---

## 1.1.0 — 2026-05-26

### Added

- `wksp --version` / `-v` — print installed version and exit.
- Per-command `--help` / `-h` — all commands now accept a help flag.
- `wksp task --rename <new-id>` — rename a task in place: renames the folder, workspace file, CLAUDE.md header, and repairs git worktree paths.
- `wksp task --to-exclude <repo>` — exclude a repo from a task after creation; reversible with `--to-worktree`.
- `wksp repo --as <alias>` — register the same repo twice under different names *(removed in v2.1.0)*.
- `wksp status [task-id]` — now accepts an optional task-id argument so you can check status from anywhere in the project.
- `.code-workspace` filename is now printed to stdout when a task is created.
- `wksp config set/get` now support `--global` flag to read/write `~/.wksp` explicitly; project-level values override global.

### Changed

- Branch prompt defaults — smarter detection of the repo's default branch.
- `wksp config set` outside a project directory now silently saves to global config instead of erroring.
- `wksp init` — improved `reposRoot` prompt wording; prompt is skipped if already configured globally.
- `wksp --help` output expanded to cover all flags, config keys, and the `WKSP_DEBUG` env var.

### Fixed

- Tree diagram whitespace preserved using `<pre>` element in presentation output.

---

## 1.0.0 — 2026-05-01

Initial release.

### Features

- `wksp init` — scaffold a new project with `.wksp`, `repos.txt`, `CLAUDE.md`, and `tasks/`.
- `wksp repo` — register local paths or GitHub URLs; `--shared` flag for read-only repos.
- `wksp task` — full worktree lifecycle: create, resume, tear down; generates VS Code `.code-workspace` file and launches Claude.
- `wksp list` — show live and archived tasks.
- `wksp status` — show repo branches and health for the current task.
- `wksp cleanup` — prune stale worktree refs from base repos.
- `wksp delete` — destroy an entire project with confirmation.
- `wksp config` — read/write `reposRoot` and `autoResume` config keys.
- Archive/unarchive workflow with branch-state classifier (`present-local`, `merged`, `dangling`, `lost`, etc.).
- Auto-resume last Claude session on `wksp task`.
- VitePress documentation site.
