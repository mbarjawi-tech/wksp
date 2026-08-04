'use strict';
const fs   = require('fs');
const path = require('path');

// Shared instruction-file templates used across commands (init, import, task, migrate).
// Kept in one place so the project- and task-level scaffolding never drift.
//
// AGENTS.md is the canonical instruction file. The claude provider reads CLAUDE.md,
// so scaffolding also writes a one-line CLAUDE.md that includes AGENTS.md (no
// symlinks — they need elevation on Windows). Other tools read AGENTS.md natively.

const AGENTS_FILE    = 'AGENTS.md';
const CLAUDE_FILE    = 'CLAUDE.md';
const CLAUDE_INCLUDE = '@AGENTS.md\n';

// Hub-only guidance lives at the project root in a NON-instruction file. Only the
// instruction file is injected into a task session (--add-dir exposes the root, it
// does not auto-load its contents), which is the same mechanism that keeps
// PLANNING.md out of every task's context. Orchestration guidance belongs here for
// two reasons: it is ~half of the root instruction file's tokens, and a task-scoped
// agent that reads it is invited to act out of role — delegating, spawning
// reviewers, choosing merge methods.
const GUIDANCE_FILE = 'ORCHESTRATION.md';

// Write the canonical AGENTS.md plus the CLAUDE.md include next to it.
function writeInstructionFiles(dir, content) {
  fs.writeFileSync(path.join(dir, AGENTS_FILE), content);
  fs.writeFileSync(path.join(dir, CLAUDE_FILE), CLAUDE_INCLUDE);
}

// The Work log section appended to every task AGENTS.md. Kept identical to the
// text `wksp migrate` backfills into older tasks (lib/commands/migrate.js).
const WORK_LOG_SECTION = `## Work log
\`WORKLOG.md\` in this folder is the running record of what has been done on this task.
- When resuming work or answering "what was done", read \`WORKLOG.md\` first.
- Before adding an entry, read the full file. If a similar concern already has an entry, rewrite it in place with a more informed version — never append a duplicate for the same topic.
- A new entry is only warranted when the work genuinely shifted to a different concern. Multiple changes to the same area within one session stay as one entry.
- Write clean prose: what changed and why, not a description of what was asked. Keep it to one short line per entry.
- Format: \`- YYYY-MM-DD: <one-liner of what changed and why>\`
`;

// Root variant: same rules, but the root worklog records planning work.
const ROOT_WORK_LOG_SECTION = `## Work log
\`WORKLOG.md\` at the project root is the running record of planning work — same rules as task worklogs.
- When resuming planning or answering "what was decided", read \`WORKLOG.md\` first.
- Before adding an entry, read the full file. If a similar concern already has an entry, rewrite it in place with a more informed version — never append a duplicate for the same topic.
- A new entry is only warranted when the work genuinely shifted to a different concern. Multiple changes to the same area within one session stay as one entry.
- Write clean prose: what changed and why, not a description of what was asked. Keep it to one short line per entry.
- Format: \`- YYYY-MM-DD: <one-liner of what changed and why>\`
`;

// The planning-hub role of the project root: guard text + the pointer to
// PLANNING.md. Shared between the fresh template and the v4 migration (which
// splices it into converted project files).
const ROOT_PLANNING_SECTION = `## The project root is the planning hub

Sessions at the project root are for planning: the feature backlog, cross-cutting design,
open decisions, and how tasks relate. Don't edit repo code here — repos are checked out
inside tasks, not at the root. When a discussion turns into implementation work, suggest
\`wksp task create <id>\` (or \`wksp start <id>\`) and continue there.

- **\`PLANNING.md\`** is the living overview: the feature backlog, open decisions, and
  research pointers. Read it at the start of a planning session; keep it current as
  decisions land.

## Docs structure

- \`PLANNING.md\` must stay readable in one pass — it is always loaded.
- New topics start as sections in \`PLANNING.md\`.
- Graduate a section to its own file under \`docs/\` when it outgrows a screenful, is
  finished, or is referenced from multiple places.
- Create a subdirectory (\`docs/research/\`, \`docs/plans/\`) only once 3+ files of a kind exist.
- Never scaffold empty dirs. Everything that moves out leaves a one-line link behind —
  \`PLANNING.md\` is the index.
`;

