# Headless wksp

wksp's commands are built for a human at the keyboard: `wksp task create` asks for a branch
per repo and ends by handing the terminal to your AI tool. That makes the project root a
dead end — a planning session there can decide "this should be a task" but can't act on it,
because it can neither answer readline prompts nor attach to a launch.

Headless mode closes that gap. A planning session at the root can set a task up, work in
it, and close it out without ever launching a second session — and you can still drop into
a task directly when you want focused work.

The enabling fact is simple: a task folder lives **under** the project root, so a session
at the root already reaches every task's files and worktrees. What it was missing was a way
to scaffold a task without prompts, and a way to get the same context a launch would have
given it. That second thing is the **task brief**.

## The three axes

Almost every headless question comes down to three separate switches. Keeping them separate
is deliberate — conflating "don't ask me" with "don't launch" would make both surprising.

| Axis | Controlled by | Default |
|---|---|---|
| Does wksp ask questions? | `--yes` / `-y` | it asks |
| Does wksp launch the AI tool? | `--no-launch` | it launches |
| Which answers are already known? | `--branch`, `--base`, `--shared`, `--exclude` | none |

`--json` implies the first two (a program is reading the output, so there is nobody to ask
and nothing to hand a terminal to). `--dry-run` implies them as well.

So all of these are meaningful:

```bash
wksp task create PROJ-1 -y --branch feat/x     # human shortcut: no questions, then launch
wksp task create PROJ-1 --no-launch            # still asks about each repo; just doesn't launch
wksp task create PROJ-1 --branch feat/x --json # the agent path: no questions, no launch, JSON out
```

## The one command an agent needs

```bash
wksp task create PROJ-1234 --goal "Fix the timezone drift in reminders" \
  --branch feat/tz --json
```

That creates the task folder, its `AGENTS.md` (with the goal filled in), `WORKLOG.md`, the
worktrees, and the `.code-workspace` file — no prompts, no launch — then prints the task
brief as JSON on stdout.

`wksp start PROJ-1234 --json` does the same thing whether or not the task exists yet, which
makes it the single "make sure this task is ready and tell me about it" call.

## The task brief

The brief is everything a launch would have put in front of your AI tool, as a document
instead: task paths, the instruction file and work log to use, the project's `AGENTS.md`
and `PLANNING.md`, every repo with its mode and branch, and the working rules.

```bash
wksp task brief PROJ-1234          # readable
wksp task brief PROJ-1234 --json   # machine-readable
```

`create --json`, `resume --json` and `brief --json` all emit the same shape, so there is
one thing to learn:

```json
{
  "ok": true,
  "briefVersion": 1,
  "project": { "name": "acme", "dir": "C:/workspaces/acme", "agentsMd": "...", "planningMd": "...", "worklog": "..." },
  "task": {
    "id": "PROJ-1234",
    "dir": "C:/workspaces/acme/tasks/PROJ-1234",
    "created": true,
    "agentsMd": "C:/workspaces/acme/tasks/PROJ-1234/AGENTS.md",
    "worklog": "C:/workspaces/acme/tasks/PROJ-1234/WORKLOG.md",
    "taskJson": "...", "workspaceFile": "...", "worktreesDir": "..."
  },
  "repos": [
    { "name": "backend", "mode": "worktree", "branch": "feat/tz", "path": ".../worktrees/backend", "baseRepo": "C:/repos/backend", "created": true },
    { "name": "shared-lib", "mode": "shared", "branch": "main", "path": "C:/repos/shared-lib" },
    { "name": "infra", "mode": "excluded", "optional": true }
  ],
  "contextDirs": ["...project root", "...task dir", "...each repo path"],
  "launched": false,
  "provider": "claude",
  "guidance": ["Read tasks/PROJ-1234/AGENTS.md first — ...", "..."]
}
```

Notes on the shape: paths are absolute with forward slashes on every platform; a file that
doesn't exist is `null` rather than a path that would fail to open; `mode` is one of
`worktree`, `shared`, `excluded`, or `missing` (registered but with no worktree yet);
`contextDirs` is exactly what a launch would have passed to the AI tool; and `guidance`
carries the working rules so an agent reading only the JSON still gets them.

`briefVersion` is bumped only for a breaking change to this shape. New fields are additive.

## Flags

For `create` and `resume` (and `start <id>`, which passes them through):

| Flag | Meaning |
|---|---|
| `--json` | Print the brief as JSON on stdout. Implies `--yes` and `--no-launch`. |
| `--no-launch` | Set the task up and print the brief as text; don't launch. |
| `--yes`, `-y` | Never ask: any repo without a flag takes its defaults. |
| `--dry-run` | Show the plan and create nothing. Implies `--yes` and `--no-launch`. |
| `--branch <repo>=<branch>` | Branch for one repo. Repeatable. |
| `--branch <branch>` | Branch for every repo not named individually — answers the whole prompt. |
| `--base <repo>=<branch>` | Where a branch that doesn't exist yet starts. Also `--base <branch>`. |
| `--shared <repo>` | Use the base repo path for this task, no worktree. Repeatable. |
| `--exclude <repo>` | Leave the repo out of this task. Repeatable. |
| `--goal <text>` | Fill in the `## Goal:` line of the task's `AGENTS.md`. |

