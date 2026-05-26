# wksp

Workspace CLI for Claude Code. Manage multi-repo development with git worktrees — each task gets its own isolated set of branches, so you can work on multiple features simultaneously without ever branch-switching.

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
wksp repo /c/dev/backend
wksp repo /c/dev/frontend
wksp repo /c/dev/company-docs --shared

# Start a task — prompts for branches, creates worktrees, launches Claude
wksp task PROJ-1234
```

At the branch prompt, press Enter to use the current branch, type a branch name to create or check out one, `s` to use the repo shared (no worktree), or `x` to exclude the repo from this task.

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
- [docs/examples/](docs/examples/) — five progressive examples

VitePress config: `docs/.vitepress/config.mts`

## Testing

```bash
npm test
```

Unit tests (`tests/unit/`) run in milliseconds. Integration tests (`tests/integration/`) use real temporary git repos and take ~60 s on Windows.
