'use strict';
const { getProvider, BUILTINS } = require('../../lib/providers');

describe('providers/index', () => {
  test('getProvider returns the claude provider', () => {
    const provider = getProvider();
    expect(provider).toBe(BUILTINS.claude);
    expect(provider.name).toBe('claude');
  });

  test('the claude provider exposes the full contract', () => {
    const provider = getProvider();
    expect(provider.name).toBe('claude');
    expect(provider.instructionFile).toBe('CLAUDE.md');
    expect(typeof provider.launch).toBe('function');

    expect(provider.sessions).toBeTruthy();
    for (const method of ['findLast', 'dirsFor', 'migrate', 'readTranscript', 'placeTranscript']) {
      expect(typeof provider.sessions[method]).toBe('function');
    }
  });
});
