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

// Note on the end states asserted here and in the 5 → 6 block below: a full
// `wksp migrate` also runs 6 → 7, which RELOCATES both of these blocks into
// ORCHESTRATION.md. So the 4 → 5 / 5 → 6 step is proven by its own log line plus the
// block's arrival in the guidance file — an AGENTS.md that still carried it would mean
// the relocation failed. The 6 → 7 block below tests the removal directly.
describe('schema 4 → 5 — teaches the project instruction file the headless flow', () => {
  let projectDir, homeDir;
  const agentsPath = () => path.join(projectDir, 'AGENTS.md');
  const agents     = () => fs.readFileSync(agentsPath(), 'utf8');
  const guidance   = () => fs.readFileSync(path.join(projectDir, templates.GUIDANCE_FILE), 'utf8');

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
    expect(logLines.some(l => l.includes('adding the headless delegation recipe'))).toBe(true);
    // The recipe was inserted here, then relocated; the shared boundary block stays.
    expect(guidance()).toContain(templates.DELEGATION_HEADING);
    expect(md).not.toContain(templates.DELEGATION_HEADING);
    expect(md).toContain(templates.BOUNDARY_HEADING);
    // Inserted, not merged: every line the user wrote survives, in order.
    expect(md).toContain('hub prose the user edited');
    expect(md).toContain('our branch naming is feat/*');
    expect(md).toContain('ask first');
    expect(md.indexOf(templates.BOUNDARY_HEADING))
      .toBeLessThan(md.indexOf('## Cross-cutting conventions'));
    expect(config.readProjectConfig(projectDir).schemaVersion).toBe(config.CURRENT_SCHEMA_VERSION);
  });

  test('falls back to a later heading when Cross-cutting conventions is gone', async () => {
    fs.writeFileSync(agentsPath(), '## Project: x\n\nsome prose\n\n## Conflict policy\nask first\n');

    await runMigrate(projectDir);

    const md = agents();
    expect(md.indexOf(templates.BOUNDARY_HEADING)).toBeLessThan(md.indexOf('## Conflict policy'));
    expect(md).toContain('some prose');
  });

  test('appends when the file has none of the anchor headings', async () => {
    fs.writeFileSync(agentsPath(), '# My own structure\n\njust prose, no standard headings\n');

    await runMigrate(projectDir);

    const md = agents();
    expect(md).toContain('just prose, no standard headings');
    expect(md.indexOf('just prose')).toBeLessThan(md.indexOf(templates.BOUNDARY_HEADING));
    expect(md.endsWith('\n')).toBe(true);
    // Appended with `.trimEnd()`, so the relocation had to tolerate that variant.
    expect(md).not.toContain(templates.DELEGATION_HEADING);
  });

  test('is idempotent — a second run and --repair change nothing', async () => {
    fs.writeFileSync(agentsPath(), '## Project: x\n\n## Cross-cutting conventions\nstuff\n');
    await runMigrate(projectDir);
    const afterFirst = agents();

    await runMigrate(projectDir, '--repair');
    expect(agents()).toBe(afterFirst);
    expect(countOf(afterFirst, templates.BOUNDARY_HEADING)).toBe(1);
    expect(countOf(afterFirst, templates.HUB_POINTER_HEADING)).toBe(1);
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
    // in the user's own words, so neither step inserts anything.
    const own = `## Project: x\n\n${templates.DELEGATION_HEADING}\nmy own wording for this\n\n${templates.ORCHESTRATION_HEADING}\nmy own review guidance\n`;
    fs.writeFileSync(agentsPath(), own);

    await runMigrate(projectDir);

    // 6 → 7 won't delete prose it didn't write, so both blocks survive verbatim;
    // it only appends its pointer.
    expect(agents().startsWith(own)).toBe(true);
    expect(agents()).toContain(templates.HUB_POINTER_HEADING);
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

    // 3 → 4 scaffolds a fresh AGENTS.md from the current template, which no longer
    // carries the recipe — 4 → 5 must recognise that (via the relocation pointer) and
    // not re-insert it, and the recipe must appear exactly once in the guidance file.
    expect(countOf(agents(), templates.DELEGATION_HEADING)).toBe(0);
    expect(countOf(guidance(), templates.DELEGATION_HEADING)).toBe(1);
    expect(countOf(agents(), templates.BOUNDARY_HEADING)).toBe(1);
    expect(config.readProjectConfig(projectDir).schemaVersion).toBe(config.CURRENT_SCHEMA_VERSION);
  });
});

