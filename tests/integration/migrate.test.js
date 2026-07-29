'use strict';
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { makeProject, makeTempDir, cleanup } = require('../helpers');

jest.mock('../../lib/prompts', () => ({
  open: jest.fn(), close: jest.fn(), ask: jest.fn(), confirm: jest.fn(),
  confirmDefaultYes: jest.fn(),
}));

jest.mock('../../lib/config', () => {
  const actual = jest.requireActual('../../lib/config');
  return { ...actual, findProjectDir: jest.fn() };
});

const prompts    = require('../../lib/prompts');
const config     = require('../../lib/config');
const claude     = require('../../lib/providers/claude');
const templates  = require('../../lib/templates');
const migrateCmd = require('../../lib/commands/migrate');

let logLines, warnLines;
beforeEach(() => {
  logLines  = [];
  warnLines = [];
  jest.spyOn(console, 'log').mockImplementation((...a)  => logLines.push(a.join(' ')));
  jest.spyOn(console, 'warn').mockImplementation((...a) => warnLines.push(a.join(' ')));
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(process, 'exit').mockImplementation(code => {
    throw new Error(`process.exit(${code})`);
  });
});
afterEach(() => jest.restoreAllMocks());

async function runMigrate(projectDir, ...args) {
  config.findProjectDir.mockReturnValue(projectDir);
  await migrateCmd.run(args);
}

// Literal occurrence count — the headings being asserted contain regex metacharacters.
const countOf = (haystack, needle) => haystack.split(needle).length - 1;

// ─── already up to date ───────────────────────────────────────────────────────

describe('project already at current schema', () => {
  let projectDir;
  beforeEach(() => { projectDir = makeProject('mig-uptodate'); });
  afterEach(() => cleanup(projectDir));

  test('prints "already up to date" and makes no changes', async () => {
    // makeProject writes a .wksp without schemaVersion — set it to current
    config.setProjectConfig(projectDir, 'schemaVersion', config.CURRENT_SCHEMA_VERSION);

    await runMigrate(projectDir);

    expect(logLines.some(l => l.includes('Already up to date'))).toBe(true);
    // .wksp unchanged
    const wksp = config.readProjectConfig(projectDir);
    expect(wksp.schemaVersion).toBe(config.CURRENT_SCHEMA_VERSION);
  });
});

// ─── schema 0 → 1 (no alias entries) ─────────────────────────────────────────

describe('schema 0 → 1 — clean repos.txt', () => {
  let projectDir;
  beforeEach(() => { projectDir = makeProject('mig-clean'); });
  afterEach(() => cleanup(projectDir));

  test('bumps schemaVersion; repos.txt only gets its header comment refreshed', async () => {
    await runMigrate(projectDir);

    expect(config.readProjectConfig(projectDir).schemaVersion).toBe(config.CURRENT_SCHEMA_VERSION);
    // No alias entries to strip — the 3→4 step just refreshes the header comment.
    const repos = fs.readFileSync(path.join(projectDir, 'repos.txt'), 'utf8');
    expect(repos).toContain('[--shared] [--optional]');
    expect(repos.split('\n').filter(l => l.trim() && !l.startsWith('#'))).toEqual([]);
    expect(logLines.some(l => l.includes('Migration complete'))).toBe(true);
  });
});

// ─── schema 0 → 1 (alias entries present) ────────────────────────────────────

describe('schema 0 → 1 — repos.txt has --as entries', () => {
  let projectDir;
  beforeEach(() => {
    projectDir = makeProject('mig-alias');
    fs.writeFileSync(path.join(projectDir, 'repos.txt'), [
      '# Workspace repos',
      '# Format: <path> [--shared] [--as <alias>]',
      '',
      'C:/dev/backend',
      'C:/dev/malachite',
      'C:/dev/malachite  --as malachite-b',
      '',
    ].join('\n'));
  });
  afterEach(() => cleanup(projectDir));

  test('strips alias entries and writes schemaVersion', async () => {
    await runMigrate(projectDir);

    const repos = fs.readFileSync(path.join(projectDir, 'repos.txt'), 'utf8');
    expect(repos).not.toContain('--as');
    expect(repos).toContain('C:/dev/malachite');
    expect(repos).toContain('C:/dev/backend');
    expect(repos).not.toContain('[--as <alias>]');

    expect(config.readProjectConfig(projectDir).schemaVersion).toBe(config.CURRENT_SCHEMA_VERSION);
  });

  test('prints details about each stripped alias', async () => {
    await runMigrate(projectDir);
    const out = logLines.join('\n');
    expect(out).toMatch(/malachite-b/);
    expect(out).toMatch(/before:/);
    expect(out).toMatch(/after:/);
  });
});

// ─── dry-run ─────────────────────────────────────────────────────────────────

