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
  test('a MERGED PR at the branch tip, based on the default branch → merged', () => {
    const out = JSON.stringify([{ number: 46, state: 'MERGED', mergedAt: '2026-07-28T10:00:00Z', headRefOid: 'tip1', baseRefName: 'main' }]);
    expect(forge.classifyPrList(out, 'tip1', 'main'))
      .toEqual({ state: 'merged', pr: { number: 46, mergedAt: '2026-07-28T10:00:00Z', baseRefName: 'main' } });
  });

  test('an OPEN PR at the branch tip → unmerged', () => {
    const out = JSON.stringify([{ number: 12, state: 'OPEN', mergedAt: null, headRefOid: 'tip1', baseRefName: 'main' }]);
    expect(forge.classifyPrList(out, 'tip1', 'main'))
      .toEqual({ state: 'unmerged', pr: { number: 12, baseRefName: 'main' } });
  });

  // The mid-stack case. "MERGED" in a forge means "merged into this PR's base", and a
  // stack member's base is the member below it — so the work is NOT on main yet.
  test('a MERGED PR whose base is a parent branch → mergedToNonDefault, not merged', () => {
    const out = JSON.stringify([{ number: 18, state: 'MERGED', mergedAt: '2026-08-03T09:00:00Z', headRefOid: 'tip1', baseRefName: 'feat/a' }]);
    expect(forge.classifyPrList(out, 'tip1', 'main')).toEqual({
      state: 'mergedToNonDefault',
      pr: { number: 18, mergedAt: '2026-08-03T09:00:00Z', baseRefName: 'feat/a' },
    });
  });

  test('with no default branch known, a MERGED PR still reads as merged', () => {
    // No evidence to contradict the forge's verdict, so don't invent doubt.
    const out = JSON.stringify([{ number: 46, state: 'MERGED', mergedAt: 'x', headRefOid: 'tip1', baseRefName: 'feat/a' }]);
    expect(forge.classifyPrList(out, 'tip1', null).state).toBe('merged');
  });

  test('a gh too old to report baseRefName still reads as merged', () => {
    const out = JSON.stringify([{ number: 46, state: 'MERGED', mergedAt: 'x', headRefOid: 'tip1' }]);
    expect(forge.classifyPrList(out, 'tip1', 'main').state).toBe('merged');
  });

  test('no PR at all → unknown', () => {
    expect(forge.classifyPrList('[]', 'tip1')).toEqual({ state: 'unknown' });
  });

  test('unparseable payload → unknown', () => {
    expect(forge.classifyPrList('not json', 'tip1')).toEqual({ state: 'unknown' });
  });

  test('a merged PR at the tip wins even when an older closed one (other oid) is present', () => {
    const out = JSON.stringify([
      { number: 9,  state: 'CLOSED', mergedAt: null, headRefOid: 'oldsha', baseRefName: 'main' },
      { number: 46, state: 'MERGED', mergedAt: '2026-07-28T10:00:00Z', headRefOid: 'tip1', baseRefName: 'main' },
    ]);
    expect(forge.classifyPrList(out, 'tip1', 'main').state).toBe('merged');
  });

  test('branch reuse: an old MERGED PR (other oid) + a current OPEN PR → unmerged, NOT merged', () => {
    // feat/x was used, merged (#10), its branch deleted, then the name reused for
    // unrelated work with a still-open PR (#20). The MERGED #10 must not win.
    const out = JSON.stringify([
      { number: 10, state: 'MERGED', mergedAt: '2026-01-01T00:00:00Z', headRefOid: 'oldsha', baseRefName: 'main' },
      { number: 20, state: 'OPEN',   mergedAt: null,                   headRefOid: 'newtip', baseRefName: 'main' },
    ]);
    expect(forge.classifyPrList(out, 'newtip', 'main'))
      .toEqual({ state: 'unmerged', pr: { number: 20, baseRefName: 'main' } });
  });

  test('a MERGED PR whose oid is not the current tip → unknown (reuse, no live PR)', () => {
    // Old merged PR under a reused head name, with no open PR: proves nothing about
    // this branch, so degrade to unknown rather than claim merged.
    const out = JSON.stringify([{ number: 10, state: 'MERGED', mergedAt: '2026-01-01T00:00:00Z', headRefOid: 'oldsha', baseRefName: 'main' }]);
    expect(forge.classifyPrList(out, 'newtip', 'main')).toEqual({ state: 'unknown' });
  });

  test('only a CLOSED-but-not-merged PR → unknown', () => {
    const out = JSON.stringify([{ number: 9, state: 'CLOSED', mergedAt: null, headRefOid: 'tip1', baseRefName: 'main' }]);
    expect(forge.classifyPrList(out, 'tip1', 'main')).toEqual({ state: 'unknown' });
  });
});

