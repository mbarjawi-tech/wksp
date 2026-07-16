# Export / Import

`wksp export` and `wksp import` let you hand off a task to a teammate — or move your own work to a new machine — by bundling everything needed to reconstruct the project folder and that single task: project config, repo registrations, git branch state, and optionally the Claude session transcript.

---

## Commands

```bash
wksp export <task-id> [--out <file>] [--with-session]
wksp import <file>
```

### `wksp export <task-id>`

Produces a `.wksp-bundle` file.

| Flag | Description |
|---|---|
| `--out <file>` | Output path. Default: `./<project>--<task-id>.wksp-bundle` in the current directory. |
| `--with-session` | Include the Claude session transcript (the most recent `.jsonl` file for this task). Opt-in because sessions can be large and contain full conversation history. |

### `wksp import <file>`

Reads a `.wksp-bundle` and interactively rebuilds the project + task. All prompts show a default; pressing Enter accepts it.

---

## Bundle format

A single UTF-8 JSON file with extension `.wksp-bundle`.

```json
{
  "bundleVersion": 1,
  "exportedAt": "2026-06-01T19:00:00.000Z",
  "project": {
    "name": "acme",
    "schemaVersion": 3
  },
  "repos": [
    {
      "folderName": "backend",
      "remoteUrl": "https://github.com/org/backend",
      "localPath": "C:/dev/backend",
      "isSharedRepo": false,
      "hasRemote": true
    },
    {
      "folderName": "company-docs",
      "remoteUrl": "https://github.com/org/company-docs",
      "localPath": "C:/dev/company-docs",
      "isSharedRepo": true,
      "hasRemote": true
    }
  ],
  "task": {
    "id": "PROJ-1234",
    "claudeMd": "## Task: PROJ-1234\n...",
    "worklogMd": "# Work Log: PROJ-1234\n- 2026-06-01: ...",
    "shared": ["company-docs"],
    "excluded": ["legacy-service"],
    "repos": [
      {
        "folderName": "backend",
        "branch": "feature/PROJ-1234",
        "baseBranch": "main",
        "tipSha": "abc123def456",
        "remoteUrl": "https://github.com/org/backend",
        "status": "worktree"
      },
      {
        "folderName": "company-docs",
        "branch": "main",
        "tipSha": "111aaa",
        "remoteUrl": "https://github.com/org/company-docs",
        "status": "shared"
      }
    ]
  },
  "session": null
}
```

### Field reference

**`bundleVersion`** — integer; used for forward compatibility. The current version is `1`.

**`project.name`** — used as the default project directory name on import.

**`project.schemaVersion`** — the wksp schema version the exporting project was at; the importer runs `wksp migrate` if the local version is newer.

**`repos[]`** — every repo registered in the project at export time.
- `folderName` — the name used inside `tasks/<id>/worktrees/` and in `task.json`.
- `remoteUrl` — git remote `origin` URL. `null` if the repo has no remote.
- `localPath` — absolute path on the exporting machine; included for reference only, not used on import.
- `isSharedRepo` — `true` if the repo is registered with `--shared` in `repos.txt` (never gets a worktree).
- `hasRemote` — `true` if `remoteUrl` is non-null.

**`task.worklogMd`** — the task's `WORKLOG.md` content (the running record of what was done). Absent in bundles created by wksp < 2.8.0; on import the schema migration backfills an empty `WORKLOG.md` in that case.

**`task.repos[]`** — one entry per non-excluded repo.
- `status` — `"worktree"` | `"shared"` | `"excluded"`.
- `branch` — the branch the worktree was on at export time.
- `baseBranch` — the branch the feature branch was created from (used as fallback if the branch needs to be recreated).
- `tipSha` — the HEAD commit SHA at export time; used to detect if the branch was deleted from remote between export and import.

**`session`** — `null` unless `--with-session` was passed. When present:
```json
"session": {
  "id": "abc123",
  "jsonl": "<full JSONL content as a string>"
}
```

---

## Export flow

```
wksp export PROJ-1234
```

1. **Resolve project** — walk up from cwd to find `.wksp`. Error if not in a project.

2. **Resolve task** — confirm `tasks/PROJ-1234/` exists. Error if not found.

