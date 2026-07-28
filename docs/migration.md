# Migration Guide

This guide covers everything that changed between major wksp versions and how to update existing projects.

---

## The migration tool

wksp tracks each project's file format with a `schemaVersion` field in `.wksp`. When you run any wksp command inside an outdated project, you'll see:

```
  ⚠  This project was created with an older version of wksp.
     Run `wksp migrate` to update it.
```

Running the migration tool brings your project up to date:

```bash
wksp migrate           # apply all pending migrations
wksp migrate --dry-run # preview what would change without writing anything
```

`wksp migrate` is safe to run multiple times — if the project is already current it does nothing.

---

## v1.x → v2.0.0

Released with wksp v2.0.0. **No file format changes** — this was purely a CLI syntax change. All v1 commands still work in v2.0.x with a deprecation warning.

### `wksp task` — verb-first subcommands

| v1 syntax | v2 syntax |
|---|---|
| `wksp task <id>` | `wksp task create <id>` |
| `wksp task <id>` *(existing task)* | `wksp task resume <id>` |
| `wksp task <id> --del` | `wksp task delete <id>` |
| `wksp task <id> --rename <new>` | `wksp task rename <id> <new>` |
| `wksp task <id> --archive` | `wksp task archive <id>` |
| `wksp task <id> --unarchive` | `wksp task unarchive <id>` |
| `wksp task <id> --to-shared <repo>` | `wksp task repo <id> <repo> share` |
| `wksp task <id> --to-worktree <repo>` | `wksp task repo <id> <repo> worktree` |
| `wksp task <id> --to-exclude <repo>` | `wksp task repo <id> <repo> exclude` |

The v1 forms print a deprecation warning but still work. They are scheduled for removal in v2.2.0.

**No `wksp migrate` step needed** — nothing in the project files changed.

---

## v2.0.0 → v2.1.0

Released with wksp v2.1.0. Introduces one breaking change (`--as` alias removed) and one deprecation (`wksp repo` positional syntax).

### `wksp repo` — verb-first subcommands

| v1 syntax | v2 syntax |
|---|---|
| `wksp repo <path>` | `wksp repo add <path>` |
| `wksp repo <path> --shared` | `wksp repo add <path> --shared` |
| `wksp repo <path> --remove` | `wksp repo remove <path>` |

The old positional forms (`wksp repo <path>`, `wksp repo <path> --remove`) still work with a deprecation warning. They will be removed in v2.2.0.

### `--as <alias>` removed *(breaking)*

`wksp repo add <path> --as <alias>` has been removed. It allowed registering the same repo twice under different folder names so two branches could coexist in one task.

**Why it was removed:** the alias concept leaked into file formats, error messages, and worktree logic throughout the codebase — and the same outcome is better achieved by checking the repo out into two separate physical directories and registering each one. That approach is consistent and needs no special-casing.

**Migration path:**

If you have `--as` entries in `repos.txt`, `wksp migrate` will strip the alias suffixes automatically and explain what you need to do:

```bash
wksp migrate --dry-run   # preview
wksp migrate             # apply
```

For each stripped alias entry you'll need to set up the second checkout manually:

```bash
# Example: you had C:/dev/malachite  --as malachite-b
# Set up a second checkout in a new folder:
cd C:/dev
git clone /path/to/malachite malachite-b   # or: git worktree add manually
# Then register it as a normal repo:
wksp repo add C:/dev/malachite-b
```

---

## v2.1.0 → v2.2.0

Released with wksp v2.2.0. Consolidates two per-task text files into a single JSON file.

### `task-shared.txt` + `task-excluded.txt` → `task.json` *(schema 1 → 2)*

Previously, two separate files tracked which repos were shared or excluded from a task:

- `tasks/<id>/task-shared.txt` — one folder name per line
- `tasks/<id>/task-excluded.txt` — one folder name per line

These are now combined into a single `task.json`:

```json
{
  "shared": ["company-docs"],
  "excluded": ["legacy-service"]
}
```

**Migration path:**

```bash
wksp migrate --dry-run   # preview which task dirs will be converted
wksp migrate             # apply: writes task.json, deletes .txt files
```

`wksp migrate` converts every task in both `tasks/` and `archived-tasks/`. Existing projects without the `.txt` files (empty shared/excluded lists) need no file changes — only the `schemaVersion` in `.wksp` is bumped.

**Backward compatibility:** The `.txt` files continue to be read if `task.json` is not present, so all existing tasks work without migration. The migration is recommended to keep your project tidy and avoid any future `wksp migrate` prompt.

### `wksp cleanup` — overhaul

The `--stale` flag is no longer required. The new signature is:

```bash
wksp cleanup                   # scan all repos registered in this project
wksp cleanup <path>            # prune a specific repo
wksp cleanup <path> --recursive
```

The old syntax (`wksp cleanup --stale <path>`, `wksp cleanup <path> -r`) still works with a deprecation warning.

