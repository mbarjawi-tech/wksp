'use strict';
const config = require('../config');
const { buildCustomProvider } = require('./custom');

// Registry of built-in agentic-tool providers. Keyed by provider id (name).
// `claude` is full-tier (exposes `sessions`); `none` is baseline (launch-only).
const BUILTINS = {
  claude: require('./claude'),
  none:   require('./none'),
};

const DEFAULT_PROVIDER = 'claude';

// The provider tier is derived, not stored: a provider exposing the optional
// `sessions` capability is "full", otherwise "baseline".
function tierOf(provider) {
  return provider && provider.sessions ? 'full' : 'baseline';
}

// Enumerate every provider visible in this context: built-ins first, then any
// `customProviders` entries. Pure/no-throw — this is the shared source of truth
// for both getProvider() (which resolves + errors) and `wksp providers` (which
// lists everything, flagging problems rather than throwing).
//
// Each entry: { name, provider, builtin, valid, warning }.
//   - A custom name colliding with a built-in is dropped: built-in wins, warning set.
//   - A custom entry without a string `command` is kept but marked invalid — it
//     surfaces as a warning when listed and errors only if configured as active.
function describeProviders(projectDir) {
  const cfg = config.readConfig(projectDir);
  const configured = cfg.aiProvider || DEFAULT_PROVIDER;

  const entries = [];
  const seen = new Set();

  for (const [name, provider] of Object.entries(BUILTINS)) {
    entries.push({ name, provider, builtin: true, valid: true, warning: null });
    seen.add(name);
  }

  const custom = cfg.customProviders;
  if (custom && typeof custom === 'object') {
    for (const [name, entry] of Object.entries(custom)) {
      if (seen.has(name)) {
        entries.push({
          name, provider: null, builtin: false, valid: false,
          warning: `custom provider "${name}" is ignored — a built-in provider already uses that name`,
        });
        continue;
      }
      if (!entry || typeof entry.command !== 'string' || entry.command.trim() === '') {
        entries.push({
          name, provider: null, builtin: false, valid: false,
          warning: `custom provider "${name}" is invalid — missing a "command" string`,
        });
        seen.add(name);
        continue;
      }
      entries.push({
        name, provider: buildCustomProvider(name, entry), builtin: false, valid: true, warning: null,
      });
      seen.add(name);
    }
  }

  return { configured, entries };
}

// Resolve the active provider from config. Resolution mirrors `autoResume`:
// readConfig merges global ~/.wksp and project .wksp (project wins). An absent
// `aiProvider` key means claude — byte-for-byte today's behavior.
//
// `projectDir` is optional: without it, only global config is consulted (used by
// callers that have no project context). Throws a clear Error when the configured
// name matches nothing usable — bin/wksp.js prints thrown errors as `Fatal:`.
function getProvider(projectDir) {
  const { configured, entries } = describeProviders(projectDir);
  const match = entries.find(e => e.name === configured);

  if (!match || !match.valid || !match.provider) {
    const available = entries.filter(e => e.valid).map(e => e.name).sort().join(', ');
    if (match && !match.valid) {
      throw new Error(`aiProvider "${configured}" is invalid: ${match.warning}. Available providers: ${available}.`);
    }
    throw new Error(`Unknown aiProvider "${configured}". Available providers: ${available}.`);
  }
  return match.provider;
}

module.exports = { BUILTINS, getProvider, describeProviders, tierOf, DEFAULT_PROVIDER };
