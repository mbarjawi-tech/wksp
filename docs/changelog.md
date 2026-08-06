# Changelog

All notable changes to this project will be documented here. Follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and [Semantic Versioning](https://semver.org/).

---

## [Unreleased] — 3.4.2

### Fixed

- **wksp no longer mistakes your home directory for a project — `wksp delete` could offer to delete `~`.** The global config is `~/.wksp` and a project marker is `<project>/.wksp`: **the same filename**. Project resolution walked up from the current directory testing only whether a file called `.wksp` existed, so from anywhere under your home directory with no real project in between, it stopped at the **home directory itself** and handed it back as "the project". Thirteen commands resolve a project that way, and the consequences ran from noisy to destructive:
  - **`wksp delete`** printed `⚠ DESTRUCTIVE: Delete project "<your-username>"?` and would have recursively deleted your entire home directory. Only the type-the-project-name confirmation stood in the way — and the name it asked you to type was the basename of your home folder, which is not obviously wrong.
  - **`wksp migrate`** would have "migrated" your home directory: scaffolding `PLANNING.md`, `WORKLOG.md`, `AGENTS.md`, `ORCHESTRATION.md` and `CLAUDE.md` into `~`, and — worse, because it is silent and lasting — stamping `schemaVersion` through `writeProjectConfig(~, …)`, which targets `~/.wksp`, i.e. **writing a project field straight into your global config**. Every command warned you to run it, too: the schema check in `bin/wksp.js` reads the "project" it just resolved, finds a global config with no `schemaVersion`, and nags `This project was created with an older version of wksp` from any directory under `~`.
  - **`wksp init`** pointed at the home directory would have replaced the global config with a project marker, silently discarding `reposRoot`, `aiProvider` and every other global setting.
  - `task create`, `import` and `repo add` would have created `~/tasks/…` and `~/repos.txt`; project-scoped `wksp config set` wrote project keys into the global file; and the read commands (`status`, `list`, `providers`) merely reported nonsense.

  Three independent fixes, because each one alone leaves a hole:
  - **The global config is never a project marker.** Resolution now skips a candidate whose marker path *is* the global config path and keeps walking up, rather than returning it. The comparison is exact-path and platform-correct (case-insensitive on Windows, via the same `path.relative` helper the teardown guards use) — deliberately **not** "anything under the home directory", because keeping projects in `~/projects/foo` is a normal setup that must go on resolving exactly as before.
  - **A marker has to look like a project, not just exist.** A stray or foreign `.wksp` anywhere else no longer hijacks resolution either: the file must parse as a JSON object carrying a non-empty `name`. `name` is the most lenient key that still tells the two files apart — wksp's **first** release wrote `{ name }` and nothing else, with `schemaVersion` only arriving later, so requiring both keys would have made wksp stop recognising the oldest projects, which is worse than the bug. Requiring nothing would accept an empty `{}` global config (reachable by clearing the last global key), and accepting `schemaVersion` on its own would accept a global config **this very bug already corrupted**, since `migrate` writes `schemaVersion` but never `name`. A `.wksp` that isn't readable or isn't JSON is treated as "not a project" instead of throwing, and resolution continues **upward** past any rejected candidate, so a real project is still found above a stray marker.
  - **The destructive and creative entry points refuse outright.** Independently of how the path was resolved, `wksp delete`, `wksp migrate` and `wksp init` now refuse the home directory and any filesystem root, saying which one it is and why — one shared rule, so the three cannot drift apart. `delete` refuses before it enumerates anything or asks for a confirmation, and it refuses even if a perfectly project-shaped `.wksp` is sitting there, because this is a rule about *location*, not content. `init` checks before its "already exists" test, so the message names the real problem (the home directory always exists) instead of shrugging. `wksp import`'s hand-typed "path to existing project" prompt asks the same shape question as resolution now, rather than accepting any directory that merely contains a `.wksp`.

  With resolution fixed, a project command run from a random directory under `~` now correctly reports `not inside a wksp project` and exits 1. No schema bump: the marker format is unchanged, and the validation only reads a key wksp has written since its first release.

---

## [3.4.1] — 2026-08-05

### Fixed

- **`wksp task finish` / `archive` / `delete` no longer tear a task half-down when something is sitting in its worktree — and every other command that removes a worktree the same way now gets the same protection.** Hit for real on Windows: the merge check passed cleanly, then `git worktree remove` deleted the worktree's **contents first — including its `.git` file** — and failed on the locked directory, because the invoking session's cwd was inside `tasks/<id>/worktrees/<repo>` and wksp, a child process, **inherits that cwd**. The retry was the dangerous half: with `.git` gone, the archive recorded the repo as `corrupted at archive` with a null branch, and every step that keys off that branch — deleting the local branch, fast-forwarding the base repo — was skipped **in silence**, while the run still printed its usual success lines. The folder rename then failed on the same lock, leaving a live task carrying a stale `archived.json` and an empty, locked `worktrees/<repo>`. Six changes:
  - **Refuse up front.** Before removing a worktree, deleting a branch or renaming anything, teardown checks whether the process cwd is inside the task folder — `delete`, `archive`, `finish`, `rename` (which renames the task folder and had no guard at all, despite the shared guard's own contract promising one), the archived-task delete, and `repo <id> <repo> share|exclude` (which remove a worktree exactly the same way and reproduced the identical bug, unguarded) — and stops with `Cannot tear down <id> — your shell is inside <path>` plus the `cd` that fixes it, exit 1, nothing touched. The headline names what the command actually is, so a mode switch reads `Cannot switch <repo> to shared in <id>` and a rename reads `Cannot rename <id>` rather than claiming a teardown. `wksp repo remove` (which tears down a repo's orphaned worktrees across every task registered against it) and the project-wide `wksp delete` get the same cwd check too, worded for their own multi-task/whole-project scope — and for `wksp delete` that now includes each **task folder** as well as each worktree, since a shell sitting in `tasks/<id>/` itself passed every per-worktree check and then hit a bare `EBUSY` on the bulk folder delete. The inherited cwd is a proxy for the launching shell's, and a parent shell's cwd keeps the directory locked no matter where wksp moves itself — so refusing is the only safe answer, and it happens before the plan, the prompt, the fetches and the fast-forwards. The containment test is `path.relative`-based rather than a string prefix: case-insensitive on Windows, and `…/tasks/foo-bar` is correctly **outside** `…/tasks/foo`, so a shell in one task never blocks the teardown of a similarly-named sibling. Junctions and 8.3 short names are covered by comparing resolved forms too
  - **Fail before destroying, not after.** Each worktree is probed for removability before the first destructive step — a rename to a temporary sibling name and straight back, since a directory the OS lets us rename is one it will let us delete, and a failed rename changes nothing. A lock held by *another* process (an editor, a dev server, a second shell) is therefore caught while the checkout is still whole: `Cannot tear down <id> — "<repo>" is locked (EBUSY)`, with `Nothing was touched` **only when that's actually true** — see below. Same probe, same commands, now also guarding `repo <id> <repo> share|exclude`, `repo remove`, and the project-wide `delete`, so `task.json` is never left recording a repo as a worktree once the folder on disk no longer has one: the mode is only ever written *after* a successful `git worktree remove`, not before, on every one of these paths
  - **A stranded probe is reported by every command and recovered by the ones that mean it.** The rename-away-and-back above is safe on the happy path, but if the process dies **between** the two renames (crash, kill, power loss) the worktree used to end up sitting under a `pid`+random name as a SIBLING of `worktrees/`, invisible to anything that only scanned `worktrees/*` — not flagged corrupted, not reported, and liable to be swept up unnoticed by the next run's bulk `fs.rmSync(taskDir, { recursive: true, force: true })`, discarding a still-valid git worktree, orphaning the base repo's `.git/worktrees/<name>` registration, and losing the branch's identity with no trail. The probe's name is now **deterministic** (`.wksp-probe-<folderName>`, encoding exactly which worktree it came from) instead of `pid`+random, and `discoverWorktrees` — the one place every command enumerates a task's worktrees — always **reports** one, so it can never be invisible again. Putting it back is **opt-in**, and belongs to the commands that write to the task: `delete`, `archive`, `finish`, `rename`, `repo remove` and the project-wide `delete` were going to move or delete that worktree anyway, and `wksp start` / `task create` / `task resume` exist to make a task ready to work in — they create worktrees and write `task.json` and the `.code-workspace` — so they recover it too instead of dead-ending on a folder wksp itself moved aside. Each recovery is announced (`⚠ Put "<repo>" back in <id> …`) rather than happening behind your back, and the project-wide `wksp delete` recovers per task *after* its typed confirmation, so cancelling that command leaves every folder exactly where it was. A read-oriented command — `status`, `list`, `brief`, `export` — names it, names the one-line move that fixes it, and names the commands that will do it for you, but renames nothing: looking at a project should not mutate it, and a read that renamed could land inside *another* run's removability probe, putting the folder back between that run's two renames so its own rename-back failed `ENOENT` and it reported a perfectly healthy worktree as locked, with remediation pointing at a path that no longer existed. (The probe survives that race from the other side too now: an `ENOENT` rename-back counts as success rather than a lock only when the probe path is gone **and** the directory is back where it belongs — a different directory appearing there while ours still sits aside is still reported.) When a recovery is asked for and truly can't be done (still locked, or the rare case something already occupies the target), the run refuses instead of proceeding, naming exactly what to move where and never leading with a command that would discard the task — `wksp start` / `resume` print that move and mention teardown only as the alternative it is; `archiveTask` refuses on its own account rather than trusting its caller to have checked, so a probe can never ride into `archived-tasks/` with its registration orphaned; the project-wide `wksp delete` and `wksp task delete` both stop rather than bulk-deleting the task (or project) folder out from under it, and `wksp repo remove` now stops as well: a stranded worktree's `.git` file is unreadable, so it can't say which repo it belongs to, and it used to be **skipped with no warning at all** while the repo was deregistered from `repos.txt` anyway — which is what makes the branch name unrecoverable, since the recovery walks `repos.txt` to find the base repo still registering that path. A stranded probe is also no longer counted as a live worktree: `wksp status` shows `(renamed aside)` instead of `(corrupted) ✗` for a path that doesn't currently exist, and `wksp list` counts it separately, in one `(+N renamed aside)` form across both of its views (`--json` reports it under `strandedProbes`, never as a worktree at a phantom path). `task repo <id> <repo> worktree` still declines to create a second worktree over the top of one, but now names the state it found — renamed aside, or unreadable — instead of reporting a worktree `on null`
  - **Never silently skip.** A repo whose worktree can't be read now reports every step that did not run for it — the worktree removal, the branch deletion, and (under `finish`) the base-repo fast-forward — with the `git -C … worktree prune` / `branch -D` / `pull --ff-only` commands that finish the job by hand (the placeholder wording now matches what's actually printed when the base repo is unknown: *"find it in repos.txt, then replace `<base repo>` below with that path"*), and the branch name recovered from the base repo's own worktree registry (the last place it survives, since git keeps listing a worktree until `worktree prune`). That name is deliberately kept out of the manifest's `branch` field: it is for reporting, and nothing verified it merged. `archive` prints `⚠ Archived <id> — with unfinished teardown.` instead of its plain `✓`, `finish` adds `⚠ <id> is NOT fully finished`, and both exit non-zero. `finish` also stops claiming `✓ All branches merged` when a worktree could not be read: those branches were never checked, and it now says so and counts only what it verified — and when *every* worktree is unreadable (nothing to verify at all), it now asks `Finish <id> anyway?` instead of silently proceeding with zero verified merges
  - **Told where it matters.** The generated task `AGENTS.md` already said to *suggest* `wksp task finish <id>` rather than run it; it now also says why it has to run from outside the task folder. Template text only — existing task files are not migrated — and `docs/reference.md` documents the whole refusal, the lock probe, the stranded-probe recovery, and the manifest recovery path
  - **Get out of the way, then explain what's left.** Mirroring what `wksp delete` already did for a project folder, teardown chdirs the process out of the task folder before deleting or renaming it, degrading with an explanation rather than an `EBUSY` when it can't — the archived-task delete now degrades the same way too, instead of letting a locked file surface as a bare `Fatal:` from a raw filesystem error. A folder rename that still fails leaves the manifest in place on purpose: re-running `archive` recognises the half-state, prints `Recovering an interrupted archive of <id>`, and **re-uses that manifest** rather than capturing a new one — capturing again once the worktrees are gone would write a record with no branch and no tip sha, quietly costing the task its restorability. `delete` names the stale `archived.json` in its plan, so discarding the half-state is deliberate. Three smaller record fixes ride along: a branch an interrupted run had already deleted is recorded as gone rather than `branchKeptInBaseRepo`; a task folder that can't be deleted says which command to re-run instead of raising a bare filesystem error — live, archived, **and** the per-task folders the project-wide `wksp delete` removes, which was the one path still leaking a raw `EBUSY`; and `task repo <id> <repo> exclude` now refuses a worktree it cannot read, exactly as `share` already did, instead of skipping the removal and writing `excluded` to `task.json` anyway — which recorded a mode the disk did not have and left a gutted folder, its git registration and its branch all still live, in silence — and it answers with the concrete `git -C … worktree prune` plus folder-removal pair that clears that state, rather than sending someone who wanted one repo excluded off to tear the whole task down