// How the hub hands work to a task without a human driving the prompts. Hub-only:
// it ships in ORCHESTRATION.md, not in the root instruction file.
//
// ⚠ FROZEN TEXT. wksp 3.1.0–3.3.0 wrote this block verbatim into users' root
// AGENTS.md (the schema 4 → 5 step), and the schema 6 → 7 step relocates it by
// matching it byte-for-byte before deleting it. Editing this constant means an
// existing project's block no longer matches and is left in place with a note
// (safe, but the relocation silently stops working). If the wording must change,
// freeze the old text in lib/commands/migrate.js as a RELOCATED_* constant first.
// A sha256 digest of the shipped bytes is pinned in tests/unit/templates.test.js
// ("frozen relocation blocks") so an accidental reword fails CI instead of shipping —
// read the note there before touching this, and add new guidance elsewhere.
const DELEGATION_HEADING = '## Delegating work to a task (from here, headless)';

const DELEGATION_RECIPE_SECTION = `${DELEGATION_HEADING}

A task folder lives under this root, so a session here can work in a task without
launching one:

1. \`wksp task create <id> --goal "<one line>" --branch <branch> --json\` — sets the task
   folder and worktrees up with no prompts, launches nothing, and prints the task brief
   (paths, per-repo branches, where to log) as JSON on stdout. Reattaching to a task that
   already exists is \`wksp task resume <id> --json\`. Use \`create\`, not \`wksp start <id>\`,
   to make a new task: \`start\` matches partial names, so an id that is a substring of an
   existing task silently resumes that one and you'd work on the wrong branch.
2. Work inside the repo paths that brief lists. Read \`tasks/<id>/AGENTS.md\` first — it is
   that task's scope contract.
3. Record what you did in \`tasks/<id>/WORKLOG.md\`, not here.
4. \`wksp task brief <id>\` re-prints that context any time. Once the PR is merged,
   \`wksp task finish <id> --yes\` closes the task out — say what that will archive and
   which branches it deletes before running it, since \`--yes\` skips wksp's own confirm.

Prefer a focused session in the task itself? \`wksp start <id>\` with no flags — that one
launches, and its history is kept under the task rather than here.

`;

// Genuinely shared between the root and its tasks — a task needs to know where its
// own notes go and what must not be duplicated upward — so this half STAYS in the
// root instruction file when the delegation recipe moves out.
//
// ⚠ FROZEN TEXT (see DELEGATION_RECIPE_SECTION): DELEGATION_SECTION below must stay
// byte-identical to what wksp 3.1.0–3.3.0 inserted.
const BOUNDARY_HEADING = '## What belongs here vs. in a task';

const BOUNDARY_SECTION = `${BOUNDARY_HEADING}

| Here (project root) | In \`tasks/<id>/\` |
|---|---|
| \`PLANNING.md\` — backlog, open decisions, cross-task design | \`AGENTS.md\` — that task's goal, scope, constraints |
| \`WORKLOG.md\` — what was decided, and why | \`WORKLOG.md\` — what was actually changed |
| \`AGENTS.md\` — project-wide conventions | \`task.json\`, \`worktrees/\` — repo membership and code |

- If it stays true after the task is archived, it belongs here; if it only matters while
  that branch is open, it belongs in the task.
- A decision graduates upward exactly once: the task work log keeps the detail, this root
  keeps one line of conclusion. Never both.
- Never put backlog content in this file — it is loaded into every task session.

`;

// Exactly what the schema 4 → 5 step inserted into a root AGENTS.md, kept whole so
// that migration is unchanged. The 6 → 7 step removes only the recipe half.
const DELEGATION_SECTION = DELEGATION_RECIPE_SECTION + BOUNDARY_SECTION;

