# Installation

## Prerequisites

- **Node.js** — v18 or later (`node --version`)
- **git** — v2.5 or later; worktrees were added in v2.5 (`git --version`)
- **Claude Code CLI** — wksp launches Claude at the end of `wksp task`. Install it from [claude.ai/code](https://claude.ai/code).

## Install

Clone or download the wksp repo, navigate into it, then run:

```bash
npm install   # install dev dependencies (Jest)
npm link      # register `wksp` as a global command
```

`npm link` creates a symlink — edits to the source files take effect immediately without reinstalling.

Verify it works:

```bash
wksp --help
```

## Uninstall

```bash
npm unlink -g wksp
```

This removes the global command. Your source folder and all project data are untouched.

## First-time setup

The first time you add a GitHub repo with `wksp repo <url>`, wksp asks where to clone it:

```
Where should GitHub repos be cloned? (reposRoot): /c/dev
```

This path is saved to `~/.wksp` as `reposRoot`. You can set or change it anytime:

```bash
wksp config set reposRoot /c/dev
wksp config get
```

## Global config

wksp stores two settings in `~/.wksp`:

| Key | Default | Description |
|---|---|---|
| `reposRoot` | — | Directory where GitHub repos are cloned. Prompted on first use. |
| `autoResume` | `true` | When true, `wksp task` automatically resumes the last Claude session so conversation history carries over. Set to `false` to be prompted each time. |

```bash
wksp config set autoResume false
```

## Windows notes

wksp accepts any path format — Windows backslash (`C:\dev\backend`), Windows forward slash (`C:/dev/backend`), or Git Bash POSIX (`/c/dev/backend`). They're all equivalent internally. When passing paths to Claude, wksp converts to POSIX format, which works in both PowerShell and Git Bash.