Both spellings work: `--branch feat/x` and `--branch=feat/x`.

Defaults for a repo no flag mentions (when `--yes` is in play): a worktree on a branch named
after the task, started from the repo's default branch. That matches what the interactive
prompt offers when you press Enter.

Related non-interactive flags elsewhere:

```bash
wksp task finish PROJ-1234 --yes    # verify merged → archive → fast-forward base repos
wksp task delete PROJ-1234 --yes    # tear down (see the safety note below)
wksp list --json                    # task inventory, live and archived
wksp providers --json               # which AI tool is configured, and its tier
```

## What a headless run guarantees

**It validates before it creates.** A non-interactive run works out every repo's mode,
branch and base first, then checks the plan. If anything is wrong it prints the problem
plus the flag that fixes it and exits 1 **having created nothing** — no half-built tasks:

```
  Cannot set this task up without asking:
    ✗  "feat/tz" is already checked out in C:/workspaces/acme/tasks/PROJ-1200/worktrees/backend
       Pick another branch with --branch backend=<branch>, or use --shared backend / --exclude backend
```

The cases it catches: a flag naming a repo that isn't in `repos.txt`, a repo whose path is
gone, a branch already checked out in another worktree, two registered repos claiming the
same folder name, and (on resume) a flag trying to re-disposition a repo that already has a
worktree — that one is `wksp task repo <id> <repo> <mode>`'s job.

**No prompt is reachable.** Anything the interactive path would ask about is supplied by a
flag, defaulted, or an error.

**`--json` puts nothing but JSON on stdout.** Progress output — including git's own worktree
chatter — goes to stderr for the duration. Failures are JSON too, so an agent never parses
prose:

```json
{ "ok": false, "error": "cannot set up task \"PROJ-1\" without asking", "details": ["..."] }
```

**`--yes` never destroys work.** On `wksp task delete`, `--yes` answers the questions whose
answer is already implied and refuses the ones that would lose something: it will not
discard uncommitted changes and will not force-delete a branch with unmerged commits. It
keeps the task and tells you why. When you really do want to discard, run it without `--yes`
and answer the prompts.

**A closed stdin is an error, not silence.** `wksp` used to wait forever for an answer that
could never arrive, so a piped run would exit part-way through and skip the worktree step.
Now it says what happened and names the flags.

## What lives in the hub vs. in a task

Hub-driven work only stays sane if information has one home. New projects get this as a
section in their root `AGENTS.md`; add it to an existing project by hand if you want your AI
to follow it.

| Hub (the project root) | Task (`tasks/<id>/`) |
|---|---|
| `PLANNING.md` — backlog, open decisions, cross-task design | `AGENTS.md` — this task's goal, scope, constraints |
| `WORKLOG.md` — what was decided, and why | `WORKLOG.md` — what was actually changed |
| `AGENTS.md` — project-wide conventions (loaded into every task session) | `task.json` — which repos participate, and how |
| `repos.txt`, `.wksp` — the repo universe and project config | `worktrees/` — the code |
| Root session history — the planning conversation | Task session history — the implementation conversation |

1. **Durability test.** If it stays true after the task is archived, it belongs in the hub.
   If it only matters while that branch is open, it belongs in the task.
2. **The goal is the handoff contract.** When the hub creates a task, the goal goes into the
   task's `AGENTS.md` (`--goal`, then edit the Notes section for constraints). That file —
   not the hub's backlog — is what the task's agent reads first.
3. **Report back through the task work log.** `tasks/<id>/WORKLOG.md` is the status channel
   the hub reads. The hub never keeps a parallel per-task log.
4. **Decisions graduate upward exactly once.** A decision made while implementing lands in
   the task's work log; when it outlives the task, the hub copies *one line* into
   `PLANNING.md` or the root work log. The hub keeps the conclusion, the task keeps the
   detail — never both.
5. **Backlog content never goes in the root `AGENTS.md`.** That file is passed into every
   task session, so anything in it is paid for by every task. `PLANNING.md` exists precisely
   so the backlog isn't.

## A full loop from the hub

```bash
# in a planning session at the project root
wksp task create PROJ-1234 --goal "Fix timezone drift in reminders" --branch feat/tz --json
#   → work inside tasks/PROJ-1234/worktrees/..., log to tasks/PROJ-1234/WORKLOG.md

wksp task brief PROJ-1234          # re-read the context at any point
wksp status PROJ-1234              # branches and health

gh pr create --repo acme/backend   # ... review, merge
wksp task finish PROJ-1234 --yes   # verify merged, archive, delete branches, ff base repos
```

Then copy the one line that outlives the task into `PLANNING.md`, and the loop is closed.

## When to launch instead

Headless is for orchestration, not for replacing a session. Launch a task when the work
needs sustained attention — a long debugging session, a large refactor, anything where the
task's own session history is worth keeping:

```bash
wksp start PROJ-1234
```

The task's transcripts are keyed to the task folder, so a launched session builds history
there that `wksp start` resumes later. Work done headlessly from the root belongs to the
root's session instead — which is the right trade for "set this up and make the change",
and the wrong one for a week of work.
