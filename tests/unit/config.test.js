'use strict';
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { makeTempDir, cleanup } = require('../helpers');

// Point GLOBAL_CONFIG at a temp file so tests never touch ~/.wksp
let tempHome;
beforeAll(() => { tempHome = makeTempDir('wksp-home'); });
afterAll(()  => { cleanup(tempHome); });

jest.mock('os', () => {
  const real = jest.requireActual('os');
  return { ...real, homedir: () => require('path').join(process.env._WKSP_TEST_HOME || real.homedir()) };
});

// Re-require config after mock is in place so GLOBAL_CONFIG picks up the override.
let config;
beforeAll(() => {
  process.env._WKSP_TEST_HOME = tempHome;
  jest.resetModules();
  config = require('../../lib/config');
});
afterAll(() => { delete process.env._WKSP_TEST_HOME; });

describe('readGlobalConfig', () => {
  test('returns {} when config file does not exist', () => {
    const globalFile = path.join(tempHome, '.wksp');
    if (fs.existsSync(globalFile)) fs.unlinkSync(globalFile);
    expect(config.readGlobalConfig()).toEqual({});
  });

  test('reads written config', () => {
    config.writeGlobalConfig({ reposRoot: '/c/dev' });
    expect(config.readGlobalConfig()).toEqual({ reposRoot: '/c/dev' });
  });

  test('migrates cloneRoot → reposRoot transparently', () => {
    fs.writeFileSync(path.join(tempHome, '.wksp'), JSON.stringify({ cloneRoot: '/c/old' }) + '\n');
    const cfg = config.readGlobalConfig();
    expect(cfg.reposRoot).toBe('/c/old');
    expect(cfg.cloneRoot).toBeUndefined();
    // persisted
    const raw = JSON.parse(fs.readFileSync(path.join(tempHome, '.wksp'), 'utf8'));
    expect(raw.reposRoot).toBe('/c/old');
    expect(raw.cloneRoot).toBeUndefined();
  });
});

describe('setGlobalConfig', () => {
  test('adds a new key', () => {
    config.writeGlobalConfig({});
    config.setGlobalConfig('myKey', 'myVal');
    expect(config.readGlobalConfig().myKey).toBe('myVal');
  });

  test('updates an existing key without losing others', () => {
    config.writeGlobalConfig({ a: '1', b: '2' });
    config.setGlobalConfig('a', 'updated');
    const cfg = config.readGlobalConfig();
    expect(cfg.a).toBe('updated');
    expect(cfg.b).toBe('2');
  });
});

describe('findProjectDir', () => {
  let projectDir;
  beforeEach(() => {
    projectDir = makeTempDir('wksp-find-project');
    fs.writeFileSync(path.join(projectDir, '.wksp'), '{}');
  });
  afterEach(() => cleanup(projectDir));

  test('finds .wksp in the given directory', () => {
    expect(config.findProjectDir(projectDir)).toBe(projectDir);
  });

  test('walks up from a subdirectory', () => {
    const sub = path.join(projectDir, 'a', 'b', 'c');
    fs.mkdirSync(sub, { recursive: true });
    expect(config.findProjectDir(sub)).toBe(projectDir);
  });

  test('does not return the isolated temp dir itself as a project', () => {
    // Note: findProjectDir walks up the tree. On systems where ~/.wksp exists
    // (the global config file), the walker may find it as a false project marker
    // before reaching the FS root. We verify only that our isolated dir itself
    // is not returned — not that null is always returned.
    const isolated = makeTempDir('wksp-no-marker');
    try {
      const result = config.findProjectDir(isolated);
      expect(result).not.toBe(path.resolve(isolated));
    } finally {
      cleanup(isolated);
    }
  });
});

describe('readProjectConfig / writeProjectConfig', () => {
  let dir;
  beforeEach(() => { dir = makeTempDir('wksp-proj-cfg'); });
  afterEach(()  => { cleanup(dir); });

  test('round-trips project config', () => {
    config.writeProjectConfig(dir, { name: 'myproject', extra: 42 });
    expect(config.readProjectConfig(dir)).toEqual({ name: 'myproject', extra: 42 });
  });
});
