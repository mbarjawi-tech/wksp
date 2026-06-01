'use strict';
const config = require('../config');

// Keys whose values are arrays — `config set` appends to them rather than replacing.
const ARRAY_KEYS = new Set(['sharedDeps']);

async function run(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
  wksp config set <key> <value>    Write a config value
  wksp config get [key]            Read config values

  Options:
    --global                       Read/write ~/.wksp instead of the project .wksp

  Config keys:
    reposRoot    Directory where GitHub repos are cloned (only needed for GitHub URLs)
    autoResume   true (default) to auto-resume the last Claude session; false to prompt
    sharedDeps   Dep directories shared across worktrees via symlinks (e.g. node_modules)
                 Pass one or more names; each is appended to the list.
                 To clear: wksp config set sharedDeps --clear

  Examples:
    wksp config set reposRoot /c/dev
    wksp config set reposRoot /c/dev --global
    wksp config set autoResume false
    wksp config set sharedDeps node_modules
    wksp config set sharedDeps node_modules .venv
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
  const isClear  = flags.has('--clear');

  if (sub === 'set') {
    if (!key || (!isClear && value === undefined)) {
      console.error('  Usage: wksp config set <key> <value> [--global]'); process.exit(1);
    }

    const projectDir = isGlobal ? null : config.findProjectDir();

    const doSet = (val) => {
      if (isGlobal || !projectDir) {
        config.setGlobalConfig(key, val);
        const where = isGlobal ? '~/.wksp' : '~/.wksp (no project found — saved globally)';
        console.log(`  ✓  ${where}: ${key} = ${JSON.stringify(val)}`);
      } else {
        config.setProjectConfig(projectDir, key, val);
        console.log(`  ✓  .wksp: ${key} = ${JSON.stringify(val)}`);
      }
    };

    if (ARRAY_KEYS.has(key)) {
      // Array keys: append entries rather than replacing.
      if (isClear) {
        doSet([]);
      } else {
        const entries = posArgs.slice(2);  // everything after the key
        const existing = (() => {
          const cfg = isGlobal || !projectDir
            ? config.readGlobalConfig()
            : config.readConfig(projectDir);
          const v = cfg[key];
          return Array.isArray(v) ? v : [];
        })();
        const merged = [...new Set([...existing, ...entries])];
        doSet(merged);
      }
    } else {
      // Scalar keys: parse JSON so false/true/numbers get the right type.
      let parsedValue = value;
      try { parsedValue = JSON.parse(value); } catch {}
      doSet(parsedValue);
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
    process.exit(1);
  }
}

module.exports = { run };
