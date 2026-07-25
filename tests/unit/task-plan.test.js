'use strict';

jest.mock('../../lib/git', () => ({
  findCheckedOutBranch:  jest.fn().mockReturnValue(null),
  branchExistsLocally:   jest.fn().mockReturnValue(false),
  branchExistsCached:    jest.fn().mockReturnValue(false),
  branchExistsRemotely:  jest.fn().mockReturnValue(false),
  defaultBranch:         jest.fn().mockReturnValue('main'),
}));
jest.mock('fs', () => ({ ...jest.requireActual('fs'), existsSync: jest.fn().mockReturnValue(true) }));

const fs  = require('fs');
const git = require('../../lib/git');
const { planRepos, renderPlan, renderErrors } = require('../../lib/task-plan');

const repo = (folderName, extra = {}) => ({
  folderName, raw: `/repos/${folderName}`, normalized: `/repos/${folderName}`,
  shared: false, optional: false, ...extra,
});

const noOpts = () => ({
  branch: { map: new Map(), fallback: null },
  base:   { map: new Map(), fallback: null },
  shared: new Set(), exclude: new Set(),
});

beforeEach(() => {
  jest.clearAllMocks();
  fs.existsSync.mockReturnValue(true);
  git.findCheckedOutBranch.mockReturnValue(null);
  git.branchExistsLocally.mockReturnValue(false);
  git.branchExistsCached.mockReturnValue(false);
  git.branchExistsRemotely.mockReturnValue(false);
  git.defaultBranch.mockReturnValue('main');
});

describe('planRepos — defaults', () => {
  test('a repo with no flag becomes a worktree on a new branch named after the task', () => {
    const api = repo('api');
    const { items, errors } = planRepos({
      allRepos: [api], pending: [api], taskId: 'T-1', opts: noOpts(),
    });
    expect(errors).toEqual([]);
    expect(items).toEqual([{
      repo: api, name: 'api', mode: 'worktree', branch: 'T-1', baseBranch: 'main', isNewBranch: true,
    }]);
  });

  test('an existing branch is checked out, and gets no base', () => {
    git.branchExistsLocally.mockReturnValue(true);
    const api = repo('api');
    const { items } = planRepos({ allRepos: [api], pending: [api], taskId: 'T-1', opts: noOpts() });
    expect(items[0].isNewBranch).toBe(false);
    expect(items[0].baseBranch).toBeNull();
  });

  test('--branch targets one repo; the bare fallback covers the rest', () => {
    const api = repo('api'), web = repo('web');
    const opts = noOpts();
    opts.branch.map.set('api', 'feat/api');
    opts.branch.fallback = 'feat/all';
    const { items } = planRepos({ allRepos: [api, web], pending: [api, web], taskId: 'T-1', opts });
    expect(items.map(i => i.branch)).toEqual(['feat/api', 'feat/all']);
  });

  test('--base overrides the repo default only for new branches', () => {
    const api = repo('api');
    const opts = noOpts();
    opts.base.map.set('api', 'develop');
    const { items } = planRepos({ allRepos: [api], pending: [api], taskId: 'T-1', opts });
    expect(items[0].baseBranch).toBe('develop');
  });

  test('--shared and --exclude short-circuit the git checks', () => {
    const api = repo('api'), web = repo('web');
    const opts = noOpts();
    opts.shared.add('api');
    opts.exclude.add('web');
    const { items, errors } = planRepos({ allRepos: [api, web], pending: [api, web], taskId: 'T', opts });
    expect(errors).toEqual([]);
    expect(items.map(i => i.mode)).toEqual(['shared', 'excluded']);
    expect(git.findCheckedOutBranch).not.toHaveBeenCalled();
  });
});

describe('planRepos — validation (nothing is created when these fire)', () => {
  test('a flag naming an unregistered repo lists what is registered', () => {
    const api = repo('api');
    const opts = noOpts();
    opts.branch.map.set('nope', 'feat/x');
    const { errors } = planRepos({ allRepos: [api], pending: [api], taskId: 'T', opts });
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/--branch names "nope"/);
    expect(errors[0].hint).toMatch(/api/);
  });

  test('a branch checked out elsewhere is reported with the conflicting path', () => {
    git.findCheckedOutBranch.mockReturnValue('/tasks/other/worktrees/api');
    const api = repo('api');
    const { errors, items } = planRepos({ allRepos: [api], pending: [api], taskId: 'T', opts: noOpts() });
    expect(items).toEqual([]);
    expect(errors[0].message).toMatch(/already checked out in \/tasks\/other/);
    expect(errors[0].hint).toMatch(/--branch api=/);
  });

  test('a repo missing on disk suggests excluding it', () => {
    fs.existsSync.mockReturnValue(false);
    const api = repo('api');
    const { errors } = planRepos({ allRepos: [api], pending: [api], taskId: 'T', opts: noOpts() });
    expect(errors[0].message).toMatch(/not found on disk/);
    expect(errors[0].hint).toMatch(/--exclude api/);
  });

  test('two repos claiming one folder name cannot be resolved without asking', () => {
    const a = repo('api'), b = { ...repo('api'), normalized: '/other/api' };
    const { errors } = planRepos({ allRepos: [a, b], pending: [a, b], taskId: 'T', opts: noOpts() });
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/both want the folder name "api"/);
  });

  test('a repo that already has a worktree points at wksp task repo', () => {
    const api = repo('api');
    const opts = noOpts();
    opts.shared.add('api');
    const { errors } = planRepos({
      allRepos: [api], pending: [], taskId: 'T', usedNames: new Set(['api']), opts,
    });
    expect(errors[0].message).toMatch(/already has a worktree/);
    expect(errors[0].hint).toMatch(/wksp task repo/);
  });

  test('--branch on a repos.txt --shared repo is refused, --exclude is allowed', () => {
    const api = repo('api', { shared: true });
    const branchOpts = noOpts(); branchOpts.branch.map.set('api', 'feat/x');
    expect(planRepos({ allRepos: [api], pending: [], taskId: 'T', opts: branchOpts }).errors)
      .toHaveLength(1);

    const excludeOpts = noOpts(); excludeOpts.exclude.add('api');
    expect(planRepos({ allRepos: [api], pending: [api], taskId: 'T', opts: excludeOpts }).errors)
      .toEqual([]);
  });
});

describe('rendering', () => {
  test('the plan shows mode, branch and where a new branch comes from', () => {
    const items = [
      { name: 'api', mode: 'worktree', branch: 'feat/x', baseBranch: 'main', isNewBranch: true },
      { name: 'web', mode: 'shared' },
      { name: 'ops', mode: 'excluded' },
    ];
    const text = renderPlan(items, { projectName: 'acme', taskId: 'T-1', exists: false }).join('\n');
    expect(text).toContain('acme / T-1 — create plan');
    expect(text).toMatch(/api\s+worktree\s+feat\/x\s+\(new branch off main\)/);
    expect(text).toMatch(/web\s+shared/);
    expect(text).toMatch(/ops\s+excluded/);
  });

  test('resuming says resume, and an empty plan says so', () => {
    const text = renderPlan([], { projectName: 'acme', taskId: 'T-1', exists: true }).join('\n');
    expect(text).toContain('— resume plan');
    expect(text).toContain('(no repos to set up)');
  });

  test('errors are printed with their hints', () => {
    const text = renderErrors([{ message: 'boom', hint: 'try this' }]).join('\n');
    expect(text).toContain('✗  boom');
    expect(text).toContain('try this');
  });
});
