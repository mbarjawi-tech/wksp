'use strict';
const config = require('../config');
const { describeProviders, tierOf } = require('../providers');

// List the AI providers visible in this context (built-ins + any customProviders),
// mark the configured one, and flag anything unusable. Works inside or outside a
// project — outside, only global config is consulted. Never throws on a bad
// configured name: it lists everything and flags the problem instead.
async function run(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
  wksp providers [--json]

  List available AI providers and show which one is configured (aiProvider).

  Options:
    --json    Machine-readable output for agent self-checks
`);
    process.exit(0);
  }

  const asJson     = args.includes('--json');
  const projectDir = config.findProjectDir();
  const { configured, entries } = describeProviders(projectDir || undefined);

  // Shape each entry for output. Invalid entries (bad/colliding custom) carry no
  // provider object — surface them so the user can see why they're not usable.
  const rows = entries.map(e => {
    if (!e.valid || !e.provider) {
      return { name: e.name, builtin: e.builtin, valid: false, warning: e.warning };
    }
    return {
      name:            e.name,
      builtin:         e.builtin,
      valid:           true,
      tier:            tierOf(e.provider),
      capabilities:    { sessions: !!e.provider.sessions },
      instructionFile: e.provider.instructionFile,
    };
  });

  const configuredRow = rows.find(r => r.name === configured);
  const configuredKnown = !!(configuredRow && configuredRow.valid);

  if (asJson) {
    const out = {
      configured,
      providers: rows
        .filter(r => r.valid)
        .map(r => ({
          name:            r.name,
          builtin:         r.builtin,
          tier:            r.tier,
          capabilities:    { sessions: r.capabilities.sessions },
          instructionFile: r.instructionFile,
        })),
    };
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  console.log('\n  AI providers:\n');
  for (const r of rows) {
    if (!r.valid) {
      console.log(`    ${r.name}  (custom, unavailable — ${r.warning})`);
      continue;
    }
    const kind   = r.builtin ? 'built-in' : 'custom';
    const marker = r.name === configured ? '* ' : '  ';
    const active = r.name === configured ? '  (configured)' : '';
    console.log(`  ${marker}${r.name}  [${kind}, ${r.tier}, ${r.instructionFile}]${active}`);
  }

  if (!configuredKnown) {
    console.log(`\n  ⚠  Configured aiProvider "${configured}" is unknown or invalid — no launch will work until you fix it.`);
    console.log(`     Set a valid one:  wksp config set aiProvider <name> [--global]`);
  }
  console.log('');
}

module.exports = { run };
