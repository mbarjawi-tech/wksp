'use strict';
const readline = require('readline');

let rl = null;
// Latched once stdin runs out. Readline fires 'close' exactly once, so a prompt
// that starts *after* the stream ended would never see the event — with only a
// per-prompt listener, piping fewer answers than there are questions still hung
// on the next one. The flag makes every later prompt fail fast instead.
let ended = false;

function open() {
  if (!rl) {
    ended = false;
    rl = readline.createInterface({
      input:    process.stdin,
      output:   process.stdout,
      terminal: false, // never call setRawMode — preserves terminal state for Claude
    });
    rl.on('close', () => { ended = true; });
  }
}

function close() {
  if (rl) { rl.close(); rl = null; }
}

// Reject rather than hang when stdin has nothing left to give. Without this the
// promise simply never settles, so Node drains the event loop and exits — which is
// how a piped or agent-driven run used to abandon a task half-created (the branch
// prompt swallowed, the worktree never made). Headless callers get a flag hint.
const EOF_MESSAGE = [
  'wksp needed an answer but stdin is closed (non-interactive run).',
  '     Pass the answers as flags instead, e.g.:',
  '       wksp task create <id> --branch <branch> --yes --no-launch',
  '     See `wksp task --help` for the full set.',
].join('\n');

function ask(prompt) {
  if (ended) return Promise.reject(new Error(EOF_MESSAGE));
  return new Promise((resolve, reject) => {
    process.stdout.write(prompt);
    const onLine  = line => { rl.off('close', onClose); resolve(line.trim()); };
    const onClose = ()   => { rl.off('line', onLine);   reject(new Error(EOF_MESSAGE)); };
    rl.once('line', onLine);
    rl.once('close', onClose);
  });
}

async function askRequired(prompt) {
  let answer = '';
  while (!answer) {
    answer = await ask(prompt);
    if (!answer) console.log('  (required)');
  }
  return answer;
}

async function confirm(prompt) {
  const a = await ask(`${prompt} [y/N]: `);
  return a.toLowerCase() === 'y';
}

// Like confirm, but defaults to Yes (Enter / anything but n/no → true).
async function confirmDefaultYes(prompt) {
  const a = (await ask(`${prompt} [Y/n]: `)).toLowerCase();
  return a !== 'n' && a !== 'no';
}

async function confirmTyped(prompt, expected) {
  const a = await ask(prompt);
  return a === expected;
}

module.exports = { open, close, ask, askRequired, confirm, confirmDefaultYes, confirmTyped, EOF_MESSAGE };
