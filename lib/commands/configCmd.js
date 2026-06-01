'use strict';
const config = require('../config');

async function run(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
  wksp config set <key> <value>    Write a config value
  wksp config get [key]            Read config values
  wksp config clear <key>          Remove a key (project-level reverts to global or built-in default)

  Options:
    --global                       Read/write ~/.wksp instead of the project .wksp

  Config keys:
    reposRoot    Directory where GitHub repos are cloned (only needed for GitHub URLs)
    autoResume   true (default) to auto-resume the last Claude session; false to prompt

  Examples:
    wksp config set reposRoot /c/dev
    wksp config set reposRoot /c/dev --global
    wksp config set autoResume false
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
      const projectDir = config.findProjectDir();
      if (!projectDir) {
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
      const projectDir = config.findProjectDir();
      if (!projectDir) {
        console.error('  Not inside a wksp project. Use --global to clear a global value.'); process.exit(1);
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
