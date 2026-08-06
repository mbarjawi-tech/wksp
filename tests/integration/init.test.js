'use strict';
const fs   = require('fs');
const os   = require('os');
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

// A project marker is `.wksp` and the global config is `~/.wksp` — the same filename — so
// initialising a project AT the home directory would overwrite the global config with a
// project marker.
describe('wksp init refuses unsafe locations', () => {
  let base, cwd, errs;
  beforeEach(() => {
    base = makeTempDir('init-unsafe');
    cwd  = process.cwd();
    process.chdir(base);
    errs = [];
    console.error.mockImplementation((...args) => errs.push(args.join(' ')));
  });
  afterEach(() => { process.chdir(cwd); cleanup(base); });

  test('refuses at the home directory rather than overwriting the global config', async () => {
    fs.writeFileSync(path.join(base, '.wksp'), JSON.stringify({ reposRoot: '/c/dev' }) + '\n');
    jest.spyOn(os, 'homedir').mockReturnValue(base);

    await expect(initCmd.run(['.'])).rejects.toThrow('process.exit(1)');

    // The global config survived untouched — a project marker would have replaced it.
    expect(JSON.parse(fs.readFileSync(path.join(base, '.wksp'), 'utf8'))).toEqual({ reposRoot: '/c/dev' });
    expect(fs.existsSync(path.join(base, 'tasks'))).toBe(false);
    expect(fs.existsSync(path.join(base, 'PLANNING.md'))).toBe(false);
    const out = errs.join('\n');
    expect(out).toContain('refusing to create a project');
    expect(out).toContain('home directory');
  });

  test('refuses at a filesystem root', async () => {
    await expect(initCmd.run([path.parse(process.cwd()).root])).rejects.toThrow('process.exit(1)');
    expect(errs.join('\n')).toContain('filesystem root');
  });

  test('a project in a SUBDIRECTORY of the home directory is still created normally', async () => {
    // The common real-world setup — the refusal must be the home directory exactly, not
    // anything under it.
    jest.spyOn(os, 'homedir').mockReturnValue(base);

    await initCmd.run(['acme']);

    expect(fs.existsSync(path.join(base, 'acme', '.wksp'))).toBe(true);
    expect(fs.existsSync(path.join(base, '.wksp'))).toBe(false);
    expect(errs).toEqual([]);
  });
});