describe('--dry-run', () => {
  let projectDir;
  beforeEach(() => {
    projectDir = makeProject('mig-dry');
    fs.writeFileSync(path.join(projectDir, 'repos.txt'),
      'C:/dev/malachite  --as malachite-b\n');
  });
  afterEach(() => cleanup(projectDir));

  test('does not modify repos.txt', async () => {
    await runMigrate(projectDir, '--dry-run');
    const repos = fs.readFileSync(path.join(projectDir, 'repos.txt'), 'utf8');
    expect(repos).toContain('--as malachite-b');
  });

  test('does not write schemaVersion', async () => {
    await runMigrate(projectDir, '--dry-run');
    expect(config.readProjectConfig(projectDir).schemaVersion).toBeUndefined();
  });

  test('prints dry-run indicator', async () => {
    await runMigrate(projectDir, '--dry-run');
    expect(logLines.some(l => l.includes('dry run'))).toBe(true);
  });
});

// ─── schema 1 → 2 (task.json consolidation) ──────────────────────────────────

describe('schema 1 → 2 — legacy .txt files present', () => {
  let projectDir;
  beforeEach(() => {
    projectDir = makeProject('mig-1to2');
    // Simulate a schema-v1 project
    config.setProjectConfig(projectDir, 'schemaVersion', 1);
    // Create a live task with legacy files
    const taskDir = path.join(projectDir, 'tasks', 'TASK-1');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'task-shared.txt'), 'backend\n');
    fs.writeFileSync(path.join(taskDir, 'task-excluded.txt'), 'docs\n');
  });
  afterEach(() => cleanup(projectDir));

  test('writes task.json and removes legacy files', async () => {
    await runMigrate(projectDir);
    const taskDir = path.join(projectDir, 'tasks', 'TASK-1');
    expect(fs.existsSync(path.join(taskDir, 'task.json'))).toBe(true);
    expect(fs.existsSync(path.join(taskDir, 'task-shared.txt'))).toBe(false);
    expect(fs.existsSync(path.join(taskDir, 'task-excluded.txt'))).toBe(false);
  });

  test('task.json contains correct shared and excluded values', async () => {
    await runMigrate(projectDir);
    const data = JSON.parse(fs.readFileSync(path.join(projectDir, 'tasks', 'TASK-1', 'task.json'), 'utf8'));
    expect(data.shared).toEqual(['backend']);
    expect(data.excluded).toEqual(['docs']);
  });

  test('bumps schemaVersion to 2', async () => {
    await runMigrate(projectDir);
    expect(config.readProjectConfig(projectDir).schemaVersion).toBe(config.CURRENT_SCHEMA_VERSION);
  });
});

describe('schema 1 → 2 — dry-run', () => {
  let projectDir;
  beforeEach(() => {
    projectDir = makeProject('mig-1to2-dry');
    config.setProjectConfig(projectDir, 'schemaVersion', 1);
    const taskDir = path.join(projectDir, 'tasks', 'TASK-X');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'task-shared.txt'), 'api\n');
  });
  afterEach(() => cleanup(projectDir));

  test('does not write task.json in dry-run', async () => {
    await runMigrate(projectDir, '--dry-run');
    expect(fs.existsSync(path.join(projectDir, 'tasks', 'TASK-X', 'task.json'))).toBe(false);
  });

  test('does not write schemaVersion in dry-run', async () => {
    await runMigrate(projectDir, '--dry-run');
    expect(config.readProjectConfig(projectDir).schemaVersion).toBe(1);
  });

  test('prints dry-run indicator', async () => {
    await runMigrate(projectDir, '--dry-run');
    expect(logLines.some(l => l.includes('dry run'))).toBe(true);
  });
});

// ─── schema 2 → 3 (WORKLOG.md + Work log section) ────────────────────────────

describe('schema 2 → 3 — adds WORKLOG.md and Work log section', () => {
  let projectDir;
  beforeEach(() => {
    projectDir = makeProject('mig-2to3');
    config.setProjectConfig(projectDir, 'schemaVersion', 2);
    const taskDir = path.join(projectDir, 'tasks', 'TASK-WL');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'CLAUDE.md'), '## Task: TASK-WL\n## Goal: test\n');
  });
  afterEach(() => cleanup(projectDir));

  test('creates WORKLOG.md in task dir', async () => {
    await runMigrate(projectDir);
    expect(fs.existsSync(path.join(projectDir, 'tasks', 'TASK-WL', 'WORKLOG.md'))).toBe(true);
  });

  test('appends Work log section (landing in AGENTS.md after the v4 conversion)', async () => {
    await runMigrate(projectDir);
    const content = fs.readFileSync(path.join(projectDir, 'tasks', 'TASK-WL', 'AGENTS.md'), 'utf8');
    expect(content).toContain('## Work log');
    expect(content).toContain('WORKLOG.md');
    expect(fs.readFileSync(path.join(projectDir, 'tasks', 'TASK-WL', 'CLAUDE.md'), 'utf8'))
      .toBe(templates.CLAUDE_INCLUDE);
  });

  test('bumps schemaVersion to 3', async () => {
    await runMigrate(projectDir);
    expect(config.readProjectConfig(projectDir).schemaVersion).toBe(config.CURRENT_SCHEMA_VERSION);
  });

  test('does not duplicate Work log section if already present', async () => {
    const taskDir = path.join(projectDir, 'tasks', 'TASK-WL');
    const existing = fs.readFileSync(path.join(taskDir, 'CLAUDE.md'), 'utf8') + '\n## Work log\nalready here\n';
    fs.writeFileSync(path.join(taskDir, 'CLAUDE.md'), existing);

    await runMigrate(projectDir);

    const content = fs.readFileSync(path.join(taskDir, 'AGENTS.md'), 'utf8');
    expect(content.split('## Work log').length).toBe(2); // exactly one occurrence
  });
});

