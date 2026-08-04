# Stacked PRs

GitHub's native stacked pull requests reached **public preview on 2026-07-30** — free, all
repos, available in the web UI, the `gh` CLI, mobile and the API. It is labelled "subject to
change", so treat availability as something to check (`gh stack --help`) rather than assume.

This page is the distilled version of two real stacks shipped through wksp tasks
(one of five PRs, one of four) plus the hand-rolled chain that came before them. New projects
get the same guidance in their root `ORCHESTRATION.md`, which is where an AI orchestrating
your work reads it from.

## Stacking constrains merge order, not build order

This is the idea worth internalising first, because getting it wrong wastes the most time.
A stack does **not** mean building one PR at a time. It means the PRs land in a fixed order.

Decide per batch by **code overlap**, and say out loud which mode is in play:

| Signal | Mode | Shape |
|---|---|---|
| The work items touch **disjoint** files / areas | Parallel | Parallel tasks, parallel agents, independent PRs off the default branch. They merge in any order. **No stack.** |
| The work items touch the **same** files or regions | Stacked | Chained branches, each based on the previous member. |

Overlap is the criterion, not team size or ambition. The reason isn't bookkeeping:

- Building overlapping work in parallel doesn't avoid conflicts, it **defers** them to stack
  time — same conflicts, later, with less context.
- Mutation-tested guards collide **textually** even when the two features are logically
  compatible: each guard asserts its own branch's spelling of the rule.
- Chaining lets each task build on the previous one's **real behaviour** instead of a guess.

**Scoping rule.** Polish and bug fixes join whatever branch is already open — cheap, serial,
no conflicts. Anything that would still stand alone as a feature after this branch merges
gets its own task and its own spec.

**Prompt, don't presume.** On a multi-item batch, an agent should state the mode it detected
and ask before stacking. "These three all touch the panel/keyboard seam, so I'd chain them —
OK?" is the right shape.

## Setting a stack up

One wksp task per PR, branch `feat/<task-id>`, each with its own worktree, each based on the
previous member:

```bash
wksp task create <id> --goal "<one line>" --branch feat/<id> --base <previous-member> --json
```

Use `create`, **never** `wksp start <id>` for a new member. `start` matches partial names, so
an id that is a substring of an existing task silently resumes *that* task and hands back its
branch — the work would land on the wrong branch, quietly. `create` refuses a taken id.

Then turn the branches into a stack:

```bash
gh stack init feat/a feat/b feat/c    # existing branches → a stack
gh stack add feat/d                   # append one on top
gh stack view                         # the chain and each member's state
gh stack switch / gh stack sync
```

### What each stacked task's brief must say

These are **task-level** rules. wksp deliberately does *not* put them in the shared task
template — they only apply to a stacked task, so whoever creates the member writes them into
its `AGENTS.md` (or passes them via `--goal`):

- **Which branch it stacks on.** Its base is the previous member, not the default branch.
- **The test baseline is the count at its BRANCH TIP, not the default branch's.** A stacked
  suite is bigger than main's — the two real stacks ran 550 → 812 and 812 → 1026 tests. An
  agent handed main's number reports a false failure on its very first run.
- **`--onto` discipline** when restacking (below).
- **Record conflict resolutions as `Integration:` commits.**
- **The self-expiring exemption** for a bug that belongs to another member (below).
- **Never mutate git state** — no `stash`, no `reset`, no branch deletion — unless explicitly
  asked. An agent's stash slip had to be undone once; the ban is now explicit in briefs.

## Publishing

```bash
gh stack submit                          # create / update the whole chain
gh pr ready <n> --repo <owner>/<repo>    # REQUIRED — submit creates DRAFTS
```

Two things to know about `submit`:

1. It creates **drafts**. Nothing is reviewable until `gh pr ready`.
2. It **restacks the branches itself and rewrites SHAs.** After a submit — or after amending
   anything mid-stack — re-read each branch's real history before any manual rebase. Never
   trust a base SHA you remembered from before a submit.

Re-run `gh stack submit` after *every* restack.

## Restacking — where the time actually goes

**Never chain rebases of different worktrees in one command.** A conflict stops the first
rebase, and every command after it silently no-ops against refs that never moved. The result
is a false "all clean" for branches that were never touched. One command per branch, each
verified:

```bash
git -C <task-worktree> rebase --onto <new-base-branch> <old-base-tip-sha> <branch>
```

