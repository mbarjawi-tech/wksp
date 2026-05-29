'use strict';
const fs   = require('fs');
const path = require('path');

const TASK_CONFIG_FILE     = 'task.json';
const LEGACY_SHARED_FILE   = 'task-shared.txt';
const LEGACY_EXCLUDED_FILE = 'task-excluded.txt';

// Read { taskSharedSet, taskExcludedSet } from task.json, falling back to legacy .txt files.
function readTaskSets(taskDir) {
  const jsonPath = path.join(taskDir, TASK_CONFIG_FILE);
  if (fs.existsSync(jsonPath)) {
    let data = {};
    try { data = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch {}
    return {
      taskSharedSet:   new Set(data.shared   || []),
      taskExcludedSet: new Set(data.excluded || []),
    };
  }
  // Backward compat: read legacy .txt files
  function readLegacy(file) {
    const f = path.join(taskDir, file);
    if (!fs.existsSync(f)) return new Set();
    return new Set(fs.readFileSync(f, 'utf8').split('\n').map(l => l.trim()).filter(Boolean));
  }
  return {
    taskSharedSet:   readLegacy(LEGACY_SHARED_FILE),
    taskExcludedSet: readLegacy(LEGACY_EXCLUDED_FILE),
  };
}

// Write { taskSharedSet, taskExcludedSet } to task.json and remove legacy .txt files.
function writeTaskSets(taskDir, taskSharedSet, taskExcludedSet) {
  const jsonPath = path.join(taskDir, TASK_CONFIG_FILE);
  const data = {};
  if (taskSharedSet.size   > 0) data.shared   = [...taskSharedSet];
  if (taskExcludedSet.size > 0) data.excluded = [...taskExcludedSet];
  if (Object.keys(data).length === 0) {
    if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);
  } else {
    fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2) + '\n');
  }
  // Remove legacy files when writing
  for (const f of [LEGACY_SHARED_FILE, LEGACY_EXCLUDED_FILE]) {
    const p = path.join(taskDir, f);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

module.exports = {
  TASK_CONFIG_FILE, LEGACY_SHARED_FILE, LEGACY_EXCLUDED_FILE,
  readTaskSets, writeTaskSets,
};
