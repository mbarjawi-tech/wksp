'use strict';
const forge = require('../../lib/forge');

// A stub exec: routes `gh --version` (the availability probe) and `gh pr list`
// (the query) independently, so gh-presence and the PR payload can be varied
// separately. `ghPresent: false` makes the probe fail.
function makeExec({ ghPresent = true, prListOutput = '[]', prListOk = true } = {}) {
  return jest.fn(cmd => {
    if (cmd.startsWith('gh --version')) {
      return ghPresent ? { ok: true, output: 'gh version 2.0.0' } : { ok: false, output: 'not found' };
    }
    if (cmd.includes('gh pr list')) {
      return prListOk ? { ok: true, output: prListOutput } : { ok: false, output: 'network error' };
    }
    return { ok: false, output: 'unexpected command: ' + cmd };
  });
}

const ghRemote = () => 'git@github.com:mbarjawi-tech/wksp.git';

describe('forge.parseGitHubSlug', () => {
  test.each([
    ['git@github.com:owner/repo.git',            { owner: 'owner', repo: 'repo' }],
    ['https://github.com/owner/repo.git',        { owner: 'owner', repo: 'repo' }],
    ['https://github.com/owner/repo',            { owner: 'owner', repo: 'repo' }],
    ['ssh://git@github.com/owner/repo.git',      { owner: 'owner', repo: 'repo' }],
    ['https://github.com/owner/repo/',           { owner: 'owner', repo: 'repo' }],
  ])('parses %s', (url, expected) => {
    expect(forge.parseGitHubSlug(url)).toEqual(expected);
  });

  test.each([
    null,
    '',
    'git@gitlab.com:owner/repo.git',
    'https://bitbucket.org/owner/repo.git',
    '/some/local/path',
  ])('returns null for non-GitHub URL %s', url => {
    expect(forge.parseGitHubSlug(url)).toBeNull();
  });
});

describe('forge.classifyPrList', () => {
  test('a MERGED PR → merged, with its number', () => {
    const out = JSON.stringify([{ number: 46, state: 'MERGED', mergedAt: '2026-07-28T10:00:00Z' }]);
    expect(forge.classifyPrList(out)).toEqual({ state: 'merged', pr: { number: 46, mergedAt: '2026-07-28T10:00:00Z' } });
  });

  test('an OPEN PR (no merged) → unmerged', () => {
    const out = JSON.stringify([{ number: 12, state: 'OPEN', mergedAt: null }]);
    expect(forge.classifyPrList(out)).toEqual({ state: 'unmerged', pr: { number: 12 } });
  });

  test('no PR at all → unknown', () => {
    expect(forge.classifyPrList('[]')).toEqual({ state: 'unknown' });
  });

  test('unparseable payload → unknown', () => {
    expect(forge.classifyPrList('not json')).toEqual({ state: 'unknown' });
  });

  test('a merged PR wins even when an older closed one is present', () => {
    const out = JSON.stringify([
      { number: 9,  state: 'CLOSED', mergedAt: null },
      { number: 46, state: 'MERGED', mergedAt: '2026-07-28T10:00:00Z' },
    ]);
    expect(forge.classifyPrList(out).state).toBe('merged');
  });
});

describe('forge.prMergeState', () => {
  test('merged PR → merged', () => {
    const exec = makeExec({ prListOutput: JSON.stringify([{ number: 46, state: 'MERGED', mergedAt: '2026-07-28T10:00:00Z' }]) });
    const res = forge.prMergeState('/base', 'feat/x', { exec, remoteUrl: ghRemote });
    expect(res.state).toBe('merged');
    expect(res.pr.number).toBe(46);
  });

  test('open PR → unmerged', () => {
    const exec = makeExec({ prListOutput: JSON.stringify([{ number: 12, state: 'OPEN', mergedAt: null }]) });
    expect(forge.prMergeState('/base', 'feat/x', { exec, remoteUrl: ghRemote }).state).toBe('unmerged');
  });

  test('no PR → unknown', () => {
    const exec = makeExec({ prListOutput: '[]' });
    expect(forge.prMergeState('/base', 'feat/x', { exec, remoteUrl: ghRemote }).state).toBe('unknown');
  });

  test('gh absent → unknown (and the query is never attempted)', () => {
    const exec = makeExec({ ghPresent: false });
    expect(forge.prMergeState('/base', 'feat/x', { exec, remoteUrl: ghRemote }).state).toBe('unknown');
    expect(exec).toHaveBeenCalledTimes(1); // only the `gh --version` probe
  });

  test('non-GitHub remote → unknown (gh present, but the query is never attempted)', () => {
    const exec = makeExec({ prListOutput: '[]' });
    const res = forge.prMergeState('/base', 'feat/x', { exec, remoteUrl: () => 'git@gitlab.com:o/r.git' });
    expect(res.state).toBe('unknown');
    expect(exec).toHaveBeenCalledTimes(1); // probe only — no pr list
  });

  test('gh query errors / offline → unknown', () => {
    const exec = makeExec({ prListOk: false });
    expect(forge.prMergeState('/base', 'feat/x', { exec, remoteUrl: ghRemote }).state).toBe('unknown');
  });

  test('no branch → unknown', () => {
    const exec = makeExec();
    expect(forge.prMergeState('/base', null, { exec, remoteUrl: ghRemote }).state).toBe('unknown');
    expect(exec).not.toHaveBeenCalled();
  });

  test('the query targets the parsed owner/repo slug', () => {
    const exec = makeExec({ prListOutput: '[]' });
    forge.prMergeState('/base', 'feat/x', { exec, remoteUrl: ghRemote });
    const prListCall = exec.mock.calls.find(c => c[0].includes('gh pr list'));
    expect(prListCall[0]).toContain('--repo "mbarjawi-tech/wksp"');
    expect(prListCall[0]).toContain('--head "feat/x"');
  });
});