describe('schema 2 → 3 — dry-run', () => {
  let projectDir;
  beforeEach(() => {
    projectDir = makeProject('mig-2to3-dry');
    config.setProjectConfig(projectDir, 'schemaVersion', 2);
    const taskDir = path.join(projectDir, 'tasks', 'TASK-DRY');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'CLAUDE.md'), '## Task: TASK-DRY\n');
  });
  afterEach(() => cleanup(projectDir));

  test('does not create WORKLOG.md in dry-run', async () => {
    await runMigrate(projectDir, '--dry-run');
    expect(fs.existsSync(path.join(projectDir, 'tasks', 'TASK-DRY', 'WORKLOG.md'))).toBe(false);
  });

  test('does not modify CLAUDE.md in dry-run', async () => {
    const before = fs.readFileSync(path.join(projectDir, 'tasks', 'TASK-DRY', 'CLAUDE.md'), 'utf8');
    await runMigrate(projectDir, '--dry-run');
    const after = fs.readFileSync(path.join(projectDir, 'tasks', 'TASK-DRY', 'CLAUDE.md'), 'utf8');
    expect(after).toBe(before);
  });

  test('does not write schemaVersion in dry-run', async () => {
    await runMigrate(projectDir, '--dry-run');
    expect(config.readProjectConfig(projectDir).schemaVersion).toBe(2);
  });
});

// ─── --repair (re-apply steps on an already-current project) ─────────────────

describe('--repair — backfills missing artifacts on a current project', () => {
  let projectDir, taskDir;
  beforeEach(() => {
    projectDir = makeProject('mig-repair');
    // Project is stamped at the current schema, but a task is missing its WORKLOG —
    // exactly the state produced by `wksp import` or a task from an older wksp.
    config.setProjectConfig(projectDir, 'schemaVersion', config.CURRENT_SCHEMA_VERSION);
    taskDir = path.join(projectDir, 'tasks', 'TASK-OLD');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'CLAUDE.md'), '## Task: TASK-OLD\n');
  });
  afterEach(() => cleanup(projectDir));

  test('plain migrate does NOT touch the task (short-circuits)', async () => {
    await runMigrate(projectDir);
    expect(logLines.some(l => l.includes('Already up to date'))).toBe(true);
    expect(fs.existsSync(path.join(taskDir, 'WORKLOG.md'))).toBe(false);
  });

  test('--repair creates the missing WORKLOG.md', async () => {
    await runMigrate(projectDir, '--repair');
    expect(fs.existsSync(path.join(taskDir, 'WORKLOG.md'))).toBe(true);
  });

  test('--repair adds the missing Work log section (in the canonical AGENTS.md)', async () => {
    await runMigrate(projectDir, '--repair');
    expect(fs.readFileSync(path.join(taskDir, 'AGENTS.md'), 'utf8')).toContain('## Work log');
    expect(fs.readFileSync(path.join(taskDir, 'CLAUDE.md'), 'utf8')).toBe(templates.CLAUDE_INCLUDE);
  });

  test('--repair leaves schemaVersion at current', async () => {
    await runMigrate(projectDir, '--repair');
    expect(config.readProjectConfig(projectDir).schemaVersion).toBe(config.CURRENT_SCHEMA_VERSION);
  });

  test('--repair is idempotent — re-running does not duplicate anything', async () => {
    await runMigrate(projectDir, '--repair');
    const firstWorklog = fs.readFileSync(path.join(taskDir, 'WORKLOG.md'), 'utf8');
    const firstAgents  = fs.readFileSync(path.join(taskDir, 'AGENTS.md'), 'utf8');
    await runMigrate(projectDir, '--repair');
    expect(fs.readFileSync(path.join(taskDir, 'WORKLOG.md'), 'utf8')).toBe(firstWorklog);
    expect(fs.readFileSync(path.join(taskDir, 'AGENTS.md'), 'utf8')).toBe(firstAgents);
    expect(fs.readFileSync(path.join(taskDir, 'AGENTS.md'), 'utf8').split('## Work log').length).toBe(2);
    expect(fs.readFileSync(path.join(taskDir, 'CLAUDE.md'), 'utf8')).toBe(templates.CLAUDE_INCLUDE);
  });

  test('--repair --dry-run reports without writing', async () => {
    await runMigrate(projectDir, '--repair', '--dry-run');
    expect(fs.existsSync(path.join(taskDir, 'WORKLOG.md'))).toBe(false);
    expect(logLines.some(l => l.includes('Dry run complete'))).toBe(true);
  });
});

