# wksp

Workspace CLI for Claude Code. Manage multi-repo development with git worktrees — each task gets its own isolated set of branches, so you can work on multiple features simultaneously without ever branch-switching.

wksp defaults to Claude but is AI-tool-agnostic: point the `aiProvider` config key at another built-in or a custom launcher (see [docs/providers.md](docs/providers.md)).

## Install

```bash
npm install -g @mbarjawi-tech/wksp
```

Or install from source:

```bash
git clone https://github.com/mbarjawi-tech/wksp
cd wksp
npm install
npm link
```

## Quick start

```bash
# Create a project
wksp init acme
cd acme

# Register repos
wksp repo add /c/dev/backend
wksp repo add /c/dev/frontend
wksp repo add /c/dev/company-docs --shared
wksp repo add /c/dev/scratch-tools --optional

# Start a task — prompts for branches, creates worktrees, launches Claude
wksp start PROJ-1234
```

At the branch prompt, press Enter to use the current branch, type a branch name to create or check out one, `s` to use the repo shared (no worktree), or `x` to exclude the repo from this task. Repos registered `--optional` are never prompted for — they start excluded from every task, and a task that needs one pulls it in with `wksp task repo <id> <repo> worktree`.

The project root is the **planning hub**: `PLANNING.md` holds the feature backlog and open decisions, `ORCHESTRATION.md` holds the hub-only guidance (delegation, PR review, [stacked PRs](docs/stacked-prs.md), agent-honored settings) that would otherwise ride into every task session, and `wksp start` (no arguments) launches a planning session right there — no worktrees, no task ceremony. Instruction files are canonicalized to `AGENTS.md`; Claude reads them through a one-line `CLAUDE.md` include. See [docs/concepts.md](docs/concepts.md#key-vocabulary).

## Headless (driving wksp from an AI session)

A task folder lives under the project root, so a planning session at the root can set a task up and work in it without launching a second session:

```bash
# no prompts, no launch — prints the task brief as JSON on stdout
wksp task create PROJ-1234 --goal "Fix timezone drift" --branch feat/tz --json

wksp task brief PROJ-1234           # reprint that context any time
wksp task finish PROJ-1234 --yes    # verify merged, archive, ff the base repos
```

Prompting (`--yes`) and launching (`--no-launch`) are separate switches; `--json` implies both. A headless run validates the whole plan before touching anything, so a bad flag never leaves a half-built task. See [docs/headless.md](docs/headless.md) — it also spells out which information belongs in the hub and which belongs in a task, and [docs/stacked-prs.md](docs/stacked-prs.md) for chaining a batch of overlapping work into a stack.

## Documentation

The docs live in `docs/` as Markdown and are powered by [VitePress](https://vitepress.dev).

**Browse locally** (hot-reloads on file changes):
```bash
npm run docs:dev        # serves at http://localhost:5173
```

**Build a static site** (for deployment):
```bash
npm run docs:build      # output → docs/.vitepress/dist/
npm run docs:preview    # serve the built output to verify before deploy
```

The `dist/` folder is a self-contained static site — drop it on GitHub Pages, Netlify, Vercel, or any CDN. For GitHub Pages, point it at the `dist/` output or use a `gh-pages` action.

Markdown source files:
- [docs/concepts.md](docs/concepts.md) — what wksp is and how git worktrees work
- [docs/installation.md](docs/installation.md) — prerequisites, setup, config
- [docs/reference.md](docs/reference.md) — all commands, flags, and file formats
- [docs/headless.md](docs/headless.md) — driving wksp from an AI session; hub vs. task information
- [docs/stacked-prs.md](docs/stacked-prs.md) — when to stack PRs and how to drive a stack
- [docs/examples/](docs/examples/) — five progressive examples

VitePress config: `docs/.vitepress/config.mts`

## Testing

```bash
npm test
```

Unit tests (`tests/unit/`) run in milliseconds. Integration tests (`tests/integration/`) use real temporary git repos and take ~60 s on Windows.
