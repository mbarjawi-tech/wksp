'use strict';
const { EventEmitter } = require('events');

// A stand-in for the readline interface so stdin behaviour can be driven directly.
const fakeRl = () => {
  const rl = new EventEmitter();
  rl.close = jest.fn(() => rl.emit('close'));
  return rl;
};

jest.mock('readline', () => ({ createInterface: jest.fn() }));

const readline = require('readline');
const prompts  = require('../../lib/prompts');

let rl;
beforeEach(() => {
  rl = fakeRl();
  readline.createInterface.mockReturnValue(rl);
  jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  prompts.open();
});
afterEach(() => { prompts.close(); jest.restoreAllMocks(); });

describe('ask', () => {
  test('resolves with the trimmed line', async () => {
    const answer = prompts.ask('  Branch: ');
    rl.emit('line', '  feat/x  ');
    await expect(answer).resolves.toBe('feat/x');
  });

  test('rejects with a headless hint when stdin closes first', async () => {
    // This is the silent failure the headless flags exist to replace: the promise
    // used to never settle, so the process exited mid-create with no explanation.
    const answer = prompts.ask('  Branch: ');
    rl.emit('close');
    await expect(answer).rejects.toThrow(/stdin is closed/);
    await expect(answer).rejects.toThrow(/--yes --no-launch/);
  });

  test('a later close does not disturb an already-answered prompt', async () => {
    const answer = prompts.ask('  Branch: ');
    rl.emit('line', 'main');
    await expect(answer).resolves.toBe('main');
    expect(() => rl.emit('close')).not.toThrow();
  });
});

describe('confirm', () => {
  test('only y means yes', async () => {
    const a = prompts.confirm('  Sure?');
    rl.emit('line', 'y');
    await expect(a).resolves.toBe(true);

    const b = prompts.confirm('  Sure?');
    rl.emit('line', '');
    await expect(b).resolves.toBe(false);
  });

  test('confirmDefaultYes treats Enter as yes and only n/no as no', async () => {
    const a = prompts.confirmDefaultYes('  Move it?');
    rl.emit('line', '');
    await expect(a).resolves.toBe(true);

    const b = prompts.confirmDefaultYes('  Move it?');
    rl.emit('line', 'no');
    await expect(b).resolves.toBe(false);
  });
});
