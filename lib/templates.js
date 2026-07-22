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

// The AI-provider self-check note. Shared between the project template and docs.
const PROVIDER_SELF_CHECK_SECTION = `## AI provider self-check
On your first session in this project, run \`wksp providers --json\` and look for your own tool in the list.
- If it's missing or shows \`"tier": "baseline"\`, tell the user which features degrade: session resume, the last-activity column in \`wksp status\`, rename session migration, and session export/import.
- Offer to add a \`customProviders\` entry to \`.wksp\` right away so \`wksp task\` at least launches your tool (baseline support — launch only).
- For full support (session awareness), offer the contribution prompt from wksp's providers doc (https://github.com/mbarjawi-tech/wksp/blob/main/docs/providers.md), which drafts a proper provider PR to wksp.
`;

// Project-level AGENTS.md. Ships the wksp vocabulary and the planning-hub role of
// the project root so a fresh project (and its AI) understand the core concepts
// from day one.
function projectAgentsMd(name) {
  return `## Project: ${name}

## wksp vocabulary (so AI and I mean the same thing)

- **project** — this workspace: a folder grouping related repos under one idea. Call it "the *${name}* project."
- **repo** — a git repository registered in \`repos.txt\` (the universe of repos).
- **task** — a unit of work inside the project, with its own worktree, \`WORKLOG.md\`, and \`AGENTS.md\`. Say "wksp task" when plain "task" is ambiguous with generic work.

${ROOT_PLANNING_SECTION}
## Cross-cutting conventions
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
- Merge PRs with \`gh pr merge <pr> --repo <owner>/<repo>\` — the \`--repo\` flag makes gh operate
  purely on the remote. Without it, gh tries to check out the default branch locally, which fails
  inside a task worktree (the base repo already has that branch checked out).
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

module.exports = {
  AGENTS_FILE, CLAUDE_FILE, CLAUDE_INCLUDE, writeInstructionFiles,
  projectAgentsMd, taskAgentsMd, planningMd,
  WORK_LOG_SECTION, ROOT_WORK_LOG_SECTION, ROOT_PLANNING_SECTION,
};
