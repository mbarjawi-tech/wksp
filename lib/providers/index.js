'use strict';

// Registry of built-in agentic-tool providers. Keyed by provider id (name).
const BUILTINS = {
  claude: require('./claude'),
};

// Resolve the active provider. Phase A always returns the Claude provider, so
// behavior is unchanged. Phase B will make this config-resolved (an `aiProvider`
// key selecting from BUILTINS). Callers must invoke getProvider() at call time
// inside their handlers — never cache the result at module load — so Phase B can
// resolve it per project config.
function getProvider() {
  return BUILTINS.claude;
}

module.exports = { BUILTINS, getProvider };

