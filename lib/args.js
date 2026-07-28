'use strict';

// Argument splitting shared by the commands that take value-carrying flags.
//
// The naive "anything not starting with -- is positional" filter breaks as soon as
// a flag's value is itself a bare word: `wksp task create --branch feat/x my-task`
// reads "feat/x" as the task id. That was survivable while value flags only ever
// came after the task id; headless runs compose flags in any order, so the value
// flags are declared up front and their arguments are consumed properly.
//
// Both spellings are accepted: `--branch value` and `--branch=value`. Values are
// collected in order, so a repeatable flag keeps every occurrence.
function splitArgs(argv, valueFlags = []) {
  const consumesValue = new Set(valueFlags);
  const positionals = [];
  const flags       = new Set();
  const values      = new Map();

  function addValue(flag, value) {
    if (!values.has(flag)) values.set(flag, []);
    values.get(flag).push(value);
  }

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { positionals.push(a); continue; }

    const eq = a.indexOf('=');
    if (eq > 2) {
      const flag = a.slice(0, eq);
      flags.add(flag);
      if (consumesValue.has(flag)) addValue(flag, a.slice(eq + 1));
      continue;
    }

    flags.add(a);
    if (consumesValue.has(a)) {
      const next = argv[i + 1];
      if (next !== undefined) { addValue(a, next); i++; }
    }
  }

  return { positionals, flags, values };
}

// Read a repeatable `<repo>=<value>` flag into { map, fallback }: `--branch api=feat/x`
// targets one repo, while the bare `--branch feat/x` form applies to every repo not
// named individually. The last bare occurrence wins.
function parseRepoMap(values) {
  const map = new Map();
  let fallback = null;
  for (const raw of values || []) {
    const eq = raw.indexOf('=');
    if (eq > 0) map.set(raw.slice(0, eq), raw.slice(eq + 1));
    else        fallback = raw;
  }
  return { map, fallback };
}

module.exports = { splitArgs, parseRepoMap };
