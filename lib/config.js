'use strict';
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const GLOBAL_CONFIG          = path.join(os.homedir(), '.wksp');
const PROJECT_MARKER         = '.wksp';
const CURRENT_SCHEMA_VERSION = 3;

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

function findProjectDir(from) {
  let dir = path.resolve(from || process.cwd());
  while (true) {
    if (fs.existsSync(path.join(dir, PROJECT_MARKER))) return dir;
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
  findProjectDir, readProjectConfig, writeProjectConfig, setProjectConfig,
  readConfig,
};
