'use strict';
const fs   = require('fs');
const path = require('path');
const config = require('../config');
const { REPOS_FILE, REPOS_HEADER } = require('../repos');
const { readTaskSets, writeTaskSets, TASK_CONFIG_FILE, LEGACY_SHARED_FILE, LEGACY_EXCLUDED_FILE } = require('../task-state');
const { discoverWorktrees } = require('../worktrees');
const { getProvider } = require('../providers');
const { open, close, confirmDefaultYes } = require('../prompts');
const { unsafeProjectDirReason } = require('../paths');
const templates = require('../templates');

// ─── migration helpers ────────────────────────────────────────────────────────

// Strip `  --as <alias>` from a repos.txt line. Returns { cleaned, changed }.
function stripAlias(line) {
  const cleaned = line.replace(/\s+--as\s+\S+/, '').trimEnd();
  return { cleaned, changed: cleaned !== line };
}

// Apply migration schema 0 → 1:
//   - Strip any `--as <alias>` entries from repos.txt
//   - Update the repos.txt header comment
// Returns { reposChanged, aliasLines } where aliasLines is the list of original lines that had --as.
function migrate0to1(projectDir, dryRun) {
  const reposPath = path.join(projectDir, REPOS_FILE);
  if (!fs.existsSync(reposPath)) {
    // No repos.txt — nothing to clean, still bump schema
    return { reposChanged: false, aliasLines: [] };
  }

  const raw   = fs.readFileSync(reposPath, 'utf8');
  const lines = raw.split('\n');

  const aliasLines = lines.filter(l => !l.trimStart().startsWith('#') && /\s+--as\s+\S+/.test(l));

  if (!dryRun && (aliasLines.length > 0 || raw.includes('[--as <alias>]'))) {
    const cleaned = lines.map(l => {
      // Update legacy header comment
      if (l.includes('[--as <alias>]')) return l.replace(' [--as <alias>]', '');
      // Strip alias from data lines
      return stripAlias(l).cleaned;
    });
    fs.writeFileSync(reposPath, cleaned.join('\n'));
  }

  return { reposChanged: aliasLines.length > 0, aliasLines };
}

// Apply migration schema 1 → 2:
//   - Convert task-shared.txt + task-excluded.txt → task.json in every task dir
//   - Applies to both tasks/ and archived-tasks/
// Returns { converted } where converted is the list of task dirs that were migrated.
// `log` lets callers (e.g. import) silence per-step output.
function migrate1to2(projectDir, dryRun, log = console.log) {
  const taskRoots = [
    path.join(projectDir, 'tasks'),
    path.join(projectDir, 'archived-tasks'),
  ];

  const toConvert = [];

  for (const root of taskRoots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const taskDir = path.join(root, entry.name);
      // Already migrated
      if (fs.existsSync(path.join(taskDir, TASK_CONFIG_FILE))) continue;
      // Nothing to convert
      const hasShared   = fs.existsSync(path.join(taskDir, LEGACY_SHARED_FILE));
      const hasExcluded = fs.existsSync(path.join(taskDir, LEGACY_EXCLUDED_FILE));
      if (!hasShared && !hasExcluded) continue;

      const { taskSharedSet, taskExcludedSet } = readTaskSets(taskDir);
      toConvert.push({ taskDir, label: path.relative(projectDir, taskDir), taskSharedSet, taskExcludedSet });
    }
  }

  if (toConvert.length === 0) {
    log('  task dirs — no legacy .txt files found, nothing to convert.');
    return { converted: [] };
  }

  for (const { taskDir, label, taskSharedSet, taskExcludedSet } of toConvert) {
    const shared   = [...taskSharedSet].join(', ')   || '(none)';
    const excluded = [...taskExcludedSet].join(', ') || '(none)';
    log(`  ${label}/task.json  shared:[${shared}]  excluded:[${excluded}]`);
    if (!dryRun) writeTaskSets(taskDir, taskSharedSet, taskExcludedSet);
  }

  return { converted: toConvert };
}

// Apply migration schema 2 → 3:
//   - Add ## Work log section to CLAUDE.md in every task dir that lacks it
//   - Create WORKLOG.md in every task dir that lacks it
// Returns { updated } where updated is the list of task dirs that were changed.
// `log` lets callers (e.g. import) silence per-step output.
function migrate2to3(projectDir, dryRun, log = console.log) {
  const WORK_LOG_SECTION = `
## Work log
\`WORKLOG.md\` in this folder is the running record of what has been done on this task.
- When resuming work or answering "what was done", read \`WORKLOG.md\` first.
- Before adding an entry, read the full file. If a similar concern already has an entry, rewrite it in place with a more informed version — never append a duplicate for the same topic.
- A new entry is only warranted when the work genuinely shifted to a different concern. Multiple changes to the same area within one session stay as one entry.
- Write clean prose: what changed and why, not a description of what was asked. Keep it to one short line per entry.
- Format: \`- YYYY-MM-DD: <one-liner of what changed and why>\`
`;

  const taskRoots = [
    path.join(projectDir, 'tasks'),
    path.join(projectDir, 'archived-tasks'),
  ];

  const updated = [];

  for (const root of taskRoots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const taskDir   = path.join(root, entry.name);
      const label     = path.relative(projectDir, taskDir);
      const agentsMd  = path.join(taskDir, 'AGENTS.md');
      const claudeMd  = path.join(taskDir, 'CLAUDE.md');
      const worklog   = path.join(taskDir, 'WORKLOG.md');
      let changed     = false;

      // Post-v4 tasks keep their content in AGENTS.md and CLAUDE.md is a one-line
      // include — append to the canonical file, and never to an include-only stub.
      const instrFile = fs.existsSync(agentsMd) ? agentsMd : claudeMd;
      if (fs.existsSync(instrFile)) {
        const content = fs.readFileSync(instrFile, 'utf8');
        if (!content.includes('## Work log') && !isIncludeOnly(content)) {
          log(`  ${label}/${path.basename(instrFile)}  — appending Work log section`);
          if (!dryRun) fs.writeFileSync(instrFile, content + WORK_LOG_SECTION);
          changed = true;
        }
      }

      if (!fs.existsSync(worklog)) {
        log(`  ${label}/WORKLOG.md  — creating`);
        if (!dryRun) fs.writeFileSync(worklog, `# Work Log: ${entry.name}\n`);
        changed = true;
      }

      if (changed) updated.push(label);
    }
  }

  if (updated.length === 0) {
    log('  task dirs — all already have WORKLOG.md and Work log section, nothing to update.');
  }

  return { updated };
}

