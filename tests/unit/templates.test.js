'use strict';
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const templates = require('../../lib/templates');
const {
  AGENTS_FILE, CLAUDE_FILE, CLAUDE_INCLUDE, GUIDANCE_FILE,
  writeInstructionFiles,
  projectAgentsMd, taskAgentsMd, planningMd, orchestrationMd,
} = templates;
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

  test('states the hub / task information boundary', () => {
    expect(md).toContain(templates.BOUNDARY_HEADING);
    expect(md).toContain('| Here (project root) | In `tasks/<id>/` |');
    expect(md).toContain('graduates upward exactly once');
    // The rule that keeps this file cheap to load into every task session.
    expect(md).toContain('Never put backlog content in this file');
  });

  test('points the hub at ORCHESTRATION.md instead of carrying its content', () => {
    expect(md).toContain(templates.HUB_POINTER_HEADING);
    expect(md).toContain(GUIDANCE_FILE);
    // It has to say WHY, or the next person folds the guidance back in.
    expect(md).toContain('loaded into every task session');
  });

  // The point of the split: this file rides into every task session, so it must not
  // teach a task-scoped agent to delegate, spawn reviewers, or pick a merge method.
  test('carries NO hub-only guidance', () => {
    expect(md).not.toContain(templates.DELEGATION_HEADING);
    expect(md).not.toContain(templates.ORCHESTRATION_HEADING);
    expect(md).not.toContain(templates.STEERING_HEADING);
    expect(md).not.toContain(templates.SETTINGS_HEADING);
    expect(md).not.toContain(templates.STACKED_PR_HEADING);
    expect(md).not.toContain('reviewLoop');
    expect(md).not.toContain('mergeMethod');
    expect(md).not.toContain('gh stack');
  });

  test('stays well under the pre-split size', () => {
    // 143 lines / ~9.0k chars before the split; the relocated half was ~1.2k tokens
    // paid for by every task session. Guard the win rather than a magic number.
    expect(md.split('\n').length).toBeLessThan(100);
    expect(md.length).toBeLessThan(6000);
  });
});

