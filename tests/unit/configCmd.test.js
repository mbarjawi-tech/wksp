'use strict';
const path = require('path');
const { makeTempDir, cleanup } = require('../helpers');

// Redirect global config to a temp home so tests never touch ~/.wksp
let tempHome;
beforeAll(() => { tempHome = makeTempDir('wksp-cfg-cmd-home'); });
afterAll(()  => { cleanup(tempHome); });

jest.mock('os', () => {
  const real = jest.requireActual('os');
  return { ...real, homedir: () => process.env._WKSP_TEST_HOME || real.homedir() };
});

let config, configCmd;
beforeAll(() => {
  process.env._WKSP_TEST_HOME = tempHome;
  jest.resetModules();
  config    = require('../../lib/config');
  configCmd = require('../../lib/commands/configCmd');
});
afterAll(() => { delete process.env._WKSP_TEST_HOME; });

let logLines;
beforeEach(() => {
  logLines = [];
  jest.spyOn(console, 'log').mockImplementation((...args) => logLines.push(args.join(' ')));
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(process, 'exit').mockImplementation(code => {
    throw new Error(`process.exit(${code})`);
  });
});
afterEach(() => jest.restoreAllMocks());

describe('config set — inside a project', () => {
  let projectDir;
  beforeEach(() => {
    projectDir = makeTempDir('wksp-cfg-project');
    config.writeProjectConfig(projectDir, { name: 'test' });
    jest.spyOn(config, 'findProjectDir').mockReturnValue(projectDir);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    cleanup(projectDir);
  });

  test('writes to project .wksp', async () => {
    await configCmd.run(['set', 'reposRoot', '/c/dev']);
    expect(config.readProjectConfig(projectDir).reposRoot).toBe('/c/dev');
    expect(logLines.join('')).toMatch(/\.wksp/);
  });

  test('--global writes to global config regardless of project', async () => {
    config.writeGlobalConfig({});
    await configCmd.run(['set', 'reposRoot', '/c/global', '--global']);
    expect(config.readGlobalConfig().reposRoot).toBe('/c/global');
    expect(logLines.join('')).toMatch(/~\/.wksp/);
  });
});

describe('config set — outside a project (global fallback)', () => {
  beforeEach(() => {
    jest.spyOn(config, 'findProjectDir').mockReturnValue(null);
    config.writeGlobalConfig({});
  });
  afterEach(() => jest.restoreAllMocks());

  test('saves to global config and prints fallback note', async () => {
    await configCmd.run(['set', 'reposRoot', '/c/dev']);
    expect(config.readGlobalConfig().reposRoot).toBe('/c/dev');
    expect(logLines.join('')).toMatch(/no project found/i);
  });
});

describe('config set — JSON parsing for scalar keys', () => {
  let projectDir;
  beforeEach(() => {
    projectDir = makeTempDir('wksp-cfg-json');
    config.writeProjectConfig(projectDir, { name: 'test' });
    jest.spyOn(config, 'findProjectDir').mockReturnValue(projectDir);
  });
  afterEach(() => { jest.restoreAllMocks(); cleanup(projectDir); });

  test('stores boolean false (not string "false") for autoResume', async () => {
    await configCmd.run(['set', 'autoResume', 'false']);
    expect(config.readProjectConfig(projectDir).autoResume).toBe(false);
  });

  test('stores string as-is when not valid JSON (e.g. a path)', async () => {
    await configCmd.run(['set', 'reposRoot', '/c/dev/my repos']);
    expect(config.readProjectConfig(projectDir).reposRoot).toBe('/c/dev/my repos');
  });
});

describe('config set — sharedDeps (array key)', () => {
  let projectDir;
  beforeEach(() => {
    projectDir = makeTempDir('wksp-cfg-shared');
    config.writeProjectConfig(projectDir, { name: 'test' });
    jest.spyOn(config, 'findProjectDir').mockReturnValue(projectDir);
  });
  afterEach(() => { jest.restoreAllMocks(); cleanup(projectDir); });

  test('adds a single entry to an empty list', async () => {
    await configCmd.run(['set', 'sharedDeps', 'node_modules']);
    expect(config.readProjectConfig(projectDir).sharedDeps).toEqual(['node_modules']);
  });

  test('adds multiple entries at once', async () => {
    await configCmd.run(['set', 'sharedDeps', 'node_modules', '.venv']);
    expect(config.readProjectConfig(projectDir).sharedDeps).toEqual(['node_modules', '.venv']);
  });

  test('appends to an existing list without duplicates', async () => {
    config.setProjectConfig(projectDir, 'sharedDeps', ['node_modules']);
    await configCmd.run(['set', 'sharedDeps', 'node_modules', '.venv']);
    expect(config.readProjectConfig(projectDir).sharedDeps).toEqual(['node_modules', '.venv']);
  });

  test('--clear resets the list to empty', async () => {
    config.setProjectConfig(projectDir, 'sharedDeps', ['node_modules']);
    await configCmd.run(['set', 'sharedDeps', '--clear']);
    expect(config.readProjectConfig(projectDir).sharedDeps).toEqual([]);
  });

  test('prints the full updated array', async () => {
    await configCmd.run(['set', 'sharedDeps', 'node_modules']);
    expect(logLines.join('')).toContain('["node_modules"]');
  });
});

describe('config set — validation', () => {
  beforeEach(() => jest.spyOn(config, 'findProjectDir').mockReturnValue(null));
  afterEach(() => jest.restoreAllMocks());

  test('exits 1 when key is missing', async () => {
    await expect(configCmd.run(['set'])).rejects.toThrow('process.exit(1)');
  });

  test('exits 1 when value is missing', async () => {
    await expect(configCmd.run(['set', 'reposRoot'])).rejects.toThrow('process.exit(1)');
  });
});

describe('config get', () => {
  beforeEach(() => {
    config.writeGlobalConfig({ reposRoot: '/c/dev', autoResume: true });
    jest.spyOn(config, 'findProjectDir').mockReturnValue(null);
  });
  afterEach(() => jest.restoreAllMocks());

  test('get with no key prints JSON of all config', async () => {
    await configCmd.run(['get']);
    const out = logLines.join('\n');
    expect(out).toMatch(/reposRoot/);
    expect(out).toMatch(/\/c\/dev/);
  });

  test('get with a key prints just that value', async () => {
    await configCmd.run(['get', 'reposRoot']);
    expect(logLines.join('')).toContain('/c/dev');
  });

  test('get --global reads only global config', async () => {
    await configCmd.run(['get', '--global']);
    expect(logLines.join('\n')).toMatch(/reposRoot/);
  });

  test('get on an unset key prints "(not set)"', async () => {
    await configCmd.run(['get', 'nonExistentKey']);
    expect(logLines.join('')).toContain('(not set)');
  });
});

describe('config — invalid subcommand', () => {
  test('exits 1 on unknown subcommand', async () => {
    jest.spyOn(config, 'findProjectDir').mockReturnValue(null);
    await expect(configCmd.run(['unknown'])).rejects.toThrow('process.exit(1)');
    jest.restoreAllMocks();
  });
});
