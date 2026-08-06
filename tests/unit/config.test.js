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
    // The shape wksp actually writes. `{}` is not a marker any release has produced,
    // and is no longer accepted as one — see the marker-shape tests below.
    fs.writeFileSync(path.join(projectDir, '.wksp'), JSON.stringify({ name: 'find-project' }));
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

  test('a directory with no marker anywhere above it resolves to null', () => {
    // This used to be unassertable: the walk ran all the way up through the home
    // directory, whose global config is ALSO called `.wksp`, and came back with the home
    // directory as "the project".
    const isolated = makeTempDir('wksp-no-marker');
    try {
      expect(config.findProjectDir(isolated)).toBeNull();
    } finally {
      cleanup(isolated);
    }
  });
});

// The bug this guards: GLOBAL_CONFIG is `~/.wksp` and PROJECT_MARKER is `.wksp` — the
// same filename — so `fs.existsSync` alone made the home directory look like a project
// from anywhere beneath it. `wksp delete` then offered to delete ~, and `wksp migrate`
// would have written project fields into the global config.
describe('findProjectDir vs. the global config (~/.wksp)', () => {
  const under = (...parts) => path.join(tempHome, ...parts);
  const mkMarker = (dir, content) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.wksp'), typeof content === 'string' ? content : JSON.stringify(content) + '\n');
    return dir;
  };

  beforeEach(() => {
    // The real-world global config shape, as found on a live machine.
    config.writeGlobalConfig({ reposRoot: 'c:/repos/work' });
  });
  afterEach(() => {
    for (const d of ['Documents', 'projects', 'legacy', 'broken', 'outer', 'empty-marker'])
      cleanup(under(d));
  });

  test('a directory under the home directory with no project resolves to null, not the home directory', () => {
    const sub = under('Documents', 'notes');
    fs.mkdirSync(sub, { recursive: true });

    const result = config.findProjectDir(sub);
    expect(result).not.toBe(path.resolve(tempHome));
    expect(result).toBeNull();
  });

  test('the home directory is not a project even when standing in it', () => {
    expect(config.findProjectDir(tempHome)).toBeNull();
  });

  test('the global config file is never a project marker', () => {
    expect(config.isProjectMarker(path.join(tempHome, '.wksp'))).toBe(false);
  });

  test('a global config already corrupted by this bug is still not a marker', () => {
    // What `wksp migrate` would have left behind: `schemaVersion` stamped into the global
    // config. It never writes `name`, which is why `name` is the key worth requiring.
    config.writeGlobalConfig({ reposRoot: 'c:/repos/work', schemaVersion: 7 });
    expect(config.isProjectMarker(path.join(tempHome, '.wksp'))).toBe(false);
    expect(config.findProjectDir(tempHome)).toBeNull();
  });

  test('a real project INSIDE the home directory still resolves — the skip is exact-path only', () => {
    // Plenty of people keep their projects under ~. Over-broadening the skip to "anything
    // below the home directory" would break every one of them.
    const projectDir = mkMarker(under('projects', 'foo'), { name: 'foo', schemaVersion: 7 });
    const sub = path.join(projectDir, 'tasks', 'bar');
    fs.mkdirSync(sub, { recursive: true });

    expect(config.findProjectDir(projectDir)).toBe(path.resolve(projectDir));
    expect(config.findProjectDir(sub)).toBe(path.resolve(projectDir));
  });

  test('a pre-schema marker — { name } alone, what the first release wrote — still resolves', () => {
    // Back-compat is the risk in validating the shape: wksp wrote `{ name }` with no
    // `schemaVersion` until schema tracking arrived, so requiring both keys would make
    // wksp stop recognising the oldest projects.
    const dir = mkMarker(under('legacy'), { name: 'legacy' });
    expect(config.isProjectMarker(path.join(dir, '.wksp'))).toBe(true);
    expect(config.findProjectDir(dir)).toBe(path.resolve(dir));
  });

  test('an unparseable .wksp is ignored rather than throwing', () => {
    const dir = mkMarker(under('broken'), 'not json at all {');
    expect(() => config.findProjectDir(dir)).not.toThrow();
    expect(config.findProjectDir(dir)).toBeNull();
  });

  test('a marker with no name — including {} — is not a project', () => {
    // `{}` matters on its own: it is a reachable global config state (clear the last key
    // with `wksp config clear <key> --global`), so accepting it would leave the hole open.
    const dir = mkMarker(under('empty-marker'), {});
    expect(config.isProjectMarker(path.join(dir, '.wksp'))).toBe(false);
    expect(config.isProjectMarker(path.join(under('empty-marker'), 'nope', '.wksp'))).toBe(false);
    expect(config.findProjectDir(dir)).toBeNull();
  });

  test('a stray global-shaped .wksp does not shadow the real project above it', () => {
    const projectDir = mkMarker(under('outer'), { name: 'outer', schemaVersion: 7 });
    const stray      = mkMarker(path.join(projectDir, 'vendor'), { reposRoot: '/c/dev' });
    expect(config.findProjectDir(stray)).toBe(path.resolve(projectDir));
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

describe('setProjectConfig', () => {
  let dir;
  beforeEach(() => { dir = makeTempDir('wksp-proj-set'); });
  afterEach(()  => { cleanup(dir); });

  test('adds a key without overwriting others', () => {
    config.writeProjectConfig(dir, { name: 'myproject' });
    config.setProjectConfig(dir, 'reposRoot', '/c/dev/games');
    expect(config.readProjectConfig(dir)).toEqual({ name: 'myproject', reposRoot: '/c/dev/games' });
  });
});

describe('readConfig', () => {
  let dir;
  beforeEach(() => {
    dir = makeTempDir('wksp-merged-cfg');
    config.writeGlobalConfig({ reposRoot: '/c/dev', autoResume: true });
  });
  afterEach(() => { cleanup(dir); });

  test('returns global config when no project overrides', () => {
    config.writeProjectConfig(dir, { name: 'test' });
    const cfg = config.readConfig(dir);
    expect(cfg.reposRoot).toBe('/c/dev');
    expect(cfg.autoResume).toBe(true);
  });

  test('project-level key overrides global', () => {
    config.writeProjectConfig(dir, { name: 'test', reposRoot: '/c/dev/games' });
    const cfg = config.readConfig(dir);
    expect(cfg.reposRoot).toBe('/c/dev/games');
    expect(cfg.autoResume).toBe(true);
  });

  test('project can override multiple keys independently', () => {
    config.writeProjectConfig(dir, { name: 'test', autoResume: false });
    const cfg = config.readConfig(dir);
    expect(cfg.reposRoot).toBe('/c/dev');
    expect(cfg.autoResume).toBe(false);
  });

  test('falls back gracefully when no projectDir given', () => {
    const cfg = config.readConfig(null);
    expect(cfg.reposRoot).toBe('/c/dev');
  });
});
