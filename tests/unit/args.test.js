'use strict';
const { splitArgs, parseRepoMap } = require('../../lib/args');

const VALUE_FLAGS = ['--branch', '--base', '--shared', '--exclude', '--goal', '--reason'];

describe('splitArgs', () => {
  test('separates positionals from flags', () => {
    const { positionals, flags } = splitArgs(['create', 'T-1', '--yes', '--no-launch'], VALUE_FLAGS);
    expect(positionals).toEqual(['create', 'T-1']);
    expect([...flags].sort()).toEqual(['--no-launch', '--yes']);
  });

  test('a value flag consumes the next argument, so the task id survives any order', () => {
    const { positionals, values } = splitArgs(['create', '--branch', 'feat/x', 'T-1'], VALUE_FLAGS);
    expect(positionals).toEqual(['create', 'T-1']);
    expect(values.get('--branch')).toEqual(['feat/x']);
  });

  test('accepts the --flag=value spelling', () => {
    const { positionals, flags, values } = splitArgs(['create', 'T-1', '--branch=api=feat/x'], VALUE_FLAGS);
    expect(positionals).toEqual(['create', 'T-1']);
    expect(flags.has('--branch')).toBe(true);
    expect(values.get('--branch')).toEqual(['api=feat/x']);
  });

  test('repeatable flags keep every occurrence in order', () => {
    const { values } = splitArgs(['create', 'T', '--exclude', 'a', '--exclude', 'b'], VALUE_FLAGS);
    expect(values.get('--exclude')).toEqual(['a', 'b']);
  });

  test('a flag not declared as value-carrying leaves its neighbour positional', () => {
    const { positionals, flags } = splitArgs(['delete', 'T-1', '--delete-branches'], VALUE_FLAGS);
    expect(positionals).toEqual(['delete', 'T-1']);
    expect(flags.has('--delete-branches')).toBe(true);
  });

  test('a trailing value flag with nothing after it is not fatal', () => {
    const { flags, values } = splitArgs(['create', 'T', '--goal'], VALUE_FLAGS);
    expect(flags.has('--goal')).toBe(true);
    expect(values.get('--goal')).toBeUndefined();
  });
});

describe('parseRepoMap', () => {
  test('<repo>=<value> targets one repo; the bare form is the fallback', () => {
    const { map, fallback } = parseRepoMap(['api=feat/x', 'feat/default', 'web=feat/y']);
    expect(map.get('api')).toBe('feat/x');
    expect(map.get('web')).toBe('feat/y');
    expect(fallback).toBe('feat/default');
  });

  test('the last bare occurrence wins', () => {
    expect(parseRepoMap(['one', 'two']).fallback).toBe('two');
  });

  test('no values → empty map, no fallback', () => {
    const { map, fallback } = parseRepoMap(undefined);
    expect(map.size).toBe(0);
    expect(fallback).toBeNull();
  });

  test('a value containing = keeps everything after the first one', () => {
    expect(parseRepoMap(['api=feat/a=b']).map.get('api')).toBe('feat/a=b');
  });
});
