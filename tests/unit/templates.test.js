'use strict';
const fs   = require('fs');
const path = require('path');
const {
  AGENTS_FILE, CLAUDE_FILE, CLAUDE_INCLUDE,
  writeInstructionFiles,
  projectAgentsMd, taskAgentsMd, planningMd,
} = require('../../lib/templates');
const { makeTempDir, cleanup } = require('../helpers');

describe('projectAgentsMd', () => {
  const md = projectAgentsMd('acme');

  test('names the project in the heading and vocabulary', () => {
    expect(md).toContain('## Project: acme');
    expect(md).toContain('the *acme* project');
  });

  test('ships the wksp vocabulary block', () => {
    expect(md).toContain('## wksp vocabulary');
  });

  test('ships the root-as-hub planning section', () => {
    expect(md).toContain('## The project root is the planning hub');
    expect(md).toContain('PLANNING.md');
  });

  test('ships the docs structure section', () => {
    expect(md).toContain('## Docs structure');
  });

  test('keeps the conflict policy', () => {
    expect(md).toContain('## Conflict policy');
  });

  test('does not reference tasks/hub', () => {
    expect(md).not.toContain('tasks/hub');
  });

  test('teaches the headless delegation recipe', () => {
    expect(md).toContain('## Delegating work to a task (from here, headless)');
    expect(md).toContain('--json');
    expect(md).toContain('wksp task brief <id>');
    expect(md).toContain('wksp start <id>');
  });

  test('states the hub / task information boundary', () => {
    expect(md).toContain('## What belongs here vs. in a task');
    expect(md).toContain('tasks/<id>/WORKLOG.md');
    expect(md).toContain('graduates upward exactly once');
    // The rule that keeps this file cheap to load into every task session.
    expect(md).toContain('Never put backlog content in this file');
  });

  test('ships the review→fix→re-review loop recipe', () => {
    expect(md).toContain('## Reviewing a delegated PR (review → fix → re-review)');
    expect(md).toContain('reviewLoop');
    expect(md).toContain('fresh, unbiased reviewer');
    // The non-negotiables of the loop.
    expect(md).toContain('never the implementer');
    expect(md).toContain('acceptance criteria');
  });

  test('ships the task-steering / iteration model', () => {
    expect(md).toContain('## Steering a task: resume, fresh, or new');
    expect(md).toContain('durable unit is the **task**');
    expect(md).toContain('resume for continuation, fresh for independence');
  });

  test('ships the agent-honored settings and their defaults', () => {
    expect(md).toContain('## Agent-honored settings');
    // All three keys, documented with their values.
    expect(md).toContain('reviewLoop');
    expect(md).toContain('prGate');
    expect(md).toContain('mergeMethod');
    // Read path and precedence stated for the agent.
    expect(md).toContain('wksp config get <key>');
    expect(md).toContain('wksp\'s CLI does');
  });
});

describe('taskAgentsMd', () => {
  const md = taskAgentsMd('PROJ-1234');

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

  test('conflict policy references project-level AGENTS.md', () => {
    expect(md).toContain('project-level AGENTS.md');
    expect(md).not.toContain('project-level CLAUDE.md');
  });
});

describe('planningMd', () => {
  const md = planningMd('acme');

  test('has the planning heading', () => {
    expect(md).toContain('# Planning — acme');
  });

  test('has feature backlog and open decisions sections', () => {
    expect(md).toContain('## Feature backlog');
    expect(md).toContain('## Open decisions');
  });
});

describe('CLAUDE_INCLUDE', () => {
  test('is exactly "@AGENTS.md\\n"', () => {
    expect(CLAUDE_INCLUDE).toBe('@AGENTS.md\n');
  });
});

describe('writeInstructionFiles', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTempDir('tmpl-write'); });
  afterEach(() => cleanup(tmpDir));

  test('writes AGENTS.md with the given content', () => {
    const content = '## Test content\n';
    writeInstructionFiles(tmpDir, content);
    expect(fs.readFileSync(path.join(tmpDir, AGENTS_FILE), 'utf8')).toBe(content);
  });

  test('writes CLAUDE.md with exactly CLAUDE_INCLUDE', () => {
    writeInstructionFiles(tmpDir, '## anything\n');
    expect(fs.readFileSync(path.join(tmpDir, CLAUDE_FILE), 'utf8')).toBe(CLAUDE_INCLUDE);
  });
});