// Orchestration guidance for the agent driving delegated work from the root: how to
// review a task's PR before it lands, how to steer a task across iterations, and the
// settings the agent honours. Hub-only — it ships in ORCHESTRATION.md.
//
// ⚠ FROZEN TEXT. wksp 3.2.0–3.3.0 wrote ORCHESTRATION_SECTION verbatim into users'
// root AGENTS.md (the schema 5 → 6 step) and the schema 6 → 7 step relocates it by
// matching it byte-for-byte — same rules as DELEGATION_RECIPE_SECTION above. The
// three sub-sections are split out only so ORCHESTRATION.md can reuse two of them
// while shipping an updated (stack-aware) settings table; the composition below must
// stay byte-identical, and its sha256 is pinned in tests/unit/templates.test.js. The
// first heading doubles as the idempotency marker.
const ORCHESTRATION_HEADING = '## Reviewing a delegated PR (review → fix → re-review)';

const REVIEW_LOOP_SECTION = `${ORCHESTRATION_HEADING}

When a delegated task's PR is a coding or behaviour change (skip trivial docs-only PRs), put
it through an independent review→fix→re-review loop before it merges. Consult the
\`reviewLoop\` setting (see *Agent-honored settings* below):

- \`always\` — run the loop without asking.
- \`never\` — skip it.
- \`ask\` (default / unset) — ask the user "Run an independent review→fix loop on this PR?",
  and mention they can set \`reviewLoop: always\` to automate it.

The loop:

1. **Spawn a fresh, unbiased reviewer** — never the implementer, and never a fork of this
   orchestrator (a fork inherits your framing and defeats the point). Brief it with the fix
   intent, explicit acceptance criteria, and "assess independently, don't rubber-stamp."
2. **If it finds issues,** a fixer works in-task on the same branch so the PR updates in
   place; then re-run the reviewer.
3. **Terminate** on a clean approve, or once every remaining finding is acknowledged as a
   non-blocker — not on an endless polish loop.

`;

const STEERING_HEADING = '## Steering a task: resume, fresh, or new';

const STEERING_SECTION = `${STEERING_HEADING}

The durable unit is the **task**, not the agent: its files, worktree, \`WORKLOG.md\`,
\`AGENTS.md\`, and session history outlive any agent that touched it. Agents are ephemeral but
resumable, and a fresh agent reloads its context from the task's \`WORKLOG.md\` and
\`AGENTS.md\` — nothing is lost when one "finishes."

Two steering modes, switchable at any point because the task carries the state either way:

- **Hub-driven** — plan here, delegate to a task (headless), and steer it from this root
  session. Iterate by resuming the same task subagent with the next batch, or by re-delegating
  a fresh agent that reloads from the task files. A manual-test gate is just this session
  pausing while you test and then telling it the next step — keep it alive to steer.
- **Direct** — \`wksp start <id>\` resumes the task's own session with full context; the root
  is uninvolved.

Rule of thumb: **resume for continuation, fresh for independence (e.g. a review), a new task
for a separate concern.** "Do 1, 2, 3 … oh, and also 4, 5" is a resume, not a new agent — don't
spawn a fresh agent per iteration.

`;

const SETTINGS_HEADING = '## Agent-honored settings';

const SETTINGS_SECTION = `${SETTINGS_HEADING}

These keys shape how you (the orchestrating agent) drive delegated work. wksp's CLI does
**not** act on them — you read them and follow them. Read each with \`wksp config get <key>\`
(project \`.wksp\` wins over global \`~/.wksp\`, like every other key), or read the \`.wksp\` JSON
directly with the same precedence; \`(not set)\` means the default below applies.

| Key | Values | Default | Meaning |
|---|---|---|---|
| \`reviewLoop\` | \`ask\` \\| \`always\` \\| \`never\` | \`ask\` | Whether to run the review→fix loop above on a coding/behaviour PR. |
| \`prGate\` | \`ask\` \\| \`always\` \\| \`never\` | \`never\` | Verify-before-PR gate. \`never\`: open the PR as soon as the work is ready. \`always\`: pause first so the user can manually test, then open it once they confirm. \`ask\`: ask which. |
| \`mergeMethod\` | \`squash\` \\| \`merge\` \\| \`rebase\` | \`squash\` | Which merge you use when landing a PR (\`gh pr merge --<method>\`). |

The defaults keep today's behaviour: \`reviewLoop: ask\` surfaces the choice rather than silently
running or skipping, \`prGate: never\` opens PRs immediately as before, and \`mergeMethod: squash\`
matches the common squash-merge workflow.

`;