// ─── 3 → 4 helpers (root-as-hub + AGENTS.md canonicalization) ────────────────

// Frozen template text from older wksp versions, matched exactly so the v4
// conversion can modernize unedited scaffolding without touching user prose.
const LEGACY_HUB_VOCAB_BULLET = `- **hub** — the project's planning task (no worktree). Holds the feature backlog, cross-cutting design, open decisions, and cross-task references — the connective tissue between repos and tasks. Here the hub is \`tasks/hub/\`.
`;
const LEGACY_TASK_VOCAB_BULLET = '- **task** — a unit of work inside the project, with its own worktree, `WORKLOG.md`, and `CLAUDE.md`. Say "wksp task" when plain "task" is ambiguous with generic work.';
const NEW_TASK_VOCAB_BULLET    = '- **task** — a unit of work inside the project, with its own worktree, `WORKLOG.md`, and `AGENTS.md`. Say "wksp task" when plain "task" is ambiguous with generic work.';
const LEGACY_WHERE_THINGS_LIVE = `## Where things live

- **The hub** (\`tasks/hub/\`) — the project's planning task and source of truth for project-wide plans: the feature backlog, agreed designs, open decisions, and how tasks relate (\`tasks/hub/CLAUDE.md\` + its \`WORKLOG.md\`). Consult it when a request touches project-wide design, references another task, or asks "what to work on next." Don't load it for work scoped to a single repo or task.
`;
const LEGACY_PROJECT_CONFLICT = `## Conflict policy
This file defines project-wide conventions. Tasks each have their own CLAUDE.md.
If you notice a contradiction between this file and a task's CLAUDE.md,
flag it immediately and ask for clarification before proceeding.`;
const NEW_PROJECT_CONFLICT = `## Conflict policy
This file defines project-wide conventions. Tasks each have their own AGENTS.md.
If you notice a contradiction between this file and a task's AGENTS.md,
flag it immediately and ask for clarification before proceeding.`;
const LEGACY_TASK_CONFLICT = `## Conflict policy
The project-level CLAUDE.md defines shared conventions. This file adds task-specific context only.
If anything here contradicts the project-level CLAUDE.md, flag the contradiction
and ask for clarification — do not silently resolve it yourself.`;
const NEW_TASK_CONFLICT = `## Conflict policy
The project-level AGENTS.md defines shared conventions. This file adds task-specific context only.
If anything here contradicts the project-level AGENTS.md, flag the contradiction
and ask for clarification — do not silently resolve it yourself.`;
const LEGACY_HUB_INTRO = `This is the project **hub** — the planning/meta task. It holds the feature backlog,
agreed designs, open decisions, and cross-task references (the connective tissue
between repos and tasks). It normally has **no worktree** — pull a repo in with
\`wksp task repo hub <repo> worktree\` only if code work has to happen here, though
real features should get their own task.
`;

function isIncludeOnly(content) {
  return content.trim() === templates.CLAUDE_INCLUDE.trim();
}

// Legacy repos.txt header comments, frozen as each generation of wksp wrote
// them. Matched exactly so a hand-edited header is never touched. Data lines
// are left alone either way — files without --optional are already valid.
const LEGACY_REPOS_HEADERS = [
  ['# Workspace repos',
   '# Format: <path> [--shared]',
   '# --shared: use original path in every task, never create a worktree'].join('\n'),
  ['# Workspace repos',
   '# Format: <path> [--shared]'].join('\n'),
];

// Refresh the repos.txt header comment so it documents the --optional flag
// (added in the same v4 window as root-as-hub — no schema bump of its own).
function refreshReposHeader(projectDir, dryRun) {
  const reposPath = path.join(projectDir, REPOS_FILE);
  if (!fs.existsSync(reposPath)) return false;
  const raw = fs.readFileSync(reposPath, 'utf8');
  if (raw.includes('--optional')) return false; // header (or a data line) already knows the flag
  const legacy = LEGACY_REPOS_HEADERS.find(h => raw.includes(h));
  if (!legacy) return false; // hand-edited header — leave it alone
  if (!dryRun) fs.writeFileSync(reposPath, raw.replace(legacy, REPOS_HEADER.join('\n')));
  return true;
}

// Modernize a converted project instruction file: swap the frozen 2.8.0 hub
// blocks for their root-as-hub equivalents. User-edited text never matches and
// passes through untouched.
function convertProjectContent(content) {
  return content
    .replace(LEGACY_HUB_VOCAB_BULLET, '')
    .replace(LEGACY_TASK_VOCAB_BULLET, NEW_TASK_VOCAB_BULLET)
    .replace(LEGACY_WHERE_THINGS_LIVE, templates.ROOT_PLANNING_SECTION)
    .replace(LEGACY_PROJECT_CONFLICT, NEW_PROJECT_CONFLICT);
}

function convertTaskContent(content) {
  return content.replace(LEGACY_TASK_CONFLICT, NEW_TASK_CONFLICT);
}

