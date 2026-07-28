'use strict';
const fs   = require('fs');
const path = require('path');

jest.mock('../../lib/git', () => ({ currentBranch: jest.fn().mockReturnValue('main') }));

const { makeProject, cleanup } = require('../helpers');
const { addRepo }  = require('../../lib/repos');
const { buildBrief, renderBrief, BRIEF_VERSION } = require('../../lib/brief');

let projectDir, taskDir;
beforeEach(() => {
  projectDir = makeProject('brief');
  taskDir    = path.join(projectDir, 'tasks', 'T-1');
  fs.mkdirSync(path.join(taskDir, 'worktrees'), { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'AGENTS.md'), '## Task: T-1\n');
  fs.writeFileSync(path.join(taskDir, 'WORKLOG.md'), '# Work Log: T-1\n');
});
afterEach(() => cleanup(projectDir));

describe('buildBrief', () => {
  test('carries the task paths, and reports files that do not exist as null', () => {
    const brief = buildBrief(projectDir, 'brief-proj', 'T-1');
    expect(brief.ok).toBe(true);
    expect(brief.briefVersion).toBe(BRIEF_VERSION);
    expect(brief.task.id).toBe('T-1');
    expect(brief.task.agentsMd).toMatch(/tasks\/T-1\/AGENTS\.md$/);
    expect(brief.task.worklog).toMatch(/tasks\/T-1\/WORKLOG\.md$/);
    // Never scaffolded here → honestly reported as absent rather than a broken path.
    expect(brief.project.planningMd).toBeNull();
    expect(brief.task.taskJson).toBeNull();
  });

  test('paths use forward slashes on every platform', () => {
    const brief = buildBrief(projectDir, 'brief-proj', 'T-1');
    expect(brief.task.dir).not.toContain('\\');
    expect(brief.project.dir).not.toContain('\\');
  });

  test('project files are included once they exist', () => {
    fs.writeFileSync(path.join(projectDir, 'PLANNING.md'), '# Planning\n');
    fs.writeFileSync(path.join(projectDir, 'AGENTS.md'), '## Project\n');
    const brief = buildBrief(projectDir, 'brief-proj', 'T-1');
    expect(brief.project.planningMd).toMatch(/PLANNING\.md$/);
    expect(brief.project.agentsMd).toMatch(/AGENTS\.md$/);
  });

  test('a shared repo reports its own path and live branch', () => {
    const shared = path.join(projectDir, 'shared-repo');
    fs.mkdirSync(shared);
    addRepo(projectDir, shared, { shared: true });

    const brief = buildBrief(projectDir, 'brief-proj', 'T-1');
    expect(brief.repos).toEqual([expect.objectContaining({
      name: 'shared-repo', mode: 'shared', branch: 'main',
    })]);
    // Shared repos are context dirs too, exactly as a launch would pass them.
    expect(brief.contextDirs).toHaveLength(3);
  });

  test('a task-excluded repo is reported as excluded with no path', () => {
    const repoPath = path.join(projectDir, 'api');
    fs.mkdirSync(repoPath);
    addRepo(projectDir, repoPath, false);
    fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify({ excluded: ['api'] }));

    const brief = buildBrief(projectDir, 'brief-proj', 'T-1');
    expect(brief.repos[0]).toMatchObject({ name: 'api', mode: 'excluded', path: null });
    expect(brief.contextDirs).toEqual([brief.project.dir, brief.task.dir]);
  });

  test('a registered repo with no worktree yet is flagged, not silently dropped', () => {
    const repoPath = path.join(projectDir, 'api');
    fs.mkdirSync(repoPath);
    addRepo(projectDir, repoPath, false);
    const brief = buildBrief(projectDir, 'brief-proj', 'T-1');
    expect(brief.repos[0].mode).toBe('missing');
  });

  test('the working rules travel inside the document', () => {
    const brief = buildBrief(projectDir, 'brief-proj', 'T-1');
    expect(brief.guidance.join(' ')).toContain('tasks/T-1/AGENTS.md');
    expect(brief.guidance.join(' ')).toContain('tasks/T-1/WORKLOG.md');
    expect(brief.guidance.join(' ')).toContain('PLANNING.md');
    expect(brief.guidance.join(' ')).toContain('wksp task finish T-1');
  });

  test('caller-supplied facts are recorded', () => {
    const brief = buildBrief(projectDir, 'brief-proj', 'T-1', {
      created: true, launched: false, provider: 'claude', createdWorktrees: new Set(['api']),
    });
    expect(brief.task.created).toBe(true);
    expect(brief.launched).toBe(false);
    expect(brief.provider).toBe('claude');
  });
});

describe('renderBrief', () => {
  test('shows the task header, the repo table and the next step', () => {
    const repoPath = path.join(projectDir, 'api');
    fs.mkdirSync(repoPath);
    addRepo(projectDir, repoPath, { shared: true });
    const text = renderBrief(buildBrief(projectDir, 'brief-proj', 'T-1')).join('\n');

    expect(text).toContain('brief-proj / T-1 — task brief');
    expect(text).toContain('Task folder:');
    expect(text).toMatch(/api\s+main\s+shared/);
    expect(text).toContain('wksp start T-1');
  });

  test('survives a project with no repos registered', () => {
    const text = renderBrief(buildBrief(projectDir, 'brief-proj', 'T-1')).join('\n');
    expect(text).toContain('(none registered)');
  });
});