// The frozen 5 → 6 block: what shipping wksp versions inserted, and what the 6 → 7
// step matches before deleting. Never reorder or reword — see the note above.
const ORCHESTRATION_SECTION = REVIEW_LOOP_SECTION + STEERING_SECTION + SETTINGS_SECTION;

// The settings table as it ships in ORCHESTRATION.md today: same keys and defaults,
// but \`mergeMethod\` is stack-aware (it governs solo-PR merges; a stack lands via
// \`gh stack merge\` whatever it says) and it tells you to check that the repo permits
// the method before passing it. Not frozen — nothing matches this text.
const HUB_SETTINGS_SECTION = `${SETTINGS_HEADING}

These keys shape how you (the orchestrating agent) drive delegated work. wksp's CLI does
**not** act on them — you read them and follow them. Read each with \`wksp config get <key>\`
(project \`.wksp\` wins over global \`~/.wksp\`, like every other key), or read the \`.wksp\` JSON
directly with the same precedence; \`(not set)\` means the default below applies.

| Key | Values | Default | Meaning |
|---|---|---|---|
| \`reviewLoop\` | \`ask\` \\| \`always\` \\| \`never\` | \`ask\` | Whether to run the review→fix loop above on a coding/behaviour PR. |
| \`prGate\` | \`ask\` \\| \`always\` \\| \`never\` | \`never\` | Verify-before-PR gate. \`never\`: open the PR as soon as the work is ready. \`always\`: pause first so the user can manually test, then open it once they confirm. \`ask\`: ask which. |
| \`mergeMethod\` | \`squash\` \\| \`merge\` \\| \`rebase\` | \`squash\` | Which merge you use when landing a **solo** PR (\`gh pr merge --<method>\`). A stack ignores it — members land together via \`gh stack merge\`. |

The defaults keep today's behaviour: \`reviewLoop: ask\` surfaces the choice rather than silently
running or skipping, \`prGate: never\` opens PRs immediately as before, and \`mergeMethod: squash\`
matches the common squash-merge workflow.

Before you pass a merge method, confirm the repo permits it — \`gh repo view --repo <slug>
--json squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed\` — and fall back to one it
does allow rather than letting the merge fail. A repo with squash merging disabled will
reject \`gh pr merge --squash\` outright.

`;

// The short pointer that STAYS in the root instruction file, so a hub session still
// finds the guidance that moved out. Two facts only: you are the hub, and where to
// read. Its heading is the 6 → 7 step's idempotency marker.
const HUB_POINTER_HEADING = '## Hub guidance (read before you orchestrate)';

const HUB_POINTER_SECTION = `${HUB_POINTER_HEADING}

A session at this root is the **hub**. Before delegating work to a task, reviewing a delegated
PR, stacking PRs, or landing one, read \`${GUIDANCE_FILE}\` at this root — it holds those
recipes and the settings you honour. It deliberately isn't part of this file: this file is
loaded into every task session, and orchestrating is not a task's job.

`;

// Stacked-PR guidance. Hub-only, and the most load-bearing idea in it is the reframe
// in the first line: the decision is about code overlap, not about bookkeeping.
const STACKED_PR_HEADING = '## Stacked PRs — merge order, not build order';

