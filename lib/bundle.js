'use strict';
const fs = require('fs');

const BUNDLE_VERSION = 1;
const BUNDLE_EXT     = '.wksp-bundle';

function readBundle(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); }
  catch (e) { throw new Error(`Cannot read bundle file: ${e.message}`); }

  let bundle;
  try { bundle = JSON.parse(raw); }
  catch (e) { throw new Error(`Bundle is not valid JSON: ${e.message}`); }

  if (typeof bundle.bundleVersion !== 'number') {
    throw new Error('Invalid bundle: missing bundleVersion field.');
  }
  if (bundle.bundleVersion > BUNDLE_VERSION) {
    throw new Error(
      `This bundle was created with a newer version of wksp (bundleVersion ${bundle.bundleVersion}). ` +
      `Update wksp and try again.`
    );
  }
  if (!bundle.project || !bundle.task) {
    throw new Error('Invalid bundle: missing required fields (project, task).');
  }
  return bundle;
}

function writeBundle(filePath, bundle) {
  fs.writeFileSync(filePath, JSON.stringify(bundle, null, 2) + '\n', 'utf8');
}

function defaultBundleFileName(projectName, taskId) {
  return `${projectName}--${taskId}${BUNDLE_EXT}`;
}

module.exports = { BUNDLE_VERSION, BUNDLE_EXT, readBundle, writeBundle, defaultBundleFileName };
