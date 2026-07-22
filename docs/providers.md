# AI Providers

wksp launches an agentic coding tool for each task and, for tools it understands deeply, tracks that tool's session history. Historically that tool was always Claude Code. The **provider layer** removes that assumption: which tool wksp launches is now configurable, and wksp ships with more than one built-in.

A *provider* is a small adapter that knows how to launch a tool (and, optionally, where that tool stores its session transcripts). Providers live in `lib/providers/`.

## Support tiers

Providers come in two tiers:

- **baseline** — launch + instruction files only. wksp opens the task's context directories in the tool and scaffolds the instruction file (`CLAUDE.md`). No session awareness: resume always starts a fresh session, `wksp status` falls back to the task folder's modification time for last-activity, `wksp task rename` can't migrate chat history, and `wksp export --with-session` has nothing to capture.
- **full** — everything baseline does, plus **session awareness**: resume the last session, show real last-activity in `wksp status`, migrate transcripts on rename, and export/import session transcripts in a bundle.

Every session feature degrades cleanly on a baseline provider — the feature simply isn't offered, nothing errors.

Built-in providers:

| Provider | Tier | Notes |
|---|---|---|
| `claude` | full | Claude Code. The default. |
| `none` | baseline | Launches nothing — prints the task path and how to enable a tool. Used when no supported tool is detected, or set explicitly to opt out of launching. |

## The `aiProvider` key

`aiProvider` selects the active provider by name. Resolution mirrors `autoResume`: the project `.wksp` overrides the global `~/.wksp`, and an **absent** key means `claude` (so existing setups are unchanged).

```bash
wksp config set aiProvider none              # this project only
wksp config set aiProvider claude --global   # global default
```

The name resolves against the built-ins plus any `customProviders`. An unknown or invalid configured name makes launches fail with a clear error listing the available names; `wksp providers` still runs and flags the problem.

### `wksp init` auto-detection

When you create a project and no `aiProvider` is set anywhere, `wksp init` checks whether `claude` is on your `PATH`. If it isn't, init writes `aiProvider: none` into the project `.wksp` and tells you — so `wksp task` prints the task path instead of dying on a cryptic spawn failure. If `claude` is found, init leaves the key absent (absent already means claude). The check is best-effort and never breaks init offline.

## `wksp providers`

Lists every provider visible in the current context (built-ins first, then custom), marks the configured one with `*`, and shows each provider's kind, tier, and instruction file. Runs inside or outside a project — outside, only global config is consulted.

```bash
wksp providers          # human-readable
wksp providers --json   # machine-readable, for agent self-checks
```

The `--json` shape is stable:

```json
{
  "configured": "claude",
  "providers": [
    {
      "name": "claude",
      "builtin": true,
      "tier": "full",
      "capabilities": { "sessions": true },
      "instructionFile": "CLAUDE.md"
    },
    {
      "name": "none",
      "builtin": true,
      "tier": "baseline",
      "capabilities": { "sessions": false },
      "instructionFile": "CLAUDE.md"
    }
  ]
}
```

## Custom providers (`customProviders`)

You can teach wksp to launch any CLI tool declaratively — no code, no PR — via the `customProviders` config key. Custom providers are always **baseline tier** (launch only). The key maps a provider name to `{ command, instructionFile? }`:

```json
{
  "customProviders": {
    "aider": {
      "command": "aider {dirs}",
      "instructionFile": "CONVENTIONS.md"
    },
    "cursor": {
      "command": "cursor {cwd}"
    }
  }
}
```

`command` is a template string with two optional placeholders, formatted exactly the way the claude provider formats its directory arguments — posix-style and double-quoted:

- `{dirs}` — every context directory (the project dir, the task dir, and each worktree/shared repo), space-joined, each double-quoted.
- `{cwd}` — the task directory, double-quoted.

If a placeholder is absent from your `command`, that data simply isn't passed. There is no resume placeholder: baseline providers have no session awareness, so resume always launches fresh.

`instructionFile` defaults to `CLAUDE.md` if omitted.

To use one, point `aiProvider` at its name:

```bash
wksp config set aiProvider aider
```

Two rules the layer enforces:

- **Built-ins win on collision.** A custom entry named `claude` or `none` is ignored (with a warning in `wksp providers`); the built-in is used.
- **A `command` is required.** An entry without a `command` string is invalid — it shows as a warning in `wksp providers`, and configuring it as the active provider is an error.

### Merge caveat — `customProviders` replaces wholesale

Config merging is a shallow spread (project over global), so a project-level `customProviders` **replaces** the global one entirely rather than merging entry-by-entry. If you keep custom providers globally and also want project-specific ones, repeat the global entries in the project `.wksp`.

## Full-tier support (a PR to wksp)

Baseline support gets a tool launched; **full** support requires code, because session awareness means knowing where the tool stores transcripts and how they're keyed. A full-tier provider is a module in `lib/providers/` whose object adds a `sessions` capability alongside `launch`:

```
sessions: {
  findLast(taskDir)                       -> { id, mtime } | null
  dirsFor(oldTaskDir, newTaskDir[, base]) -> { from, to, sessionCount, targetExists }
  migrate(from, to)                       -> { moved, merged, sessionCount, warnings }
  readTranscript(taskDir, sessionId)      -> string | null
  placeTranscript(taskDir, sessionId, content)
}
```

`lib/providers/claude.js` is the reference implementation of this contract. Adding a full-tier provider means implementing that module, registering it in `lib/providers/index.js`'s `BUILTINS`, and opening a pull request to wksp.

### Contribution prompt

Hand the following to an AI coding agent working in a checkout of wksp to draft a new full-tier provider:

```text
You are adding a new full-tier AI provider to the wksp CLI (Node.js, CommonJS, zero runtime deps).

Reference implementation: lib/providers/claude.js
Contract + tiers: docs/providers.md

Task:
1. Create lib/providers/<name>.js exporting a provider object:
   { name: '<name>', instructionFile: 'CLAUDE.md', launch, sessions: { findLast, dirsFor, migrate, readTranscript, placeTranscript } }
   - launch(dirs, cwd, resumeId): spawn the tool with the context dirs added and resume the given session id when set. Reuse lib/providers/spawn.js for the shell/spawn.
   - sessions.*: mirror claude.js exactly, but pointed at wherever THIS tool stores its session transcripts and however it keys them (claude keys by an encoded absolute folder path under ~/.claude/projects).
2. Register it in lib/providers/index.js BUILTINS.
3. Add unit tests mirroring tests/unit/providers-claude.test.js, and confirm `wksp providers --json` reports it with "tier": "full".
4. Keep 'use strict', two-space CLI output, and the comment voice of the surrounding files. No new dependencies.

Tell me which files you changed and why, and paste the `wksp providers --json` output showing the new provider.
```
