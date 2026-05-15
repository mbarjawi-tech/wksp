# Example 3 — Concurrent Tasks

Builds on [Example 2](02-multiple-repos.md). You have PROJ-1234 active with worktrees on `feature/PROJ-1234`. Now you need to start a second feature — without touching the first.

## Create a second task

```bash
wksp task PROJ-5678
```

The prompts ask for branches just like before. Both tasks can use the same branch name (they're separate worktrees) or different ones:

```
Branch for backend [main, s=shared, x=exclude]: feature/PROJ-5678
Branch for frontend [main, s=shared, x=exclude]: feature/PROJ-5678
Branch for services [main, s=shared, x=exclude]: s
```

Here `services` was entered as `s` (shared) — this task doesn't need changes there, so it uses the base repo path directly.

The project folder now looks like:

```
acme/
  tasks/
    PROJ-1234/
      worktrees/
        backend/                  ← on feature/PROJ-1234
        frontend/    ← on feature/PROJ-1234
        services/          ← on feature/PROJ-1234

    PROJ-5678/
      task-shared.txt         ← contains path to services
      worktrees/
        backend/                  ← on feature/PROJ-5678
        frontend/    ← on feature/PROJ-5678
```

Both tasks exist simultaneously. The `backend` base repo has two active worktrees on different branches. git handles this fine.

## Switching between tasks

To resume PROJ-1234:

```bash
wksp task PROJ-1234
```

To resume PROJ-5678:

```bash
wksp task PROJ-5678
```

In VS Code: open the `.code-workspace` file for the task you want. You can have both open in separate windows.

## List all tasks

```bash
wksp list
```

```
acme — 2 tasks

  PROJ-1234   3 worktrees, 1 shared
  PROJ-5678   2 worktrees, 1 shared
```

## Clean up a finished task

When PROJ-5678 is merged and you no longer need the worktrees:

```bash
wksp task PROJ-5678 --del
```

wksp lists what it will remove and asks for confirmation:

```
Will remove:
  worktrees/backend          (feature/PROJ-5678)
  worktrees/frontend  (feature/PROJ-5678)

Confirm? [y/N]:
```

After tearing down the worktrees, it asks whether to delete the local branches:

```
Delete local branches (feature/PROJ-5678)? [y/N]:
```

If a branch has unmerged commits, wksp warns and asks for explicit force-delete confirmation before removing it.

## Why the base repos are never touched

The base clones (`/c/dev/backend` etc.) sit on whatever branch they were on before. wksp never checks them out to a different branch and never touches them during task create, resume, or delete. They're purely the git database backing all the worktrees.

You can leave the base repos on `main` and use them as a stable reference while tasks work on their own branches in isolated worktrees.

---

**Next:** [Example 4 — Task Options](04-task-options.md)
