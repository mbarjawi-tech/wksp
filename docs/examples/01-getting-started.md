# Example 1 — Getting Started

This example starts from nothing and ends with Claude running inside a task with a live git worktree.

## Prerequisites

Install wksp first. See [Installation](../installation.md).

## Step 1 — Create a project

Navigate to where you want to keep your workspace (this is separate from your actual repos — it's the control plane that organizes them).

```bash
cd /c/workspaces
wksp init acme
cd acme
```

This creates:

```
acme/
  .wksp           ← project marker
  repos.txt       ← empty for now
  CLAUDE.md       ← fill in project conventions
  tasks/          ← tasks will live here
```

## Step 2 — Register a repo

```bash
wksp repo /c/dev/backend
```

The repo path is appended to `repos.txt`. If you pass a GitHub URL instead, the repo is cloned into `reposRoot` first:

```bash
wksp repo https://github.com/your-org/backend
```

Check what's registered:

```bash
cat repos.txt
# C:/dev/backend
```

## Step 3 — Create a task

```bash
wksp task create PROJ-1234
```

You're prompted once per repo:

```
Branch for backend [main, s=shared, x=exclude]: feature/PROJ-1234
```

Type the branch name you want and press Enter. Since `feature/PROJ-1234` doesn't exist yet, you're asked what to base it on:

```
→ new branch on backend, base off [main]:
```

Press Enter to accept `main`, or type a different base branch.

wksp then:
1. Runs `git worktree add .../tasks/PROJ-1234/worktrees/backend -b feature/PROJ-1234 main`
2. Creates `tasks/PROJ-1234/CLAUDE.md` from the task template
3. Writes `tasks/PROJ-1234/acme--PROJ-1234.code-workspace`
4. Prints a startup summary
5. Launches Claude

## What you get

```
acme/
  tasks/
    PROJ-1234/
      CLAUDE.md                          ← fill in: task goal, notes, decisions
      acme--PROJ-1234.code-workspace  ← open in VS Code
      worktrees/
        backend/                             ← git worktree on feature/PROJ-1234
```

The startup summary confirms everything before Claude appears:

```
────────────────────────────────────────────
  wksp · acme / PROJ-1234
────────────────────────────────────────────
  Repos:

    backend    feature/PROJ-1234   (worktree)
────────────────────────────────────────────
```

## Step 4 — Open in VS Code

```bash
code tasks/PROJ-1234/acme--PROJ-1234.code-workspace
```

Or open it from VS Code's recent files list. The multi-root workspace shows all repos in the sidebar on their task branches.

## Step 5 — Resume the task later

When you come back to this task:

```bash
wksp task resume PROJ-1234
```

wksp re-validates the worktrees, prints the current branch status, and launches Claude — automatically resuming the last conversation session so your history is intact.

---

**Next:** [Example 2 — Multiple Repos](02-multiple-repos.md)