// ─── schema 5 → 6 — orchestration guidance + agent-honored settings ──────────

describe('schema 5 → 6 — adds the orchestration guidance to the project instruction file', () => {
  let projectDir, homeDir;
  const agentsPath = () => path.join(projectDir, 'AGENTS.md');
  const agents     = () => fs.readFileSync(agentsPath(), 'utf8');
  const guidance   = () => fs.readFileSync(path.join(projectDir, templates.GUIDANCE_FILE), 'utf8');

  beforeEach(() => {
    homeDir = makeTempDir('fake-home-v6');
    jest.spyOn(os, 'homedir').mockReturnValue(homeDir);
    projectDir = makeProject('mig-orchestration');
    config.setProjectConfig(projectDir, 'schemaVersion', 5);
  });
  afterEach(() => cleanup(projectDir, homeDir));

  test('inserts the section, then 6 → 7 relocates it, keeping user prose', async () => {
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
    expect(logLines.some(l => l.includes('review→fix loop'))).toBe(true);
    const g = guidance();
    expect(g).toContain(templates.ORCHESTRATION_HEADING);
    expect(g).toContain(templates.STEERING_HEADING);
    expect(g).toContain(templates.SETTINGS_HEADING);
    expect(g).toContain('reviewLoop');
    expect(g).toContain('prGate');
    expect(g).toContain('mergeMethod');
    // None of it is left in the file every task session loads.
    expect(md).not.toContain(templates.ORCHESTRATION_HEADING);
    expect(md).not.toContain('reviewLoop');
    // Inserted, not merged: every line the user wrote survives — including their own
    // edited delegation heading, which 6 → 7 has no shipped text to match against.
    expect(md).toContain('delegation prose the user edited');
    expect(md).toContain('our branch naming is feat/*');
    expect(md).toContain('ask first');
    expect(md).toContain(templates.HUB_POINTER_HEADING);
    expect(config.readProjectConfig(projectDir).schemaVersion).toBe(config.CURRENT_SCHEMA_VERSION);
  });

  test('falls back to a later heading when Cross-cutting conventions is gone', async () => {
    fs.writeFileSync(agentsPath(), '## Project: x\n\nsome prose\n\n## Conflict policy\nask first\n');

    await runMigrate(projectDir);

    const md = agents();
    expect(md.indexOf(templates.HUB_POINTER_HEADING)).toBeLessThan(md.indexOf('## Conflict policy'));
    expect(md).toContain('some prose');
  });

  test('appends when the file has none of the anchor headings', async () => {
    fs.writeFileSync(agentsPath(), '# My own structure\n\njust prose, no standard headings\n');

    await runMigrate(projectDir);

    const md = agents();
    expect(md).toContain('just prose, no standard headings');
    expect(md.indexOf('just prose')).toBeLessThan(md.indexOf(templates.HUB_POINTER_HEADING));
    expect(md.endsWith('\n')).toBe(true);
    // Appended with `.trimEnd()` at end-of-file — the removal tolerated that variant.
    expect(md).not.toContain(templates.ORCHESTRATION_HEADING);
  });

  test('is idempotent — a second run and --repair change nothing', async () => {
    // Pre-document the delegation flow so the 4 → 5 step is a no-op during --repair;
    // then the only insertion under test is 5 → 6's orchestration block.
    fs.writeFileSync(agentsPath(),
      `## Project: x\n\n${templates.DELEGATION_HEADING}\ndelegation already here\n\n## Cross-cutting conventions\nstuff\n`);
    await runMigrate(projectDir);
    const afterFirst = agents();
    const guidanceAfterFirst = guidance();

    await runMigrate(projectDir, '--repair');
    expect(agents()).toBe(afterFirst);
    expect(guidance()).toBe(guidanceAfterFirst);
    expect(countOf(guidanceAfterFirst, templates.ORCHESTRATION_HEADING)).toBe(1);
    expect(countOf(afterFirst, templates.HUB_POINTER_HEADING)).toBe(1);
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

    // The user's wording survives verbatim; only the pointer is appended.
    expect(agents().startsWith(own)).toBe(true);
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

    // 3 → 4 scaffolds a fresh AGENTS.md from the current template, which points at the
    // guidance file instead of carrying the block — 5 → 6 must recognise that and not
    // re-insert it, and it must appear exactly once in ORCHESTRATION.md.
    expect(countOf(agents(), templates.ORCHESTRATION_HEADING)).toBe(0);
    expect(countOf(guidance(), templates.ORCHESTRATION_HEADING)).toBe(1);
    expect(config.readProjectConfig(projectDir).schemaVersion).toBe(config.CURRENT_SCHEMA_VERSION);
  });
});