// The hub's instruction-file body, ready for PLANNING.md: template boilerplate
// (heading, intro, conflict policy, work-log rules) stripped, user content kept.
function planningBodyFromHub(content) {
  return content
    .replace(/^## Task: hub[^\n]*\n/, '')
    .replace(LEGACY_HUB_INTRO, '')
    .replace(LEGACY_TASK_CONFLICT + '\n', '')
    .replace(templates.WORK_LOG_SECTION, '')
    .trim();
}

// Convert one directory's CLAUDE.md to AGENTS.md (canonical) + a one-line
// CLAUDE.md include. Returns 'converted' | 'scaffolded' | 'include-added' |
// 'conflict' | null (already converted / nothing to do).
function convertInstructionDir(dir, freshContent, transform, dryRun) {
  const agentsPath = path.join(dir, 'AGENTS.md');
  const claudePath = path.join(dir, 'CLAUDE.md');
  const hasAgents  = fs.existsSync(agentsPath);
  const claudeRaw  = fs.existsSync(claudePath) ? fs.readFileSync(claudePath, 'utf8') : null;

  if (hasAgents) {
    if (claudeRaw === null) {
      if (!dryRun) fs.writeFileSync(claudePath, templates.CLAUDE_INCLUDE);
      return 'include-added';
    }
    return isIncludeOnly(claudeRaw) ? null : 'conflict';
  }

  if (claudeRaw !== null && !isIncludeOnly(claudeRaw)) {
    if (!dryRun) {
      fs.writeFileSync(agentsPath, transform ? transform(claudeRaw) : claudeRaw);
      fs.writeFileSync(claudePath, templates.CLAUDE_INCLUDE);
    }
    return 'converted';
  }

  if (!dryRun) {
    fs.writeFileSync(agentsPath, freshContent);
    fs.writeFileSync(claudePath, templates.CLAUDE_INCLUDE);
  }
  return 'scaffolded';
}

// Offer to re-key the hub's provider session dir to the project root, so
// `wksp start` resumes the old hub history. Pure path math on the source side —
// it works even after tasks/hub/ is gone, which is what makes a declined or
// skipped move recoverable via `wksp migrate --repair`. Prompts before touching
// the provider's home storage (confirm-then-migrate); never prompts when the
// caller is non-interactive (e.g. wksp import) or in a dry run.
async function offerHubSessionMigration(projectDir, dryRun, log, interactive) {
  let provider = null;
  try { provider = getProvider(projectDir); } catch { /* unusable provider config → skip */ }
  if (!provider || !provider.sessions) return;

  const hubTaskDir = path.join(projectDir, 'tasks', 'hub');
  const { from, to, sessionCount, targetExists } = provider.sessions.dirsFor(hubTaskDir, projectDir);
  if (!fs.existsSync(from)) return;

  const label     = sessionCount === 1 ? '1 session' : `${sessionCount} sessions`;
  const manualCmd = process.platform === 'win32' ? `move "${from}" "${to}"` : `mv "${from}" "${to}"`;

  if (dryRun) {
    log(`  hub sessions — would offer to move ${label} to the project-root key`);
    return;
  }
  if (!interactive) {
    log(`  ⚠  hub session history (${label}) is still keyed by tasks/hub — run \`wksp migrate --repair\` to move it.`);
    return;
  }

  log(`\n  The hub's chat history (${label}) is keyed by the old tasks/hub path. wksp can`);
  log(`  re-key it to the project root so \`wksp start\` resumes it:`);
  log(`    from: ${from}`);
  log(`    to:   ${to}`);
  if (targetExists) log(`    (a root-keyed dir already exists — sessions will be merged)`);
  open();
  const yes = await confirmDefaultYes('  Move session history now?');
  close();
  if (!yes) {
    log(`  Left under the old key. Move it later with \`wksp migrate --repair\`, or:`);
    log(`    ${manualCmd}`);
    return;
  }

  const res = provider.sessions.migrate(from, to);
  for (const w of res.warnings) log(`  ⚠  ${w}`);
  if (!fs.existsSync(from)) {
    log(`  ✓  Migrated hub session history → project-root key`);
  } else {
    log(`  ⚠  Some chat history could not be moved — it's still under the old key, so`);
    log(`     \`wksp start\` won't find it. Move it yourself to keep it:`);
    log(`       from: ${from}`);
    log(`       to:   ${to}`);
    log(`       (e.g. ${manualCmd})`);
  }
}

// Apply migration schema 3 → 4 (root-as-hub):
//   - Refresh the repos.txt header comment to document --optional
//   - Merge tasks/hub/ into the project root: instruction file → PLANNING.md,
//     WORKLOG.md → root WORKLOG.md, then remove tasks/hub/
//   - Scaffold PLANNING.md / root WORKLOG.md when missing (pre-2.8.0 projects)
//   - AGENTS.md canonicalization: root + every task (live and archived) gets
//     AGENTS.md as the canonical instruction file, CLAUDE.md as a one-line include
//   - Offer to re-key hub session history to the project root (behind a prompt)
// Idempotent across all three input states: pre-2.8.0 (no hub), 2.8.0 hub,
// and user-renamed hub (treated as a normal task; nothing to merge).
async function migrate3to4(projectDir, dryRun, log = console.log, opts = {}) {
  const interactive = opts.interactive !== false;
  const projectName = config.readProjectConfig(projectDir).name || path.basename(projectDir);
  const hubDir      = path.join(projectDir, 'tasks', 'hub');
  const planningPath = path.join(projectDir, 'PLANNING.md');
  const rootWorklog  = path.join(projectDir, 'WORKLOG.md');
  const changed = [];
  let hubMerged = false; // the hub was (or, in a dry run, would be) folded into the root

  // ── repos.txt header — document the --optional flag ────────────────────────
  if (refreshReposHeader(projectDir, dryRun)) {
    log('  repos.txt — header comment updated to document --optional');
    changed.push('repos.txt');
  }

  // ── tasks/hub → project root ────────────────────────────────────────────────
  if (fs.existsSync(hubDir)) {
    let hubWts = [];
    try { hubWts = discoverWorktrees(hubDir); } catch { /* unreadable → treat as none */ }
    if (hubWts.length) {
      log(`  ⚠  tasks/hub has ${hubWts.length} worktree(s) — move that work to a real task first`);
      log(`     (wksp task repo hub <repo> exclude), then re-run \`wksp migrate --repair\`.`);
      log(`     Leaving tasks/hub in place.`);
    } else {
      hubMerged = true;
      // Instruction content → PLANNING.md. Read AGENTS.md first in case an earlier
      // partial run already converted the hub; skip include-only files.
      let hubBody = null;
      const hubInstrFiles = ['AGENTS.md', 'CLAUDE.md']
        .map(f => path.join(hubDir, f))
        .filter(p => fs.existsSync(p));
      for (const p of hubInstrFiles) {
        const raw = fs.readFileSync(p, 'utf8');
        if (!isIncludeOnly(raw)) { hubBody = planningBodyFromHub(raw); break; }
      }

      if (hubBody) {
        if (!fs.existsSync(planningPath)) {
          log(`  tasks/hub instruction file → PLANNING.md  (backlog + open decisions)`);
          if (!dryRun) fs.writeFileSync(planningPath, `# Planning — ${projectName}\n\n${hubBody}\n`);
        } else {
          log(`  PLANNING.md already exists — appending hub content under a "Merged from tasks/hub" heading`);
          if (!dryRun) fs.appendFileSync(planningPath, `\n---\n\n## Merged from tasks/hub\n\n${hubBody}\n`);
        }
        changed.push('PLANNING.md');
      }
      if (!dryRun) for (const p of hubInstrFiles) fs.rmSync(p, { force: true });

      // Hub worklog → root worklog.
      const hubWorklog = path.join(hubDir, 'WORKLOG.md');
      if (fs.existsSync(hubWorklog)) {
        const raw  = fs.readFileSync(hubWorklog, 'utf8');
        const body = raw.replace(/^# Work Log:[^\n]*\n/, '').trim();
        if (!fs.existsSync(rootWorklog)) {
          log(`  tasks/hub/WORKLOG.md → WORKLOG.md`);
          if (!dryRun) fs.writeFileSync(rootWorklog, `# Work Log: ${projectName}\n${body ? body + '\n' : ''}`);
        } else if (body) {
          log(`  tasks/hub/WORKLOG.md — appending entries to root WORKLOG.md`);
          if (!dryRun) {
            const existing = fs.readFileSync(rootWorklog, 'utf8');
            fs.appendFileSync(rootWorklog, (existing.endsWith('\n') ? '' : '\n') + body + '\n');
          }
        }
        if (!dryRun) fs.rmSync(hubWorklog, { force: true });
        changed.push('WORKLOG.md');
      }

      log(`  removing tasks/hub/  (the project root is the planning surface now)`);
      if (!dryRun) fs.rmSync(hubDir, { recursive: true, force: true });
      changed.push('tasks/hub removed');
    }
  }

  // ── root planning scaffold (covers pre-2.8.0 projects with no hub) ──────────
  // In a dry run the hub merge above didn't actually write, so don't re-report
  // files the merge already accounted for.
  if (!fs.existsSync(planningPath) && !changed.includes('PLANNING.md')) {
    log(`  PLANNING.md — creating  (backlog + open decisions live at the root now)`);
    if (!dryRun) fs.writeFileSync(planningPath, templates.planningMd(projectName));
    changed.push('PLANNING.md');
  }
  if (!fs.existsSync(rootWorklog) && !changed.includes('WORKLOG.md')) {
    log(`  WORKLOG.md — creating at the project root`);
    if (!dryRun) fs.writeFileSync(rootWorklog, `# Work Log: ${projectName}\n`);
    changed.push('WORKLOG.md');
  }

  // ── AGENTS.md canonicalization: root, then every task dir ───────────────────
  const rootResult = convertInstructionDir(
    projectDir, templates.projectAgentsMd(projectName), convertProjectContent, dryRun);
  if (rootResult === 'conflict') {
    log(`  ⚠  AGENTS.md and a non-include CLAUDE.md both exist at the root — merge them`);
    log(`     into AGENTS.md yourself, then reduce CLAUDE.md to a single "@AGENTS.md" line.`);
  } else if (rootResult) {
    log(`  AGENTS.md — ${rootResult === 'converted' ? 'created from CLAUDE.md; CLAUDE.md is now a one-line include' : rootResult}`);
    changed.push('AGENTS.md');
  }

  const liveTasksRoot = path.join(projectDir, 'tasks');
  for (const root of [liveTasksRoot, path.join(projectDir, 'archived-tasks')]) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      // The merged hub is removed, not converted (in a dry run it still exists).
      if (hubMerged && root === liveTasksRoot && entry.name === 'hub') continue;
      const taskDir = path.join(root, entry.name);
      const label   = path.relative(projectDir, taskDir);
      const result  = convertInstructionDir(
        taskDir, templates.taskAgentsMd(entry.name), convertTaskContent, dryRun);
      if (result === 'conflict') {
        log(`  ⚠  ${label} — AGENTS.md and a non-include CLAUDE.md both exist; merge manually`);
      } else if (result) {
        log(`  ${label}/AGENTS.md — ${result}`);
        changed.push(label);
      }
    }
  }

  // ── hub session history → project-root key (prompted) ───────────────────────
  await offerHubSessionMigration(projectDir, dryRun, log, interactive);

  if (!changed.length) log('  root-as-hub — nothing to convert, already up to date.');
  return { changed };
}

