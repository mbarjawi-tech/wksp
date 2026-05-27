'use strict';
const { execSync } = require('child_process');
const path = require('path');

const bin = path.resolve(__dirname, '../../bin/wksp.js');
const pkg = require('../../package.json');

function runBin(args) {
  return execSync(`node "${bin}" ${args}`, { encoding: 'utf8' }).trim();
}

describe('wksp --version', () => {
  test('--version prints the package version', () => {
    expect(runBin('--version')).toBe(pkg.version);
  });

  test('-v prints the package version', () => {
    expect(runBin('-v')).toBe(pkg.version);
  });
});
