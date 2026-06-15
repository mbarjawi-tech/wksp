'use strict';
const fs   = require('fs');
const path = require('path');
const config = require('../config');
const { REPOS_FILE } = require('../repos');
const { readTaskSets, writeTaskSets, TASK_CONFIG_FILE, LEGACY_SHARED_FILE, LEGACY_EXCLUDED_FILE } = require('../task-state');

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
      const claudeMd  = path.join(taskDir, 'CLAUDE.md');
      const worklog   = path.join(taskDir, 'WORKLOG.md');
      let changed     = false;

      if (fs.existsSync(claudeMd)) {
        const content = fs.readFileSync(claudeMd, 'utf8');
        if (!content.includes('## Work log')) {
          log(`  ${label}/CLAUDE.md  — appending Work log section`);
          if (!dryRun) fs.writeFileSync(claudeMd, content + WORK_LOG_SECTION);
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

// ─── migration engine ─────────────────────────────────────────────────────────

// Run every migration step whose target version is greater than `from`, in order,
// stamping schemaVersion after each. Every step is idempotent (it checks before it
// writes), so this is safe to call with from = 0 to re-assert the full schema on a
// project that is already stamped current — that is exactly what `--repair` and
// `wksp import` rely on. `log` lets callers silence the per-step output.
// Returns { converted, updated } so callers can report what actually changed.
function applyMigrations(projectDir, from, dryRun, log = console.log) {
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

  applyMigrations(projectDir, from, dryRun, console.log);

  if (dryRun) {
    console.log('\n  Dry run complete — no files were written.');
  } else if (repair) {
    console.log('\n  ✓  Repair complete. Project is at schema v' + config.CURRENT_SCHEMA_VERSION + '.');
  } else {
    console.log('\n  ✓  Migration complete. Project is now at schema v' + config.CURRENT_SCHEMA_VERSION + '.');
  }
}

module.exports = { run, applyMigrations, migrate0to1, migrate1to2, migrate2to3, stripAlias };
