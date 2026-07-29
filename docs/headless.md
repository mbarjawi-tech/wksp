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

Reattaching to a task that already exists is `wksp task resume PROJ-1234 --json` — same
document back, `task.created: false`, and any repo added to `repos.txt` since gets its
worktree without a prompt.

`wksp start PROJ-1234 --json` accepts the same flags and creates the task if it's missing,
which makes it a convenient "make sure this is ready and tell me about it" call — but only
when you know the id is unambiguous. **`start` matches partial names.** If `auth-refactor`
exists and you run `wksp start auth --branch feat/auth --json` meaning to create a new
`auth` task, it resolves to `auth-refactor`, resumes it, and hands back that task's existing
branch — so work would land on the wrong branch, quietly. For a task you intend to be new,
use `wksp task create`, which refuses outright if the id is taken and never resolves to a
neighbour.

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
wksp task repo PROJ-1234 infra worktree --branch feat/tz   # pull a repo in, no prompt
wksp task finish PROJ-1234 --yes    # verify merged → archive → fast-forward base repos
wksp task delete PROJ-1234 --yes    # tear down (see the safety note below)
wksp task archive PROJ-1234 --yes
wksp list --json                    # task inventory, live and archived
wksp providers --json               # which AI tool is configured, and its tier
```

`wksp task repo` takes `--branch` / `--base` for `worktree` mode and `--yes` for the others.
Naming a repo registered `--shared` in `repos.txt` is allowed here — giving one task a
worktree for a normally-shared repo is the documented use of this verb, not a mistake.

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

## Reviewing a PR before it lands

An unbiased second agent catches what the author — human or AI — can't see. wksp's own `finish`
merge-verification bug shipped past 495 passing tests and a convention check; a fresh reviewer
found it in one pass. So for a **coding or behaviour** PR out of a delegated task (trivial
docs-only changes are exempt), run an independent review→fix→re-review loop before merging.

The orchestrator consults the `reviewLoop` setting (see [Agent-honored settings](#agent-honored-settings)):

- `always` — run the loop without asking.
- `never` — skip it.
- `ask` (the default) — ask you first ("Run an independent review→fix loop on this PR?"), and
  mention you can set `reviewLoop: always` to make it automatic.

The loop has four rules that keep it honest:

1. **The reviewer is fresh and unbiased.** Spawn a new agent (or resume a dedicated reviewer) —
   never the implementer, and never a *fork* of the orchestrator, because a fork inherits the
   orchestrator's framing and would rubber-stamp its own plan.
2. **Brief it with intent plus acceptance criteria.** Tell it what the change is meant to do and
   what "correct" looks like, and tell it explicitly to assess independently rather than confirm.
3. **The fixer works in-task, on the same branch.** Fixes land on the PR's branch so the PR
   updates in place — no second PR, no divergence.
4. **It terminates.** Stop on a clean approve, or once every remaining finding is acknowledged as
   a non-blocker. That acknowledgement clause is what prevents an endless polish loop.

## Steering a task across iterations

A recurring confusion in headless work is the agent lifecycle: does an agent "die" when it's
done, and does every iteration need a new one? No — because **the durable unit is the task, not
the agent.** A task's files, worktree, `WORKLOG.md`, `AGENTS.md`, and session history persist
across time and across agents. A background subagent stays resumable while its orchestrator is
alive, and a *fresh* agent simply reloads its context from the task's `WORKLOG.md` and
`AGENTS.md`. Nothing is lost when an agent finishes.

That gives you two first-class steering modes, and you can switch between them freely because the
task carries the state either way:

- **Hub-driven** — stay in the root planning session, delegate an idea to a task (headless), and
  steer the whole thing from the root. Iterate by resuming the *same* task subagent with the next
  batch of work, or by re-delegating a *fresh* agent that reloads from the task files. A
  manual-test gate is simply the root session pausing while you test, then telling it the next
  step — keep the root session alive to keep steering.
- **Direct** — go straight to the task with `wksp start <id>`, which resumes the task's own
  session with full context; the root is uninvolved.

Start hub-driven and later switch to direct (or back), and the state carries over — `WORKLOG.md`
and `AGENTS.md` keep both modes coherent.

**The rule of thumb: resume for continuation, spawn fresh for independence, open a new task for a
separate concern.** The classic "task 1: do 1, 2, 3 … oh, and also 4, 5" is a *resume* of the same
agent, not a new one. A code review is the canonical case for *fresh*. A genuinely different piece
of work is a *new task*.

## Agent-honored settings

wksp has two kinds of config. **CLI-behaviour** keys (`aiProvider`, `autoResume`, `reposRoot`,
`customProviders`) change what the `wksp` command itself does. **Agent-honored** keys are read by
the orchestrating agent to shape delegated work — **wksp's CLI never acts on them.** They resolve
the same way as every other key (project `.wksp` overrides global `~/.wksp`), and the agent reads
them with `wksp config get <key>` (or straight from the `.wksp` JSON, same precedence). An unset
key reads as `(not set)` — treat that as the default.

| Key | Values | Default | What the agent does |
|---|---|---|---|
| `reviewLoop` | `ask` \| `always` \| `never` | `ask` | Whether to run the [review→fix loop](#reviewing-a-pr-before-it-lands) on a coding/behaviour PR. `ask` prompts; `always` runs it; `never` skips. |
| `prGate` | `ask` \| `always` \| `never` | `never` | Verify-before-PR gate. `never` opens the PR as soon as the work is ready. `always` pauses first so you can manually test, then opens it once you confirm. `ask` asks which each time. |
| `mergeMethod` | `squash` \| `merge` \| `rebase` | `squash` | Which merge the agent uses when it lands a PR — passed to `gh pr merge --<method>`. Encodes a per-project default so it isn't re-decided each time. |

The defaults preserve current behaviour: `prGate: never` means PRs still open immediately unless
you opt into a manual-test pause, and `mergeMethod: squash` matches the common squash-merge
workflow. `reviewLoop` defaults to `ask` so the review step is surfaced rather than run — or
skipped — without you knowing.

```bash
wksp config set reviewLoop always            # project-level
wksp config set mergeMethod squash --global  # your default everywhere
wksp config get prGate                        # effective value (project over global)
```

New projects get all three sections in their root `AGENTS.md`; existing projects receive them
from the schema 5 → 6 migration (`wksp migrate`), which inserts them without rewriting anything
you've written — see the [migration guide](/migration#v3-1-x-v3-2-0-orchestration-guidance-schema-5-6).

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