describe('forge.prMergeState', () => {
  // The full dep set every case needs: gh present, a GitHub remote, a known tip, and
  // the repo's default branch (finish already knows it and passes it in).
  const deps = (exec, extra = {}) => ({
    exec, remoteUrl: ghRemote, revParse: tipAt('tip1'), defaultBranch: 'main', ...extra,
  });

  test('merged PR at the local tip, based on the default branch → merged', () => {
    const exec = makeExec({ prListOutput: JSON.stringify([{ number: 46, state: 'MERGED', mergedAt: '2026-07-28T10:00:00Z', headRefOid: 'tip1', baseRefName: 'main' }]) });
    const res = forge.prMergeState('/base', 'feat/x', deps(exec));
    expect(res.state).toBe('merged');
    expect(res.pr.number).toBe(46);
  });

  // The mid-stack safety bug: reporting this as `merged` let finish claim "merged
  // (confirmed on GitHub)", delete the branch and archive, while the work sat on the
  // parent branch and never reached main.
  test('merged PR whose base is the parent branch → mergedToNonDefault, with the base named', () => {
    const exec = makeExec({ prListOutput: JSON.stringify([{ number: 18, state: 'MERGED', mergedAt: '2026-08-03T09:00:00Z', headRefOid: 'tip1', baseRefName: 'feat/a' }]) });
    const res = forge.prMergeState('/base', 'feat/b', deps(exec));
    expect(res.state).toBe('mergedToNonDefault');
    expect(res.state).not.toBe('merged');
    expect(res.pr).toEqual({ number: 18, mergedAt: '2026-08-03T09:00:00Z', baseRefName: 'feat/a' });
  });

  test('master as the default branch is respected, not hard-coded to main', () => {
    const exec = makeExec({ prListOutput: JSON.stringify([{ number: 5, state: 'MERGED', mergedAt: 'x', headRefOid: 'tip1', baseRefName: 'master' }]) });
    expect(forge.prMergeState('/base', 'feat/x', deps(exec, { defaultBranch: 'master' })).state).toBe('merged');
    expect(forge.prMergeState('/base', 'feat/x', deps(exec, { defaultBranch: 'main' })).state).toBe('mergedToNonDefault');
  });

  test('open PR at the local tip → unmerged', () => {
    const exec = makeExec({ prListOutput: JSON.stringify([{ number: 12, state: 'OPEN', mergedAt: null, headRefOid: 'tip1', baseRefName: 'main' }]) });
    expect(forge.prMergeState('/base', 'feat/x', deps(exec)).state).toBe('unmerged');
  });

  test('branch reuse: old MERGED PR (other oid) + current OPEN PR → unmerged, NOT merged', () => {
    // The safety bug this guards: without the tip check, the MERGED #10 would win
    // and finish would force-delete a branch whose real PR (#20) is still open.
    const exec = makeExec({ prListOutput: JSON.stringify([
      { number: 10, state: 'MERGED', mergedAt: '2026-01-01T00:00:00Z', headRefOid: 'oldsha', baseRefName: 'main' },
      { number: 20, state: 'OPEN',   mergedAt: null,                   headRefOid: 'newtip', baseRefName: 'main' },
    ]) });
    const res = forge.prMergeState('/base', 'feat/x', deps(exec, { revParse: tipAt('newtip') }));
    expect(res.state).toBe('unmerged');
    expect(res.pr.number).toBe(20);
  });

  test('no PR → unknown', () => {
    const exec = makeExec({ prListOutput: '[]' });
    expect(forge.prMergeState('/base', 'feat/x', deps(exec)).state).toBe('unknown');
  });

  test('gh absent → unknown (and the query is never attempted)', () => {
    const exec = makeExec({ ghPresent: false });
    expect(forge.prMergeState('/base', 'feat/x', deps(exec)).state).toBe('unknown');
    expect(exec).toHaveBeenCalledTimes(1); // only the `gh --version` probe
  });

  test('non-GitHub remote → unknown (gh present, but the query is never attempted)', () => {
    const exec = makeExec({ prListOutput: '[]' });
    const res = forge.prMergeState('/base', 'feat/x', deps(exec, { remoteUrl: () => 'git@gitlab.com:o/r.git' }));
    expect(res.state).toBe('unknown');
    expect(exec).toHaveBeenCalledTimes(1); // probe only — no pr list
  });

  test('gh query errors / offline → unknown', () => {
    const exec = makeExec({ prListOk: false });
    expect(forge.prMergeState('/base', 'feat/x', deps(exec)).state).toBe('unknown');
  });

  test('no branch → unknown', () => {
    const exec = makeExec();
    expect(forge.prMergeState('/base', null, deps(exec)).state).toBe('unknown');
    expect(exec).not.toHaveBeenCalled();
  });

  test('the query targets the parsed slug and asks for the head oid and the base ref', () => {
    const exec = makeExec({ prListOutput: '[]' });
    forge.prMergeState('/base', 'feat/x', deps(exec));
    const prListCall = exec.mock.calls.find(c => c[0].includes('gh pr list'));
    expect(prListCall[0]).toContain('--repo "mbarjawi-tech/wksp"');
    expect(prListCall[0]).toContain('--head "feat/x"');
    expect(prListCall[0]).toContain('headRefOid');  // ties a PR to the tip
    expect(prListCall[0]).toContain('baseRefName'); // ties the merge to a branch
  });

  test('an unspecified defaultBranch is looked up, not assumed', () => {
    const exec = makeExec({ prListOutput: JSON.stringify([{ number: 7, state: 'MERGED', mergedAt: 'x', headRefOid: 'tip1', baseRefName: 'trunk' }]) });
    const git = require('../../lib/git');
    const spy = jest.spyOn(git, 'defaultBranch').mockReturnValue('trunk');
    try {
      const res = forge.prMergeState('/base', 'feat/x', { exec, remoteUrl: ghRemote, revParse: tipAt('tip1') });
      expect(spy).toHaveBeenCalledWith('/base');
      expect(res.state).toBe('merged');
    } finally { spy.mockRestore(); }
  });
});
