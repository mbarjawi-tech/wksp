'use strict';

// Resolution of the active provider from config (the aiProvider key + customProviders).
// config.readConfig is mocked so each test controls the merged config directly, and
// spawnShell is mocked so we can assert the command a custom provider composes.

jest.mock('../../lib/config', () => {
  const actual = jest.requireActual('../../lib/config');
  return { ...actual, readConfig: jest.fn().mockReturnValue({}) };
});

jest.mock('../../lib/providers/spawn', () => ({
  spawnShell: jest.fn().mockReturnValue({ status: 0 }),
}));

const config = require('../../lib/config');
const { spawnShell } = require('../../lib/providers/spawn');
const { getProvider, describeProviders, BUILTINS, tierOf } = require('../../lib/providers');

beforeEach(() => {
  config.readConfig.mockReset().mockReturnValue({});
  spawnShell.mockReset().mockReturnValue({ status: 0 });
});

describe('getProvider resolution', () => {
  test('absent aiProvider resolves to claude (the default)', () => {
    config.readConfig.mockReturnValue({});
    const p = getProvider('/proj');
    expect(p).toBe(BUILTINS.claude);
    expect(p.name).toBe('claude');
  });

  test('project config overrides global (readConfig already merges; project wins)', () => {
    // readConfig returns the merged view — simulate project having set none.
    config.readConfig.mockReturnValue({ aiProvider: 'none' });
    const p = getProvider('/proj');
    expect(p).toBe(BUILTINS.none);
    expect(p.name).toBe('none');
    expect(p.sessions).toBeUndefined(); // baseline tier
  });

  test('none resolves to the built-in none provider', () => {
    config.readConfig.mockReturnValue({ aiProvider: 'none' });
    expect(getProvider('/proj').name).toBe('none');
  });

  test('unknown configured name throws, listing the available names', () => {
    config.readConfig.mockReturnValue({ aiProvider: 'ghost' });
    expect(() => getProvider('/proj')).toThrow(/Unknown aiProvider "ghost"/);
    expect(() => getProvider('/proj')).toThrow(/claude/);
    expect(() => getProvider('/proj')).toThrow(/none/);
  });

  test('a custom entry without a command errors when configured active', () => {
    config.readConfig.mockReturnValue({
      aiProvider: 'broken',
      customProviders: { broken: { instructionFile: 'X.md' } },
    });
    expect(() => getProvider('/proj')).toThrow(/broken.*invalid|invalid.*broken/i);
  });
});

describe('custom provider build + launch', () => {
  test('resolves a custom provider and composes a working launch command', () => {
    config.readConfig.mockReturnValue({
      aiProvider: 'aider',
      customProviders: { aider: { command: 'aider {dirs} --cwd {cwd}' } },
    });
    const p = getProvider('/proj');
    expect(p.name).toBe('aider');
    expect(p.builtin).toBe(false);
    expect(p.instructionFile).toBe('CLAUDE.md');   // default
    expect(p.sessions).toBeUndefined();            // baseline
    expect(tierOf(p)).toBe('baseline');

    // Launch calls process.exit — swallow it and inspect the spawned command.
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    p.launch(['/a/one', '/b/two'], '/task');
    exitSpy.mockRestore();

    expect(spawnShell).toHaveBeenCalledTimes(1);
    const [cmdString, cwd] = spawnShell.mock.calls[0];
    // {dirs} expands to each dir, quoted, posix-style; {cwd} likewise.
    expect(cmdString).toMatch(/^aider "\S+one" "\S+two" --cwd "\S+task"$/);
    expect(cmdString).not.toContain('{dirs}');
    expect(cmdString).not.toContain('{cwd}');
    expect(cwd).toBe('/task');
  });

  test('custom instructionFile overrides the CLAUDE.md default', () => {
    config.readConfig.mockReturnValue({
      customProviders: { cursor: { command: 'cursor {cwd}', instructionFile: 'CONVENTIONS.md' } },
    });
    const { entries } = describeProviders('/proj');
    const cursor = entries.find(e => e.name === 'cursor');
    expect(cursor.valid).toBe(true);
    expect(cursor.provider.instructionFile).toBe('CONVENTIONS.md');
  });
});

describe('collision + invalid entries (describeProviders)', () => {
  test('a custom name colliding with a built-in is dropped with a warning', () => {
    config.readConfig.mockReturnValue({
      customProviders: { claude: { command: 'not-claude {cwd}' } },
    });
    const { entries } = describeProviders('/proj');
    const claudeEntries = entries.filter(e => e.name === 'claude');
    // The built-in survives; the colliding custom entry is a separate, invalid row.
    expect(claudeEntries.some(e => e.builtin && e.valid)).toBe(true);
    const collided = claudeEntries.find(e => !e.builtin);
    expect(collided).toBeTruthy();
    expect(collided.valid).toBe(false);
    expect(collided.warning).toMatch(/built-in/i);
    // Resolving claude still returns the real built-in, not the custom launcher.
    expect(getProvider('/proj')).toBe(BUILTINS.claude);
  });

  test('a custom entry with no command is listed invalid but does not throw when inactive', () => {
    config.readConfig.mockReturnValue({
      customProviders: { half: { instructionFile: 'Y.md' } },
    });
    const { entries } = describeProviders('/proj');
    const half = entries.find(e => e.name === 'half');
    expect(half.valid).toBe(false);
    expect(half.warning).toMatch(/command/i);
    // aiProvider absent → claude, so no throw despite the invalid entry.
    expect(() => getProvider('/proj')).not.toThrow();
  });
});
