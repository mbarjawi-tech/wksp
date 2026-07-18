'use strict';
const readline = require('readline');

let rl = null;

function open() {
  if (!rl) rl = readline.createInterface({
    input:    process.stdin,
    output:   process.stdout,
    terminal: false, // never call setRawMode — preserves terminal state for Claude
  });
}

function close() {
  if (rl) { rl.close(); rl = null; }
}

function ask(prompt) {
  return new Promise(resolve => {
    process.stdout.write(prompt);
    rl.once('line', line => resolve(line.trim()));
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

module.exports = { open, close, ask, askRequired, confirm, confirmDefaultYes, confirmTyped };