// ─── 4 → 5 helper (headless delegation in the project instruction file) ──────

// Headings the project template places *after* the delegation block, tried in
// order as an insertion anchor. A hand-edited file with none of them gets the
// block appended instead — this step only ever inserts, so user prose is never
// rewritten or merged into.
const DELEGATION_ANCHORS = [
  '## Cross-cutting conventions',
  '## AI provider self-check',
  '## Conflict policy',
  '## Work log',
];

// The 3 → 4 conversion refuses to act when AGENTS.md and a real (non-include)
// CLAUDE.md both exist at the root, asking the user to merge them by hand. Adding
// a section to one of them mid-conflict would drop new text into the middle of
// that pending merge, so this step stands down until it is resolved.
function rootInstructionConflict(projectDir) {
  const agentsPath = path.join(projectDir, 'AGENTS.md');
  const claudePath = path.join(projectDir, 'CLAUDE.md');
  if (!fs.existsSync(agentsPath) || !fs.existsSync(claudePath)) return false;
  return !isIncludeOnly(fs.readFileSync(claudePath, 'utf8'));
}

// The root instruction file to add to / edit: AGENTS.md is canonical (the 3 → 4 step
// guarantees it), and CLAUDE.md is only the target for a project whose conversion
// couldn't complete. Shared by the 4 → 5, 5 → 6 and 6 → 7 content steps.
function rootInstructionTarget(projectDir) {
  const agentsMd = path.join(projectDir, 'AGENTS.md');
  const claudeMd = path.join(projectDir, 'CLAUDE.md');
  return fs.existsSync(agentsMd) ? agentsMd
       : fs.existsSync(claudeMd) ? claudeMd
       : null;
}

