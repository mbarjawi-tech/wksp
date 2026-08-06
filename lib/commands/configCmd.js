'use strict';
const config = require('../config');

// `name` is not an ordinary setting in a PROJECT marker — it is the marker's identity.
// Resolution tells a project marker from the global config by content, because both files
// are called `.wksp`, and the test is a non-empty string `name` (lib/config.js). So clearing
// it, or setting it to something that isn't a non-empty string (`config set` runs the value
// through JSON.parse, so `42` and `""` arrive as a number and an empty string), makes the
// project stop existing for every command — including `wksp migrate --repair`, which has to
// resolve the project before it can repair anything.
//
// Global scope is deliberately left alone: `wksp config clear name --global` is exactly the
// repair for a global config that has wrongly acquired a `name`.
const IDENTITY_KEY = 'name';

async function run(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
  wksp config set <key> <value>    Write a config value
  wksp config get [key]            Read config values
  wksp config clear <key>          Remove a key (project-level reverts to global or built-in default)

  Options:
    --global                       Read/write ~/.wksp instead of the project .wksp

  Config keys — CLI behaviour (wksp itself acts on these):
    reposRoot        Directory where GitHub repos are cloned (only needed for GitHub URLs)
    autoResume       true (default) to auto-resume the last AI session; false to prompt
    aiProvider       Which AI tool to launch: claude (default) | none | a custom provider name
    customProviders  Object of declarative providers — { "<name>": { "command": "...", ... } }
                     See: wksp providers

  Config keys — agent-honored (wksp NEVER acts on these; the orchestrating agent
  reads them and follows them — see ORCHESTRATION.md at your project root):
    reviewLoop       ask (default) | always | never — run an independent review→fix loop
                     on a coding/behaviour PR before it merges
    prGate           ask | always | never (default never) — pause for a manual test
                     before opening a PR
    mergeMethod      squash (default) | merge | rebase — which merge lands a solo PR
                     (a stack lands via \`gh stack merge\` regardless)

  Every key resolves project .wksp over global ~/.wksp.

  Examples:
    wksp config set reposRoot /c/dev
    wksp config set reposRoot /c/dev --global
    wksp config set autoResume false
    wksp config set reviewLoop always
    wksp config set mergeMethod squash --global
    wksp config clear autoResume          # remove project-level override, fall back to global
    wksp config clear reposRoot --global  # remove global value
    wksp config get
    wksp config get reposRoot --global
`);
    process.exit(0);
  }

  const flags   = new Set(args.filter(a => a.startsWith('--')));
  const posArgs = args.filter(a => !a.startsWith('--'));
  const sub     = posArgs[0];
  const key     = posArgs[1];
  const value   = posArgs[2];
  const isGlobal = flags.has('--global');

  if (sub === 'set') {
    if (!key || value === undefined) {
      console.error('  Usage: wksp config set <key> <value> [--global]'); process.exit(1);
    }
    // Try to parse the value as JSON so booleans, numbers, and arrays are
    // stored with the correct type (e.g. false not "false", 42 not "42").
    // Plain strings that aren't valid JSON (e.g. paths) are stored as-is.
    let parsedValue = value;
    try { parsedValue = JSON.parse(value); } catch {}

    if (isGlobal) {
      config.setGlobalConfig(key, parsedValue);
      console.log(`  ✓  ~/.wksp: ${key} = ${JSON.stringify(parsedValue)}`);
    } else {
      if (key === IDENTITY_KEY && (typeof parsedValue !== 'string' || parsedValue.trim() === '')) {
        console.error(`\n  Error: "${IDENTITY_KEY}" must be a non-empty string — got ${JSON.stringify(parsedValue)}.`);
        console.error('         It is the project marker\'s identity: .wksp is only recognised as a project');
        console.error('         while it carries a non-empty "name". Nothing was changed.\n');
        process.exit(1);
      }
      const projectDir = config.findProjectDir();
      if (!projectDir) {
        // Never let the global fallback write `name`: a `name` in ~/.wksp makes the global
        // config itself project-shaped, and the exact-path check in lib/config.js becomes
        // the only thing still telling the two files apart.
        if (key === IDENTITY_KEY) {
          console.error(`\n  Error: not inside a wksp project — refusing to save "${IDENTITY_KEY}" globally.`);
          config.printNoProjectHint();
          console.error('         "name" is what marks a .wksp as a project marker rather than the global config,');
          console.error('         so a global "name" would make ~/.wksp look like one. Run this inside the project,');
          console.error('         or pass --global if you really do mean the global config.\n');
          process.exit(1);
        }
        config.setGlobalConfig(key, parsedValue);
        console.log(`  ✓  ~/.wksp: ${key} = ${JSON.stringify(parsedValue)}  (no project found — saved globally)`);
      } else {
        config.setProjectConfig(projectDir, key, parsedValue);
        console.log(`  ✓  .wksp: ${key} = ${JSON.stringify(parsedValue)}`);
      }
    }

  } else if (sub === 'clear') {
    if (!key) {
      console.error('  Usage: wksp config clear <key> [--global]'); process.exit(1);
    }
    if (isGlobal) {
      const cfg = config.readGlobalConfig();
      if (!(key in cfg)) {
        console.log(`  ~/.wksp: "${key}" is not set — nothing to clear.`);
      } else {
        delete cfg[key];
        config.writeGlobalConfig(cfg);
        console.log(`  ✓  ~/.wksp: ${key} cleared`);
      }
    } else {
      if (key === IDENTITY_KEY) {
        console.error(`\n  Error: "${IDENTITY_KEY}" cannot be cleared from a project marker — it identifies the project.`);
        console.error('         Without a non-empty "name" the .wksp stops being recognised as a project marker,');
        console.error('         so every command reports "not inside a wksp project" and even');
        console.error('         `wksp migrate --repair` cannot reach it. Nothing was changed.');
        console.error(`         To rename the project instead:  wksp config set ${IDENTITY_KEY} <new-name>\n`);
        process.exit(1);
      }
      const projectDir = config.findProjectDir();
      if (!projectDir) {
        console.error('  Not inside a wksp project. Use --global to clear a global value.');
        config.printNoProjectHint();
        process.exit(1);
      }
      const cfg = config.readProjectConfig(projectDir);
      if (!(key in cfg)) {
        console.log(`  .wksp: "${key}" is not set — nothing to clear.`);
      } else {
        delete cfg[key];
        config.writeProjectConfig(projectDir, cfg);
        console.log(`  ✓  .wksp: ${key} cleared (will fall back to global value or built-in default)`);
      }
    }

  } else if (sub === 'get') {
    if (isGlobal) {
      const cfg = config.readGlobalConfig();
      if (key) {
        console.log(cfg[key] !== undefined ? JSON.stringify(cfg[key]) : '(not set)');
      } else {
        console.log(JSON.stringify(cfg, null, 2));
      }
    } else {
      const projectDir = config.findProjectDir();
      const cfg = config.readConfig(projectDir || undefined);
      if (key) {
        console.log(cfg[key] !== undefined ? JSON.stringify(cfg[key]) : '(not set)');
      } else {
        console.log(JSON.stringify(cfg, null, 2));
      }
    }

  } else {
    console.error('  Usage: wksp config set <key> <value> [--global]');
    console.error('         wksp config get [key] [--global]');
    console.error('         wksp config clear <key> [--global]');
    process.exit(1);
  }
}

module.exports = { run };
