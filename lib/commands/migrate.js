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
function migrate1to2(projectDir, dryRun) {
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
    console.log('  task dirs — no legacy .txt files found, nothing to convert.');
    return { converted: [] };
  }

  for (const { taskDir, label, taskSharedSet, taskExcludedSet } of toConvert) {
    const shared   = [...taskSharedSet].join(', ')   || '(none)';
    const excluded = [...taskExcludedSet].join(', ') || '(none)';
    console.log(`  ${label}/task.json  shared:[${shared}]  excluded:[${excluded}]`);
    if (!dryRun) writeTaskSets(taskDir, taskSharedSet, taskExcludedSet);
  }

  return { converted: toConvert };
}

// ─── main command ─────────────────────────────────────────────────────────────

async function run(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
  wksp migrate

  Detect and apply any pending project schema migrations.

  Options:
    --dry-run    Show what would be changed without writing anything

  What it does:
    Schema 0 → 1  Strips legacy --as <alias> entries from repos.txt (removed in v2.1.0).
                  The alias portion is removed; the base path is kept. If you relied on
                  --as to register the same repo twice, check out the repo into two
                  separate directories and register each with \`wksp repo add\`.

    Schema 1 → 2  Converts task-shared.txt + task-excluded.txt in every task dir
                  (live and archived) into a single task.json file. The old .txt
                  files are removed once task.json is written.
`);
    process.exit(0);
  }

  const dryRun = args.includes('--dry-run');

  const projectDir = config.findProjectDir();
  if (!projectDir) {
    console.error('  Error: not inside a wksp project (no .wksp marker found)');
    process.exit(1);
  }

  const { schemaVersion = 0 } = config.readProjectConfig(projectDir);

  if (schemaVersion >= config.CURRENT_SCHEMA_VERSION) {
    console.log('  ✓  Already up to date (schema v' + schemaVersion + ').');
    return;
  }

  console.log(`\n  Migrating project from schema v${schemaVersion} → v${config.CURRENT_SCHEMA_VERSION}${dryRun ? '  (dry run)' : ''}\n`);

  let from = schemaVersion;

  // ── 0 → 1 ──────────────────────────────────────────────────────────────────
  if (from < 1) {
    const { aliasLines } = migrate0to1(projectDir, dryRun);

    if (aliasLines.length > 0) {
      console.log('  repos.txt — alias entries found (--as is no longer supported):');
      aliasLines.forEach(l => {
        const { cleaned } = stripAlias(l);
        console.log(`    before: ${l.trim()}`);
        console.log(`    after:  ${cleaned.trim()}`);
        console.log('    ⚠  If you needed this alias for a second branch, check out the repo into');
        console.log('       a separate directory and register it with `wksp repo add <new-path>`.\n');
      });
    } else {
      console.log('  repos.txt — no alias entries found, nothing to clean.');
    }

    if (!dryRun) {
      config.setProjectConfig(projectDir, 'schemaVersion', 1);
      console.log('  ✓  .wksp: schemaVersion set to 1');
    }

    from = 1;
  }

  // ── 1 → 2 ──────────────────────────────────────────────────────────────────
  if (from < 2) {
    const { converted } = migrate1to2(projectDir, dryRun);
    if (!dryRun) {
      config.setProjectConfig(projectDir, 'schemaVersion', 2);
      console.log('  ✓  .wksp: schemaVersion set to 2');
      if (converted.length > 0) {
        console.log(`  ✓  Converted ${converted.length} task dir(s) to task.json`);
      }
    }
    from = 2;
  }

  if (dryRun) {
    console.log('\n  Dry run complete — no files were written.');
  } else {
    console.log('\n  ✓  Migration complete. Project is now at schema v' + config.CURRENT_SCHEMA_VERSION + '.');
  }
}

module.exports = { run, migrate0to1, migrate1to2, stripAlias };