// Has the schema 6 → 7 relocation already happened for this file? The pointer that
// step leaves behind is the marker. The 4 → 5 and 5 → 6 steps consult this and stand
// down when it is true: their blocks now live in ORCHESTRATION.md, so re-inserting
// them under `--repair` would resurrect hub-only guidance in the instruction file and
// duplicate the boundary section that 6 → 7 deliberately keeps.
function guidanceRelocated(content) {
  return content.includes(templates.HUB_POINTER_HEADING);
}

// Apply migration schema 4 → 5:
//   - Add the headless delegation recipe + the hub/task information boundary to
//     the project's instruction file.
// Content-only — no file structure changes — but it earns a schema bump because
// without it the headless flow is invisible to every project that already exists:
// the recipe is how a planning session learns it can create and drive tasks
// itself. Idempotent: a file that already has the section is left alone, which is
// what makes it safe under `--repair` and `wksp import`.
function migrate4to5(projectDir, dryRun, log = console.log) {
  const target = rootInstructionTarget(projectDir);

  if (!target) {
    log('  no project instruction file at the root — nothing to add.');
    return { changed: false };
  }
  if (rootInstructionConflict(projectDir)) {
    log('  ⚠  root AGENTS.md / CLAUDE.md are still unmerged — not adding the delegation');
    log('     section. Resolve that first, then run `wksp migrate --repair`.');
    return { changed: false };
  }

  const content = fs.readFileSync(target, 'utf8');
  const name    = path.basename(target);

  if (isIncludeOnly(content)) {
    log(`  ${name} is an include-only stub and AGENTS.md is missing — skipping.`);
    return { changed: false };
  }
  if (content.includes(templates.DELEGATION_HEADING)) {
    log(`  ${name} — already explains headless delegation, nothing to add.`);
    return { changed: false };
  }
  if (guidanceRelocated(content)) {
    log(`  ${name} — delegation guidance lives in ${templates.GUIDANCE_FILE} now, nothing to add here.`);
    return { changed: false };
  }

  const anchor = DELEGATION_ANCHORS.find(h => content.includes('\n' + h));
  const next = anchor
    ? content.replace('\n' + anchor, '\n' + templates.DELEGATION_SECTION + anchor)
    : content.replace(/\s*$/, '') + '\n\n' + templates.DELEGATION_SECTION.trimEnd() + '\n';

  log(`  ${name} — adding the headless delegation recipe and hub/task boundary`);
  log(`    (${anchor ? `inserted before "${anchor}"` : 'appended at the end'})`);
  if (!dryRun) fs.writeFileSync(target, next);
  return { changed: true };
}

// ─── 5 → 6 helper (orchestration guidance in the project instruction file) ───

// Headings the project template places *after* the orchestration block, tried in
// order as an insertion anchor — identical to the delegation anchors, since the
// orchestration block sits between the delegation block and these headings. A
// hand-edited file with none of them gets the block appended instead, so this step
// only ever inserts and never rewrites user prose.
const ORCHESTRATION_ANCHORS = DELEGATION_ANCHORS;

// Apply migration schema 5 → 6:
//   - Add the review→fix→re-review loop recipe, the task-steering model, and the
//     agent-honored settings (reviewLoop / prGate / mergeMethod) to the project's
//     instruction file.
// Content-only — no file structure changes — but it earns a schema bump for the same
// reason 4 → 5 did: the sections are how a planning session learns the orchestration
// flow and the settings exist, so without a migration the guidance is invisible to
// every project that already exists. Mirrors migrate4to5's safety properties exactly:
// insert-only, idempotent (a file that already has the section is left alone, which is
// what makes it safe under `--repair` and `wksp import`), and it stands down while the
// root AGENTS.md / CLAUDE.md are still unmerged. Task files are not touched — this is a
// root concern.
function migrate5to6(projectDir, dryRun, log = console.log) {
  const target = rootInstructionTarget(projectDir);

  if (!target) {
    log('  no project instruction file at the root — nothing to add.');
    return { changed: false };
  }
  if (rootInstructionConflict(projectDir)) {
    log('  ⚠  root AGENTS.md / CLAUDE.md are still unmerged — not adding the orchestration');
    log('     section. Resolve that first, then run `wksp migrate --repair`.');
    return { changed: false };
  }

  const content = fs.readFileSync(target, 'utf8');
  const name    = path.basename(target);

  if (isIncludeOnly(content)) {
    log(`  ${name} is an include-only stub and AGENTS.md is missing — skipping.`);
    return { changed: false };
  }
  if (content.includes(templates.ORCHESTRATION_HEADING)) {
    log(`  ${name} — already explains PR review and agent-honored settings, nothing to add.`);
    return { changed: false };
  }
  if (guidanceRelocated(content)) {
    log(`  ${name} — orchestration guidance lives in ${templates.GUIDANCE_FILE} now, nothing to add here.`);
    return { changed: false };
  }

  const anchor = ORCHESTRATION_ANCHORS.find(h => content.includes('\n' + h));
  const next = anchor
    ? content.replace('\n' + anchor, '\n' + templates.ORCHESTRATION_SECTION + anchor)
    : content.replace(/\s*$/, '') + '\n\n' + templates.ORCHESTRATION_SECTION.trimEnd() + '\n';

  log(`  ${name} — adding the review→fix loop, task-steering model, and agent-honored settings`);
  log(`    (${anchor ? `inserted before "${anchor}"` : 'appended at the end'})`);
  if (!dryRun) fs.writeFileSync(target, next);
  return { changed: true };
}

// ─── 6 → 7 helpers (hub-only guidance out of the task-injected instruction file) ──

// Where the short hub pointer goes. The template puts it right before the
// information-boundary block (the half of the old delegation section that stays), so
// that heading is tried first; the rest are the same fallbacks the 4 → 5 and 5 → 6
// steps use. A file with none of them gets the pointer appended.
const POINTER_ANCHORS = [templates.BOUNDARY_HEADING, ...DELEGATION_ANCHORS];

// Rewrite `block`'s line endings to match the ones `content` already uses, so text
// inserted into a CRLF file doesn't come back as an LF-only patch wedged inside it.
// Majority wins: a CRLF file that the 4 → 5 step already appended an LF block to is
// still a CRLF file everywhere else.
function matchEol(content, block) {
  const lf   = (content.match(/\n/g)   || []).length;
  const crlf = (content.match(/\r\n/g) || []).length;
  return crlf * 2 > lf ? block.replace(/\n/g, '\r\n') : block;
}

