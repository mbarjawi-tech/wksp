# Concepts

## The problem wksp solves

In a multi-repo project — say, an API, a frontend, and a docs site — working on a feature means branching multiple repos simultaneously and keeping them in sync. The conventional approach is to `cd` into each repo, `git checkout -b feature/X`, do your work, then switch back when the task is done. That works for one task. When you have three open tasks at once, you're constantly branch-switching, losing your place, and running into the git error "branch is already checked out."

wksp solves this with **git worktrees**: each task gets its own isolated checkout of every repo, all on the right branch, all in one folder. You never branch-switch — you just open a different task folder.

## Git worktrees

A git worktree is a second (or third, or fourth) working directory linked to the same git database. Every worktree has its own branch, its own `HEAD`, and its own working copy. They share the object database, so checkout is near-instant and there's no disk duplication of history.

```
C:/dev/backend/           ← the base clone (on `main`)
acme/tasks/PROJ-1234/
  worktrees/
    backend/                      ← worktree, on `feature/PROJ-1234`
    frontend/        ← worktree, on `feature/PROJ-1234`
```

git enforces one rule: the same branch cannot be checked out in two worktrees at once. wksp respects this — and helps you work around it when it happens.

## Key vocabulary

**Project** — a named group of repos, tracked in a folder with a `.wksp` marker. Corresponds to a product or team area (e.g. `acme`). Holds all your tasks.

**Repo** — a git repository registered in the project's `repos.txt`. Can be local or cloned from GitHub. Marked `--shared` if you only ever read from it, `--optional` if only some tasks need it.

**Task** — a unit of work (a ticket, a feature, a bug fix). Each task gets its own subfolder under `tasks/` and its own set of git worktrees, one per repo.

**Worktree** — an isolated checkout of a repo at a specific branch, living inside the task folder. Multiple tasks can have worktrees of the same repo on different branches simultaneously.

**Shared** — a repo that does not get a worktree for a specific task. The base repo folder is used directly instead. Useful for docs or reference repos you only read, or when you need the default branch in a task but it's already checked out in the base clone.

**Excluded** — a repo that is omitted from a specific task entirely. No worktree, not added to the VS Code workspace, not passed to Claude. Useful when a repo is irrelevant to a particular task.

**Optional** — a repo only some tasks need, registered with `wksp repo add <path> --optional`. Tasks skip it silently: it starts excluded (no branch prompt), and a task that needs it pulls it in with `wksp task repo <id> <repo> worktree`. Where `--shared` and per-task exclusion answer "how does this repo participate", `--optional` flips the default from opt-out to opt-in.

**The root is the planning hub** — the project root itself is the planning surface. It holds `PLANNING.md` (the living feature backlog, open decisions, and research pointers), `ORCHESTRATION.md` (hub-only guidance: delegating to a task, reviewing a delegated PR, [stacked PRs](/stacked-prs), agent-honored settings), a root `WORKLOG.md`, and the project-wide `AGENTS.md`. Only `AGENTS.md` rides into task sessions — the other two are reachable from the root and deliberately not loaded, so a task pays for neither the backlog nor the orchestration guidance. `wksp start` (no arguments) launches a planning session there — no repos are checked out at the root, so planning stays separate from implementation; when a discussion turns into work, a task is created for it. See [reference](/reference#wksp-start).

**Instruction files** — `AGENTS.md` is the canonical instruction file at the root and in every task. The `claude` provider reads `CLAUDE.md`, so wksp also writes a one-line `CLAUDE.md` containing `@AGENTS.md` — one source of truth, readable by any tool.

## Mental model

```
acme/                        ← project root = the planning hub (config + all tasks)
  repos.txt                     ← which repos belong to this project
  AGENTS.md                     ← project-wide conventions (canonical instruction file)
  CLAUDE.md                     ← one-line "@AGENTS.md" include for Claude
  PLANNING.md                   ← feature backlog, open decisions, research pointers
  ORCHESTRATION.md              ← hub-only: delegation, PR review, stacked PRs, settings
  WORKLOG.md                    ← running record of planning work

  tasks/
    PROJ-1234/                  ← one task (feature branch set)
      AGENTS.md                 ← task-specific notes and goals (+ CLAUDE.md include)
      acme--PROJ-1234.code-workspace
      worktrees/
        backend/                    ← on feature/PROJ-1234
        frontend/      ← on feature/PROJ-1234

    PROJ-5678/                  ← another task, different branches
      worktrees/
        backend/                    ← on feature/PROJ-5678
        frontend/      ← on feature/PROJ-5678

  archived-tasks/
    PROJ-9999/                  ← done task, worktrees removed, context kept
      archived.json             ← branch names + tip SHAs for rehydration
      AGENTS.md
```

Opening `acme--PROJ-1234.code-workspace` in VS Code gives you all repos in the sidebar, scoped to the task's branches. You can have both workspace files open in separate VS Code windows — no state to manage.

## How worktree discovery works

Inside each worktree folder, git places a `.git` **file** (not a directory) containing a pointer back to the main git database:

```
# tasks/PROJ-1234/worktrees/backend/.git
gitdir: C:/dev/backend/.git/worktrees/backend
```

wksp reads this file to discover which base repo a worktree belongs to — no separate tracking file needed. On task resume, it scans the `worktrees/` folder, parses each `.git` file, and cross-references against `repos.txt` to detect any newly added repos that still need worktrees.
