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