// Delete one shipped block from `content`, byte-for-byte. Returns the new content, or
// null when the block isn't present verbatim.
//
// This is the only migration step that REMOVES text, so it is deliberately
// unforgiving: an exact match proves the block is still the text wksp wrote, which is
// the only case where deleting it can't lose anything the user typed. Anything else —
// a word changed, a line added, indentation touched — fails to match, and the caller
// leaves the block alone and reports it instead.
//
// Exactly three shapes count as "the text wksp wrote":
//   1. the block as shipped, trailing blank line and all;
//   2. `block.trimEnd() + '\n'` — what the 4 → 5 / 5 → 6 append fallback writes when a
//      restructured file has none of their anchor headings, so the block ends the file;
//   3. `block.trimEnd()` — shape 2 with the final newline stripped by an editor.
//
// Shape 3 is accepted ONLY at end-of-file. Matched anywhere, it also matches a block
// whose last line the user APPENDED to (`…rather than here. ALSO SEE MY NOTES.`): the
// shipped text would be deleted and the user's own words left orphaned with no heading
// above them, which is exactly the "never rewrites user prose" invariant this function
// exists to hold. A stripped final newline is by definition at the end of the file, so
// the gate costs the legitimate case nothing.
//
// Each shape is tried in LF and in CRLF form. A Windows editor that normalizes line
// endings on save rewrites the whole file to CRLF; without the CRLF forms nothing
// matches, so both blocks stay put, the user gets two bogus "you've edited …" warnings,
// and ORCHESTRATION.md is created anyway — leaving the guidance duplicated and the
// relocation silently doing nothing.
function removeShippedBlock(content, block) {
  const crlf = s => s.replace(/\n/g, '\r\n');
  // [text, onlyAtEof] — longest shape first, so a block that still has its trailing
  // blank line is never matched by one of the trimmed shapes.
  const variants = [s => s, crlf].flatMap(eol => [
    [eol(block),                       false],
    [eol(block.trimEnd()) + eol('\n'), false],
    [eol(block.trimEnd()),             true ],
  ]);
  for (const [variant, onlyAtEof] of variants) {
    const found = onlyAtEof ? content.endsWith(variant) : content.includes(variant);
    // Slice off the EOF match rather than replace(): replace() would delete the FIRST
    // copy, which for a file holding two copies — one appended-to mid-file, one verbatim
    // at EOF — is the edited one, orphaning the user's words after all.
    if (found) return onlyAtEof ? content.slice(0, -variant.length) : content.replace(variant, '');
  }
  return null;
}

// Apply migration schema 6 → 7 (hub-only guidance leaves the instruction file):
//   - Create ORCHESTRATION.md at the project root from the template
//   - Remove the relocated blocks (the headless delegation recipe, and the review
//     loop / steering / settings trio) from the root instruction file
//   - Leave a short pointer behind so a hub session still finds them
//
// Why: the root instruction file is passed into EVERY task session, and just over half
// of it was orchestrator-only. The tokens matter less than the role confusion — a
// task-scoped agent was being told how to delegate, spawn reviewers and choose merge
// methods. The mechanism is the one PLANNING.md already proves: a file at the root is
// reachable but not auto-loaded, because only the instruction file is injected.
//
// Safety, mirroring migrate5to6 and going further because this step deletes text:
//   - idempotent — re-runs, `--repair` and `wksp import` add and remove nothing
//   - stands down while root AGENTS.md / CLAUDE.md are unmerged
//   - never rewrites user prose: a block the user edited no longer matches the shipped
//     text, so it is LEFT IN PLACE and reported, for them to delete when they want
//   - root file only. Task instruction files are not touched.
function migrate6to7(projectDir, dryRun, log = console.log) {
  const projectName   = config.readProjectConfig(projectDir).name || path.basename(projectDir);
  const guidancePath  = path.join(projectDir, templates.GUIDANCE_FILE);
  const target        = rootInstructionTarget(projectDir);

  if (!target) {
    log('  no project instruction file at the root — nothing to relocate.');
    return { changed: false };
  }
  if (rootInstructionConflict(projectDir)) {
    log(`  ⚠  root AGENTS.md / CLAUDE.md are still unmerged — not relocating the hub`);
    log(`     guidance. Resolve that first, then run \`wksp migrate --repair\`.`);
    return { changed: false };
  }

  const before = fs.readFileSync(target, 'utf8');
  const name   = path.basename(target);

  if (isIncludeOnly(before)) {
    log(`  ${name} is an include-only stub and AGENTS.md is missing — skipping.`);
    return { changed: false };
  }

  // ── ORCHESTRATION.md ────────────────────────────────────────────────────────
  let guidanceCreated = false;
  if (fs.existsSync(guidancePath)) {
    log(`  ${templates.GUIDANCE_FILE} already exists — left as it is.`);
  } else {
    log(`  ${templates.GUIDANCE_FILE} — creating  (hub-only guidance: delegation, PR review,`);
    log(`    stacked PRs, agent-honored settings — not loaded into task sessions)`);
    if (!dryRun) fs.writeFileSync(guidancePath, templates.orchestrationMd(projectName));
    guidanceCreated = true;
  }

  // ── remove the relocated blocks from the instruction file ───────────────────
  let content = before;
  const kept  = [];
  const relocated = [
    { label: 'the headless delegation recipe', heading: templates.DELEGATION_HEADING,   block: templates.DELEGATION_RECIPE_SECTION },
    { label: 'the review loop / steering / settings sections', heading: templates.ORCHESTRATION_HEADING, block: templates.ORCHESTRATION_SECTION },
  ];
  for (const { label, heading, block } of relocated) {
    // Remove every verbatim copy, not just the first: a file that somehow ended up with
    // the block twice would otherwise keep one silently.
    let removed = 0;
    for (let stripped; (stripped = removeShippedBlock(content, block)) !== null; removed++) {
      content = stripped;
    }
    if (removed) {
      const copies = removed > 1 ? ` (${removed} copies)` : '';
      log(`  ${name} — removing ${label}${copies}  (now in ${templates.GUIDANCE_FILE})`);
    }
    // Heading still there → what is left doesn't match the shipped text, so it is the
    // user's own version. Never touched, only reported.
    if (content.includes(heading)) kept.push({ label, heading, partial: removed > 0 });
  }
  // Removing a block that sat at the end of the file can leave a run of blank lines.
  // `\r?\n` so a CRLF file is collapsed to CRLF blank lines, not left with stray \r.
  content = content.replace(/(\r?\n){3,}$/, m => (m.includes('\r') ? '\r\n\r\n' : '\n\n'));

  // ── the pointer that stays ──────────────────────────────────────────────────
  if (!guidanceRelocated(content)) {
    // Anchor matching uses a bare '\n' so it also hits the \n of a CRLF '\r\n'; the
    // inserted block takes the file's own line endings.
    const pointer = matchEol(content, templates.HUB_POINTER_SECTION);
    const nl      = pointer.includes('\r\n') ? '\r\n' : '\n';
    const anchor  = POINTER_ANCHORS.find(h => content.includes('\n' + h));
    content = anchor
      ? content.replace('\n' + anchor, '\n' + pointer + anchor)
      : content.replace(/\s*$/, '') + nl + nl + pointer.trimEnd() + nl;
    log(`  ${name} — adding the hub pointer to ${templates.GUIDANCE_FILE}`);
    log(`    (${anchor ? `inserted before "${anchor}"` : 'appended at the end'})`);
  }

  for (const { label, heading, partial } of kept) {
    log(partial
      ? `  ⚠  ${name} — another, edited copy of ${label} is still there; left in place.`
      : `  ⚠  ${name} — you've edited ${label}, so it was left in place.`);
    log(`     The shipped version now lives in ${templates.GUIDANCE_FILE}; delete "${heading}"`);
    log(`     (and what follows it) by hand once you're happy with the new file.`);
  }

  const changed = content !== before;
  if (changed && !dryRun) fs.writeFileSync(target, content);
  if (!changed && !guidanceCreated) log(`  ${name} — hub guidance already relocated, nothing to do.`);
  return { changed: changed || guidanceCreated };
}