// ─── schema 3 → 4 (root-as-hub) ──────────────────────────────────────────────

describe('schema 3 → 4 — root-as-hub', () => {
  let projectDir, homeDir;

  const HUB_CLAUDE_MD = [
    '## Task: hub',
    '',
    'Custom intro the user wrote about this project.',
    '',
    '## Feature backlog',
    '- item one: build the thing',
    '',
    '## Open decisions',
    '- decide X or Y',
    '',
    templates.WORK_LOG_SECTION,
  ].join('\n');

  beforeEach(() => {
    // Isolate ~/.claude and ~/.wksp under a fake home (see task-rename-sessions).
    homeDir = makeTempDir('fake-home-migrate');
    jest.spyOn(os, 'homedir').mockReturnValue(homeDir);
    prompts.confirmDefaultYes.mockReset();

    projectDir = makeProject('mig-3to4');
    config.setProjectConfig(projectDir, 'schemaVersion', 3);

    // A 2.8.0-style hub with user content, plus a normal task.
    const hubDir = path.join(projectDir, 'tasks', 'hub');
    fs.mkdirSync(path.join(hubDir, 'worktrees'), { recursive: true });
    fs.writeFileSync(path.join(hubDir, 'CLAUDE.md'), HUB_CLAUDE_MD);
    fs.writeFileSync(path.join(hubDir, 'WORKLOG.md'), '# Work Log: hub\n- 2026-07-01: decided the roadmap\n');

    const taskDir = path.join(projectDir, 'tasks', 'TASK-A');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'CLAUDE.md'), '## Task: TASK-A\ncustom task notes\n\n## Work log\nrules here\n');
    fs.writeFileSync(path.join(taskDir, 'WORKLOG.md'), '# Work Log: TASK-A\n');

    // A 2.8.0-template project CLAUDE.md at the root.
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '## Project: mig-3to4\nmy conventions\n');
  });
  afterEach(() => cleanup(projectDir, homeDir));

  test('merges the hub instruction file into PLANNING.md, dropping template boilerplate', async () => {
    await runMigrate(projectDir);
    const planning = fs.readFileSync(path.join(projectDir, 'PLANNING.md'), 'utf8');
    expect(planning).toContain('# Planning —');
    expect(planning).toContain('- item one: build the thing');
    expect(planning).toContain('- decide X or Y');
    expect(planning).toContain('Custom intro the user wrote');
    expect(planning).not.toContain('## Task: hub');
    expect(planning).not.toContain('## Work log'); // template section stripped
  });

  test('merges the hub worklog into the root WORKLOG.md and removes tasks/hub/', async () => {
    await runMigrate(projectDir);
    const worklog = fs.readFileSync(path.join(projectDir, 'WORKLOG.md'), 'utf8');
    expect(worklog).toContain('# Work Log:');
    expect(worklog).toContain('- 2026-07-01: decided the roadmap');
    expect(fs.existsSync(path.join(projectDir, 'tasks', 'hub'))).toBe(false);
  });

  test('converts root and task CLAUDE.md files to AGENTS.md + include', async () => {
    await runMigrate(projectDir);

    expect(fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf8')).toContain('my conventions');
    expect(fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf8')).toBe(templates.CLAUDE_INCLUDE);

    const taskAgents = fs.readFileSync(path.join(projectDir, 'tasks', 'TASK-A', 'AGENTS.md'), 'utf8');
    expect(taskAgents).toContain('custom task notes');
    expect(fs.readFileSync(path.join(projectDir, 'tasks', 'TASK-A', 'CLAUDE.md'), 'utf8')).toBe(templates.CLAUDE_INCLUDE);
  });

  test('stamps the current schema version', async () => {
    await runMigrate(projectDir);
    expect(config.readProjectConfig(projectDir).schemaVersion).toBe(config.CURRENT_SCHEMA_VERSION);
  });

  test('does not prompt when there is no hub session history', async () => {
    await runMigrate(projectDir);
    expect(prompts.confirmDefaultYes).not.toHaveBeenCalled();
  });

  test('offers to re-key hub session history and moves it on Yes', async () => {
    const hubKeyDir = path.join(homeDir, '.claude', 'projects',
      claude.encodeProjectPath(path.join(projectDir, 'tasks', 'hub')));
    fs.mkdirSync(hubKeyDir, { recursive: true });
    fs.writeFileSync(path.join(hubKeyDir, 's1.jsonl'), '{"type":"session"}\n');
    prompts.confirmDefaultYes.mockResolvedValue(true);

    await runMigrate(projectDir);

    const rootKeyDir = path.join(homeDir, '.claude', 'projects', claude.encodeProjectPath(projectDir));
    expect(prompts.confirmDefaultYes).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(hubKeyDir)).toBe(false);
    expect(fs.existsSync(path.join(rootKeyDir, 's1.jsonl'))).toBe(true);
  });

  test('leaves session history in place when declined, recoverable via --repair', async () => {
    const hubKeyDir = path.join(homeDir, '.claude', 'projects',
      claude.encodeProjectPath(path.join(projectDir, 'tasks', 'hub')));
    fs.mkdirSync(hubKeyDir, { recursive: true });
    fs.writeFileSync(path.join(hubKeyDir, 's1.jsonl'), '{"type":"session"}\n');
    prompts.confirmDefaultYes.mockResolvedValue(false);

    await runMigrate(projectDir);
    expect(fs.existsSync(path.join(hubKeyDir, 's1.jsonl'))).toBe(true);
    expect(logLines.some(l => l.includes('--repair'))).toBe(true);

    // The offer repeats on --repair even though tasks/hub/ is gone (pure path math).
    prompts.confirmDefaultYes.mockResolvedValue(true);
    await runMigrate(projectDir, '--repair');
    expect(fs.existsSync(hubKeyDir)).toBe(false);
  });

  test('hub with live worktrees is left in place with a warning', async () => {
    // Simulate a pulled-in worktree: a non-empty dir under tasks/hub/worktrees
    // with a .git file makes discoverWorktrees see (and reject) it as corrupted,
    // which still counts as "has worktrees" for the guard.
    const wtDir = path.join(projectDir, 'tasks', 'hub', 'worktrees', 'repo');
    fs.mkdirSync(wtDir, { recursive: true });
    fs.writeFileSync(path.join(wtDir, '.git'), 'gitdir: /nonexistent\n');

    await runMigrate(projectDir);

    expect(fs.existsSync(path.join(projectDir, 'tasks', 'hub', 'CLAUDE.md'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'PLANNING.md'))).toBe(true); // fresh scaffold, no merge
    const planning = fs.readFileSync(path.join(projectDir, 'PLANNING.md'), 'utf8');
    expect(planning).not.toContain('- item one: build the thing');
  });

  test('dry-run reports without touching anything', async () => {
    await runMigrate(projectDir, '--dry-run');
    expect(fs.existsSync(path.join(projectDir, 'tasks', 'hub'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'PLANNING.md'))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, 'AGENTS.md'))).toBe(false);
    expect(config.readProjectConfig(projectDir).schemaVersion).toBe(3);
  });

  test('is idempotent — a second run changes nothing', async () => {
    await runMigrate(projectDir);
    const planning = fs.readFileSync(path.join(projectDir, 'PLANNING.md'), 'utf8');
    const worklog  = fs.readFileSync(path.join(projectDir, 'WORKLOG.md'), 'utf8');
    const agents   = fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf8');

    await runMigrate(projectDir, '--repair');

    expect(fs.readFileSync(path.join(projectDir, 'PLANNING.md'), 'utf8')).toBe(planning);
    expect(fs.readFileSync(path.join(projectDir, 'WORKLOG.md'), 'utf8')).toBe(worklog);
    expect(fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf8')).toBe(agents);
  });
});

