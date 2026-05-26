# Changelog

All notable changes to this project will be documented here. Follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and [Semantic Versioning](https://semver.org/).

---

## [1.1.0] — 2026-05-26

### Added

- `wksp --version` / `-v` — print installed version and exit
- Per-command `--help` / `-h` — all commands now accept a help flag
- `wksp task --rename <new-id>` — rename a task in place: renames the folder, workspace file, CLAUDE.md header, and repairs git worktree paths
- `wksp task --to-exclude <repo>` — exclude a repo from a task after creation; reversible with `--to-worktree`
- `wksp repo --as <alias>` — register the same repo twice under different names, each getting its own worktree on a different branch
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