3. **Check for unpushed commits** — for each worktree repo:
   - Run `git log origin/<branch>..<branch> --oneline`.
   - If any unpushed commits exist, print:
     ```
       Error: backend / feature/PROJ-1234 has 3 unpushed commit(s).
              Push before exporting so the importer can fetch the branch.
     ```
   - Abort. All repos must be fully pushed before export.

4. **Check for local-only repos** (no remote) — collect any repos where `hasRemote: false`. Do not abort, but include a warning in the output:
   ```
     ⚠  "internal-tools" has no git remote. The importer will need to
        provide a local path for this repo manually.
   ```

5. **Capture session** (only with `--with-session`) — read the most recent `.jsonl` from
   `~/.claude/projects/<encoded-task-path>/`. Include its full content as a string in `session.jsonl`.
   Print the file size so the user knows what they're including.

6. **Write bundle** — serialize to JSON and write to the output path. Print:
   ```
     ✓  PROJ-1234 exported → acme--PROJ-1234.wksp-bundle  (14 KB)
        Share this file with your teammate. They run: wksp import acme--PROJ-1234.wksp-bundle
   ```

---

## Import flow

```
wksp import acme--PROJ-1234.wksp-bundle
```

### Step 1 — Parse and validate

- Read and JSON-parse the bundle. Error if malformed or `bundleVersion` is unsupported.
- Print a summary:
  ```
    Bundle: acme / PROJ-1234
    Exported: 01 Jun 2026 by (machine: Mutas-lenovo)
    Repos:    backend (worktree · feature/PROJ-1234), company-docs (shared)
    Session:  not included
  ```

### Step 2 — Choose import mode

```
  Import as:
    [1] New project  — create a new project folder from scratch (default)
    [2] Add to existing project — add this task to a project you already have set up
  Choice [1]:
```

---

### Mode 1: New project

#### Step 2a — Project location

```
  Project name [acme]:
  Create in [/c/workspaces]:
```