describe('schema 3 → 4 — pre-2.8.0 project (no hub)', () => {
  let projectDir, homeDir;
  beforeEach(() => {
    homeDir = makeTempDir('fake-home-nohub');
    jest.spyOn(os, 'homedir').mockReturnValue(homeDir);
    projectDir = makeProject('mig-nohub');
    config.setProjectConfig(projectDir, 'schemaVersion', 3);
  });
  afterEach(() => cleanup(projectDir, homeDir));

  test('scaffolds PLANNING.md, root WORKLOG.md, and a fresh AGENTS.md', async () => {
    await runMigrate(projectDir);
    expect(fs.readFileSync(path.join(projectDir, 'PLANNING.md'), 'utf8')).toContain('## Feature backlog');
    expect(fs.readFileSync(path.join(projectDir, 'WORKLOG.md'), 'utf8')).toContain('# Work Log:');
    expect(fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf8')).toContain('## wksp vocabulary');
    expect(fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf8')).toBe(templates.CLAUDE_INCLUDE);
    expect(prompts.confirmDefaultYes).not.toHaveBeenCalled();
  });

  test('modernizes an unedited 2.8.0 project template during conversion', async () => {
    // Recreate the frozen 2.8.0 template blocks around user content.
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), [
      '## Project: mig-nohub',
      '',
      "- **hub** — the project's planning task (no worktree). Holds the feature backlog, cross-cutting design, open decisions, and cross-task references — the connective tissue between repos and tasks. Here the hub is `tasks/hub/`.",
      'user line kept',
      '## Where things live',
      '',
      "- **The hub** (`tasks/hub/`) — the project's planning task and source of truth for project-wide plans: the feature backlog, agreed designs, open decisions, and how tasks relate (`tasks/hub/CLAUDE.md` + its `WORKLOG.md`). Consult it when a request touches project-wide design, references another task, or asks \"what to work on next.\" Don't load it for work scoped to a single repo or task.",
      '',
      'trailing user line',
    ].join('\n') + '\n');

    await runMigrate(projectDir);

    const agents = fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('user line kept');
    expect(agents).toContain('trailing user line');
    expect(agents).not.toContain('tasks/hub');
    expect(agents).toContain('## The project root is the planning hub');
  });

  test('warns instead of clobbering when AGENTS.md and a real CLAUDE.md both exist', async () => {
    fs.writeFileSync(path.join(projectDir, 'AGENTS.md'), 'hand-written agents file\n');
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), 'hand-written claude file\n');

    await runMigrate(projectDir);

    expect(fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf8')).toBe('hand-written agents file\n');
    expect(fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf8')).toBe('hand-written claude file\n');
    expect(logLines.some(l => l.includes('merge'))).toBe(true);
  });
});

