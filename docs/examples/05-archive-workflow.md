# Example 5 — Archive Workflow

Builds on [Example 4](04-task-options.md). You know how to manage tasks. This example covers archiving: putting a completed task into cold storage while keeping its context, and bringing it back when needed.

## Why archive instead of delete

`--del` removes everything: worktrees, branches (optionally), and the task folder including CLAUDE.md. That's the right move for tasks you're truly done with.

Archive is for tasks that are done *for now* but might come back — a feature waiting for a second phase, a bug you can't reproduce yet, a spike you want to reference later. Archive:
- Removes the worktrees (frees disk space)
- Preserves the task folder: CLAUDE.md, notes, any files you left there
- Records the branch names and tip SHAs in `archived.json`
- Moves everything to `archived-tasks/`

When it comes back, you can rehydrate it with a single command.

## Archive a task

```bash
wksp task PROJ-1234 --archive
```

wksp checks for uncommitted changes. If any exist, it blocks and tells you what's dirty — you need to commit, stash, or discard before archiving. To override:

```bash
wksp task PROJ-1234 --archive --force
```

By default, local branches are kept in the base repos. To delete them at archive time:

```bash
wksp task PROJ-1234 --archive --delete-branches
```

After archive:

```
acme/
  archived-tasks/
    PROJ-1234/
      archived.json   ← rehydration manifest
      CLAUDE.md       ← preserved
      ...             ← any other files left in the task folder
  tasks/              ← PROJ-1234 is gone from here
```

## List archived tasks

```bash
wksp list --archived
```

```
acme — 3 archived tasks

  PROJ-1234   archived 2026-05-14
  PROJ-0987   archived 2026-03-02
  PROJ-0500   archived 2025-11-18
```

To see live and archived together:

```bash
wksp list --all
```

```
acme

  Task       Status     Worktrees
  PROJ-1234  archived   —
  PROJ-5678  live       3 worktrees, 1 shared
  PROJ-0987  archived   —
```

## Unarchive a task

```bash
wksp task PROJ-1234 --unarchive
```

wksp reads `archived.json`, classifies each repo's branch against the current state of the base repos, and picks a sensible default action per repo. When nothing unusual has happened, it runs silently and restores everything.

When something has changed — a branch was deleted, merged, or drifted — it prints a preview and asks for confirmation:

```
Restore plan for PROJ-1234:

  Repo                  Branch                State             Action
  backend               feature/PROJ-1234     present-local     worktree
  frontend              feature/PROJ-1234     merged            task-shared (main)
  services              feature/PROJ-5678     remote-only       worktree (from remote)

Apply? [y/N]:
```

## What "merged" looks like

If `feature/PROJ-1234` was merged into `main` and the branch was deleted, wksp detects this by checking whether the archived tip SHA is reachable from `main`. Rather than failing, it restores that repo as task-shared on `main` — so you can still open the task and read the code, even though the feature branch is gone.

## Unarchive flags

Preview without applying:

```bash
wksp task PROJ-1234 --unarchive --dry-run
```

Fetch remote refs in all base repos before classifying (catches remote-only branches):

```bash
wksp task PROJ-1234 --unarchive --fetch
```

Per-repo overrides:

```bash
# Skip a repo entirely
wksp task PROJ-1234 --unarchive --skip services

# Use a specific branch for a repo
wksp task PROJ-1234 --unarchive --branch backend=hotfix/PROJ-1234

# Restore a repo as task-shared
wksp task PROJ-1234 --unarchive --shared frontend
```

## Permanently delete an archived task

```bash
wksp task PROJ-1234 --del
```

Works the same way as on a live task. Since archive already removed the worktrees, there's nothing to tear down — it just asks for confirmation and deletes the folder.

To also remove branches that were kept at archive time:

```bash
wksp task PROJ-1234 --del --delete-branches
```

---

That's the full workflow. For a complete command listing and file format details, see the [Reference](../reference.md).