// ─── migration engine ─────────────────────────────────────────────────────────

// Run every migration step whose target version is greater than `from`, in order,
// stamping schemaVersion after each. Every step is idempotent (it checks before it
// writes), so this is safe to call with from = 0 to re-assert the full schema on a
// project that is already stamped current — that is exactly what `--repair` and
// `wksp import` rely on. `log` lets callers silence the per-step output.
// `opts.interactive: false` suppresses every prompt (the 3→4 session move is then
// skipped with a note) — used by `wksp import`, which runs migrations silently.
// Returns { converted, updated } so callers can report what actually changed.
async function applyMigrations(projectDir, from, dryRun, log = console.log, opts = {}) {
  let converted = [];
  let updated   = [];

  // ── 0 → 1 ──────────────────────────────────────────────────────────────────
  if (from < 1) {
    const { aliasLines } = migrate0to1(projectDir, dryRun);

    if (aliasLines.length > 0) {
      log('  repos.txt — alias entries found (--as is no longer supported):');
      aliasLines.forEach(l => {
        const { cleaned } = stripAlias(l);
        log(`    before: ${l.trim()}`);
        log(`    after:  ${cleaned.trim()}`);
        log('    ⚠  If you needed this alias for a second branch, check out the repo into');
        log('       a separate directory and register it with `wksp repo add <new-path>`.\n');
      });
    } else {
      log('  repos.txt — no alias entries found, nothing to clean.');
    }

    if (!dryRun) {
      config.setProjectConfig(projectDir, 'schemaVersion', 1);
      log('  ✓  .wksp: schemaVersion set to 1');
    }

    from = 1;
  }

  // ── 1 → 2 ──────────────────────────────────────────────────────────────────
  if (from < 2) {
    ({ converted } = migrate1to2(projectDir, dryRun, log));
    if (!dryRun) {
      config.setProjectConfig(projectDir, 'schemaVersion', 2);
      log('  ✓  .wksp: schemaVersion set to 2');
      if (converted.length > 0) {
        log(`  ✓  Converted ${converted.length} task dir(s) to task.json`);
      }
    }
    from = 2;
  }

  // ── 2 → 3 ──────────────────────────────────────────────────────────────────
  if (from < 3) {
    ({ updated } = migrate2to3(projectDir, dryRun, log));
    if (!dryRun) {
      config.setProjectConfig(projectDir, 'schemaVersion', 3);
      log('  ✓  .wksp: schemaVersion set to 3');
      if (updated.length > 0) {
        log(`  ✓  Updated ${updated.length} task dir(s) with WORKLOG.md`);
      }
    }
    from = 3;
  }

  // ── 3 → 4 ──────────────────────────────────────────────────────────────────
  if (from < 4) {
    await migrate3to4(projectDir, dryRun, log, opts);
    if (!dryRun) {
      config.setProjectConfig(projectDir, 'schemaVersion', 4);
      log('  ✓  .wksp: schemaVersion set to 4');
    }
    from = 4;
  }

  // ── 4 → 5 ──────────────────────────────────────────────────────────────────
  if (from < 5) {
    migrate4to5(projectDir, dryRun, log);
    if (!dryRun) {
      config.setProjectConfig(projectDir, 'schemaVersion', 5);
      log('  ✓  .wksp: schemaVersion set to 5');
    }
    from = 5;
  }

  // ── 5 → 6 ──────────────────────────────────────────────────────────────────
  if (from < 6) {
    migrate5to6(projectDir, dryRun, log);
    if (!dryRun) {
      config.setProjectConfig(projectDir, 'schemaVersion', 6);
      log('  ✓  .wksp: schemaVersion set to 6');
    }
    from = 6;
  }

  // ── 6 → 7 ──────────────────────────────────────────────────────────────────
  if (from < 7) {
    migrate6to7(projectDir, dryRun, log);
    if (!dryRun) {
      config.setProjectConfig(projectDir, 'schemaVersion', 7);
      log('  ✓  .wksp: schemaVersion set to 7');
    }
    from = 7;
  }

  return { converted, updated };
}

