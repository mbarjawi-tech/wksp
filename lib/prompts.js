'use strict';
const readline = require('readline');

let rl = null;

function open() {
  if (!rl) rl = readline.createInterface({ input: process.stdin, output: process.stdout });
}

function close() {
  if (rl) { rl.close(); rl = null; }
}

function ask(prompt) {
  return new Promise(resolve => rl.question(prompt, a => resolve(a.trim())));
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

async function confirmTyped(prompt, expected) {
  const a = await ask(prompt);
  return a === expected;
}

module.exports = { open, close, ask, askRequired, confirm, confirmTyped };
