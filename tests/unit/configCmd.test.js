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
