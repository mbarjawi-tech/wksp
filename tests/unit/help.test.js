'use strict';

jest.mock('../../lib/config', () => ({
  ...jest.requireActual('../../lib/config'),
  findProjectDir:    jest.fn().mockReturnValue(null),
  readGlobalConfig:  jest.fn().mockReturnValue({}),
  readProjectConfig: jest.fn().mockReturnValue({ name: 'test' }),
  readConfig:        jest.fn().mockReturnValue({}),
}));

jest.mock('../../lib/prompts', () => ({
  open: jest.fn(), close: jest.fn(), ask: jest.fn(), confirm: jest.fn(),
}));

jest.mock('../../lib/claude', () => ({
  launch: jest.fn(), findLastSession: jest.fn().mockReturnValue(null),
}));

let logOutput;
beforeEach(() => {
  logOutput = [];
  jest.spyOn(console, 'log').mockImplementation((...args) => logOutput.push(args.join(' ')));
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(process, 'exit').mockImplementation(code => {
    throw new Error(`process.exit(${code})`);
  });
});
afterEach(() => jest.restoreAllMocks());

function helpExits(run, ...args) {
  return async () => {
    await expect(run(args)).rejects.toThrow('process.exit(0)');
    const out = logOutput.join('\n');
    expect(out).toMatch(/wksp/i);
    expect(out.length).toBeGreaterThan(30);
  };
}

describe('wksp task --help', () => {
  const { run } = require('../../lib/commands/task');
  test('no args prints help', helpExits(run));
  test('--help prints help', helpExits(run, '--help'));
  test('-h prints help',     helpExits(run, '-h'));
});

describe('wksp repo --help', () => {
  const { run } = require('../../lib/commands/repo');
  test('--help prints help', helpExits(run, '--help'));
  test('-h prints help', helpExits(run, '-h'));
});

describe('wksp cleanup --help', () => {
  const { run } = require('../../lib/commands/cleanup');
  test('--help prints help', helpExits(run, '--help'));
  test('-h prints help',     helpExits(run, '-h'));
});

describe('wksp status --help', () => {
  const { run } = require('../../lib/commands/status');
  test('--help prints help', helpExits(run, '--help'));
  test('-h prints help',     helpExits(run, '-h'));
});

describe('wksp config --help', () => {
  const { run } = require('../../lib/commands/configCmd');
  test('--help prints help', helpExits(run, '--help'));
  test('-h prints help',     helpExits(run, '-h'));
});
