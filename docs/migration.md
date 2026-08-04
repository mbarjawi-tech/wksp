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

---

## v3.1.x → v3.2.0 — orchestration guidance *(schema 5 → 6)*

v3.2.0 adds the guidance an AI needs to *orchestrate* delegated work from the project root — see [Headless wksp](/headless). Like the 4 → 5 step, this is content only; the schema bump exists so **existing projects learn the flow**, which isn't discoverable on its own.

### What changes

Nothing about your files' structure. The schema 5 → 6 step adds three sections to your project's root `AGENTS.md`:

- **Reviewing a delegated PR (review → fix → re-review)** — when and how to run an independent review loop before a coding/behaviour PR merges, and how the `reviewLoop` setting gates it.
- **Steering a task: resume, fresh, or new** — the durable-task model (the task, not the agent, is what persists) and the rule of thumb: resume for continuation, spawn fresh for independence, open a new task for a separate concern.
- **Agent-honored settings** — the `reviewLoop`, `prGate`, and `mergeMethod` keys the orchestrator reads (and wksp's CLI deliberately does not act on), with their values and defaults.

### Migration path

```bash
wksp migrate --dry-run   # preview: shows where the section would be inserted
wksp migrate             # apply
```

The step only ever **inserts**, never rewrites — your prose is untouched, and it mirrors the 4 → 5 step's safety rules exactly:

1. The block goes in before your `## Cross-cutting conventions` heading (where the template puts it, right after the delegation block). If you've removed that heading, it falls back to `## AI provider self-check`, then `## Conflict policy`, then `## Work log`; if the file has none of them, it's appended at the end.
2. A file that already documents the orchestration flow — including one where you've written your own version under that heading — is left alone.
3. If a real `AGENTS.md` and a real `CLAUDE.md` both still exist at the root (the unresolved 3 → 4 conflict), this step stands down rather than dropping new text into a pending merge. Resolve that, then run `wksp migrate --repair`.

Task-level instruction files are not touched: orchestration is a root concern.

The three settings are **agent-honored**: nothing in wksp reads them, so leaving them unset changes no CLI behaviour, and the documented defaults (`reviewLoop: ask`, `prGate: never`, `mergeMethod: squash`) preserve how things work today. If you'd rather not have the guidance sections, delete them — `wksp migrate --repair` will re-add them, as it re-applies every step.

---

## v3.3.x → v3.4.0 — hub guidance split *(schema 6 → 7)* {#v3-3-x-v3-4-0-hub-guidance-split-schema-6-7}

v3.4.0 moves **hub-only** guidance out of the root `AGENTS.md` and into a new root
`ORCHESTRATION.md`. This is the first migration step that **removes** text from a file you
own, so it is deliberately conservative — see the safety rules below.

### Why

The root instruction file is passed into **every** task session (`--add-dir` at the project
root). Just over half of it — measured at 79 of 143 lines, ~1.2k tokens — was
orchestrator-only: the headless delegation recipe, and the review-loop / task-steering /
agent-honored-settings trio. Tokens were the smaller half of the problem. The bigger half is
role confusion: a task-scoped agent was being told how to delegate work, spawn reviewers and
choose merge methods, which invites it to act out of role, and no test catches that.

The mechanism is one wksp already proves. Only the *instruction* file is injected into a task
session, so a file sitting beside it at the root is reachable by a planning session and
invisible to tasks — exactly how `PLANNING.md` keeps the backlog out of every task's context.

### What changes

| Moves to `ORCHESTRATION.md` | Stays in `AGENTS.md` |
|---|---|
| Delegating work to a task (from here, headless) | Project heading and wksp vocabulary |
| Reviewing a delegated PR (review → fix → re-review) | The project root is the planning hub |
| Steering a task: resume, fresh, or new | Docs structure |
| Agent-honored settings (`reviewLoop`, `prGate`, `mergeMethod`) | What belongs here vs. in a task |
| *New:* [Stacked PRs](/stacked-prs) — merge order, not build order | Cross-cutting conventions, AI provider self-check, conflict policy, work log |

`AGENTS.md` keeps a short **pointer** — "you are the hub; read `ORCHESTRATION.md` before
delegating, reviewing, or merging" — so a planning session still finds the guidance.

Two content corrections ride along, in templates only (no existing file is rewritten):

- The **task** `AGENTS.md` template's "Finishing this task" section used to teach
  `gh pr merge <pr> --repo <slug>` unconditionally. That command is **refused for a stack
  member**, so the text is now stack-aware: a solo PR merges that way, a stack member is left
  to the hub's `gh stack merge`.
- `mergeMethod` is documented as governing **solo** PR merges, and as a preference that the
  repo may not permit — check `squashMergeAllowed` before passing `--squash`.

### Migration path

```bash
wksp migrate --dry-run   # preview: shows the new file and every block that would be removed
wksp migrate             # apply
```

### Safety rules

1. **Only text wksp wrote is removed.** Each relocated block must still match the shipped
   template **byte-for-byte**. Change a word, add a line, re-indent it — and it no longer
   matches, so it is **left in place** and reported:

   ```
   ⚠  AGENTS.md — you've edited the headless delegation recipe, so it was left in place.
      The shipped version now lives in ORCHESTRATION.md; delete "## Delegating work to a
      task (from here, headless)" (and what follows it) by hand once you're happy with it.
   ```

   Your prose is never rewritten and never deleted. The two blocks are judged independently —
   an edited delegation recipe doesn't stop the orchestration block from relocating.
2. **An existing `ORCHESTRATION.md` is never overwritten.** If you already have one, wksp says
   so and leaves it alone; the instruction file is still cleaned up.
3. **Idempotent.** Re-runs, `wksp migrate --repair` and `wksp import` add nothing and remove
   nothing. The pointer is the marker.
4. **It stands down on an unresolved conflict.** While a real `AGENTS.md` and a real
   `CLAUDE.md` both exist at the root (the 3 → 4 conflict), nothing is written or removed and
   no guidance file is created. Resolve the merge, then `wksp migrate --repair`.
5. **Root file only.** Task instruction files — live and archived — are not touched.

One thing that looks odd in the output of a longer upgrade: a project coming from schema 4 or
5 sees the 4 → 5 / 5 → 6 steps *add* those blocks and then the 6 → 7 step *relocate* them, in
the same run. Each step is individually correct and the end state is the same as a project
that was already at 6; nothing is written twice.

If you'd rather not keep `ORCHESTRATION.md`, delete it and write your own guidance — nothing in
wksp depends on it existing. Note that `wksp migrate --repair` re-applies every step, so it
will re-create the file (it will not re-add the sections to `AGENTS.md`).