---

## [3.4.0] — 2026-08-04

### Added

- **Stacked-PR guidance**, product-wide: a new [Stacked PRs](https://mbarjawi-tech.github.io/wksp/stacked-prs) guide plus a section in every project's root `ORCHESTRATION.md`. It leads with the reframe that matters — **stacking constrains merge order, not build order** — and makes the decision about **code overlap**: disjoint areas get parallel agents in parallel tasks and independent PRs off the default branch with **no stack at all**; overlapping files or regions get chained branches, because building overlapping work in parallel only defers the same conflicts to stack time and mutation-tested guards collide *textually* even when the two features are logically compatible. Scoping rule: polish and bugs join whatever branch is already open, and anything that would still stand alone after this branch merges gets its own task. On a multi-item batch the agent states the mode it detected and asks before stacking, and treats GitHub's native stacked PRs (public preview since 2026-07-30, "subject to change") as something to verify rather than assume. The mechanics are all there: one wksp task per PR via `wksp task create <id> --branch feat/<id> --base <previous-member> --json` (`create`, never `start`, which partial-matches); `gh stack init/add/view/switch/sync`; `gh stack submit` creates new PRs as **drafts** when it runs non-interactively (which is how an agent runs it) or with `--auto`, so `gh pr ready <n>` is required on that path — run interactively its editor defaults new PRs to ready for review instead; observed in practice rather than documented, `submit` also **restacks and rewrites SHAs**, so a base SHA remembered from before a submit is worthless; `gh stack merge --yes --merge` is atomic all-or-nothing bottom-up and **`gh pr merge` is refused for stack members** (also observed in practice, not in `gh`'s help); and a bare number after `gh stack merge` reads as a *stack* number before a PR number (separate sequences). Restacking discipline: **never chain rebases of different worktrees in one command** — a conflict stops the first and every later command silently no-ops against refs that never moved, producing a false "all clean" — and always `git rebase --onto <new-base> <old-base-tip> <branch>`, reading the real old tip out of the branch log, since conflict resolution below changes patch-ids and a plain `rebase <base>` replays work already merged beneath. Guard conflicts are expected work recorded as `Integration:` commits, and a bug that belongs to another member gets a **self-expiring exemption** — a named workaround whose test asserts the exemption is still needed, so the real fix landing underneath fails the suite and forces its deletion. The **auto-close trap** (squash-merging a base and deleting its branch auto-closes the child PR) is scoped correctly for the first time: it is a *hand-rolled chain* hazard, while a native `gh stack` auto-rebases and retargets the remainder server-side when the bottom lands. Also documented: the review rhythm (per-member rounds → restack → republish → one retest list), the task-level rules the hub injects into each member's brief — which branch it stacks on, **the test baseline is the count at BRANCH TIP, not the default branch's** (else the agent reports a false failure on its very first run), `--onto` discipline, `Integration:` commits, self-expiring exemptions, and never mutating git state (no `stash` / `reset` / branch deletion) unless asked — and stopping servers plus moving shells out of a worktree before teardown, because Windows locks it
- `wksp config --help` now documents every config key, split into **CLI behaviour** (`reposRoot`, `autoResume`, and the previously undocumented `aiProvider` and `customProviders`) and **agent-honored** (`reviewLoop`, `prGate`, `mergeMethod`), with the distinction spelled out — wksp's CLI never acts on the second group, the orchestrating agent reads them — plus the project-over-global resolution and examples

### Changed

- **Hub-only guidance moved out of the root `AGENTS.md` into a new root `ORCHESTRATION.md`** (schema 6 → 7). The root instruction file is `--add-dir`'d into **every** task session, and just over half of it — 79 of 143 lines, ~1.2k tokens — was orchestrator-only: the headless delegation recipe, and the review-loop / task-steering / agent-honored-settings trio. Tokens were the smaller half of the problem; the bigger half is role confusion, since a task-scoped agent was being told how to delegate work, spawn reviewers and choose merge methods, and no test catches an agent acting out of role. The mechanism is the one `PLANNING.md` already proves: only the *instruction* file is injected into a task session, so a file sitting beside it at the root is reachable by a planning session and invisible to tasks. `ORCHESTRATION.md` is scaffolded by `wksp init` and `wksp import` alongside `PLANNING.md`, and also carries the stacked-PR guidance above. Everything genuinely shared stays in `AGENTS.md` — the wksp vocabulary, the planning-hub role, the docs-structure rule, "what belongs here vs. in a task", cross-cutting conventions, the provider self-check, the conflict policy and the work-log rules — plus a short pointer so the hub still finds what moved. The generated project instruction file drops from 144 lines / 8.6k chars to 72 lines / 4.4k chars, a 49% cut paid back on every task session
- `wksp migrate` schema 6 → 7 relocates the guidance in existing projects. It is the **first migration step that removes text from a file you own**, so it is deliberately conservative: a block is deleted only when it still matches the shipped template **byte-for-byte**, which proves it is text wksp wrote rather than something you typed. A block you have edited is **left in place** and reported, with its heading named so you can delete it by hand once you are happy with the new file — and the two blocks are judged independently, so an edited delegation recipe doesn't stop the orchestration block from relocating. The step also creates `ORCHESTRATION.md` (never overwriting an existing one), inserts the pointer, is idempotent under re-runs, `--repair` and `wksp import` (the pointer is the marker), stands down entirely while a real `AGENTS.md` and a real `CLAUDE.md` both exist at the root, and touches the **root file only** — task instruction files, live and archived, are untouched. The 4 → 5 and 5 → 6 steps now stand down once the pointer is present, so `--repair` on a converted project can't resurrect the relocated sections. The byte-exact match accepts **CRLF as well as LF**, so a root instruction file that a Windows editor has normalized to CRLF still relocates cleanly instead of being misread as edited — which would have left both blocks in place, warned about edits you never made, and duplicated the guidance across the two files — and the pointer is inserted in the file's own line endings. The one tolerated trailing variant (the block with its final newline stripped) is now only accepted at **end of file**: appending your own words to the block's last line therefore preserves the whole block and reports it, rather than deleting the shipped text and leaving your words orphaned under no heading
- The **task** `AGENTS.md` template's "Finishing this task" section is stack-aware. It used to teach `gh pr merge <pr> --repo <owner>/<repo>` unconditionally — but that command is *refused* for a PR in a stack, so a stacked task was being told to run something that cannot work. A solo PR still merges that way, now with a note to confirm the repo permits the method (`--squash` isn't enabled everywhere); a stack member is explicitly not the task's to merge — the hub lands the whole stack with `gh stack merge`. Template text only: existing task files are not migrated. `mergeMethod`'s documented meaning is stack-aware for the same reason — it governs solo-PR merges, and a stack ignores it
- The review-loop section heading is now identical in the instruction template and the [Headless wksp](https://mbarjawi-tech.github.io/wksp/headless) guide ("Reviewing a delegated PR (review → fix → re-review)"), so finding one finds the other

### Fixed

- `wksp task finish` could claim a **mid-stack** PR was merged when the work was not on the default branch. `lib/forge.js` reported `merged` whenever the branch's PR was MERGED, but "MERGED" in a forge means "merged into *this PR's* base" — and a stack member's base is the member below it, not the default branch. So finish would print `✓ <branch> merged — PR #N (confirmed on GitHub)`, force-delete the local branch and archive the task while the work had never reached the default branch. The `gh pr list` query now also asks for `baseRefName`, and a merged PR only counts as `merged` when its base **is** the repo's default branch; when it merged somewhere else the result is a distinct `mergedToNonDefault` carrying the parent's name, and finish reports `⚠ … PR #N merged into feat/a — not yet on main` and falls through to the existing warn + y/N confirm instead of claiming a clean merge. The existing `headRefOid` tip-matching is unchanged, and the check stays best-effort in every direction: no default branch known, or a `gh` too old to report `baseRefName`, leaves the previous verdict alone rather than inventing doubt

---

## [3.3.0] — 2026-07-31

### Added

- `wksp task finish --no-archive` (alias `--delete`) — finish a merged task without keeping an archive. It runs the same tiered merged-verification and fast-forwards each base repo's default branch, but then deletes the task outright (worktrees, local branches, and the task folder) instead of moving it to `archived-tasks/`. The delete path has its own confirmation that clearly flags it as irreversible with no archive kept and, like the archiving path, refuses up-front when a worktree has uncommitted changes unless `--force` is passed (which then lists what would be discarded — `--yes` is never a substitute for `--force`); `--keep-branches`, `--force`, and `--yes` carry the same meaning they have for the archiving path. The worktree-teardown code is now shared with `wksp task delete`

### Fixed

- `wksp task delete` can now reach archived tasks by partial name and from the picker, not just by exact id. A partial that matches no live task falls back to matching archived tasks, and the delete picker lists archived tasks marked `(archived)`. `resume`, `archive`, and `finish` are unchanged — only `delete` reaches into `archived-tasks/`

### Changed

- Docs audited and corrected to the current release. The five `docs/examples/*.md` walkthroughs now use the verb-first task syntax (`wksp task create/resume/delete`, `wksp task archive/unarchive`, `wksp task repo <id> <repo> share|worktree|exclude`) and the current `wksp repo add/remove` and `wksp cleanup` forms instead of the removed v1 positional flags; obsolete `task-shared.txt` / `task-excluded.txt` references become `task.json`. `docs/export-import.md` documents the canonical `task.agentsMd` bundle field (with `claudeMd` kept for back-compat) and bumps the example `schemaVersion` to `6`; `docs/reference.md` and `docs/examples/05-archive-workflow.md` document `finish --no-archive`

---

## [3.2.0] — 2026-07-29

### Added

- The project `AGENTS.md` now carries orchestration guidance for an AI driving delegated work from the root. First, an independent **review→fix→re-review loop** to run before a coding or behaviour PR merges: spawn a *fresh, unbiased* reviewer — never the implementer, and never a fork of the orchestrator, since a fork inherits its framing — brief it with the fix intent, explicit acceptance criteria, and "assess independently, don't rubber-stamp"; if it finds issues a fixer works in-task on the same branch so the PR updates in place, then the reviewer runs again; the loop ends on a clean approve or once every remaining finding is an acknowledged non-blocker (trivial docs-only PRs are exempt). Second, the **task-steering model**: the durable unit is the task — its files, worktree, `WORKLOG.md`, `AGENTS.md`, and session history outlive any agent — so **resume for continuation, spawn fresh for independence** (e.g. a review), and **open a new task for a separate concern**, rather than spinning up a fresh agent per iteration. The full write-ups, with a worked hub-driven loop, are in the [Headless wksp](https://mbarjawi-tech.github.io/wksp/headless) guide
- Three **agent-honored** config keys the orchestrator reads — wksp's CLI deliberately does *not* act on them; the agent does — resolved project `.wksp` over global `~/.wksp` like every other key and read with `wksp config get <key>`. `reviewLoop` (`ask` (default) | `always` | `never`) gates the review loop above: `ask`/unset prompts, `always` runs it, `never` skips. `prGate` (`ask` | `always` | `never`, default `never`) is the verify-before-PR gate — `never` opens the PR as soon as the work is ready (today's behaviour), `always` pauses first so you can manually test and opens it once you confirm, `ask` asks which. `mergeMethod` (`squash` (default) | `merge` | `rebase`) records which merge the agent uses when it lands a PR. The defaults preserve current behaviour and are documented in the [Headless wksp](https://mbarjawi-tech.github.io/wksp/headless) guide and the [config reference](https://mbarjawi-tech.github.io/wksp/reference)

### Changed

- `wksp migrate` schema 5 → 6 back-fills the orchestration guidance and the agent-honored settings reference into an existing project's root `AGENTS.md`. As with the 4 → 5 delegation step, a content-only change earns a schema bump because those sections are how a planning session *learns* the review loop, the steering model, and the settings exist — without the migration they would ship invisible to every project that already exists. The step only ever inserts: the block goes in before your `## Cross-cutting conventions` heading (falling back to the next known heading, then the end of the file), your prose is never rewritten, a file that already documents the flow is left alone, and while a real `AGENTS.md` and a real `CLAUDE.md` both still exist at the root (the unresolved 3 → 4 conflict) it stands down rather than dropping new text into a pending merge. Task instruction files aren't touched — orchestration is a root concern

---

## [3.1.1] — 2026-07-29

### Fixed

- `wksp task finish` no longer cries wolf on squash- and rebase-merged PRs. Its merge check was pure git ancestry — "is the branch tip reachable from the default branch?" — but a squash or rebase rewrites the branch into a *new* commit on the default branch, so the tip is never an ancestor. On a squash-merge workflow that meant a `⚠ Not merged into the default branch` on *every* finish, a flat headline that reads like data loss even though the branch really did merge. Finish now confirms merges in tiers, most-authoritative first: git ancestry still catches true merge-commits and fast-forwards, and when it can't, finish asks GitHub. If `gh` is on PATH and the base repo's `origin` is a GitHub remote, it queries the branch's pull request and, on a merged PR whose head commit is the branch's current tip — tying the verdict to this branch, so a since-deleted branch name later reused for other work whose old PR merged long ago can't trigger a false "merged" and delete a branch whose real PR is still open — prints a positive `✓ <branch> merged — PR #N (confirmed on GitHub)` instead of a warning; an open PR is reported plainly as `⚠ PR #N is still open` rather than the squash-merge hedge. `gh` stays entirely optional and feature-detected: if it's missing, offline, errors, or the remote isn't GitHub, finish degrades silently to the last tier. That last-resort warning is reworded from the old verdict to `⚠ Couldn't confirm <branch> is merged — a squash-/rebase-merged PR looks exactly like this even when it merged; verify the PR`, keeping the same y/N confirm before any branch is deleted (the same ancestry blind spot in the archive-restore classifier is noted in the code as a follow-up)

---

## [3.1.0] — 2026-07-28

### Added

- **wksp runs headless.** Until now every way into a task assumed a human at the keyboard: `wksp task create` asks for a branch per repo and ends by handing the terminal to your AI tool. That made the project root a dead end — a planning session there could decide "this should be a task" but couldn't act on it, since it can neither answer readline prompts nor attach to a launch. `create` and `resume` now take flags along three deliberately separate axes: whether wksp asks (`--yes`/`-y`), whether it launches (`--no-launch`), and which answers you supply up front (`--branch <repo>=<branch>` or bare `--branch <branch>` for every repo, `--base`, `--shared <repo>`, `--exclude <repo>`). `--json` implies the first two, so `wksp task create <id> --goal "<one line>" --branch <branch> --json` sets the task folder and worktrees up with no prompts, launches nothing, and prints the task brief on stdout. `--dry-run` shows the plan and creates nothing; `--goal <text>` fills in the `## Goal:` line of the task's `AGENTS.md`, which is how the hub states the handoff contract. Both flag spellings work (`--branch feat/x` and `--branch=feat/x`)
- `wksp task brief <id> [--json]` — everything needed to work in a task without launching a session: the task folder, its instruction file and work log, the project's `AGENTS.md` and `PLANNING.md`, every repo with its mode / branch / path, and the working rules (where changes go, where to log, what belongs in the hub instead). It is the same document `create --json` and `resume --json` return — one shape to learn, versioned as `briefVersion` — and it is what makes hub-driven work possible: a task folder lives under the project root, so a session there can work in a task from its brief exactly as if it had been launched in it
- `wksp start <id>` accepts every headless flag and passes it through, so `wksp start <id> --json` is a convenient "make sure this task exists and tell me about it" call (with `--yes` it also skips the "create it?" confirmation). Non-interactive runs never open the task picker: an ambiguous partial name is an error listing the candidates instead. For a task meant to be *new*, prefer `wksp task create` — `start` matches partial names, so an id that is a substring of an existing task resumes that task and hands back its branch, whereas `create` refuses a taken id outright
- `wksp task repo <id> <repo> worktree --branch <branch>` (plus `--base`) sets a repo's worktree up without the branch prompt, which was the last piece of the task lifecycle an agent couldn't drive — the verb always asked, so pulling a repo into an existing task needed a human. Naming a repo registered `--shared` in `repos.txt` is accepted here, since giving one task its own worktree for a normally-shared repo is exactly what this verb is for. `--yes` covers the `share` and `exclude` modes, and like `delete --yes` it refuses to discard uncommitted work rather than removing a dirty worktree
- `wksp list --json` — machine-readable task inventory (live and archived, honoring `--archived` / `--all`), so an agent can orient itself in a project it didn't create
- `wksp task delete <id> --yes` — non-interactive teardown that is deliberately not a `--force`: it answers the questions whose answer is already implied and refuses the ones that would lose something, never discarding uncommitted changes and never force-deleting a branch with unmerged commits. It keeps the task and says why. `wksp task archive <id> --yes` skips its confirmation too (`finish --yes` already did)
- The project `AGENTS.md` explains how the hub hands work to a task and states which information lives where — `PLANNING.md` and the root work log for anything that outlives a task, the task's `AGENTS.md` and work log for anything that doesn't, with each decision graduating upward exactly once. The full rules, the JSON shape, and a worked loop are in the new [Headless wksp](https://mbarjawi-tech.github.io/wksp/headless) guide

### Changed

- `wksp migrate` schema 4 → 5 adds the headless delegation recipe and the hub/task information boundary to an existing project's root `AGENTS.md`. Those sections are how a planning session *knows* it can create and drive tasks itself, so without the migration the whole feature would ship invisible to every project that already exists — which is why a content-only change earns a schema bump. The step only ever inserts: the block goes in before your `## Cross-cutting conventions` heading, falling back to the next known heading and finally to the end of the file, and your own prose is never rewritten. A project that already documents the flow (including in your own words under that heading) is left alone, and while a real `AGENTS.md` and a real `CLAUDE.md` both still exist at the root — the unresolved 3 → 4 conflict — the step stands down rather than dropping new text into a pending merge. Task instruction files aren't touched; delegation is a root concern

### Fixed

- A headless run now validates the entire plan before touching the filesystem, so it can never leave a half-built task behind. A flag naming a repo that isn't in `repos.txt`, a repo whose path is gone, a branch already checked out in another worktree, two registered repos claiming one folder name, or (on resume) a flag trying to re-disposition a repo that already has a worktree each print the problem plus the flag that fixes it and exit 1 with nothing created
- `wksp` no longer hangs — and then silently gives up — when a prompt has no stdin to read. The promise behind each question never settled on EOF, so Node drained its event loop and exited part-way through: on Windows a piped `wksp task create` would print the branch prompt, exit, and skip the worktree step, which is what made feeding answers through a pipe unusable. It now fails with a message naming the headless flags to use instead. End-of-stdin is latched rather than watched per prompt — readline reports it exactly once, so piping fewer answers than there are questions used to leave the *next* prompt with no event to wait for, hanging in precisely the way the fix was meant to prevent
- Positional arguments were extracted with a naive "doesn't start with `--`" filter, so a flag's value could be mistaken for the task id — `wksp task create --branch feat/x my-task` read the branch as the task name. Flag values are now parsed properly across every `wksp task` subcommand, which matters much more now that these commands get composed by agents
- `--json` output is guaranteed to be the only thing on stdout: progress lines, and git's own worktree chatter, are diverted to stderr for the duration, and failures are emitted as JSON (`{ "ok": false, "error": …, "details": [ … ] }`) so an agent never has to parse prose
- The launch summary said "Launching Claude..." whatever tool was configured; it now names the configured provider, and says nothing when the provider is `none` (which prints its own explanation)
- A repo registered `--optional` can now be pulled into a task at creation time by naming it in a flag (`--branch <optional-repo>=<branch>`), instead of being silently excluded and needing a follow-up `wksp task repo` call

---

## [3.0.0] — 2026-07-22

### Added

- `wksp start [task-id]` — the unified entry point. With no arguments it launches the configured AI tool at the **project root** for a planning session, resuming the last root session (sessions key off the root path, so typing the tool's own command there lands in the same history). With an id it resumes that task — partial names match exactly like `wksp task resume` — or, when nothing matches, offers to create the task (default Yes)
- The project root is now the planning surface: `wksp init` scaffolds `PLANNING.md` (the living feature backlog, open decisions, and research pointers — kept out of the instruction file so backlog content doesn't ride into every task session) and a root `WORKLOG.md`. The root instruction file ships the planning-role guard text (repos are checked out inside tasks, not at the root; when a discussion turns into implementation, create a task) and a docs-structure rule: `PLANNING.md` stays readable in one pass, sections graduate to files under `docs/` when they outgrow a screenful, and everything that moves out leaves a one-line link behind
- `wksp repo add <path> --optional` — a third `repos.txt` flag for repos only some tasks need. Until now such a repo made every new task interrogate you about it (pick branch / share / exclude). An optional repo is excluded from tasks by default: creating or resuming a task records it as excluded silently instead of prompting, and the launch summary shows it as `(optional)`. Pull it into a specific task with the existing `wksp task repo <id> <repo> worktree` (answer `s` at the branch prompt to use it shared instead). The flag shows in `wksp repo list` and `wksp status`, and export bundles carry it as an additive `repos[].isOptionalRepo` field (no bundle version bump) so an imported registration stays optional. The schema 3 → 4 migration refreshes the `repos.txt` header comment to document the flag — data lines are untouched and existing files are already valid, so the flag rides the v4 window without a schema bump of its own

### Changed

- **Breaking:** the reserved `hub` task from v2.8.0 is gone — the project root replaces it as the planning surface. `wksp task create hub` now creates a perfectly normal task, the reserved-name guards on delete/rename are removed, and `wksp init --no-hub` no longer exists. Dogfooding showed the hub was a task pretending not to be one: reserved-name special cases, a never-used `worktrees/` folder, and `wksp task resume hub` as a heavyweight spelling of "start working on my project"
- **Breaking:** instruction files are canonicalized to **`AGENTS.md`**. Scaffolding (init, task create, import) writes the content to `AGENTS.md` and puts a one-line `@AGENTS.md` include in `CLAUDE.md`, so Claude reads the same content while any other tool reads `AGENTS.md` natively (no symlinks — they need elevation on Windows). The `none` provider and the `customProviders` default now report `AGENTS.md` as their instruction file; `claude` keeps `CLAUDE.md`. Task rename now rewrites the `## Task:` heading in `AGENTS.md`
- `wksp migrate` schema 3 → 4 converts existing projects across all three starting states (pre-2.8.0 without a hub, 2.8.0 with `tasks/hub/`, or a user-renamed hub): merges the hub's instruction file into a new root `PLANNING.md` (template boilerplate stripped, user content kept) and its worklog into the root `WORKLOG.md`, removes `tasks/hub/` (unless it still has worktrees — then it warns and leaves it for `--repair`), scaffolds the planning files fresh when there was no hub, and converts every instruction file (root and every task, live and archived) to `AGENTS.md` + include — modernizing unedited 2.8.0 template blocks and never rewriting user prose. Because Claude keys chat history by folder path, the migration also offers — behind a prompt (default Yes), since it touches `~/.claude` — to re-key the hub's session directory to the project root so `wksp start` resumes it; a declined or skipped move stays recoverable via `wksp migrate --repair`, which re-offers even after `tasks/hub/` is gone
- Task bundles now carry the instruction file as `task.agentsMd` (additive field — no bundle version bump). For backward compatibility `task.claudeMd` keeps carrying the same meaningful content, so older wksp versions import new bundles cleanly; importing an older bundle writes `CLAUDE.md` and the schema migration converts it

---

## [2.10.0] — 2026-07-22

### Added

- wksp no longer assumes Claude. A new `aiProvider` config key (global or per-project, project wins; absent means `claude`, so existing setups are untouched) selects which agentic tool `wksp task` launches. Alongside `claude`, wksp ships a `none` provider that launches nothing — it prints the task path and how to enable a tool — used both when you want to opt out of launching and when `wksp init` detects no supported tool on your `PATH` (in which case init pins the project to `none` so `wksp task` fails soft instead of dying on a cryptic spawn error). You can also register your own tools declaratively with a `customProviders` config object (name → `{ command, instructionFile? }`): the `command` is a template with `{dirs}` and `{cwd}` placeholders, formatted exactly like Claude's directory arguments (posix, quoted), and such providers are launch-only (baseline) — no session awareness. A new `wksp providers [--json]` command lists every provider, marks the configured one, shows each one's tier (full when it tracks sessions, baseline otherwise) and instruction file, and flags an unknown or invalid configured name without dying; `--json` emits a stable shape for agent self-checks. Finally, task bundles now record which provider captured a session (`session.provider`): on import, a transcript is restored only when the active provider both understands sessions and matches the one that produced it, and is otherwise skipped with a clear note (bundles made before this field are treated as Claude)

### Changed

- Internal groundwork for supporting agentic tools other than Claude. All of wksp's Claude coupling — the launch flags and `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` env var, the `~/.claude/projects` session store, and the path-encoding that keys transcripts by folder — now lives behind a small provider interface in `lib/providers/`, resolved at call time via `getProvider()`. A provider must implement `launch`, and may optionally expose a `sessions` capability (finding, migrating, reading, and placing transcripts); callers fall back to their existing no-session paths when a provider omits it. This is a pure extraction with no user-facing change in this release — configuration to actually select a different provider comes later

---

## [2.9.0] — 2026-07-22

### Added

- `wksp task finish <id>` (alias: `done`) — an explicit way to close out a merged task. Finishing used to be undefined, and the obvious move backfires: `gh pr merge --delete-branch` run from inside a task worktree merges the PR remotely but then fails locally, because gh tries to check out the default branch and the base repo already holds it. `finish` cleans up from the wksp side instead: it fetches each base repo and verifies the task's branches are merged into the default branch (warning and asking first if any are not — a squash- or rebase-merged PR legitimately shows as unmerged), then runs the normal archive path with branch deletion defaulted (`--keep-branches` opts out), and finally fast-forwards each base repo's default branch — only when that repo is clean and already on it, otherwise it prints the `git pull --ff-only` command and leaves the repo alone. `--force` archives despite uncommitted changes, `--reason <text>` records why (default "finished"), and `--yes`/`-y` skips the confirmations for scripts. Omitting the id drops into the same picker as resume/delete/archive, and partial names match. New task `CLAUDE.md` files now also teach the AI the safe merge pattern — `gh pr merge --repo <owner>/<repo>`, which never touches the local checkout — and to suggest `wksp task finish` once the PR lands

### Fixed

- `wksp task rename` now migrates the task's Claude session history to match the new name. Claude keys transcripts by the task's absolute folder path, so renaming a task used to orphan all of its history — `wksp task resume` and the last-activity column in `wksp status` would then find nothing. Rename now detects the sessions under the old key and, after printing exactly what it will move and asking (default Yes), re-keys the directory under `~/.claude/projects` — touching only this task's two encoded dirs. `--no-migrate-sessions` skips the move (printing the manual command); `--yes`/`-y` auto-confirms for scripts/CI. If a directory already exists under the new key the two are merged: non-colliding sessions are moved across and `memory/` is merged file-by-file preferring the newer copy, never overwriting existing history. If the move can't complete — the folder is locked, or a collision leaves entries behind — rename warns clearly that the affected chat history is still under the old key and may be lost, and prints where it is so you can recover it. The `# Work Log:` heading in `WORKLOG.md` is now renamed too, matching the existing `## Task:` rewrite in `CLAUDE.md`

---

## [2.8.0] — 2026-07-17

### Added

- The **hub** is now a first-class wksp concept — a reserved, worktree-less planning task that holds a project's feature backlog, cross-cutting design, and open decisions. `wksp init` auto-creates a `hub` task (opt out with `wksp init --no-hub`) and its project `CLAUDE.md` now ships a `## wksp vocabulary` block plus a conditional pointer to the hub. Add a hub to an existing project with `wksp task create hub`, which explains what the hub is and asks before creating it; the name is reserved (you can't create a normal task called `hub`), and `delete`/`rename` of the hub warn first. Scaffolding only — no schema bump and no forced backfill, so existing projects are untouched until they opt in

### Fixed

- `wksp export` now includes the task's `WORKLOG.md` in the bundle (`task.worklogMd`), and `wksp import` restores it. Previously the work log was left behind on export and the imported task started with an empty `WORKLOG.md` — the running record of the work was silently lost on handoff. Bundles from older wksp versions (no `worklogMd` field) still import fine: the schema migration backfills an empty `WORKLOG.md` as before

---

## [2.7.0] — 2026-07-07

### Added

- `wksp task resume|delete|archive` no longer needs the full task name. Omit the id to pick from a numbered list of live tasks (sorted by most-recent activity, with worktree count and a relative date), or pass part of a name — e.g. `wksp task resume isa` — and a unique substring match is used; multiple matches drop into the picker, and an exact name always wins. Line-based prompt only, no new dependencies

---

## [2.6.0] — 2026-06-15

### Added

- Each new task now gets a `WORKLOG.md` file — Claude appends a brief entry after each meaningful set of changes, providing a running record of what was done and why
- `wksp migrate` schema 2 → 3: adds a `## Work log` instruction to existing task `CLAUDE.md` files and creates `WORKLOG.md` for tasks that don't have one
- `wksp migrate --repair`: re-applies every migration step even when the project is already stamped at the current schema. Backfills per-task artifacts (e.g. `WORKLOG.md`) that are missing because a task was created by an older wksp or brought in via `wksp import`. Idempotent — only fills in what is missing

### Fixed

- `wksp import` now runs schema migrations on the imported task instead of just stamping the project at the current version. Previously an imported task could be missing the artifacts of its stamped schema (e.g. `WORKLOG.md`), and `wksp migrate` would then report "already up to date" and never create them

---

## [2.5.0] — 2026-06-02

### Removed

- v1 positional syntax for `wksp task` — `wksp task <id>`, `wksp task <id> --del`, `--archive`, `--unarchive`, `--rename`, `--to-shared`, `--to-worktree`, `--to-exclude` no longer work; use the v2 verb-first subcommands (`wksp task create/resume/delete/archive/unarchive/rename/repo`)
- v1 positional syntax for `wksp repo` — `wksp repo <path>` and `wksp repo <path> --remove` no longer work; use `wksp repo add` / `wksp repo remove`
- `wksp cleanup --stale <path>` and `-r` flag no longer work; use `wksp cleanup <path>` and `--recursive`

---

## [2.4.0] — 2026-06-02

### Added

- `wksp export <task-id>` — bundle a task into a portable `.wksp-bundle` file containing project config, repo registrations, branch state, and optionally the Claude session transcript; `--out <file>` to control output path; `--with-session` to include the session
- `wksp import <file>` — read a `.wksp-bundle` and interactively rebuild the project and task; supports creating a new project (Mode 1) or adding the task to an existing project (Mode 2); reconciles repos by remote URL
- `wksp migrate` — detect and apply pending project schema migrations; `--dry-run` flag to preview without writing
- `schemaVersion` field in `.wksp` — written by `wksp init` from v2.2.0 onwards; any wksp command warns and suggests `wksp migrate` when the project schema is outdated
- `wksp repo list` — new subcommand listing all registered repos and their flags
- `wksp cleanup` zero-arg mode — scans all repos registered in the current project (no path required)
- `wksp cleanup --recursive` — prune all first-level subdirectory git repos inside a given path
- `task.json` — replaces `task-shared.txt` + `task-excluded.txt` with a single JSON file per task; existing `.txt` files continue to work (read transparently); `wksp migrate` converts them
- `wksp config clear <key> [--global]` — remove a config key entirely; project-level key reverts to global or built-in default

### Changed

- `wksp cleanup` signature — `--stale` flag is no longer required; new form is `wksp cleanup [<path>] [--recursive]`; old `--stale`/`-r` syntax still works with a deprecation warning
- `CURRENT_SCHEMA_VERSION` bumped from 1 → 2; `wksp migrate` now applies a 1→2 migration that converts legacy `.txt` task files to `task.json`
- `repos.txt` paths are now always written with forward slashes, regardless of how the path was provided or which command registered the repo

### Fixed

- `wksp delete` — no longer crashes with `EBUSY` when run from inside the project folder on Windows; also prints a hint to `cd ..` after the project folder is removed
- `wksp config set` — boolean and numeric values are now stored with their correct JSON type (`false` not `"false"`, `42` not `"42"`); plain strings (e.g. paths) are stored as-is
- `wksp init` next-steps message now shows current v2 syntax (`wksp repo add`, `wksp task create`) instead of old v1 syntax

### Removed

- v1 positional syntax for `wksp repo` (`wksp repo <path>`, `wksp repo <path> --remove`) — use `wksp repo add` / `wksp repo remove` instead
- v1 positional syntax for `wksp task` (`wksp task <id> --del`, `wksp task <id> --archive`, etc.) — use `wksp task delete` / `wksp task archive` etc. instead

---

## [2.1.0] — 2026-05-28

### Added

- `wksp repo add <path-or-url>` — verb-first subcommand for registering a repo (`--shared` flag supported)
- `wksp repo remove <path-or-url>` — verb-first subcommand for removing a repo

### Removed

- `wksp repo --as <alias>` — removed. It allowed registering the same repo twice under a different folder name so two branches could coexist in one task. The correct approach is to check the repo out into two separate physical directories and register each as a distinct path.

### Deprecated

- Old positional syntax (`wksp repo <path>`, `wksp repo <path> --remove`) still works but prints a deprecation warning. Will be removed in v2.2.0.

---

## [1.1.1] — 2026-05-26

### Changed

- `package.json` — added `"license": "MIT"` so npm displays the correct license
- `docs/installation.md` — leads with `npm install -g @mbarjawi-tech/wksp`; moved clone-and-link to a "from source" section for contributors

---

## [1.1.0] — 2026-05-26

### Added

- `wksp --version` / `-v` — print installed version and exit
- Per-command `--help` / `-h` — all commands now accept a help flag
- `wksp task --rename <new-id>` — rename a task in place: renames the folder, workspace file, CLAUDE.md header, and repairs git worktree paths
- `wksp task --to-exclude <repo>` — exclude a repo from a task after creation; reversible with `--to-worktree`
- `wksp repo --as <alias>` — register the same repo twice under different names, each getting its own worktree on a different branch *(removed in v2.1.0)*
- `wksp status [task-id]` — now accepts an optional task-id argument so you can check status from anywhere in the project, not just from inside the task folder
- `.code-workspace` filename is now printed to stdout when a task is created, so you can open it directly
- `wksp config set/get` now support `--global` flag to read/write `~/.wksp` explicitly; project-level values override global

### Changed

- Branch prompt defaults — smarter detection of the repo's default branch
- `wksp config set` outside a project directory now silently saves to global config instead of erroring
- `wksp init` — improved `reposRoot` prompt wording; prompt is skipped if already configured globally
- `wksp --help` output expanded to cover all flags, config keys, and the `WKSP_DEBUG` env var

### Fixed

- Tree diagram whitespace preserved using `<pre>` element in presentation output (#2)

---

## [1.0.0] — 2026-05-01

Initial release.

### Features

- `wksp init` — scaffold a new project with `.wksp`, `repos.txt`, `CLAUDE.md`, and `tasks/`
- `wksp repo` — register local paths or GitHub URLs; `--shared` flag for read-only repos
- `wksp task` — full worktree lifecycle: create, resume, tear down; generates VS Code `.code-workspace` file and launches Claude
- `wksp list` — show live and archived tasks
- `wksp status` — show repo branches and health for the current task
- `wksp cleanup` — prune stale worktree refs from base repos
- `wksp delete` — destroy an entire project with confirmation
- `wksp config` — read/write `reposRoot` and `autoResume` config keys
- Archive/unarchive workflow with branch-state classifier (`present-local`, `merged`, `dangling`, `lost`, etc.)
- Auto-resume last Claude session on `wksp task`
- VitePress documentation site