// ─── schema 3 → 4 — repos.txt header refresh (--optional) ────────────────────

describe('schema 3 → 4 — repos.txt header refresh', () => {
  let projectDir, homeDir;
  beforeEach(() => {
    homeDir = makeTempDir('fake-home-reposhdr');
    jest.spyOn(os, 'homedir').mockReturnValue(homeDir);
    projectDir = makeProject('mig-repos-header');
    config.setProjectConfig(projectDir, 'schemaVersion', 3);
  });
  afterEach(() => cleanup(projectDir, homeDir));

  test('refreshes a legacy header and leaves data lines byte-identical', async () => {
    fs.writeFileSync(path.join(projectDir, 'repos.txt'), [
      '# Workspace repos',
      '# Format: <path> [--shared]',
      '# --shared: use original path in every task, never create a worktree',
      '',
      'C:/dev/backend',
      'C:/dev/company-docs  --shared',
      '',
    ].join('\n'));

    await runMigrate(projectDir);

    const repos = fs.readFileSync(path.join(projectDir, 'repos.txt'), 'utf8');
    expect(repos).toContain('# Format: <path> [--shared] [--optional]');
    expect(repos).toContain('# --optional:');
    expect(repos).toContain('\nC:/dev/backend\nC:/dev/company-docs  --shared\n');
    expect(logLines.some(l => l.includes('repos.txt') && l.includes('--optional'))).toBe(true);
  });

  test('leaves a hand-edited header alone', async () => {
    const handEdited = [
      '# my own notes about these repos',
      'C:/dev/backend',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(projectDir, 'repos.txt'), handEdited);

    await runMigrate(projectDir);

    expect(fs.readFileSync(path.join(projectDir, 'repos.txt'), 'utf8')).toBe(handEdited);
  });

  test('--dry-run reports but does not write', async () => {
    const before = [
      '# Workspace repos',
      '# Format: <path> [--shared]',
      '',
      'C:/dev/backend',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(projectDir, 'repos.txt'), before);

    await runMigrate(projectDir, '--dry-run');

    expect(fs.readFileSync(path.join(projectDir, 'repos.txt'), 'utf8')).toBe(before);
    expect(logLines.some(l => l.includes('repos.txt') && l.includes('--optional'))).toBe(true);
  });

  test('is idempotent — a second run (via --repair) changes nothing', async () => {
    fs.writeFileSync(path.join(projectDir, 'repos.txt'), [
      '# Workspace repos',
      '# Format: <path> [--shared]',
      '',
      'C:/dev/backend',
      '',
    ].join('\n'));

    await runMigrate(projectDir);
    const afterFirst = fs.readFileSync(path.join(projectDir, 'repos.txt'), 'utf8');

    await runMigrate(projectDir, '--repair');

    expect(fs.readFileSync(path.join(projectDir, 'repos.txt'), 'utf8')).toBe(afterFirst);
  });
});

// ─── not inside a project ─────────────────────────────────────────────────────

// ─── schema 4 → 5 — headless delegation section ──────────────────────────────