// ─── schema 6 → 7 — hub-only guidance out of the task-injected file ───────────

describe('schema 6 → 7 — relocates hub-only guidance to ORCHESTRATION.md', () => {
  let projectDir, homeDir;
  const agentsPath   = () => path.join(projectDir, 'AGENTS.md');
  const agents       = () => fs.readFileSync(agentsPath(), 'utf8');
  const guidancePath = () => path.join(projectDir, templates.GUIDANCE_FILE);
  const guidance     = () => fs.readFileSync(guidancePath(), 'utf8');

  // A v6 project's root AGENTS.md: exactly what wksp 3.2.0/3.3.0 produced.
  const v6Agents = (name = 'mig-split') => [
    `## Project: ${name}`,
    '',
    templates.ROOT_PLANNING_SECTION,
    templates.DELEGATION_SECTION + templates.ORCHESTRATION_SECTION + '## Cross-cutting conventions',
    'our branch naming is feat/*',
    '',
    '## Conflict policy',
    'ask first',
    '',
  ].join('\n');

  beforeEach(() => {
    homeDir = makeTempDir('fake-home-v7');
    jest.spyOn(os, 'homedir').mockReturnValue(homeDir);
    projectDir = makeProject('mig-split');
    config.setProjectConfig(projectDir, 'schemaVersion', 6);
  });
  afterEach(() => cleanup(projectDir, homeDir));

  test('creates ORCHESTRATION.md with the relocated guidance plus stacked-PR guidance', async () => {
    fs.writeFileSync(agentsPath(), v6Agents());

    await runMigrate(projectDir);

    expect(fs.existsSync(guidancePath())).toBe(true);
    const g = guidance();
    expect(g).toContain('# Orchestration — mig-split');
    expect(g).toContain(templates.DELEGATION_HEADING);
    expect(g).toContain(templates.ORCHESTRATION_HEADING);
    expect(g).toContain(templates.STEERING_HEADING);
    expect(g).toContain(templates.SETTINGS_HEADING);
    // The new content that only ships in the guidance file.
    expect(g).toContain(templates.STACKED_PR_HEADING);
    expect(g).toContain('gh stack merge');
    expect(config.readProjectConfig(projectDir).schemaVersion).toBe(7);
  });

  test('removes the relocated blocks from AGENTS.md and leaves the pointer', async () => {
    fs.writeFileSync(agentsPath(), v6Agents());

    await runMigrate(projectDir);

    const md = agents();
    // Gone: the delegation recipe and the whole orchestration trio.
    expect(md).not.toContain(templates.DELEGATION_HEADING);
    expect(md).not.toContain(templates.ORCHESTRATION_HEADING);
    expect(md).not.toContain(templates.STEERING_HEADING);
    expect(md).not.toContain(templates.SETTINGS_HEADING);
    expect(md).not.toContain('reviewLoop');
    // Kept: everything genuinely shared, plus the user's own prose.
    expect(md).toContain('## The project root is the planning hub');
    expect(md).toContain('## Docs structure');
    expect(md).toContain(templates.BOUNDARY_HEADING);
    expect(md).toContain('Never put backlog content in this file');
    expect(md).toContain('our branch naming is feat/*');
    expect(md).toContain('ask first');
    // The pointer lands before the boundary block, where the template puts it.
    expect(md).toContain(templates.HUB_POINTER_HEADING);
    expect(md).toContain(templates.GUIDANCE_FILE);
    expect(md.indexOf(templates.HUB_POINTER_HEADING))
      .toBeLessThan(md.indexOf(templates.BOUNDARY_HEADING));
    // And the file really did get smaller.
    expect(md.length).toBeLessThan(v6Agents().length);
  });

  test('is idempotent — a second run and --repair change nothing', async () => {
    fs.writeFileSync(agentsPath(), v6Agents());
    await runMigrate(projectDir);
    const afterFirst = agents();
    const guidanceAfterFirst = guidance();

    await runMigrate(projectDir, '--repair');

    expect(agents()).toBe(afterFirst);
    expect(guidance()).toBe(guidanceAfterFirst);
    expect(countOf(afterFirst, templates.HUB_POINTER_HEADING)).toBe(1);
    expect(countOf(afterFirst, templates.BOUNDARY_HEADING)).toBe(1);
    expect(countOf(guidanceAfterFirst, templates.DELEGATION_HEADING)).toBe(1);
    expect(countOf(guidanceAfterFirst, templates.STACKED_PR_HEADING)).toBe(1);
  });

  test('a third run via --repair still changes nothing', async () => {
    fs.writeFileSync(agentsPath(), v6Agents());
    await runMigrate(projectDir);
    await runMigrate(projectDir, '--repair');
    const afterSecond = agents();

    await runMigrate(projectDir, '--repair');

    expect(agents()).toBe(afterSecond);
    expect(logLines.some(l => l.includes('hub guidance already relocated'))).toBe(true);
  });

  test('stands down while root AGENTS.md and CLAUDE.md are still unmerged', async () => {
    // Deleting text out of one of two files pending a manual merge is the worst case
    // this step could cause, so it refuses outright — and writes no guidance file.
    const hand = v6Agents();
    fs.writeFileSync(agentsPath(), hand);
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), 'hand-written claude file\n');

    await runMigrate(projectDir);

    expect(agents()).toBe(hand);
    expect(fs.existsSync(guidancePath())).toBe(false);
    expect(logLines.some(l => l.includes('not relocating the hub'))).toBe(true);
  });

  test('a block the user edited is LEFT IN PLACE and reported', async () => {
    // One word changed inside the delegation recipe. The orchestration block is
    // untouched, so it still relocates — the two decisions are independent.
    const edited = v6Agents().replace(
      'Work inside the repo paths that brief lists.',
      'Work inside the repo paths that brief lists (ask me first!).');
    fs.writeFileSync(agentsPath(), edited);

    await runMigrate(projectDir);

    const md = agents();
    expect(md).toContain('(ask me first!)');
    expect(md).toContain(templates.DELEGATION_HEADING);     // left alone
    expect(md).not.toContain(templates.ORCHESTRATION_HEADING); // still relocated
    expect(md).toContain(templates.HUB_POINTER_HEADING);
    expect(logLines.some(l => l.includes("you've edited the headless delegation recipe"))).toBe(true);
    // and it tells them they can now delete it themselves
    expect(logLines.join('\n')).toMatch(/delete[\s\S]*by hand/);
  });

  test('a CRLF-normalized file relocates cleanly, with no false "edited" warning', async () => {
    // A Windows editor that normalizes line endings on save rewrites the WHOLE file to
    // CRLF, the blocks wksp wrote included. Matching only LF candidates then matches
    // nothing: both blocks stay, the user is warned about two edits they never made,
    // and ORCHESTRATION.md is created anyway — so the guidance ends up duplicated
    // across both files and the relocation is a silent no-op. Realistic on Windows.
    fs.writeFileSync(agentsPath(), v6Agents().replace(/\n/g, '\r\n'));

    await runMigrate(projectDir);

    const md = agents();
    // Relocated, not left behind.
    expect(md).not.toContain(templates.DELEGATION_HEADING);
    expect(md).not.toContain(templates.ORCHESTRATION_HEADING);
    expect(md).not.toContain(templates.STEERING_HEADING);
    expect(md).not.toContain(templates.SETTINGS_HEADING);
    expect(md).not.toContain('reviewLoop');
    // Kept: the genuinely shared blocks and the user's own prose.
    expect(md).toContain(templates.BOUNDARY_HEADING);
    expect(md).toContain(templates.HUB_POINTER_HEADING);
    expect(md).toContain('our branch naming is feat/*');
    expect(md).toContain('ask first');
    // Never accused of editing what they didn't touch.
    expect(logLines.some(l => l.includes("you've edited"))).toBe(false);
    // Endings stay uniform: no bare \n survives, and no orphaned \r was introduced.
    expect(md).not.toMatch(/(?<!\r)\n/);
    expect(md).not.toMatch(/\r(?!\n)/);
    // The guidance lives in exactly one place.
    expect(countOf(md, templates.HUB_POINTER_HEADING)).toBe(1);
    expect(countOf(guidance(), templates.DELEGATION_HEADING)).toBe(1);
    expect(countOf(guidance(), templates.ORCHESTRATION_HEADING)).toBe(1);
  });

  test('the CRLF result is byte-for-byte the LF result with CRLF endings', async () => {
    // Guards the removal and insertion arithmetic itself: no lost blank line, no extra
    // one, nothing shifted. Whatever the LF path writes, the CRLF path must write the
    // same thing line for line.
    fs.writeFileSync(agentsPath(), v6Agents().replace(/\n/g, '\r\n'));
    await runMigrate(projectDir);
    const fromCrlf = agents();

    const lfProject = makeProject('mig-split-lf');
    try {
      config.setProjectConfig(lfProject, 'schemaVersion', 6);
      fs.writeFileSync(path.join(lfProject, 'AGENTS.md'), v6Agents());
      await runMigrate(lfProject);
      const fromLf = fs.readFileSync(path.join(lfProject, 'AGENTS.md'), 'utf8');

      expect(fromLf).not.toContain('\r');
      expect(fromCrlf).toBe(fromLf.replace(/\n/g, '\r\n'));
    } finally {
      cleanup(lfProject);
    }
  });

  test('appending to a block\'s last line preserves the whole block', async () => {
    // The bare-`trimEnd` candidate exists for a file whose final newline an editor
    // stripped. Accepted anywhere rather than only at EOF, it also matches a block whose
    // last line the user APPENDED to: wksp's text gets deleted and the user's words are
    // left orphaned with no heading above them — the one thing this step must never do.
    const appended = v6Agents().replace(
      'launches, and its history is kept under the task rather than here.',
      'launches, and its history is kept under the task rather than here. ALSO SEE MY NOTES.');
    fs.writeFileSync(agentsPath(), appended);

    await runMigrate(projectDir);

    const md = agents();
    // The user's words survive WITH the block they were attached to, heading and all.
    expect(md).toContain('ALSO SEE MY NOTES.');
    expect(md).toContain(templates.DELEGATION_HEADING);
    expect(md).toContain('Prefer a focused session in the task itself?');
    expect(logLines.some(l => l.includes("you've edited the headless delegation recipe"))).toBe(true);
    // Independent as ever: the untouched orchestration trio still relocates.
    expect(md).not.toContain(templates.ORCHESTRATION_HEADING);
    expect(md).toContain(templates.HUB_POINTER_HEADING);
  });

  test('a block whose final newline was stripped is still removed at end of file', async () => {
    // The legitimate case the bare-`trimEnd` candidate is for, and the reason the EOF
    // gate costs nothing: the 5 → 6 append fallback put the block at the end of a
    // restructured file, then an editor dropped the trailing newline.
    fs.writeFileSync(agentsPath(),
      '# my own layout\n\nprose\n\n' + templates.DELEGATION_SECTION
        + templates.ORCHESTRATION_SECTION.trimEnd());

    await runMigrate(projectDir);

    const md = agents();
    expect(md).not.toContain(templates.DELEGATION_HEADING);
    expect(md).not.toContain(templates.ORCHESTRATION_HEADING);
    expect(md).not.toContain(templates.SETTINGS_HEADING);
    expect(md).toContain('prose');
    expect(md).toContain(templates.BOUNDARY_HEADING);
    expect(md).toContain(templates.HUB_POINTER_HEADING);
    expect(logLines.some(l => l.includes("you've edited"))).toBe(false);
  });

  test('a duplicated block is removed in full, not left half-cleaned', async () => {
    // Defensive: a file that somehow carries the block twice must not keep one copy.
    fs.writeFileSync(agentsPath(),
      v6Agents().replace(templates.ORCHESTRATION_SECTION,
                         templates.ORCHESTRATION_SECTION + templates.ORCHESTRATION_SECTION));

    await runMigrate(projectDir);

    expect(countOf(agents(), templates.ORCHESTRATION_HEADING)).toBe(0);
    expect(logLines.some(l => l.includes('(2 copies)'))).toBe(true);
  });

  test('an existing ORCHESTRATION.md is never overwritten', async () => {
    fs.writeFileSync(agentsPath(), v6Agents());
    fs.writeFileSync(guidancePath(), '# my own orchestration notes\n');

    await runMigrate(projectDir);

    expect(guidance()).toBe('# my own orchestration notes\n');
    expect(logLines.some(l => l.includes('already exists'))).toBe(true);
    // The instruction file is still cleaned up — the two halves are independent.
    expect(agents()).not.toContain(templates.ORCHESTRATION_HEADING);
    expect(agents()).toContain(templates.HUB_POINTER_HEADING);
  });

  test('--dry-run previews without writing', async () => {
    const before = v6Agents();
    fs.writeFileSync(agentsPath(), before);

    await runMigrate(projectDir, '--dry-run');

    expect(agents()).toBe(before);
    expect(fs.existsSync(guidancePath())).toBe(false);
    expect(logLines.some(l => l.includes(templates.GUIDANCE_FILE) && l.includes('creating'))).toBe(true);
    expect(logLines.some(l => l.includes('removing the headless delegation recipe'))).toBe(true);
    expect(config.readProjectConfig(projectDir).schemaVersion).toBe(6);
  });

  test('task instruction files are not touched', async () => {
    fs.writeFileSync(agentsPath(), v6Agents());
    const taskDir = path.join(projectDir, 'tasks', 'T-1');
    fs.mkdirSync(taskDir, { recursive: true });
    const taskMd = templates.taskAgentsMd('T-1');
    fs.writeFileSync(path.join(taskDir, 'AGENTS.md'), taskMd);
    fs.writeFileSync(path.join(taskDir, 'CLAUDE.md'), templates.CLAUDE_INCLUDE);
    fs.writeFileSync(path.join(taskDir, 'WORKLOG.md'), '# Work Log: T-1\n');
    fs.writeFileSync(path.join(taskDir, 'task.json'), '{}\n');

    await runMigrate(projectDir);

    expect(fs.readFileSync(path.join(taskDir, 'AGENTS.md'), 'utf8')).toBe(taskMd);
    expect(fs.existsSync(path.join(taskDir, templates.GUIDANCE_FILE))).toBe(false);
  });

  test('an include-only root CLAUDE.md with no AGENTS.md is skipped', async () => {
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), templates.CLAUDE_INCLUDE);

    await runMigrate(projectDir);

    expect(fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf8')).toBe(templates.CLAUDE_INCLUDE);
    expect(fs.existsSync(guidancePath())).toBe(false);
  });

  test('a project migrating all the way from v0 lands on v7 with no duplication', async () => {
    // The full chain: 4 → 5 inserts the delegation block, 5 → 6 the orchestration
    // block, 6 → 7 relocates both. Nothing may appear twice anywhere.
    config.setProjectConfig(projectDir, 'schemaVersion', 0);
    fs.writeFileSync(agentsPath(), [
      '## Project: mig-split',
      '',
      '## Cross-cutting conventions',
      'run npx jest',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), templates.CLAUDE_INCLUDE);

    await runMigrate(projectDir);

    const md = agents(), g = guidance();
    expect(config.readProjectConfig(projectDir).schemaVersion).toBe(7);
    expect(countOf(md, templates.HUB_POINTER_HEADING)).toBe(1);
    expect(countOf(md, templates.BOUNDARY_HEADING)).toBe(1);
    expect(countOf(md, templates.DELEGATION_HEADING)).toBe(0);
    expect(countOf(md, templates.ORCHESTRATION_HEADING)).toBe(0);
    expect(countOf(g, templates.DELEGATION_HEADING)).toBe(1);
    expect(countOf(g, templates.ORCHESTRATION_HEADING)).toBe(1);
    expect(countOf(g, templates.SETTINGS_HEADING)).toBe(1);
    expect(countOf(g, templates.STACKED_PR_HEADING)).toBe(1);
    expect(md).toContain('run npx jest');
  });

  test('a hand-restructured file with no anchor headings still gets the pointer', async () => {
    fs.writeFileSync(agentsPath(),
      '# my own layout\n\nprose\n\n' + templates.DELEGATION_SECTION + templates.ORCHESTRATION_SECTION);

    await runMigrate(projectDir);

    const md = agents();
    expect(md).toContain('prose');
    expect(md).not.toContain(templates.DELEGATION_HEADING);
    expect(md).not.toContain(templates.ORCHESTRATION_HEADING);
    // The boundary block survived the delegation removal, so the pointer anchors to it.
    expect(md).toContain(templates.BOUNDARY_HEADING);
    expect(md).toContain(templates.HUB_POINTER_HEADING);
    expect(md.endsWith('\n')).toBe(true);
    expect(/\n{3,}$/.test(md)).toBe(false);
  });
});

