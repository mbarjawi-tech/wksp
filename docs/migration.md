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

## Upcoming: v2.2.0

The following deprecated syntaxes will be **removed** in v2.2.0:

- `wksp task <id>` positional form (all variants)
- `wksp repo <path>` and `wksp repo <path> --remove` positional forms

If you have scripts or aliases using the old syntax, update them to the v2 verb-first forms before upgrading to v2.2.0. Both the [reference](/reference) and the deprecation warnings printed at runtime show the replacement syntax.

No `wksp migrate` step will be needed for this change — it's CLI syntax only, no file format changes.