const STACKED_PR_SECTION = `${STACKED_PR_HEADING}

**Stacking constrains merge order, not build order.** A stack does not mean building one PR at
a time. Decide per batch by **code overlap**, and say which mode is in play:

- **Disjoint areas** → parallel agents in parallel tasks, independent PRs off the default
  branch. They can merge in any order and need **no stack at all**.
- **Overlapping files or regions** → chained branches. Not for bookkeeping reasons: building
  overlapping work in parallel just defers the same conflicts to stack time, and
  mutation-tested guards collide **textually** even when the two features are logically
  compatible. Chaining also lets each task build on the previous one's real behaviour instead
  of a guess.

Scoping rule: polish and bug fixes join whatever branch is already open (cheap, serial, no
conflicts); anything that would still stand alone as a feature after this branch merges gets
its own task.

**Prompt, don't presume.** On a multi-item batch, state the mode you detected
(disjoint / overlapping) and ask before stacking. GitHub's native stacked PRs reached public
preview on 2026-07-30 and are labelled "subject to change" — verify the tooling is there
(\`gh stack --help\`) rather than assuming it.

### Setting one up

One wksp task per PR, branch \`feat/<task-id>\`, each with its own worktree:

\`\`\`
wksp task create <id> --goal "<one line>" --branch feat/<id> --base <previous-member> --json
\`\`\`

Use \`create\`, **never** \`wksp start <id>\` for a new member — \`start\` partial-matches, so an id
that is a substring of an existing task silently resumes that task and hands back the wrong
branch.

\`\`\`
gh stack init feat/a feat/b feat/c    # turn existing branches into a stack
gh stack add feat/d                   # append one on top
gh stack view / switch / sync
\`\`\`

### Publishing

\`\`\`
gh stack submit                          # creates/updates the chain — re-run after every restack
gh pr ready <n> --repo <owner>/<repo>    # REQUIRED on the agent path — new PRs are DRAFTS
\`\`\`

**Whether \`submit\` creates drafts depends on how you run it.** Run non-interactively — which
is how an agent runs it — or with \`--auto\`, it skips its editor and creates new PRs as
**drafts** unless you pass \`--open\`. So on the agent path \`gh pr ready <n>\` on each new PR is
required: nothing is reviewable until then. Run interactively, the editor defaults new PRs to
ready for review instead, and there is nothing to do.

⚠ Observed in practice (gh 2.8x), not stated in \`--help\`: \`gh stack submit\` restacks the
branches itself and **rewrites SHAs**. After it runs — or after amending anything mid-stack —
re-read each branch's real history before any manual rebase. Never trust a base SHA you
remembered from before a submit.

### Restacking — where the time actually goes

**Never chain rebases of different worktrees in one command.** A conflict stops the first
rebase and every later command silently no-ops against refs that never moved, so you get a
false "all clean". One command per branch, each verified.

\`\`\`
git -C <task-worktree> rebase --onto <new-base-branch> <old-base-tip-sha> <branch>
\`\`\`

**Always \`--onto\`, never plain \`git rebase <base>\`.** Conflict resolution on a lower branch
changes commit patch-ids, so git stops recognising the base's commits as duplicates and
replays work already merged below. Read the real old base tip out of the branch's log — don't
assume it.

Guard and test conflicts between logically compatible features are **expected work**, not
noise. Record each resolution as an \`Integration:\` commit so the history is honest about what
was reconciled.

**Found a bug in a section another member owns? Don't fix it.** Add a *named, self-expiring
exemption* whose test asserts the exemption is still needed — so the moment the owning branch's
real fix lands underneath in the restack, the suite fails and forces the workaround's deletion.
A cross-branch TODO that cannot rot. Two branches editing one rule is a conflict for nothing.

### Reviewing and merging

Review each member live, in rounds. A fix round folds into that member's branch, then the
**whole chain is restacked and republished**, then one message lists what to retest. Five
rounds on a single member is common.

\`\`\`
gh stack merge --yes --merge     # atomic, all-or-nothing, bottom-up, the whole stack
\`\`\`

- **\`gh pr merge\` is refused for stack members** — use \`gh stack merge\`. (Observed in practice
  (gh 2.8x), not stated in \`--help\`.) \`gh pr merge <n> --repo <owner>/<repo>\` stays right for a
  solo PR, and \`--repo\` is what keeps gh off the local checkout.
- The merge is genuinely atomic: if any member can't merge, none do. You never hand-merge
  members one at a time.
- A bare number after \`gh stack merge\` is read as a **stack** number before a PR number — they
  are separate sequences (stack #14 ≠ PR #14, which may not exist).
- \`mergeMethod\` governs **solo** PRs only; a stack lands with \`gh stack merge\` regardless.

**The auto-close trap, scoped correctly.** In a **hand-rolled chain** (branches you based on
each other yourself, no \`gh stack\`), squash-merging the base and deleting its branch
**auto-closes the child PR** — retarget the child to the default branch *before* deleting the
base branch, or rebase and re-open it. With a native \`gh stack\`, GitHub auto-rebases and
retargets the remainder server-side when the bottom lands, so that caution does not apply
there. Know which one you are driving.

A mid-stack PR merges into its **parent branch**, not the default branch, so it is not yet on
the default branch: \`wksp task finish\` reports that as "merged into \`<parent>\` — not yet on
\`<default>\`" and asks before deleting anything. Finish members after the stack has landed.

### What each stacked task's brief must say

Task-level rules — write them into the member's \`AGENTS.md\` (or \`--goal\`) when you create it.
They are deliberately **not** in the shared task template, because they apply only to a stacked
task:

- **which branch it stacks on** — its base is the previous member, not the default branch;
- **the test baseline is the count at its BRANCH TIP, not the default branch's.** A stacked
  suite is bigger (550 → 812 → 1026 across two real stacks); an agent handed the default
  branch's number reports a false failure on its very first run;
- the \`git rebase --onto <new-base> <old-base-tip> <branch>\` discipline when restacking;
- record conflict resolutions as \`Integration:\` commits;
- the self-expiring-exemption pattern for a bug that belongs to another member;
- **never mutate git state** — no \`stash\`, no \`reset\`, no branch deletion — unless explicitly
  asked. (An agent's stash slip had to be undone once.)

Housekeeping: don't let a stacked branch sit — a long-lived branch goes CONFLICTING and is
better re-implemented than rebased, since a rebase force-fits old logic onto a moved codebase.
Stop any running server and move shells out of a worktree before teardown; Windows locks it.

`;

