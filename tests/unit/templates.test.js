'use strict';
const { projectClaudeMd, taskClaudeMd, hubClaudeMd } = require('../../lib/templates');

describe('projectClaudeMd', () => {
  const md = projectClaudeMd('acme');

  test('names the project in the heading and vocabulary', () => {
    expect(md).toContain('## Project: acme');
    expect(md).toContain('the *acme* project');
  });

  test('ships the wksp vocabulary block including the hub', () => {
    expect(md).toContain('## wksp vocabulary');
    expect(md).toMatch(/\*\*hub\*\* — the project's planning task/);
  });

  test('ships the conditional hub pointer', () => {
    expect(md).toContain('## Where things live');
    expect(md).toContain('tasks/hub/');
    expect(md).toContain("what to work on next");
  });

  test('keeps the conflict policy', () => {
    expect(md).toContain('## Conflict policy');
  });
});

describe('taskClaudeMd', () => {
  const md = taskClaudeMd('PROJ-1234');

  test('names the task and has goal + work log sections', () => {
    expect(md).toContain('## Task: PROJ-1234');
    expect(md).toContain('## Goal: (describe the task here)');
    expect(md).toContain('## Work log');
  });

  test('teaches the safe merge / finish pattern', () => {
    expect(md).toContain('## Finishing this task');
    expect(md).toContain('gh pr merge');
    expect(md).toContain('wksp task finish PROJ-1234');
  });
});

describe('hubClaudeMd', () => {
  const md = hubClaudeMd();

  test('is the hub-flavored planning task', () => {
    expect(md).toContain('## Task: hub');
    expect(md).toContain('no worktree');
    expect(md).toContain('## Feature backlog');
    expect(md).toContain('## Open decisions');
    expect(md).toContain('## Work log');
  });
});
