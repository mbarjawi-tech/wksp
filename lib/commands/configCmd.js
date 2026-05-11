'use strict';
const config = require('../config');

async function run(args) {
  const sub   = args[0];
  const key   = args[1];
  const value = args[2];

  if (sub === 'set') {
    if (!key || value === undefined) {
      console.error('  Usage: wksp config set <key> <value>'); process.exit(1);
    }
    config.setGlobalConfig(key, value);
    console.log(`  ✓  ~/.wksp: ${key} = ${value}`);
  } else if (sub === 'get') {
    const cfg = config.readGlobalConfig();
    if (key) {
      console.log(cfg[key] !== undefined ? cfg[key] : '(not set)');
    } else {
      console.log(JSON.stringify(cfg, null, 2));
    }
  } else {
    console.error('  Usage: wksp config set <key> <value>');
    console.error('         wksp config get [key]');
    process.exit(1);
  }
}

module.exports = { run };