// The AI-provider self-check note. Shared between the project template and docs.
const PROVIDER_SELF_CHECK_SECTION = `## AI provider self-check
On your first session in this project, run \`wksp providers --json\` and look for your own tool in the list.
- If it's missing or shows \`"tier": "baseline"\`, tell the user which features degrade: session resume, the last-activity column in \`wksp status\`, rename session migration, and session export/import.
- Offer to add a \`customProviders\` entry to \`.wksp\` right away so \`wksp task\` at least launches your tool (baseline support — launch only).
- For full support (session awareness), offer the contribution prompt from wksp's providers doc (https://github.com/mbarjawi-tech/wksp/blob/main/docs/providers.md), which drafts a proper provider PR to wksp.
`;

// Project-level AGENTS.md. Ships the wksp vocabulary, the planning-hub role of the
// project root, and the information boundary between root and task — everything a
// task session genuinely needs from the root. Orchestration guidance is NOT here; it
// lives in ORCHESTRATION.md (see GUIDANCE_FILE), pointed at from HUB_POINTER_SECTION.
function projectAgentsMd(name) {
  return `## Project: ${name}

## wksp vocabulary (so AI and I mean the same thing)

- **project** — this workspace: a folder grouping related repos under one idea. Call it "the *${name}* project."
- **repo** — a git repository registered in \`repos.txt\` (the universe of repos).
- **task** — a unit of work inside the project, with its own worktree, \`WORKLOG.md\`, and \`AGENTS.md\`. Say "wksp task" when plain "task" is ambiguous with generic work.

${ROOT_PLANNING_SECTION}
${HUB_POINTER_SECTION}${BOUNDARY_SECTION}## Cross-cutting conventions
<!-- fill in: backend, frontend, branch naming, test commands... -->

${PROVIDER_SELF_CHECK_SECTION}
## Conflict policy
This file defines project-wide conventions. Tasks each have their own AGENTS.md.
If you notice a contradiction between this file and a task's AGENTS.md,
flag it immediately and ask for clarification before proceeding.

${ROOT_WORK_LOG_SECTION}`;
}