describe('schema 4 → 5 — teaches the project instruction file the headless flow', () => {
  let projectDir, homeDir;
  const agentsPath = () => path.join(projectDir, 'AGENTS.md');
  const agents     = () => fs.readFileSync(agentsPath(), 'utf8');

  beforeEach(() => {
    homeDir = makeTempDir('fake-home-v5');
    jest.spyOn(os, 'homedir').mockReturnValue(homeDir);
    projectDir = makeProject('mig-delegation');
    config.setProjectConfig(projectDir, 'schemaVersion', 4);
  });
  afterEach(() => cleanup(projectDir, homeDir));

  test('inserts the section before Cross-cutting conventions, keeping user prose', async () => {
    fs.writeFileSync(agentsPath(), [
      '## Project: mig-delegation',
      '',
      '## The project root is the planning hub',
      'hub prose the user edited',
      '',
      '## Cross-cutting conventions',
      'our branch naming is feat/*',
      '',
      '## Conflict policy',
      'ask first',
      '',
    ].join('\n'));

    await runMigrate(projectDir);

    const md = agents();
    expect(md).toContain(templates.DELEGATION_HEADING);
    expect(md).toContain('## What belongs here vs. in a task');
    // Inserted, not merged: every line the user wrote survives, in order.
    expect(md).toContain('hub prose the user edited');
    expect(md).toContain('our branch naming is feat/*');
    expect(md).toContain('ask first');
    expect(md.indexOf(templates.DELEGATION_HEADING))
      .toBeLessThan(md.indexOf('## Cross-cutting conventions'));
    expect(config.readProjectConfig(projectDir).schemaVersion).toBe(config.CURRENT_SCHEMA_VERSION);
  });

  test('falls back to a later heading when Cross-cutting conventions is gone', async () => {
    fs.writeFileSync(agentsPath(), '## Project: x\n\nsome prose\n\n## Conflict policy\nask first\n');

    await runMigrate(projectDir);

    const md = agents();
    expect(md.indexOf(templates.DELEGATION_HEADING)).toBeLessThan(md.indexOf('## Conflict policy'));
    expect(md).toContain('some prose');
  });

  test('appends when the file has none of the anchor headings', async () => {
    fs.writeFileSync(agentsPath(), '# My own structure\n\njust prose, no standard headings\n');

    await runMigrate(projectDir);

    const md = agents();
    expect(md).toContain('just prose, no standard headings');
    expect(md.indexOf('just prose')).toBeLessThan(md.indexOf(templates.DELEGATION_HEADING));
    expect(md.endsWith('\n')).toBe(true);
  });

  test('is idempotent — a second run and --repair change nothing', async () => {
    fs.writeFileSync(agentsPath(), '## Project: x\n\n## Cross-cutting conventions\nstuff\n');
    await runMigrate(projectDir);
    const afterFirst = agents();

    await runMigrate(projectDir, '--repair');
    expect(agents()).toBe(afterFirst);
    expect(countOf(afterFirst, templates.DELEGATION_HEADING)).toBe(1);
  });

  test('stands down while root AGENTS.md and CLAUDE.md are still unmerged', async () => {
    // 3 → 4 leaves this conflict for the user to resolve; dropping a new section
    // into one of the two files would land in the middle of that merge.
    fs.writeFileSync(agentsPath(), 'hand-written agents file\n');
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), 'hand-written claude file\n');

    await runMigrate(projectDir);

    expect(agents()).toBe('hand-written agents file\n');
    expect(logLines.some(l => l.includes('still unmerged'))).toBe(true);
  });

  test('leaves a project that already documents the flow alone', async () => {
    // Document both the delegation flow (4 → 5) and the orchestration flow (5 → 6)
    // so the full pipeline leaves the file untouched.
    const own = `## Project: x\n\n${templates.DELEGATION_HEADING}\nmy own wording for this\n\n${templates.ORCHESTRATION_HEADING}\nmy own review guidance\n`;
    fs.writeFileSync(agentsPath(), own);

    await runMigrate(projectDir);

    expect(agents()).toBe(own);
    expect(logLines.some(l => l.includes('already explains headless delegation'))).toBe(true);
  });

  test('--dry-run reports the change without writing', async () => {
    fs.writeFileSync(agentsPath(), '## Project: x\n\n## Cross-cutting conventions\nstuff\n');

    await runMigrate(projectDir, '--dry-run');

    expect(agents()).not.toContain(templates.DELEGATION_HEADING);
    expect(logLines.some(l => l.includes('adding the headless delegation recipe'))).toBe(true);
    expect(config.readProjectConfig(projectDir).schemaVersion).toBe(4);
  });

  test('skips an include-only CLAUDE.md when AGENTS.md is absent', async () => {
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), templates.CLAUDE_INCLUDE);

    await runMigrate(projectDir);

    // 3 → 4 already ran for this project, so nothing should have invented content here.
    expect(fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf8')).toBe(templates.CLAUDE_INCLUDE);
  });

  test('a project migrating all the way from v3 ends up with the section too', async () => {
    config.setProjectConfig(projectDir, 'schemaVersion', 3);

    await runMigrate(projectDir);

    // 3 → 4 scaffolds a fresh AGENTS.md from the template, which already has it —
    // so 4 → 5 must recognise that and not add a second copy.
    expect(countOf(agents(), templates.DELEGATION_HEADING)).toBe(1);
    expect(config.readProjectConfig(projectDir).schemaVersion).toBe(config.CURRENT_SCHEMA_VERSION);
  });
});

// ─── schema 5 → 6 — orchestration guidance + agent-honored settings ──────────

