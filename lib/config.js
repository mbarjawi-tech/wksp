'use strict';
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { samePathEitherForm } = require('./paths');

const GLOBAL_CONFIG          = path.join(os.homedir(), '.wksp');
const PROJECT_MARKER         = '.wksp';
const CURRENT_SCHEMA_VERSION = 7;

// A UTF-8 BOM in front of the JSON is not exotic on Windows: PowerShell's `>` and
// `Out-File` write one by default, so any hand-edited `.wksp` can pick one up. `JSON.parse`
// throws on it, which for a project marker used to mean the project silently stopped
// existing. Strip it wherever a `.wksp` is parsed.
function stripBom(text) {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

function readJson(filePath) {
  try { return JSON.parse(stripBom(fs.readFileSync(filePath, 'utf8'))); }
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
  let parsed;
  try { parsed = JSON.parse(stripBom(fs.readFileSync(markerPath, 'utf8'))); }
  catch { return false; }  // missing, unreadable, a directory, or not JSON
  // The global-config check runs AFTER the read, not before. It answers the same either
  // way — a marker we cannot read is not a project marker regardless — but it now costs
  // a realpath, and findProjectDir asks this question at every level of its walk up to
  // the filesystem root, almost always about a `.wksp` that does not exist. Reading
  // first means only a `.wksp` that is really there pays for the comparison.
  //
  // Either-form, because this is a guard: `markerPath` is built by walking up from the
  // cwd, so it carries whatever spelling the shell handed us, while GLOBAL_CONFIG is
  // built from os.homedir(). On a machine whose username is over 8 characters those are
  // two different strings for `~/.wksp`, and a raw string comparison would let the global
  // config through as a project marker — putting `wksp delete` back in front of the home
  // directory, the exact hole PLANNING #21 closed.
  if (samePathEitherForm(markerPath, GLOBAL_CONFIG)) return false;
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

// Every rejection above is silent — resolution just keeps walking — which leaves "there is
// a .wksp here but it is not a project marker" indistinguishable from "there is no .wksp
// anywhere". Those are very different problems: the first is one bad file away from working
// (a cleared or mistyped `name`, a BOM, a hand-edit that lost a key), and with nothing said
// about it the only diagnosis available from the CLI is the wrong one.
//
// So the "not inside a wksp project" errors carry one extra line naming the first candidate
// rejected for SHAPE. The global config is deliberately NOT reported: `~/.wksp` is skipped
// on every run from anywhere under the home directory, and that is business as usual, not a
// diagnosis. Resolution itself is unchanged — this only reads.
function rejectedMarkerDir(from) {
  let dir = path.resolve(from || process.cwd());
  while (true) {
    const marker = path.join(dir, PROJECT_MARKER);
    if (isProjectMarker(marker)) return null;                                 // a real project — nothing to explain
    // existsSync first, same reason as isProjectMarker: the realpath comparison is only
    // worth paying for once a `.wksp` is actually there.
    if (fs.existsSync(marker) && !samePathEitherForm(marker, GLOBAL_CONFIG)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// The line itself, or null when there is nothing worth saying. Indented to sit under the
// `  Error: ` prefix its callers print.
function noProjectHint(from) {
  const dir = rejectedMarkerDir(from);
  if (!dir) return null;
  return `         A ${PROJECT_MARKER} exists at ${dir} but is not a project marker `
       + `(a project marker carries a non-empty "name").`;
}

function printNoProjectHint(from) {
  const hint = noProjectHint(from);
  if (hint) console.error(hint);
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
  findProjectDir, isProjectMarker, noProjectHint, printNoProjectHint,
  readProjectConfig, writeProjectConfig, setProjectConfig,
  readConfig,
};
