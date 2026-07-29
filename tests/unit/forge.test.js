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
// A revParse stub: pretend the branch's local tip is `oid`.
const tipAt = oid => () => oid;

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
  test('a MERGED PR at the branch tip → merged, with its number', () => {
    const out = JSON.stringify([{ number: 46, state: 'MERGED', mergedAt: '2026-07-28T10:00:00Z', headRefOid: 'tip1' }]);
    expect(forge.classifyPrList(out, 'tip1')).toEqual({ state: 'merged', pr: { number: 46, mergedAt: '2026-07-28T10:00:00Z' } });
  });

  test('an OPEN PR at the branch tip → unmerged', () => {
    const out = JSON.stringify([{ number: 12, state: 'OPEN', mergedAt: null, headRefOid: 'tip1' }]);
    expect(forge.classifyPrList(out, 'tip1')).toEqual({ state: 'unmerged', pr: { number: 12 } });
  });

  test('no PR at all → unknown', () => {
    expect(forge.classifyPrList('[]', 'tip1')).toEqual({ state: 'unknown' });
  });

  test('unparseable payload → unknown', () => {
    expect(forge.classifyPrList('not json', 'tip1')).toEqual({ state: 'unknown' });
  });

  test('a merged PR at the tip wins even when an older closed one (other oid) is present', () => {
    const out = JSON.stringify([
      { number: 9,  state: 'CLOSED', mergedAt: null, headRefOid: 'oldsha' },
      { number: 46, state: 'MERGED', mergedAt: '2026-07-28T10:00:00Z', headRefOid: 'tip1' },
    ]);
    expect(forge.classifyPrList(out, 'tip1').state).toBe('merged');
  });

  test('branch reuse: an old MERGED PR (other oid) + a current OPEN PR → unmerged, NOT merged', () => {
    // feat/x was used, merged (#10), its branch deleted, then the name reused for
    // unrelated work with a still-open PR (#20). The MERGED #10 must not win.
    const out = JSON.stringify([
      { number: 10, state: 'MERGED', mergedAt: '2026-01-01T00:00:00Z', headRefOid: 'oldsha' },
      { number: 20, state: 'OPEN',   mergedAt: null,                   headRefOid: 'newtip' },
    ]);
    expect(forge.classifyPrList(out, 'newtip')).toEqual({ state: 'unmerged', pr: { number: 20 } });
  });

  test('a MERGED PR whose oid is not the current tip → unknown (reuse, no live PR)', () => {
    // Old merged PR under a reused head name, with no open PR: proves nothing about
    // this branch, so degrade to unknown rather than claim merged.
    const out = JSON.stringify([{ number: 10, state: 'MERGED', mergedAt: '2026-01-01T00:00:00Z', headRefOid: 'oldsha' }]);
    expect(forge.classifyPrList(out, 'newtip')).toEqual({ state: 'unknown' });
  });

  test('only a CLOSED-but-not-merged PR → unknown', () => {
    const out = JSON.stringify([{ number: 9, state: 'CLOSED', mergedAt: null, headRefOid: 'tip1' }]);
    expect(forge.classifyPrList(out, 'tip1')).toEqual({ state: 'unknown' });
  });
});

describe('forge.prMergeState', () => {
  test('merged PR at the local tip → merged', () => {
    const exec = makeExec({ prListOutput: JSON.stringify([{ number: 46, state: 'MERGED', mergedAt: '2026-07-28T10:00:00Z', headRefOid: 'tip1' }]) });
    const res = forge.prMergeState('/base', 'feat/x', { exec, remoteUrl: ghRemote, revParse: tipAt('tip1') });
    expect(res.state).toBe('merged');
    expect(res.pr.number).toBe(46);
  });

  test('open PR at the local tip → unmerged', () => {
    const exec = makeExec({ prListOutput: JSON.stringify([{ number: 12, state: 'OPEN', mergedAt: null, headRefOid: 'tip1' }]) });
    expect(forge.prMergeState('/base', 'feat/x', { exec, remoteUrl: ghRemote, revParse: tipAt('tip1') }).state).toBe('unmerged');
  });

  test('branch reuse: old MERGED PR (other oid) + current OPEN PR → unmerged, NOT merged', () => {
    // The safety bug this guards: without the tip check, the MERGED #10 would win
    // and finish would force-delete a branch whose real PR (#20) is still open.
    const exec = makeExec({ prListOutput: JSON.stringify([
      { number: 10, state: 'MERGED', mergedAt: '2026-01-01T00:00:00Z', headRefOid: 'oldsha' },
      { number: 20, state: 'OPEN',   mergedAt: null,                   headRefOid: 'newtip' },
    ]) });
    const res = forge.prMergeState('/base', 'feat/x', { exec, remoteUrl: ghRemote, revParse: tipAt('newtip') });
    expect(res.state).toBe('unmerged');
    expect(res.pr.number).toBe(20);
  });

  test('no PR → unknown', () => {
    const exec = makeExec({ prListOutput: '[]' });
    expect(forge.prMergeState('/base', 'feat/x', { exec, remoteUrl: ghRemote, revParse: tipAt('tip1') }).state).toBe('unknown');
  });

  test('gh absent → unknown (and the query is never attempted)', () => {
    const exec = makeExec({ ghPresent: false });
    expect(forge.prMergeState('/base', 'feat/x', { exec, remoteUrl: ghRemote, revParse: tipAt('tip1') }).state).toBe('unknown');
    expect(exec).toHaveBeenCalledTimes(1); // only the `gh --version` probe
  });

  test('non-GitHub remote → unknown (gh present, but the query is never attempted)', () => {
    const exec = makeExec({ prListOutput: '[]' });
    const res = forge.prMergeState('/base', 'feat/x', { exec, remoteUrl: () => 'git@gitlab.com:o/r.git', revParse: tipAt('tip1') });
    expect(res.state).toBe('unknown');
    expect(exec).toHaveBeenCalledTimes(1); // probe only — no pr list
  });

  test('gh query errors / offline → unknown', () => {
    const exec = makeExec({ prListOk: false });
    expect(forge.prMergeState('/base', 'feat/x', { exec, remoteUrl: ghRemote, revParse: tipAt('tip1') }).state).toBe('unknown');
  });

  test('no branch → unknown', () => {
    const exec = makeExec();
    expect(forge.prMergeState('/base', null, { exec, remoteUrl: ghRemote, revParse: tipAt('tip1') }).state).toBe('unknown');
    expect(exec).not.toHaveBeenCalled();
  });

  test('the query targets the parsed owner/repo slug and asks for the head oid', () => {
    const exec = makeExec({ prListOutput: '[]' });
    forge.prMergeState('/base', 'feat/x', { exec, remoteUrl: ghRemote, revParse: tipAt('tip1') });
    const prListCall = exec.mock.calls.find(c => c[0].includes('gh pr list'));
    expect(prListCall[0]).toContain('--repo "mbarjawi-tech/wksp"');
    expect(prListCall[0]).toContain('--head "feat/x"');
    expect(prListCall[0]).toContain('headRefOid'); // needed to tie a PR to the tip
  });
});
