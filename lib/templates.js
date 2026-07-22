'use strict';

// Shared CLAUDE.md templates used across commands (init, import, task).
// Kept in one place so the project- and task-level scaffolding never drift.

// The Work log section appended to every task CLAUDE.md. Kept identical to the
// text `wksp migrate` backfills into older tasks (lib/commands/migrate.js).
const WORK_LOG_SECTION = `## Work log
\`WORKLOG.md\` in this folder is the running record of what has been done on this task.
- When resuming work or answering "what was done", read \`WORKLOG.md\` first.
- Before adding an entry, read the full file. If a similar concern already has an entry, rewrite it in place with a more informed version — never append a duplicate for the same topic.
- A new entry is only warranted when the work genuinely shifted to a different concern. Multiple changes to the same area within one session stay as one entry.
- Write clean prose: what changed and why, not a description of what was asked. Keep it to one short line per entry.
- Format: \`- YYYY-MM-DD: <one-liner of what changed and why>\`
`;

// Project-level CLAUDE.md. Ships the wksp vocabulary and a conditional pointer to
// the hub so a fresh project (and its AI) understand the core concepts from day one.
function projectClaudeMd(name) {
  return `## Project: ${name}

## wksp vocabulary (so AI and I mean the same thing)

- **project** — this workspace: a folder grouping related repos under one idea. Call it "the *${name}* project."
- **repo** — a git repository registered in \`repos.txt\` (the universe of repos).
- **task** — a unit of work inside the project, with its own worktree, \`WORKLOG.md\`, and \`CLAUDE.md\`. Say "wksp task" when plain "task" is ambiguous with generic work.
- **hub** — the project's planning task (no worktree). Holds the feature backlog, cross-cutting design, open decisions, and cross-task references — the connective tissue between repos and tasks. Here the hub is \`tasks/hub/\`.

## Cross-cutting conventions
<!-- fill in: backend, frontend, branch naming, test commands... -->

## Where things live

- **The hub** (\`tasks/hub/\`) — the project's planning task and source of truth for project-wide plans: the feature backlog, agreed designs, open decisions, and how tasks relate (\`tasks/hub/CLAUDE.md\` + its \`WORKLOG.md\`). Consult it when a request touches project-wide design, references another task, or asks "what to work on next." Don't load it for work scoped to a single repo or task.

## AI provider self-check
On your first session in this project, run \`wksp providers --json\` and look for your own tool in the list.
- If it's missing or shows \`"tier": "baseline"\`, tell the user which features degrade: session resume, the last-activity column in \`wksp status\`, rename session migration, and session export/import.
- Offer to add a \`customProviders\` entry to \`.wksp\` right away so \`wksp task\` at least launches your tool (baseline support — launch only).
- For full support (session awareness), offer the contribution prompt in \`docs/providers.md\`, which drafts a proper provider PR to wksp.

## Conflict policy
This file defines project-wide conventions. Tasks each have their own CLAUDE.md.
If you notice a contradiction between this file and a task's CLAUDE.md,
flag it immediately and ask for clarification before proceeding.
`;
}

// Standard task-level CLAUDE.md.
function taskClaudeMd(taskId) {
  return `## Task: ${taskId}
## Goal: (describe the task here)

## Notes
<!-- decisions, constraints, references, links to tickets... -->

## Finishing this task
When the work is merged, clean up from inside the task — never check out the default branch here.
- Merge PRs with \`gh pr merge <pr> --repo <owner>/<repo>\` — the \`--repo\` flag makes gh operate
  purely on the remote. Without it, gh tries to check out the default branch locally, which fails
  inside a task worktree (the base repo already has that branch checked out).
- After the merge lands, suggest \`wksp task finish ${taskId}\` — it verifies the branches are
  merged, archives the task, deletes the local branches, and fast-forwards each base repo.

## Conflict policy
The project-level CLAUDE.md defines shared conventions. This file adds task-specific context only.
If anything here contradicts the project-level CLAUDE.md, flag the contradiction
and ask for clarification — do not silently resolve it yourself.

${WORK_LOG_SECTION}`;
}

// Hub-flavored task CLAUDE.md — the reserved planning/meta task. No worktree by
// default; holds the feature backlog, cross-cutting design, and open decisions.
function hubClaudeMd() {
  return `## Task: hub

This is the project **hub** — the planning/meta task. It holds the feature backlog,
agreed designs, open decisions, and cross-task references (the connective tissue
between repos and tasks). It normally has **no worktree** — pull a repo in with
\`wksp task repo hub <repo> worktree\` only if code work has to happen here, though
real features should get their own task.

## Feature backlog
<!-- numbered candidate features / work items, newest thinking wins -->

## Open decisions
<!-- decisions not yet made, with the context needed to make them -->

## Conflict policy
The project-level CLAUDE.md defines shared conventions. This file adds task-specific context only.
If anything here contradicts the project-level CLAUDE.md, flag the contradiction
and ask for clarification — do not silently resolve it yourself.

${WORK_LOG_SECTION}`;
}

module.exports = { projectClaudeMd, taskClaudeMd, hubClaudeMd, WORK_LOG_SECTION };