describe('schema 5 → 6 — adds the orchestration guidance to the project instruction file', () => {
  let projectDir, homeDir;
  const agentsPath = () => path.join(projectDir, 'AGENTS.md');
  const agents     = () => fs.readFileSync(agentsPath(), 'utf8');

  beforeEach(() => {
    homeDir = makeTempDir('fake-home-v6');
    jest.spyOn(os, 'homedir').mockReturnValue(homeDir);
    projectDir = makeProject('mig-orchestration');
    config.setProjectConfig(projectDir, 'schemaVersion', 5);
  });
  afterEach(() => cleanup(projectDir, homeDir));

  test('inserts the section before Cross-cutting conventions, keeping user prose', async () => {
    fs.writeFileSync(agentsPath(), [
      '## Project: mig-orchestration',
      '',
      templates.DELEGATION_HEADING,
      'delegation prose the user edited',
      '',
      '## Cross-cutting conventions',
      'our branch naming is feat/*',
      '',
      '## Conflict policy',
      'ask first',
      '',
    ].join('\n'));

    await runMigrate(projectDir);

    const md = agents();
    expect(md).toContain(templates.ORCHESTRATION_HEADING);
    expect(md).toContain('## Steering a task');
    expect(md).toContain('## Agent-honored settings');
    expect(md).toContain('reviewLoop');
    expect(md).toContain('prGate');
    expect(md).toContain('mergeMethod');
    // Inserted, not merged: every line the user wrote survives.
    expect(md).toContain('delegation prose the user edited');
    expect(md).toContain('our branch naming is feat/*');
    expect(md).toContain('ask first');
    expect(md.indexOf(templates.ORCHESTRATION_HEADING))
      .toBeLessThan(md.indexOf('## Cross-cutting conventions'));
    // Lands after the delegation block, before Cross-cutting conventions.
    expect(md.indexOf(templates.DELEGATION_HEADING))
      .toBeLessThan(md.indexOf(templates.ORCHESTRATION_HEADING));
    expect(config.readProjectConfig(projectDir).schemaVersion).toBe(config.CURRENT_SCHEMA_VERSION);
  });

  test('falls back to a later heading when Cross-cutting conventions is gone', async () => {
    fs.writeFileSync(agentsPath(), '## Project: x\n\nsome prose\n\n## Conflict policy\nask first\n');

    await runMigrate(projectDir);

    const md = agents();
    expect(md.indexOf(templates.ORCHESTRATION_HEADING)).toBeLessThan(md.indexOf('## Conflict policy'));
    expect(md).toContain('some prose');
  });

  test('appends when the file has none of the anchor headings', async () => {
    fs.writeFileSync(agentsPath(), '# My own structure\n\njust prose, no standard headings\n');

    await runMigrate(projectDir);

    const md = agents();
    expect(md).toContain('just prose, no standard headings');
    expect(md.indexOf('just prose')).toBeLessThan(md.indexOf(templates.ORCHESTRATION_HEADING));
    expect(md.endsWith('\n')).toBe(true);
  });

  test('is idempotent — a second run and --repair change nothing', async () => {
    // Pre-document the delegation flow so the 4 → 5 step is a no-op during --repair;
    // then the only insertion under test is 5 → 6's orchestration block.
    fs.writeFileSync(agentsPath(),
      `## Project: x\n\n${templates.DELEGATION_HEADING}\ndelegation already here\n\n## Cross-cutting conventions\nstuff\n`);
    await runMigrate(projectDir);
    const afterFirst = agents();

    await runMigrate(projectDir, '--repair');
    expect(agents()).toBe(afterFirst);
    expect(countOf(afterFirst, templates.ORCHESTRATION_HEADING)).toBe(1);
  });

  test('stands down while root AGENTS.md and CLAUDE.md are still unmerged', async () => {
    fs.writeFileSync(agentsPath(), 'hand-written agents file\n');
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), 'hand-written claude file\n');

    await runMigrate(projectDir);

    expect(agents()).toBe('hand-written agents file\n');
    expect(logLines.some(l => l.includes('still unmerged'))).toBe(true);
  });

  test('leaves a project that already documents the flow alone', async () => {
    const own = `## Project: x\n\n${templates.ORCHESTRATION_HEADING}\nmy own review wording\n`;
    fs.writeFileSync(agentsPath(), own);

    await runMigrate(projectDir);

    expect(agents()).toBe(own);
    expect(logLines.some(l => l.includes('already explains PR review'))).toBe(true);
  });

  test('--dry-run reports the change without writing', async () => {
    fs.writeFileSync(agentsPath(), '## Project: x\n\n## Cross-cutting conventions\nstuff\n');

    await runMigrate(projectDir, '--dry-run');

    expect(agents()).not.toContain(templates.ORCHESTRATION_HEADING);
    expect(logLines.some(l => l.includes('review→fix loop'))).toBe(true);
    expect(config.readProjectConfig(projectDir).schemaVersion).toBe(5);
  });

  test('skips an include-only CLAUDE.md when AGENTS.md is absent', async () => {
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), templates.CLAUDE_INCLUDE);

    await runMigrate(projectDir);

    expect(fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf8')).toBe(templates.CLAUDE_INCLUDE);
  });

  test('a project migrating all the way from v3 ends up with the section too', async () => {
    config.setProjectConfig(projectDir, 'schemaVersion', 3);

    await runMigrate(projectDir);

    // 3 → 4 scaffolds a fresh AGENTS.md from the template, which already ships the
    // orchestration block — so 5 → 6 must recognise that and not add a second copy.
    expect(countOf(agents(), templates.ORCHESTRATION_HEADING)).toBe(1);
    expect(config.readProjectConfig(projectDir).schemaVersion).toBe(config.CURRENT_SCHEMA_VERSION);
  });
});

describe('not inside a project', () => {
  test('exits 1', async () => {
    config.findProjectDir.mockReturnValue(null);
    await expect(migrateCmd.run([])).rejects.toThrow('process.exit(1)');
  });
});
