'use strict';
const fs   = require('fs');
const path = require('path');
const { makeTempDir, cleanup } = require('../helpers');

jest.mock('../../lib/prompts', () => ({
  open: jest.fn(), close: jest.fn(), ask: jest.fn(), askRequired: jest.fn(),
}));

jest.mock('../../lib/config', () => {
  const actual = jest.requireActual('../../lib/config');
  return { ...actual, readGlobalConfig: jest.fn().mockReturnValue({ reposRoot: 'x' }) };
});

const initCmd = require('../../lib/commands/init');

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(process, 'exit').mockImplementation(code => { throw new Error(`process.exit(${code})`); });
});
afterEach(() => jest.restoreAllMocks());

describe('wksp init root scaffolding', () => {
  let base, cwd;
  beforeEach(() => { base = makeTempDir('init'); cwd = process.cwd(); process.chdir(base); });
  afterEach(() => { process.chdir(cwd); cleanup(base); });

  test('creates AGENTS.md with wksp vocabulary', async () => {
    await initCmd.run(['acme']);
    const projectDir = path.join(base, 'acme');

    expect(fs.existsSync(path.join(projectDir, '.wksp'))).toBe(true);
    expect(fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf8')).toContain('## wksp vocabulary');
  });

  test('creates CLAUDE.md as the one-line include', async () => {
    await initCmd.run(['acme']);
    const projectDir = path.join(base, 'acme');

    expect(fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf8')).toBe('@AGENTS.md\n');
  });

  test('creates PLANNING.md with feature backlog section', async () => {
    await initCmd.run(['acme']);
    const projectDir = path.join(base, 'acme');

    expect(fs.readFileSync(path.join(projectDir, 'PLANNING.md'), 'utf8')).toContain('## Feature backlog');
  });

  test('creates WORKLOG.md', async () => {
    await initCmd.run(['acme']);
    const projectDir = path.join(base, 'acme');

    expect(fs.existsSync(path.join(projectDir, 'WORKLOG.md'))).toBe(true);
  });

  test('creates ORCHESTRATION.md, and AGENTS.md points at it instead of carrying it', async () => {
    const templates = require('../../lib/templates');
    await initCmd.run(['acme']);
    const projectDir = path.join(base, 'acme');

    const guidance = fs.readFileSync(path.join(projectDir, 'ORCHESTRATION.md'), 'utf8');
    expect(guidance).toContain('# Orchestration — acme');
    expect(guidance).toContain(templates.DELEGATION_HEADING);
    expect(guidance).toContain(templates.ORCHESTRATION_HEADING);
    expect(guidance).toContain(templates.STACKED_PR_HEADING);

    // The instruction file — injected into every task session — only points at it.
    const agents = fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf8');
    expect(agents).toContain(templates.HUB_POINTER_HEADING);
    expect(agents).toContain('ORCHESTRATION.md');
    expect(agents).not.toContain(templates.DELEGATION_HEADING);
    expect(agents).not.toContain(templates.ORCHESTRATION_HEADING);
  });

  test('a freshly initialised project is already at the current schema', async () => {
    const config = require('../../lib/config');
    await initCmd.run(['acme']);
    const projectDir = path.join(base, 'acme');

    expect(config.readProjectConfig(projectDir).schemaVersion).toBe(config.CURRENT_SCHEMA_VERSION);
  });

  test('does NOT create tasks/hub/', async () => {
    await initCmd.run(['acme']);
    const projectDir = path.join(base, 'acme');

    expect(fs.existsSync(path.join(projectDir, 'tasks', 'hub'))).toBe(false);
  });
});
