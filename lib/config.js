'use strict';
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { samePath } = require('./paths');

const GLOBAL_CONFIG          = path.join(os.homedir(), '.wksp');
const PROJECT_MARKER         = '.wksp';
const CURRENT_SCHEMA_VERSION = 7;

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return {}; }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

function readGlobalConfig() {
  const cfg = readJson(GLOBAL_CONFIG);
  // migrate cloneRoot → reposRoot transparently
  if (cfg.cloneRoot && !cfg.reposRoot) {
    cfg.reposRoot = cfg.cloneRoot;
    delete cfg.cloneRoot;
    writeJson(GLOBAL_CONFIG, cfg);
  }
  return cfg;
}
function writeGlobalConfig(data)   { writeJson(GLOBAL_CONFIG, data); }

function setGlobalConfig(key, value) {
  const cfg = readGlobalConfig();
  cfg[key] = value;
  writeGlobalConfig(cfg);
}

// The global config (`~/.wksp`) and a project marker (`<project>/.wksp`) share a
// filename, so "a file called .wksp exists here" is not enough to call a directory a
// project — from anywhere under the home directory the walk below used to stop at the
// home directory itself and hand it back as the project. Two independent checks, because
// neither alone closes the hole:
//
//  1. The global config path itself is never a marker. EXACT path only — a real project
//     living inside the home directory (~/projects/foo/.wksp) is a normal setup and must
//     still resolve, so this must not become "anything under ~".
//  2. The content has to look like a project. Every wksp version has written `name` into
//     a project marker — the very first release wrote `{ name }` and nothing else, with
//     `schemaVersion` only arriving later — so `name` is the most lenient key that still
//     tells a project marker from the global config, which has never had one. Requiring
//     `schemaVersion` too would orphan pre-schema projects; requiring nothing would
//     accept an empty `{}` global config (reachable via `wksp config clear --global`),
//     and accepting `schemaVersion` alone would accept a global config this very bug has
//     already corrupted, since `migrate` writes `schemaVersion` but never `name`.
//
// Unparseable content means "not a project", not a crash.
function isProjectMarker(markerPath) {
  if (samePath(markerPath, GLOBAL_CONFIG)) return false;
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(markerPath, 'utf8')); }
  catch { return false; }  // missing, unreadable, a directory, or not JSON
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  return typeof parsed.name === 'string' && parsed.name.trim() !== '';
}

function findProjectDir(from) {
  let dir = path.resolve(from || process.cwd());
  while (true) {
    // Keep walking up past a rejected candidate rather than giving up on it: a project
    // may well sit above a stray or foreign .wksp.
    if (isProjectMarker(path.join(dir, PROJECT_MARKER))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readProjectConfig(projectDir)       { return readJson(path.join(projectDir, PROJECT_MARKER)); }
function writeProjectConfig(projectDir, data){ writeJson(path.join(projectDir, PROJECT_MARKER), data); }

function setProjectConfig(projectDir, key, value) {
  const cfg = readProjectConfig(projectDir);
  cfg[key] = value;
  writeProjectConfig(projectDir, cfg);
}

// Effective config: project-level keys override global ones.
// Consumers should call this instead of readGlobalConfig() when a project context is available.
function readConfig(projectDir) {
  const global  = readGlobalConfig();
  const project = projectDir ? readProjectConfig(projectDir) : {};
  return { ...global, ...project };
}

module.exports = {
  GLOBAL_CONFIG, PROJECT_MARKER, CURRENT_SCHEMA_VERSION,
  readGlobalConfig, writeGlobalConfig, setGlobalConfig,
  findProjectDir, isProjectMarker, readProjectConfig, writeProjectConfig, setProjectConfig,
  readConfig,
};