describe('not inside a project', () => {
  test('exits 1', async () => {
    config.findProjectDir.mockReturnValue(null);
    await expect(migrateCmd.run([])).rejects.toThrow('process.exit(1)');
  });
});

// `migrate` is the command the marker/global-config filename collision corrupted rather
// than merely confused: pointed at the home directory it scaffolds PLANNING.md and friends
// into ~, and stamps `schemaVersion` through writeProjectConfig — which for ~ writes a
// project field straight into the global config, since both files are `.wksp`.
describe('refuses the home directory and filesystem roots', () => {
  let errs;
  beforeEach(() => {
    errs = [];
    console.error.mockImplementation((...a) => errs.push(a.join(' ')));
  });

  test('refuses at the home directory, leaving the global config untouched', async () => {
    const fakeHome = makeTempDir('mig-fake-home');
    try {
      fs.writeFileSync(path.join(fakeHome, '.wksp'), JSON.stringify({ reposRoot: '/c/dev' }) + '\n');
      jest.spyOn(os, 'homedir').mockReturnValue(fakeHome);

      await expect(runMigrate(fakeHome)).rejects.toThrow('process.exit(1)');

      // No project fields written into the global config, and no scaffolding dropped in ~.
      expect(JSON.parse(fs.readFileSync(path.join(fakeHome, '.wksp'), 'utf8'))).toEqual({ reposRoot: '/c/dev' });
      expect(fs.existsSync(path.join(fakeHome, 'PLANNING.md'))).toBe(false);
      expect(fs.existsSync(path.join(fakeHome, 'ORCHESTRATION.md'))).toBe(false);
      expect(fs.existsSync(path.join(fakeHome, 'AGENTS.md'))).toBe(false);
      expect(errs.join('\n')).toContain('refusing to migrate');
    } finally {
      cleanup(fakeHome);
    }
  });

  test('refuses at a filesystem root', async () => {
    await expect(runMigrate(path.parse(process.cwd()).root)).rejects.toThrow('process.exit(1)');
    expect(errs.join('\n')).toContain('filesystem root');
  });
});
