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

describe('wksp init hub scaffolding', () => {
  let base, cwd;
  beforeEach(() => { base = makeTempDir('init'); cwd = process.cwd(); process.chdir(base); });
  afterEach(() => { process.chdir(cwd); cleanup(base); });

  test('auto-creates a worktree-less hub by default', async () => {
    await initCmd.run(['acme']);
    const projectDir = path.join(base, 'acme');

    expect(fs.existsSync(path.join(projectDir, '.wksp'))).toBe(true);
    const hubDir = path.join(projectDir, 'tasks', 'hub');
    expect(fs.existsSync(path.join(hubDir, 'CLAUDE.md'))).toBe(true);
    expect(fs.readFileSync(path.join(hubDir, 'CLAUDE.md'), 'utf8')).toContain('## Feature backlog');
    // The project CLAUDE.md ships the vocabulary + hub pointer.
    expect(fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf8')).toContain('## wksp vocabulary');
  });

  test('--no-hub skips the hub but still scaffolds the project', async () => {
    await initCmd.run(['lean', '--no-hub']);
    const projectDir = path.join(base, 'lean');

    expect(fs.existsSync(path.join(projectDir, '.wksp'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'tasks'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'tasks', 'hub'))).toBe(false);
  });
});