Validate that `<parent>/<name>/` does not already exist. Error if it does (don't overwrite).

#### Step 2b — Repo resolution

For each repo in the bundle, in order, wksp resolves where the repo lives on this machine.
The resolution logic is:

| Condition | Auto-resolution | Prompt shown? |
|---|---|---|
| `hasRemote: true` AND `reposRoot` is configured AND `<reposRoot>/<folderName>` already exists with the same remote | Use that path | No — print `✓ found at <path>` |
| `hasRemote: true` AND `reposRoot` is configured AND path doesn't exist | Clone into `<reposRoot>/<folderName>` | Confirm: `Clone <remoteUrl> into <reposRoot>/<folderName>? [Y/n]` |
| `hasRemote: true` AND no `reposRoot` configured | Cannot auto-clone | See prompt A below |
| `hasRemote: false` | Cannot clone | See prompt B below |

**Prompt A** — repo has a remote but no `reposRoot`:
```
  "backend" — https://github.com/org/backend
    [1] Clone into a folder (enter path):  /c/dev/backend
    [2] Point to an existing local checkout: ___
    [3] Skip this repo (it will be excluded from the task)
  Choice [1]:
```

**Prompt B** — repo has no remote (local-only):
```
  "internal-tools" — no git remote
    This repo was registered from a local path only. It cannot be cloned.
    [1] Point to an existing local checkout: ___
    [2] Skip this repo (it will be excluded from the task)
  Choice [1]:
```

If a repo is skipped:
- If it was a `worktree` repo → added to the task's `excluded` list.
- If it was a `shared` repo → added to `excluded` (it won't appear in the workspace).
- Print a note reminding the user they can add it later with `wksp task repo <id> <repo> worktree`.

#### Step 2c — Preview

Before writing anything, print the full plan:
```
  ── Import plan ────────────────────────────────────
  Create project:   /c/workspaces/acme/
  Register repos:   backend, company-docs
  Clone:            backend → /c/workspaces/acme-repos/backend
  Task:             PROJ-1234
    backend         feature/PROJ-1234  (worktree)
    company-docs    main               (shared)
  Session:          not included
  ───────────────────────────────────────────────────
  Proceed? [Y/n]:
```

#### Step 2d — Execute

1. `mkdir` project dir, scaffold `.wksp`, `repos.txt`, `CLAUDE.md`, `tasks/`.
2. For each repo: clone (if needed) and register in `repos.txt`.
3. Fetch each repo's remote refs (`git fetch origin`).
4. Create task dir, write `CLAUDE.md` and `WORKLOG.md` from bundle, write `task.json`.
5. For each worktree repo:
   - Check if `branch` exists locally or on remote after fetch.
   - If found: `git worktree add <worktreePath> <branch>`.
   - If not found (branch was deleted from remote after export): warn and prompt:
     ```
       ⚠  Branch "feature/PROJ-1234" not found in backend (tip SHA: abc123).
          [1] Create branch from <baseBranch> (you'll need to re-apply your changes)
          [2] Skip — exclude this repo from the task
       Choice [1]:
     ```
6. Write `.code-workspace` file.
7. Place session file (if included): write `<session.jsonl>` to
   `~/.claude/projects/<encoded-new-task-path>/<session.id>.jsonl`.
8. Print summary and next step:
   ```
     ✓  Project created: /c/workspaces/acme/
     ✓  Repos cloned:    backend
     ✓  Task restored:   PROJ-1234

     To start working:
       cd /c/workspaces/acme
       wksp task resume PROJ-1234
   ```

---

### Mode 2: Add task to existing project

#### Step 2a — Locate existing project

If the user is already inside a project (`.wksp` found in cwd ancestry), use it automatically and print:
```
  Using current project: acme  (/c/workspaces/acme)
```

Otherwise prompt:
```
  Path to existing project:
```

Error if the path has no `.wksp` marker.

#### Step 2b — Task conflict check

If `tasks/PROJ-1234/` already exists, error:
```
  Error: task "PROJ-1234" already exists in this project.
         Archive or delete it first, then re-import.
```

#### Step 2c — Repo reconciliation

Compare bundle repos against the existing project's `repos.txt`. Match by `remoteUrl` (preferred) then `folderName`.

| Bundle repo | Existing project | Action |
|---|---|---|
| Matched by remoteUrl | Same folderName | Use as-is. No prompt. |
| Matched by remoteUrl | Different folderName | Use existing folderName (print notice). |
| Not matched | — | Prompt to add, point to existing, or skip (same prompts A/B as Mode 1). |
| Exists in project | Not in bundle | No action — stays registered; task just won't include it. |

Repos that are newly added during import are appended to `repos.txt`.

#### Step 2d — Preview and execute

Same preview and execution as Mode 1, but scoped to the task only (no project scaffolding).

---

## Edge cases

| Situation | Behaviour |
|---|---|
| Exporting an archived task | Error: `"PROJ-1234" is archived. Unarchive it first, then export.` |
| Bundle `bundleVersion` newer than this wksp supports | Error: `This bundle requires wksp vX.Y.0 or later.` |
| Session file missing at export time (`--with-session`) | Warning: `No Claude session found for PROJ-1234 — exporting without session.` Continue. |
| Session JSONL larger than 10 MB | Warning printed with size; user must confirm to include. |
| `reposRoot` path doesn't exist during clone | Error: `reposRoot "/c/dev" does not exist. Create it or run: wksp config set reposRoot <path>` |
| Import file is not a `.wksp-bundle` | Warning only (don't enforce extension); validate JSON structure instead. |
| Two repos in bundle share the same `folderName` | Error at export time: `Duplicate folder name "backend" — cannot export.` (Should not happen in practice.) |
| Worktree has uncommitted changes at export | Error (same as unpushed check — clean state required). |

---

## What is NOT in the bundle

| Item | Reason |
|---|---|
| Worktree file contents | Comes from git — clone/fetch is sufficient |
| `node_modules`, `.venv`, build output | Never committed, too large |
| `.code-workspace` file | Regenerated on import |
| `reposRoot` config key | Per-machine setting |
| Other tasks in the project | Out of scope — task-only export |
| Archived tasks | Out of scope |

---

## Implementation notes

- `lib/commands/export.js` — export command
- `lib/commands/importCmd.js` — import command (`import` is a JS reserved word)
- `lib/bundle.js` — read/write bundle format, schema validation
- Registered in `bin/wksp.js` as `export` and `import`
- The `encodeProjectPath` function in `lib/claude.js` must be exported and reused by `importCmd.js` to place the session file at the correct path on the target machine
- Tests: `tests/integration/export.test.js`, `tests/integration/import.test.js`