**Always `--onto`, never plain `git rebase <base>`.** Resolving a conflict on a lower branch
changes its commits' patch-ids, so git stops recognising the base's commits as duplicates and
replays work that already merged below. Read the real old base tip out of the branch's log —
don't assume it.

**Guard and test conflicts are expected work, not noise.** Two logically compatible features
that each added a guard to the same rule will conflict textually. Resolving them is real
integration work, so record each resolution as an `Integration:` commit and the merge history
stays honest about what was reconciled.

### The self-expiring exemption

You are working on member B and you find a bug in code member A owns. **Don't fix it** — two
branches editing one rule is a conflict for nothing.

Instead, add a *named* exemption for the broken case, and write its test so the test asserts
**the exemption is still needed**. When A's real fix lands underneath in the restack, that
test fails, and the failure forces the workaround's deletion. It's a cross-branch TODO that
cannot rot.

## Merging

```bash
gh stack merge --yes --merge     # atomic, all-or-nothing, bottom-up, the whole stack
```

- **`gh pr merge` is refused for stack members.** Use `gh stack merge`.
- The merge is genuinely atomic: if any member can't merge, none do. You never hand-merge
  members one at a time.
- A bare number after `gh stack merge` is read as a **stack** number before a PR number.
  Stack numbers and PR numbers are separate sequences — stack #14 is not PR #14 (which may
  not exist at all).
- The landing artifact is one merge commit per stack: the *top* PR's merge commit, with every
  stack commit linearised beneath it.
- The `mergeMethod` [agent-honored setting](/headless#agent-honored-settings) governs **solo**
  PR merges. A stack ignores it — members land together via `gh stack merge`.

For a **solo** PR, always pass `--repo`, and check the repo permits the method:

```bash
gh repo view --repo <owner>/<repo> --json squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed
gh pr merge <n> --repo <owner>/<repo> --squash
```

Without `--repo`, gh tries to check out the default branch locally and fails inside a task
worktree, because the base repo has that branch checked out. It merges remotely and errors
locally — a git-worktree constraint, not a tooling bug. And a repo with squash merging
disabled rejects `--squash` outright, so fall back to a method it does allow.

### The auto-close trap — scope it correctly

Squash-merging a base PR and deleting its branch **auto-closes the child PR**. This bit
wksp's own development once: PR #39 had to be re-opened as #40.

That hazard belongs to a **hand-rolled chain** — branches you based on each other yourself,
with no `gh stack`. There, retarget the child to the default branch *before* deleting the base
branch, or rebase and re-open it as a new PR.

With a **native `gh stack`**, GitHub auto-rebases and retargets the remainder server-side when
the bottom member lands, so that caution does not apply. Know which of the two you are
driving, and don't carry stale caution into the native path.

## After the merge

A **mid-stack PR merges into its parent branch, not the default branch.** GitHub reports it as
MERGED, but the work is not on the default branch until the members below it land too. `wksp
task finish` knows this: it only claims a clean merge when the merged PR's base *is* the
repo's default branch, and otherwise reports

```
⚠  The following branch(es) are not on the default branch yet.
   · feat/b in myrepo — PR #18 merged into feat/a — not yet on main
```

and asks before deleting anything. Finish members after the stack has landed, one per member:

```bash
wksp task finish <id> --yes
```

Two more teardown notes:

- Squash-merges defeat ancestry-based merge detection — `git merge-base --is-ancestor` says
  "not merged" for a branch that definitely merged. `finish` already falls back to the forge
  for exactly this reason; see [`wksp task`](/reference#wksp-task-subcommand-id).
- **Stop any running server and move shells out of a worktree before teardown.** Windows locks
  a directory that a shell is sitting in, and the removal fails.

## Review rhythm

Each PR is reviewed live, in rounds. A fix round folds back into that member's branch, then
the **whole chain is restacked and republished**, then **one** message lists what to retest.
Ten rounds on a single member has happened; five is common.

For a non-trivial PR, run the independent
[review→fix→re-review loop](/headless#reviewing-a-delegated-pr): a **fresh, unbiased**
reviewer — never the implementer, and never a fork of the orchestrator, since a fork inherits
its framing and defeats the point. Terminate on a clean approve, or once every remaining
finding is an acknowledged non-blocker.

## Don't let a stacked branch sit

A long-lived stacked branch goes CONFLICTING and is usually better **re-implemented than
rebased** — a rebase force-fits old logic onto a codebase that has moved underneath it. The
whole point of the scoping rule at the top is to keep members small enough to land quickly.
