'use strict';
const fs   = require('fs');
const path = require('path');
const config = require('../config');
const { REPOS_FILE, REPOS_HEADER } = require('../repos');
const { readTaskSets, writeTaskSets, TASK_CONFIG_FILE, LEGACY_SHARED_FILE, LEGACY_EXCLUDED_FILE } = require('../task-state');
const { discoverWorktrees } = require('../worktrees');
const { getProvider } = require('../providers');
const { open, close, confirmDefaultYes } = require('../prompts');
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

module.exports = { run, applyMigrations, migrate0to1, migrate1to2, migrate2to3, migrate3to4, stripAlias };