// ─── main command ─────────────────────────────────────────────────────────────

async function run(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
  wksp migrate

  Detect and apply any pending project schema migrations.

  Options:
    --dry-run    Show what would be changed without writing anything
    --repair     Re-apply every migration step even when the project is already
                 stamped at the current schema. Use when a task is missing schema
                 artifacts (e.g. WORKLOG.md) it should have — this happens for tasks
                 created by an older wksp or brought in via \`wksp import\`. Idempotent:
                 it only fills in what is missing and never duplicates anything.

  What it does:
    Schema 0 → 1  Strips legacy --as <alias> entries from repos.txt (removed in v2.1.0).
                  The alias portion is removed; the base path is kept. If you relied on
                  --as to register the same repo twice, check out the repo into two
                  separate directories and register each with \`wksp repo add\`.

    Schema 1 → 2  Converts task-shared.txt + task-excluded.txt in every task dir
                  (live and archived) into a single task.json file. The old .txt
                  files are removed once task.json is written.

    Schema 2 → 3  Adds a \`## Work log\` section to each task's CLAUDE.md (if missing)
                  and creates an empty WORKLOG.md in each task dir (if missing).
                  Applies to both live and archived tasks.

    Schema 3 → 4  Root-as-hub: the project root replaces the reserved "hub" task as
                  the planning surface. Merges tasks/hub/ into the root (instruction
                  file → PLANNING.md, worklog → root WORKLOG.md), scaffolds those
                  files when there was no hub, and removes tasks/hub/. Canonicalizes
                  instruction files: AGENTS.md holds the content everywhere (root and
                  every task, live and archived); CLAUDE.md becomes a one-line
                  "@AGENTS.md" include. Offers — behind a prompt, since it touches
                  the AI tool's own storage — to re-key hub chat history to the
                  project root so \`wksp start\` resumes it. Also refreshes the
                  repos.txt header comment to document the --optional flag (data
                  lines are untouched — existing files are already valid).

    Schema 4 → 5  Teaches the project's instruction file the headless flow: how a
                  planning session at the root creates a task and works in it
                  (\`wksp task create <id> --json\`, \`wksp task brief\`), plus which
                  information belongs at the root and which belongs in a task.
                  Content only — the block is inserted before the "Cross-cutting
                  conventions" heading (or appended when the file has been
                  restructured), and a file that already explains it is left alone.

    Schema 5 → 6  Adds the orchestration guidance to the project's instruction file:
                  the review→fix→re-review loop for a delegated PR, how to steer a task
                  across iterations (resume vs. fresh vs. new), and the agent-honored
                  settings the orchestrator reads (\`reviewLoop\`, \`prGate\`,
                  \`mergeMethod\`). Content only, inserted with the same insert-only,
                  idempotent, conflict-safe rules as the 4 → 5 step; a file that already
                  documents it is left alone. Task instruction files are untouched.

    Schema 6 → 7  Moves hub-only guidance out of the root instruction file, which is
                  passed into every task session, and into a new root
                  \`ORCHESTRATION.md\` — reachable by a planning session at the root but
                  never loaded by a task, the same way \`PLANNING.md\` already works. The
                  delegation recipe and the review-loop / steering / settings sections
                  move (joined there by stacked-PR guidance); the vocabulary, the
                  root/task information boundary, conventions, and the conflict policy
                  stay. A short pointer is left in the instruction file so the hub still
                  finds them. This is the one step that DELETES text, so it only removes
                  a block that still matches the shipped template byte-for-byte: a block
                  you have edited is left in place and reported for you to delete by
                  hand. An existing \`ORCHESTRATION.md\` is never overwritten. Root file
                  only — task instruction files are untouched.
`);
    process.exit(0);
  }

  const dryRun = args.includes('--dry-run');
  const repair = args.includes('--repair');

  const projectDir = config.findProjectDir();
  if (!projectDir) {
    console.error('  Error: not inside a wksp project (no .wksp marker found)');
    process.exit(1);
  }

  // Belt and braces with the resolution fix in lib/config.js. `migrate` is the command
  // that corrupts on a wrong answer rather than merely misreporting: it scaffolds
  // PLANNING.md/WORKLOG.md/AGENTS.md/ORCHESTRATION.md into the directory and stamps
  // `schemaVersion` via writeProjectConfig — which for the home directory means writing a
  // project field straight into the global config, because both files are `.wksp`.
  const unsafe = unsafeProjectDirReason(projectDir);
  if (unsafe) {
    console.error(`\n  Error: refusing to migrate ${projectDir} — ${unsafe}.`);
    console.error('  This is never a wksp project. Nothing was changed.\n');
    process.exit(1);
  }

  const { schemaVersion = 0 } = config.readProjectConfig(projectDir);

  if (!repair && schemaVersion >= config.CURRENT_SCHEMA_VERSION) {
    console.log('  ✓  Already up to date (schema v' + schemaVersion + ').');
    console.log('     If a task is missing files it should have, run: wksp migrate --repair');
    return;
  }

  // --repair re-runs every step regardless of the stamped version; each step is
  // idempotent, so a task missing an artifact gets it backfilled.
  const from = repair ? 0 : schemaVersion;

  if (repair) {
    console.log(`\n  Repairing project — re-applying all schema steps up to v${config.CURRENT_SCHEMA_VERSION}${dryRun ? '  (dry run)' : ''}\n`);
  } else {
    console.log(`\n  Migrating project from schema v${schemaVersion} → v${config.CURRENT_SCHEMA_VERSION}${dryRun ? '  (dry run)' : ''}\n`);
  }

  await applyMigrations(projectDir, from, dryRun, console.log);

  if (dryRun) {
    console.log('\n  Dry run complete — no files were written.');
  } else if (repair) {
    console.log('\n  ✓  Repair complete. Project is at schema v' + config.CURRENT_SCHEMA_VERSION + '.');
  } else {
    console.log('\n  ✓  Migration complete. Project is now at schema v' + config.CURRENT_SCHEMA_VERSION + '.');
  }
}

module.exports = {
  run, applyMigrations,
  migrate0to1, migrate1to2, migrate2to3, migrate3to4, migrate4to5, migrate5to6, migrate6to7,
  stripAlias, removeShippedBlock,
};
