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

Released with wksp v2.2.0. Consolidates task files into JSON, adds shared dependency directories, and bumps `schemaVersion` from 1 → 3.

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

### Shared dependency directories *(schema 2 → 3)*

wksp can now share installed dependency directories (e.g. `node_modules`) across all worktrees of the same repo. This is opt-in — nothing changes unless you add `sharedDeps` to `.wksp`.

**What changed in the project file format:**

- New `.wksp-cache/` directory at the project root holds shared installs.
- New `task-own-deps.txt` per-task file tracks worktrees that opted out of sharing.
- `.wksp-cache/` is added to `.gitignore` so the cache is never committed.
- `archived.json` gains an `ownDepsRepos` field (defaults to `[]` on read — old archives are unaffected).

**Migration path:**

`wksp migrate` adds `.wksp-cache/` to your `.gitignore` if it's not already listed. That's the only required file change.

```bash
wksp migrate --dry-run   # preview
wksp migrate             # apply
```

After migrating, opt in by adding `sharedDeps` to `.wksp`:

```json
{
  "sharedDeps": ["node_modules"]
}
```

Projects without `sharedDeps` are completely unaffected — the migration only touches `.gitignore`.

---

## Upcoming: v2.3.0

The following deprecated syntaxes will be **removed** in v2.3.0:

- `wksp task <id>` positional form (all variants)
- `wksp repo <path>` and `wksp repo <path> --remove` positional forms
- `wksp cleanup --stale <path>` and `wksp cleanup <path> -r`

If you have scripts or aliases using the old syntax, update them to the v2 verb-first forms before upgrading to v2.3.0. Both the [reference](/reference) and the deprecation warnings printed at runtime show the replacement syntax.

No `wksp migrate` step will be needed for this change — it's CLI syntax only, no file format changes.