// Standard task-level AGENTS.md.
function taskAgentsMd(taskId) {
  return `## Task: ${taskId}
## Goal: (describe the task here)

## Notes
<!-- decisions, constraints, references, links to tickets... -->

## Finishing this task
When the work is merged, clean up from inside the task — never check out the default branch here.
- **A solo PR** merges with \`gh pr merge <pr> --repo <owner>/<repo>\` — the \`--repo\` flag makes gh
  operate purely on the remote. Without it, gh tries to check out the default branch locally, which
  fails inside a task worktree (the base repo already has that branch checked out). Check the repo
  permits the method you pass; \`--squash\` isn't enabled everywhere.
- **A PR that is part of a stack** is not yours to merge: \`gh pr merge\` is refused for stack
  members (observed in practice, gh 2.8x), and the whole stack lands together with
  \`gh stack merge\`, driven by whoever is orchestrating it. Say the branch is ready and stop
  there.
- After the merge lands, suggest \`wksp task finish ${taskId}\` — it verifies the branches are
  merged, archives the task, deletes the local branches, and fast-forwards each base repo.

## Conflict policy
The project-level AGENTS.md defines shared conventions. This file adds task-specific context only.
If anything here contradicts the project-level AGENTS.md, flag the contradiction
and ask for clarification — do not silently resolve it yourself.

${WORK_LOG_SECTION}`;
}

// PLANNING.md — the living overview at the project root. Deliberately separate
// from AGENTS.md: the root instruction file is --add-dir'd into every task
// session, and backlog content there would bloat each task's context.
function planningMd(name) {
  return `# Planning — ${name}

The living overview of the *${name}* project: feature backlog, open decisions, research
pointers. Keep it readable in one pass — graduate anything bigger to \`docs/\` and leave
a one-line link behind (see the docs-structure rule in AGENTS.md).

## Feature backlog
<!-- numbered candidate features / work items, newest thinking wins -->

## Open decisions
<!-- decisions not yet made, with the context needed to make them -->
`;
}

// ORCHESTRATION.md — hub-only guidance at the project root. Same mechanism as
// PLANNING.md: it sits in the root directory (so a hub session reaches it) but is not
// an instruction file, so no task session loads it. That is the whole point — a
// task-scoped agent should not be reading how to delegate, review, or merge.
function orchestrationMd(name) {
  return `# Orchestration — ${name}

Hub-only guidance for a session at this project root: how to hand work to a task, review a
delegated PR, decide between a stack and parallel PRs, land the result, and which settings you
honour while doing it.

This file is **not** an instruction file. Only \`AGENTS.md\` is injected into a task session, so
nothing here is paid for by tasks that never orchestrate — and a task-scoped agent is not
invited to act out of role. Everything genuinely shared with tasks (vocabulary, the root/task
information boundary, cross-cutting conventions) stays in \`AGENTS.md\`; the backlog stays in
\`PLANNING.md\`.

${DELEGATION_RECIPE_SECTION}${REVIEW_LOOP_SECTION}${STEERING_SECTION}${STACKED_PR_SECTION}${HUB_SETTINGS_SECTION}`.replace(/\n+$/, '\n');
}

module.exports = {
  AGENTS_FILE, CLAUDE_FILE, CLAUDE_INCLUDE, GUIDANCE_FILE, writeInstructionFiles,
  projectAgentsMd, taskAgentsMd, planningMd, orchestrationMd,
  WORK_LOG_SECTION, ROOT_WORK_LOG_SECTION, ROOT_PLANNING_SECTION,
  DELEGATION_SECTION, DELEGATION_HEADING,
  DELEGATION_RECIPE_SECTION, BOUNDARY_SECTION, BOUNDARY_HEADING,
  ORCHESTRATION_SECTION, ORCHESTRATION_HEADING,
  REVIEW_LOOP_SECTION, STEERING_SECTION, STEERING_HEADING,
  SETTINGS_SECTION, SETTINGS_HEADING, HUB_SETTINGS_SECTION,
  HUB_POINTER_SECTION, HUB_POINTER_HEADING,
  STACKED_PR_SECTION, STACKED_PR_HEADING,
};