### `wksp repo list` — new subcommand

```bash
wksp repo list    # list all registered repos and their flags
```

---

## Upcoming: v2.3.0

The following deprecated syntaxes will be **removed** in v2.3.0:

- `wksp task <id>` positional form (all variants)
- `wksp repo <path>` and `wksp repo <path> --remove` positional forms
- `wksp cleanup --stale <path>` and `wksp cleanup <path> -r`

If you have scripts or aliases using the old syntax, update them to the v2 verb-first forms before upgrading to v2.3.0. Both the [reference](/reference) and the deprecation warnings printed at runtime show the replacement syntax.

No `wksp migrate` step will be needed for this change — it's CLI syntax only, no file format changes.

---

## v2.x → v3.0.0 — root-as-hub *(schema 3 → 4)*

v3.0.0 reverts the v2.8.0 reserved `hub` task and makes the **project root the planning surface**, and canonicalizes instruction files to **AGENTS.md**.

### What changes

- The reserved `hub` task is gone: no `wksp task create hub` special-casing, no reserved-name guards. `wksp init --no-hub` is removed.
- New `wksp start [task-id]` command: no args → planning session at the project root; with an id → create/resume that task.
- The root gains `PLANNING.md` (feature backlog + open decisions) and a root `WORKLOG.md`.
- `AGENTS.md` becomes the canonical instruction file at the root and in every task. `CLAUDE.md` becomes a one-line `@AGENTS.md` include so Claude keeps reading the same content. Other tools read `AGENTS.md` natively.

### Migration path

```bash
wksp migrate --dry-run   # preview
wksp migrate             # apply
```

The schema 3 → 4 step handles all three starting states — pre-2.8.0 projects (no hub), 2.8.0 projects (with `tasks/hub/`), and projects whose hub was renamed (treated as a normal task):

1. **`tasks/hub/` merges into the root.** The hub's instruction file becomes `PLANNING.md` (template boilerplate stripped, your backlog and decisions kept); the hub `WORKLOG.md` merges into the root `WORKLOG.md`; then `tasks/hub/` is removed. A hub that still has worktrees is left in place with a warning — move that work to a real task and re-run `wksp migrate --repair`.
2. **Missing planning files are scaffolded.** Projects that never had a hub get a fresh `PLANNING.md` and root `WORKLOG.md`.
3. **Instruction files are converted.** At the root and in every task (live and archived): existing `CLAUDE.md` content moves to `AGENTS.md`, and `CLAUDE.md` is rewritten to the one-line include. Unedited 2.8.0 template blocks referencing the hub are modernized; your own prose is never rewritten. If both a real `AGENTS.md` and a real `CLAUDE.md` already exist, wksp warns and leaves both for you to merge.
4. **Hub chat history is offered a re-key.** Claude keys session transcripts by folder path, so hub sessions are stranded once `tasks/hub/` is gone. The migration asks (default Yes) before touching `~/.claude` and moves the hub's session directory to the project-root key so `wksp start` resumes it. Declined or skipped? Re-run `wksp migrate --repair` anytime — the offer repeats even after the hub folder is gone.

---

## v3.0.0 → v3.1.0 — headless delegation *(schema 4 → 5)*

v3.1.0 makes wksp drivable from an AI session — see [Headless wksp](/headless). The commands work regardless of your schema version; the migration exists so **existing projects learn the flow**, which is the part that isn't discoverable on its own.

### What changes

Nothing about your files' structure. The schema 4 → 5 step adds two sections to your project's root `AGENTS.md`:

- **Delegating work to a task (from here, headless)** — the four-step recipe a planning session follows to create a task, work in it, and close it out.
- **What belongs here vs. in a task** — which information lives at the root and which lives in a task, so hub-driven work doesn't scatter.

The bump exists because those sections are how a planning session *knows* the headless flow is available. Without them the feature ships invisible to every project that already exists.

### Migration path

```bash
wksp migrate --dry-run   # preview: shows where the section would be inserted
wksp migrate             # apply
```

The step only ever **inserts**, never rewrites — your prose is untouched:

1. The block goes in before your `## Cross-cutting conventions` heading (where the template puts it). If you've removed that heading, it falls back to `## AI provider self-check`, then `## Conflict policy`, then `## Work log`; if the file has none of them, it's appended at the end.
2. A file that already documents the flow — including one where you've written your own version under that heading — is left alone.
3. If a real `AGENTS.md` and a real `CLAUDE.md` both still exist at the root (the unresolved 3 → 4 conflict), this step stands down rather than dropping new text into a pending merge. Resolve that, then run `wksp migrate --repair`.

Task-level instruction files are not touched: delegation is a root concern.

If you'd rather not have the sections, delete them and add your own guidance — nothing in wksp depends on their presence, and the commands behave identically either way. Note that `wksp migrate --repair` re-applies every step, so it will re-add them.
