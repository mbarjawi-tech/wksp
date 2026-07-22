'use strict';

// The `wksp providers` command: human output marks the configured provider and
// flags problems; --json emits the documented shape exactly.

jest.mock('../../lib/config', () => {
  const actual = jest.requireActual('../../lib/config');
  return {
    ...actual,
    findProjectDir: jest.fn().mockReturnValue('/proj'),
    readConfig:     jest.fn().mockReturnValue({}),
  };
});

const config = require('../../lib/config');
const providersCmd = require('../../lib/commands/providers');

let logLines;
beforeEach(() => {
  logLines = [];
  jest.spyOn(console, 'log').mockImplementation((...a) => logLines.push(a.join(' ')));
  jest.spyOn(process, 'exit').mockImplementation(code => { throw new Error(`process.exit(${code})`); });
  config.findProjectDir.mockReturnValue('/proj');
  config.readConfig.mockReset().mockReturnValue({});
});
afterEach(() => jest.restoreAllMocks());

const out = () => logLines.join('\n');

describe('wksp providers — human output', () => {
  test('lists built-ins and marks the configured one', async () => {
    config.readConfig.mockReturnValue({}); // absent → claude
    await providersCmd.run([]);
    const text = out();
    expect(text).toMatch(/claude/);
    expect(text).toMatch(/none/);
    // configured (claude) marked with * and (configured); none is not.
    const claudeLine = logLines.find(l => l.includes('claude') && l.includes('['));
    expect(claudeLine).toMatch(/\*/);
    expect(claudeLine).toMatch(/\(configured\)/);
    const noneLine = logLines.find(l => l.includes('none') && l.includes('['));
    expect(noneLine).not.toMatch(/\(configured\)/);
    // Tiers rendered.
    expect(claudeLine).toMatch(/full/);
    expect(noneLine).toMatch(/baseline/);
  });

  test('flags an unknown configured name without throwing', async () => {
    config.readConfig.mockReturnValue({ aiProvider: 'ghost' });
    await providersCmd.run([]);   // must not throw
    expect(out()).toMatch(/"ghost" is unknown or invalid/);
  });

  test('shows invalid custom entries as unavailable', async () => {
    config.readConfig.mockReturnValue({ customProviders: { half: { instructionFile: 'y' } } });
    await providersCmd.run([]);
    expect(out()).toMatch(/half.*unavailable/i);
  });
});

describe('wksp providers --json', () => {
  test('matches the documented shape exactly', async () => {
    config.readConfig.mockReturnValue({});
    await providersCmd.run(['--json']);
    const parsed = JSON.parse(out());

    expect(parsed).toHaveProperty('configured', 'claude');
    expect(Array.isArray(parsed.providers)).toBe(true);

    const byName = Object.fromEntries(parsed.providers.map(p => [p.name, p]));
    expect(byName.claude).toEqual({
      name: 'claude',
      builtin: true,
      tier: 'full',
      capabilities: { sessions: true },
      instructionFile: 'CLAUDE.md',
    });
    expect(byName.none).toEqual({
      name: 'none',
      builtin: true,
      tier: 'baseline',
      capabilities: { sessions: false },
      instructionFile: 'AGENTS.md',
    });

    // Every provider row has exactly the documented keys.
    for (const p of parsed.providers) {
      expect(Object.keys(p).sort()).toEqual(
        ['builtin', 'capabilities', 'instructionFile', 'name', 'tier'],
      );
      expect(Object.keys(p.capabilities)).toEqual(['sessions']);
    }
  });

  test('a valid custom provider appears as baseline in --json', async () => {
    config.readConfig.mockReturnValue({
      aiProvider: 'aider',
      customProviders: { aider: { command: 'aider {dirs}' } },
    });
    await providersCmd.run(['--json']);
    const parsed = JSON.parse(out());
    expect(parsed.configured).toBe('aider');
    const aider = parsed.providers.find(p => p.name === 'aider');
    expect(aider).toEqual({
      name: 'aider',
      builtin: false,
      tier: 'baseline',
      capabilities: { sessions: false },
      instructionFile: 'AGENTS.md',
    });
  });
});
