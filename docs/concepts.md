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

**Repo** — a git repository registered in the project's `repos.txt`. Can be local or cloned from GitHub. Marked `--shared` if you only ever read from it.

**Task** — a unit of work (a ticket, a feature, a bug fix). Each task gets its own subfolder under `tasks/` and its own set of git worktrees, one per repo.

**Worktree** — an isolated checkout of a repo at a specific branch, living inside the task folder. Multiple tasks can have worktrees of the same repo on different branches simultaneously.

**Shared** — a repo that does not get a worktree for a specific task. The base repo folder is used directly instead. Useful for docs or reference repos you only read, or when you need the default branch in a task but it's already checked out in the base clone.

**Excluded** — a repo that is omitted from a specific task entirely. No worktree, not added to the VS Code workspace, not passed to Claude. Useful when a repo is irrelevant to a particular task.

## Mental model

```
acme/                        ← project root (holds config + all tasks)
  repos.txt                     ← which repos belong to this project
  CLAUDE.md                     ← project-wide conventions for Claude

  tasks/
    PROJ-1234/                  ← one task (feature branch set)
      CLAUDE.md                 ← task-specific notes and goals
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
      CLAUDE.md
```

Opening `acme--PROJ-1234.code-workspace` in VS Code gives you all repos in the sidebar, scoped to the task's branches. You can have both workspace files open in separate VS Code windows — no state to manage.

## Shared dependency directories

When multiple worktrees of the same repo are checked out for different tasks, each worktree needs its own installed dependencies — `node_modules`, `.venv`, or similar — even though those deps are usually identical across feature branches. Installing them fresh for every worktree is slow.

wksp solves this with an opt-in shared dep cache. Add a `sharedDeps` key to your `.wksp` file and every worktree automatically gets a symlink (or junction on Windows) pointing to a shared cache directory. Install once, and every worktree benefits immediately.

### Enabling shared deps

Add `sharedDeps` to `.wksp` (manual edit — no CLI flag needed):

```json
{
  "name": "acme",
  "sharedDeps": ["node_modules"]
}
```

You can list multiple dep directories:

```json
"sharedDeps": ["node_modules", ".venv"]
```

### How the cache works

wksp maintains a cache directory at `<projectDir>/.wksp-cache/` (gitignored). Inside it, each repo has its own subdirectory:

```
acme/
  .wksp-cache/            ← gitignored; persists through archive/unarchive
    backend/
      node_modules/       ← real install, shared by all backend worktrees
    frontend/
      node_modules/
  tasks/
    PROJ-1234/
      worktrees/
        backend/
          node_modules    → .wksp-cache/backend/node_modules  (junction/symlink)
        frontend/
          node_modules    → .wksp-cache/frontend/node_modules
    PROJ-5678/
      worktrees/
        backend/
          node_modules    → .wksp-cache/backend/node_modules  (same cache!)
```

When wksp creates a task or resumes one, it creates the cache directories (empty) and places the symlinks automatically. On Windows it uses directory junctions (no administrator rights required).

### First-use workflow

1. Add `sharedDeps` to `.wksp`.
2. Create a task — wksp creates the symlinks immediately (the cache dirs are empty).
3. Run your install command in **any** one of the worktrees, e.g. `npm install`. Because `node_modules` is a junction pointing to the cache, the install lands in `.wksp-cache/backend/node_modules`.
4. Every other worktree with a link to that cache now has the deps too — no reinstall needed.

### Opting out per-worktree

If a specific task-worktree combination needs independent deps (different version, experimental package, etc.), you can opt it out:

```
wksp task repo PROJ-1234 backend own-deps
```

This removes the shared symlink and writes the worktree's name to `task-own-deps.txt`. You can then run `npm install` inside that worktree and it will install into a real `node_modules` directory, isolated from the cache.

To switch back to the shared cache:

```
wksp task repo PROJ-1234 backend link-deps
```

This restores the symlink. Any real `node_modules` you installed must be removed first (wksp will tell you if one is in the way).

### What happens when you resume with existing deps

If you enable `sharedDeps` on a project that already has tasks with real dep directories installed, wksp detects this on `task resume` and **auto-opts-out** instead of overwriting your install. A warning is printed, and the worktree is added to `task-own-deps.txt` so it's skipped on future resumes. You can switch to the shared cache any time with `link-deps` (after removing the real directory).

### Archive and unarchive

The `task-own-deps.txt` file is preserved in the archive manifest (`ownDepsRepos` field). On unarchive, the own-deps list is restored and shared dep links are recreated for all other worktrees.

## How worktree discovery works

Inside each worktree folder, git places a `.git` **file** (not a directory) containing a pointer back to the main git database:

```
# tasks/PROJ-1234/worktrees/backend/.git
gitdir: C:/dev/backend/.git/worktrees/backend
```

wksp reads this file to discover which base repo a worktree belongs to — no separate tracking file needed. On task resume, it scans the `worktrees/` folder, parses each `.git` file, and cross-references against `repos.txt` to detect any newly added repos that still need worktrees.
