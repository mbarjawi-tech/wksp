# Example 2 — Multiple Repos

Builds on [Example 1](01-getting-started.md). You have an `acme` project with one repo (`backend`). Now you'll add a frontend repo, a shared docs repo, and see how they all behave on task creation and resume.

## Add a second repo

```bash
wksp repo /c/dev/frontend
```

`repos.txt` now has two entries:

```
C:/dev/backend
C:/dev/frontend
```

## Add a shared repo

Some repos you only read from — documentation, design systems, reference data. Mark them `--shared` to use their original folder in every task without ever creating a worktree:

```bash
wksp repo /c/dev/company-docs --shared
```

`repos.txt`:

```
C:/dev/backend
C:/dev/frontend
C:/dev/company-docs  --shared
```

Shared repos appear in the VS Code workspace and are passed to Claude as `--add-dir`, but no branch management is needed. They always reflect whatever branch they're on in the base clone.

## Clone from GitHub

If the repo isn't cloned yet, pass the GitHub URL:

```bash
wksp repo https://github.com/your-org/services
```

wksp clones into `reposRoot` (set in `~/.wksp`) if the repo isn't already there, then registers the local path. This is a one-time operation — future `wksp task` calls use the local clone.

## Create a task with multiple repos

```bash
wksp task PROJ-1234
```

You're prompted once per non-shared repo:

```
Branch for backend [main, s=shared, x=exclude]: feature/PROJ-1234
Branch for frontend [main, s=shared, x=exclude]: feature/PROJ-1234
Branch for services [main, s=shared, x=exclude]: feature/PROJ-1234
```

The shared repo (`company-docs`) is not prompted — it uses its base path automatically.

The startup summary after all worktrees are created:

```
────────────────────────────────────────────
  wksp · acme / PROJ-1234
────────────────────────────────────────────
  Repos:

    backend              feature/PROJ-1234   (worktree)
    frontend             feature/PROJ-1234   (worktree)
    services             feature/PROJ-1234   (worktree)
    company-docs         main                (shared)
────────────────────────────────────────────
```

## Staleness warnings

If a worktree's branch is behind the repo's default branch, a warning appears:

```
    backend    feature/PROJ-1234   (worktree)  ⚠ 3 commits behind main
```

This uses locally cached remote refs — no network fetch at launch. To check for new upstream commits, fetch manually from inside the worktree.

## Resume after adding a new repo

Suppose you register `notifications` after PROJ-1234 already exists:

```bash
wksp repo /c/dev/notifications
wksp task PROJ-1234
```

wksp detects that `notifications` has no worktree in PROJ-1234 and prompts just for that one:

```
New repo since last run: notifications
Branch for notifications [main, s=shared, x=exclude]: feature/PROJ-1234
```

Existing worktrees are untouched.

## Remove a repo

```bash
wksp repo /c/dev/old-service --remove
```

The entry is removed from `repos.txt`. If any tasks still have a worktree for that repo, wksp prints a warning — you can clean those up with `wksp task <id> --del` or `wksp cleanup --stale`.

---

**Next:** [Example 3 — Concurrent Tasks](03-concurrent-tasks.md)
