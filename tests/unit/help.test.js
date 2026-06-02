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

// ─── v1 removal error messages ───────────────────────────────────────────────

describe('wksp task — v1 removal hints', () => {
  let errLines;
  const { run } = require('../../lib/commands/task');
  beforeEach(() => {
    errLines = [];
    jest.spyOn(console, 'error').mockImplementation((...a) => errLines.push(a.join(' ')));
  });

  async function expectV1Error(...args) {
    await expect(run(args)).rejects.toThrow('process.exit(1)');
  }

  test('bare task ID suggests create/resume', async () => {
    await expectV1Error('TASK-1');
    expect(errLines.some(l => l.includes('wksp task create TASK-1'))).toBe(true);
    expect(errLines.some(l => l.includes('v2.5.0'))).toBe(true);
  });

  test('--del flag suggests wksp task delete', async () => {
    await expectV1Error('TASK-1', '--del');
    expect(errLines.some(l => l.includes('wksp task delete TASK-1'))).toBe(true);
  });

  test('--archive flag suggests wksp task archive', async () => {
    await expectV1Error('TASK-1', '--archive');
    expect(errLines.some(l => l.includes('wksp task archive TASK-1'))).toBe(true);
  });

  test('--rename flag suggests wksp task rename', async () => {
    await expectV1Error('TASK-1', '--rename', 'NEW');
    expect(errLines.some(l => l.includes('wksp task rename TASK-1'))).toBe(true);
  });

  test('--to-shared flag suggests wksp task repo share', async () => {
    await expectV1Error('TASK-1', '--to-shared', 'backend');
    expect(errLines.some(l => l.includes('wksp task repo TASK-1') && l.includes('share'))).toBe(true);
  });
});

describe('wksp repo — v1 removal hints', () => {
  let errLines;
  const { run } = require('../../lib/commands/repo');
  beforeEach(() => {
    errLines = [];
    jest.spyOn(console, 'error').mockImplementation((...a) => errLines.push(a.join(' ')));
  });

  async function expectV1Error(...args) {
    await expect(run(args)).rejects.toThrow('process.exit(1)');
  }

  test('bare path suggests wksp repo add', async () => {
    await expectV1Error('/c/dev/myrepo');
    expect(errLines.some(l => l.includes('wksp repo add /c/dev/myrepo'))).toBe(true);
    expect(errLines.some(l => l.includes('v2.5.0'))).toBe(true);
  });

  test('bare path --remove suggests wksp repo remove', async () => {
    await expectV1Error('/c/dev/myrepo', '--remove');
    expect(errLines.some(l => l.includes('wksp repo remove /c/dev/myrepo'))).toBe(true);
  });

  test('github URL suggests wksp repo add', async () => {
    await expectV1Error('https://github.com/org/repo');
    expect(errLines.some(l => l.includes('wksp repo add'))).toBe(true);
  });
});

describe('wksp cleanup — v1 removal hints', () => {
  let errLines;
  const { run } = require('../../lib/commands/cleanup');
  beforeEach(() => {
    errLines = [];
    jest.spyOn(console, 'error').mockImplementation((...a) => errLines.push(a.join(' ')));
  });

  test('--stale errors with migration hint', async () => {
    await expect(run(['--stale', '/some/path'])).rejects.toThrow('process.exit(1)');
    expect(errLines.some(l => l.includes('wksp cleanup /some/path'))).toBe(true);
    expect(errLines.some(l => l.includes('v2.5.0'))).toBe(true);
  });

  test('-r errors with migration hint', async () => {
    await expect(run(['/some/path', '-r'])).rejects.toThrow('process.exit(1)');
    expect(errLines.some(l => l.includes('--recursive'))).toBe(true);
    expect(errLines.some(l => l.includes('v2.5.0'))).toBe(true);
  });
});