describe('orchestrationMd', () => {
  const md = orchestrationMd('acme');

  test('names the project and says it is not an instruction file', () => {
    expect(md).toContain('# Orchestration — acme');
    expect(md).toContain('**not** an instruction file');
    expect(md).toContain('AGENTS.md');
  });

  test('teaches the headless delegation recipe', () => {
    expect(md).toContain(templates.DELEGATION_HEADING);
    expect(md).toContain('--json');
    expect(md).toContain('wksp task brief <id>');
    expect(md).toContain('wksp start <id>');
    expect(md).toContain('tasks/<id>/WORKLOG.md');
  });

  test('ships the review→fix→re-review loop recipe', () => {
    expect(md).toContain(templates.ORCHESTRATION_HEADING);
    expect(md).toContain('reviewLoop');
    expect(md).toContain('fresh, unbiased reviewer');
    // The non-negotiables of the loop.
    expect(md).toContain('never the implementer');
    expect(md).toContain('acceptance criteria');
  });

  test('ships the task-steering / iteration model', () => {
    expect(md).toContain(templates.STEERING_HEADING);
    expect(md).toContain('durable unit is the **task**');
    expect(md).toContain('resume for continuation, fresh for independence');
  });

  test('ships the agent-honored settings and their defaults', () => {
    expect(md).toContain(templates.SETTINGS_HEADING);
    expect(md).toContain('reviewLoop');
    expect(md).toContain('prGate');
    expect(md).toContain('mergeMethod');
    // Read path and precedence stated for the agent.
    expect(md).toContain('wksp config get <key>');
    expect(md).toContain('wksp\'s CLI does');
  });

  test('mergeMethod is documented stack-aware, and squash is not assumed allowed', () => {
    expect(md).toContain('landing a **solo** PR');
    expect(md).toContain('members land together via `gh stack merge`');
    expect(md).toContain('squashMergeAllowed');
  });

  describe('stacked-PR guidance', () => {
    test('leads with the reframe and the code-overlap decision', () => {
      expect(md).toContain(templates.STACKED_PR_HEADING);
      expect(md).toContain('**Stacking constrains merge order, not build order.**');
      expect(md).toContain('code overlap');
      expect(md).toContain('Disjoint areas');
      expect(md).toContain('no stack at all');
      expect(md).toContain('collide **textually**');
      // The scoping rule that decides what becomes a new member.
      expect(md).toContain('polish and bug fixes join whatever branch is already open');
    });

    test('tells the hub to prompt rather than presume, and to verify the preview feature', () => {
      expect(md).toContain('Prompt, don\'t presume');
      expect(md).toContain('ask before stacking');
      expect(md).toContain('public\npreview on 2026-07-30');
      expect(md).toContain('gh stack --help');
    });

    test('gives the wksp recipe with --base and forbids `start`', () => {
      expect(md).toContain('--base <previous-member> --json');
      expect(md).toContain('never** `wksp start <id>`');
    });

    test('covers the publish / merge CLI mechanics', () => {
      expect(md).toContain('gh stack init');
      expect(md).toContain('gh stack add');
      expect(md).toContain('gh stack submit');
      expect(md).toContain('new PRs are DRAFTS');
      expect(md).toContain('gh pr ready <n>');
      expect(md).toContain('rewrites SHAs');
      expect(md).toContain('gh stack merge --yes --merge');
      expect(md).toContain('`gh pr merge` is refused for stack members');
      expect(md).toContain('read as a **stack** number before a PR number');
    });

    // `gh stack submit --help` (2.89.0): the interactive editor defaults new PRs to
    // ready for review, and only --auto / a non-interactive terminal creates drafts.
    // Stating "submit creates drafts" flatly would be wrong for a human at a terminal,
    // so the claim has to name the path it holds on — the agent's.
    test('scopes the drafts claim to the non-interactive / --auto path', () => {
      expect(md).toContain('Run non-interactively');
      expect(md).toContain('how an agent runs it');
      expect(md).toContain('with `--auto`');
      expect(md).toContain('unless you pass `--open`');
      expect(md).toContain('the editor defaults new PRs to\nready for review');
      // The practical instruction for the agent path stays prominent.
      expect(md).toContain('`gh pr ready <n>` on each new PR is\nrequired');
    });

    // Neither of these is in `gh`'s help output — both were hit on real stacks. Keep
    // them, but say where they come from so a reader doesn't take them as doc-quoted.
    test('attributes the two claims that gh --help does not corroborate', () => {
      const attributed = md.split('\n')
        .filter(l => /Observed in practice/.test(l))
        .join('\n');
      expect(attributed).not.toBe('');
      // 1. submit rewriting SHAs, 2. gh pr merge being refused for stack members.
      expect(md).toMatch(/Observed in practice[\s\S]{0,80}`gh stack submit` restacks/);
      expect(md).toMatch(/`gh pr merge` is refused for stack members[\s\S]{0,60}Observed in practice/);
      // Attributed, not softened: the conservative advice must survive.
      expect(md).toContain('re-read each branch\'s real history before any manual');
      expect(md).toContain('use `gh stack merge`');
    });

    test('covers restacking discipline', () => {
      expect(md).toContain('Never chain rebases of different worktrees in one command');
      expect(md).toContain('false "all clean"');
      expect(md).toContain('rebase --onto <new-base-branch> <old-base-tip-sha> <branch>');
      expect(md).toContain('`Integration:` commit');
      expect(md).toContain('self-expiring\nexemption');
    });

    test('scopes the auto-close trap to hand-rolled chains and states the native behaviour', () => {
      expect(md).toContain('hand-rolled chain');
      expect(md).toContain('auto-closes the child PR');
      expect(md).toContain('auto-rebases and\nretargets the remainder server-side');
    });

    test('names the mid-stack finish wording and the Windows teardown order', () => {
      expect(md).toContain('not yet on');
      expect(md).toContain('Windows locks it');
    });

    test('lists the task-level rules the hub must inject into each member\'s brief', () => {
      expect(md).toContain('which branch it stacks on');
      expect(md).toContain('count at its BRANCH TIP');
      expect(md).toContain('never mutate git state');
      // Explicitly NOT the shared task template — that keeps the migration root-only.
      expect(md).toContain('not** in the shared task template');
    });
  });
});

