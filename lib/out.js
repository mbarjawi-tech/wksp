'use strict';

// Output discipline for `--json` runs.
//
// A headless caller parses stdout, but the commands that back it are chatty:
// they log progress, and `git worktree add` writes to stdout itself. So in json
// mode every human-readable line is diverted to stderr and stdout carries exactly
// one JSON document. Nothing else about the code has to know — callers wrap the
// work in `withJsonStdout` and print the document at the end.

// Redirect console.log/warn to stderr for the duration of `fn`. Restores the
// originals even if `fn` throws.
async function withJsonStdout(fn) {
  const log  = console.log;
  const warn = console.warn;
  console.log  = (...a) => console.error(...a);
  console.warn = (...a) => console.error(...a);
  try   { return await fn(); }
  finally { console.log = log; console.warn = warn; }
}

// The child-process stdio for git commands that normally inherit: in json mode
// their stdout is pointed at our stderr (fd 2) so it can't corrupt the document.
function childStdio(jsonMode) {
  return jsonMode ? ['ignore', 2, 2] : 'inherit';
}

// Print a JSON document on stdout. Written directly rather than via console.log
// so it is unaffected by the redirect above.
function printJson(doc) {
  process.stdout.write(JSON.stringify(doc, null, 2) + '\n');
}

// The failure counterpart: a machine-readable error, then exit 1. Keeps agents
// from having to parse prose to find out what went wrong.
function failJson(message, extra = {}) {
  printJson({ ok: false, error: message, ...extra });
  process.exit(1);
}

module.exports = { withJsonStdout, childStdio, printJson, failJson };
