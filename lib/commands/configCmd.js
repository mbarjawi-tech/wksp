'use strict';
const config = require('../config');

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

  Examples:
    wksp config set reposRoot /c/dev
    wksp config set reposRoot /c/dev --global
    wksp config get
    wksp config get reposRoot --global
`);
    process.exit(0);
  }

  const flags  = new Set(args.filter(a => a.startsWith('--')));
  const posArgs = args.filter(a => !a.startsWith('--'));
  const sub    = posArgs[0];
  const key    = posArgs[1];
  const value  = posArgs[2];
  const global = flags.has('--global');

  if (sub === 'set') {
    if (!key || value === undefined) {
      console.error('  Usage: wksp config set <key> <value> [--global]'); process.exit(1);
    }
    if (global) {
      config.setGlobalConfig(key, value);
      console.log(`  ✓  ~/.wksp: ${key} = ${value}`);
    } else {
      const projectDir = config.findProjectDir();
      if (!projectDir) {
        config.setGlobalConfig(key, value);
        console.log(`  ✓  ~/.wksp: ${key} = ${value}  (no project found — saved globally)`);
      } else {
        config.setProjectConfig(projectDir, key, value);
        console.log(`  ✓  .wksp: ${key} = ${value}`);
      }
    }
  } else if (sub === 'get') {
    if (global) {
      const cfg = config.readGlobalConfig();
      if (key) {
        console.log(cfg[key] !== undefined ? cfg[key] : '(not set)');
      } else {
        console.log(JSON.stringify(cfg, null, 2));
      }
    } else {
      const projectDir = config.findProjectDir();
      const cfg = config.readConfig(projectDir || undefined);
      if (key) {
        console.log(cfg[key] !== undefined ? cfg[key] : '(not set)');
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