// The 6 → 7 migration deletes these blocks out of users' files by matching them
// byte-for-byte, so the composition must not drift. If a change here is deliberate,
// freeze the old text in migrate.js first (see the FROZEN notes in templates.js).
describe('frozen relocation blocks', () => {
  const sha256 = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

  // ⚠ These two digests are the bytes wksp actually shipped, taken from the released
  // tags: DELEGATION_SECTION as written by 3.1.0, 3.1.1, 3.2.0 and 3.3.0 (schema 4 → 5),
  // ORCHESTRATION_SECTION as written by 3.2.0 and 3.3.0 (schema 5 → 6). Reproduce either
  // with:
  //
  //   git show v3.3.0:lib/templates.js > /tmp/t.js
  //   node -e "const c=require('crypto'),m=require('/tmp/t.js');
  //            console.log(c.createHash('sha256').update(m.DELEGATION_SECTION).digest('hex'))"
  //
  // The composition tests below only prove the constants are still glued together the
  // same way — they stay green if the recipe's wording is rewritten. These digests are
  // what catches that, because the 6 → 7 step finds these blocks in users' files by
  // matching them BYTE-FOR-BYTE. Reword the frozen text and every project still on
  // schema ≤ 6 stops relocating: the stale block is left behind AND the user is warned
  // they edited something they never touched.
  //
  // So do NOT re-pin these to whatever your change produced. To add or change hub
  // guidance, leave the frozen constants alone and put the new text somewhere else —
  // orchestrationMd()'s own sections, or a new constant that only ships in
  // ORCHESTRATION.md. If the frozen wording genuinely must change, first copy the exact
  // old strings into lib/commands/migrate.js as RELOCATED_* constants and match against
  // those, then update the digests here in the same commit.
  const FROZEN_SHA256 = {
    DELEGATION_SECTION:    '260b3fe444e23903cb2704b81d4e9e6a3a7cd6a8942590fb48438d3d3becac85',
    ORCHESTRATION_SECTION: '650436ef9b56ff5378e1967d6664de00536e3ed591b4597b5fb0525beb2a2510',
  };

  test('DELEGATION_SECTION is byte-identical to what 3.1.0–3.3.0 wrote', () => {
    expect(sha256(templates.DELEGATION_SECTION)).toBe(FROZEN_SHA256.DELEGATION_SECTION);
  });

  test('ORCHESTRATION_SECTION is byte-identical to what 3.2.0–3.3.0 wrote', () => {
    expect(sha256(templates.ORCHESTRATION_SECTION)).toBe(FROZEN_SHA256.ORCHESTRATION_SECTION);
  });

  test('DELEGATION_SECTION is exactly the recipe followed by the boundary block', () => {
    expect(templates.DELEGATION_SECTION)
      .toBe(templates.DELEGATION_RECIPE_SECTION + templates.BOUNDARY_SECTION);
  });

  test('ORCHESTRATION_SECTION is exactly review loop + steering + settings', () => {
    expect(templates.ORCHESTRATION_SECTION)
      .toBe(templates.REVIEW_LOOP_SECTION + templates.STEERING_SECTION + templates.SETTINGS_SECTION);
  });

  test('each block starts at its own heading and ends with a blank line', () => {
    for (const [block, heading] of [
      [templates.DELEGATION_RECIPE_SECTION, templates.DELEGATION_HEADING],
      [templates.BOUNDARY_SECTION,          templates.BOUNDARY_HEADING],
      [templates.REVIEW_LOOP_SECTION,       templates.ORCHESTRATION_HEADING],
      [templates.STEERING_SECTION,          templates.STEERING_HEADING],
      [templates.SETTINGS_SECTION,          templates.SETTINGS_HEADING],
      [templates.HUB_POINTER_SECTION,       templates.HUB_POINTER_HEADING],
      [templates.STACKED_PR_SECTION,        templates.STACKED_PR_HEADING],
    ]) {
      expect(block.startsWith(heading + '\n')).toBe(true);
      expect(block.endsWith('\n\n')).toBe(true);
    }
  });

  test('GUIDANCE_FILE is ORCHESTRATION.md', () => {
    expect(GUIDANCE_FILE).toBe('ORCHESTRATION.md');
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

  // `gh pr merge` is REFUSED for a stack member, so an unconditional instruction to
  // run it is wrong for a stacked task; and squash isn't enabled on every repo.
  test('the finish instructions are stack-aware', () => {
    expect(md).toContain('`gh pr merge` is refused for stack\n  members');
    expect(md).toContain('gh stack merge');
    expect(md).toContain('not yours to merge');
    expect(md).toContain('permits the method you pass');
  });

  // Stacked-task rules are injected per-task by the hub, deliberately NOT shipped
  // here — that is what keeps the schema 6 → 7 migration root-only.
  test('carries no stacked-task rules of its own', () => {
    expect(md).not.toContain('BRANCH TIP');
    expect(md).not.toContain('Integration:');
    expect(md).not.toContain('--onto');
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
