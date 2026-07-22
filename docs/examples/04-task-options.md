# Example 4 — Task Options

Builds on [Example 3](03-concurrent-tasks.md). You know how to create and clean up tasks. This example covers the options that let you fine-tune how each repo participates in a specific task.

## Excluding a repo from a task

Sometimes a task genuinely has nothing to do with a particular repo. Enter `x` at the branch prompt:

```
Branch for notifications [main, s=shared, x=exclude]: x
```

`notifications` is recorded as excluded in this task's `task.json`. It won't appear in the VS Code workspace and won't be passed to Claude. The exclusion persists on every resume — you're not asked again.

This is per-task and doesn't affect other tasks or `repos.txt`.

## Using a repo as shared mid-task

You created a task and gave `services` a worktree on `feature/PROJ-1234`. Now you realize you don't need to make changes there — and you're getting a branch-conflict error because `main` is already checked out in the base clone.

Remove the worktree and switch to shared for this task:

```bash
wksp task repo PROJ-1234 services share
```

If the worktree has uncommitted changes, wksp lists them and asks before removing:

```
services has uncommitted changes:
  M src/routes/index.js

Remove worktree anyway? [y/N]:
```

After switching to `share`, `services`'s base path is used directly for this task. The worktree is gone; the base repo is untouched.

## Converting back to a worktree

You changed your mind — `services` does need changes after all. Or you used `x` to exclude it but now need to include it:

```bash
wksp task repo PROJ-1234 services worktree
```

This is the "ensure a worktree exists" command. It:
- Clears any task-shared or task-excluded record for this repo
- Prompts for a branch name
- Creates the worktree

If the repo already has a worktree in this task, it's a no-op.

## The branch-conflict case

git enforces that the same branch cannot be checked out in two worktrees at once. This comes up when you want a worktree on `main`, but `main` is already the base clone's branch.

```
Branch for backend [main, s=shared, x=exclude]: main
✖ main is already checked out at /c/dev/backend
  Use a different branch, or press s to use the shared path
Branch for backend [main, s=shared, x=exclude]:
```

Two clean escapes:
1. Use a different branch (e.g. `feature/PROJ-1234`) — you'll be branching off `main` anyway
2. Press `s` — use the base repo path directly for this task

## Summary of per-task modes

| Mode | How to set | What it means |
|---|---|---|
| Worktree | default, or `wksp task repo <id> <repo> worktree` | Isolated checkout on a task branch. The standard mode for repos you're changing. |
| Shared | `s` at prompt, or `wksp task repo <id> <repo> share` | Uses the base repo path directly. The original clone's current branch. |
| Excluded | `x` at prompt, or `wksp task repo <id> <repo> exclude` | Omitted entirely. Not in workspace, not passed to Claude. |

All three modes are per-task only. Other tasks are unaffected. `repos.txt` is unchanged.

---

**Next:** [Example 5 — Archive Workflow](05-archive-workflow.md)
