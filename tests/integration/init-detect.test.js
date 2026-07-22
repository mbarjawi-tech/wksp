'use strict';
const fs   = require('fs');
const path = require('path');
const { makeTempDir, cleanup } = require('../helpers');

// Control whether `claude` is "found" on PATH. init.js shells out to where/which;
// we intercept that spawnSync call and leave everything else to the real module.
// The flag is read at call time; the `mock` prefix is required for jest to allow
// the factory to reference an out-of-scope variable.
const mockState = { claudeFound: true };

jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  return {
    ...actual,
    spawnSync: jest.fn((cmd, args, ...rest) => {
      if ((cmd === 'where' || cmd === 'which') && args && args[0] === 'claude') {
        return { status: mockState.claudeFound ? 0 : 1 };
      }
      return actual.spawnSync(cmd, args, ...rest);
    }),
  };
});

jest.mock('../../lib/prompts', () => ({
  open: jest.fn(), close: jest.fn(), ask: jest.fn(), askRequired: jest.fn(),
}));

jest.mock('../../lib/config', () => {
  const actual = jest.requireActual('../../lib/config');
  return {
    ...actual,
    readGlobalConfig: jest.fn().mockReturnValue({ reposRoot: 'x' }),
    readConfig:       jest.fn().mockReturnValue({}),   // no aiProvider anywhere
  };
});

const initCmd = require('../../lib/commands/init');

let logLines;
beforeEach(() => {
  logLines = [];
  jest.spyOn(console, 'log').mockImplementation((...a) => logLines.push(a.join(' ')));
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(process, 'exit').mockImplementation(code => { throw new Error(`process.exit(${code})`); });
});
afterEach(() => jest.restoreAllMocks());

describe('wksp init — AI tool auto-detection', () => {
  let base, cwd;
  beforeEach(() => { base = makeTempDir('init-detect'); cwd = process.cwd(); process.chdir(base); });
  afterEach(() => { process.chdir(cwd); cleanup(base); });

  test('claude on PATH → no aiProvider written, no message', async () => {
    mockState.claudeFound = true;
    await initCmd.run(['found']);
    const cfg = JSON.parse(fs.readFileSync(path.join(base, 'found', '.wksp'), 'utf8'));
    expect(cfg.aiProvider).toBeUndefined();
    expect(logLines.join('\n')).not.toMatch(/no supported ai tool/i);
  });

  test('claude not found → writes aiProvider: none and explains', async () => {
    mockState.claudeFound = false;
    await initCmd.run(['missing']);
    const cfg = JSON.parse(fs.readFileSync(path.join(base, 'missing', '.wksp'), 'utf8'));
    expect(cfg.aiProvider).toBe('none');
    const text = logLines.join('\n');
    expect(text).toMatch(/no supported ai tool detected/i);
    expect(text).toMatch(/wksp providers/);
  });
});
