'use strict';
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { toPosix } = require('./paths');

// Encode a Windows path to Claude's project-directory naming convention:
// C:\workspaces\acme\tasks\PROJ-1234 → C--workspaces-acme-tasks-PROJ-1234
function encodeProjectPath(dir) {
  return path.resolve(dir)
    .replace(/^([A-Za-z]):[\\\/]/, (_, d) => `${d.toUpperCase()}--`)
    .replace(/[\\\/]/g, '-');
}

// Root of Claude's per-project storage. Split out so callers (and tests) can
// reason about / inject the base independently of the encoded subdir name.
function claudeBase() {
  return path.join(os.homedir(), '.claude');
}

// Compute the encoded session dirs for a task rename. Pure path math via
// encodeProjectPath — no filesystem mutation. `base` defaults to ~/.claude but
// is injectable for tests. Returns the source/target dirs, how many session
// transcripts (`*.jsonl`) live under the source, and whether the target already
// exists (a collision that would force a merge). Reused later by repo/project move.
function sessionDirsFor(oldTaskDir, newTaskDir, base = claudeBase()) {
  const projects = path.join(base, 'projects');
  const from = path.join(projects, encodeProjectPath(oldTaskDir));
  const to   = path.join(projects, encodeProjectPath(newTaskDir));

  let sessionCount = 0;
  try {
    sessionCount = fs.readdirSync(from).filter(f => f.endsWith('.jsonl')).length;
  } catch { /* source missing → 0 sessions */ }

  let targetExists = false;
  try {
    targetExists = fs.statSync(to).isDirectory();
  } catch { /* target missing */ }

  return { from, to, sessionCount, targetExists };
}

// Move a single entry (file or dir). renameSync first; fall back to a recursive
// copy + remove on EXDEV (cross-device). Throws on any other failure so callers
// can turn it into a warning.
function moveEntry(src, dst) {
  try {
    fs.renameSync(src, dst);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.cpSync(src, dst, { recursive: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

// Merge a `memory/` dir into the target, file by file. Non-colliding files are
// moved across; on a name clash the newer mtime wins but the target file is
// never deleted (only overwritten when the source is strictly newer). Source
// copies are dropped either way so the source dir can be drained afterwards.
function mergeMemory(src, dst, warnings) {
  fs.mkdirSync(dst, { recursive: true });
  let entries;
  try { entries = fs.readdirSync(src, { withFileTypes: true }); }
  catch (e) { warnings.push(`Could not read ${src}: ${e.message}`); return; }

  for (const ent of entries) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    try {
      if (ent.isDirectory()) { mergeMemory(s, d, warnings); continue; }
      if (fs.existsSync(d)) {
        if (fs.statSync(s).mtimeMs > fs.statSync(d).mtimeMs) fs.copyFileSync(s, d);
        fs.rmSync(s, { force: true });
      } else {
        moveEntry(s, d);
      }
    } catch (e) {
      warnings.push(`Could not merge memory/${ent.name}: ${e.message}`);
    }
  }
  try { if (fs.readdirSync(src).length === 0) fs.rmdirSync(src); } catch { /* residue left behind */ }
}

// Move the session dir from → to. Pure filesystem, no prompting, best-effort:
// per-entry failures become warnings and it never throws fatally. Returns
// { moved, merged, sessionCount, warnings }.
//   - No target (≈99% case): mkdir -p parent, then rename (EXDEV → copy+rm).
//   - Target exists (collision): merge — move non-colliding *.jsonl / <uuid>/
//     entries, merge memory/ preferring newer, skip+warn on a true clash. Remove
//     the source dir once drained.
function migrateSessionDir(from, to) {
  const result = { moved: false, merged: false, sessionCount: 0, warnings: [] };

  let entries;
  try { entries = fs.readdirSync(from, { withFileTypes: true }); }
  catch { return result; } // no source → no-op

  result.sessionCount = entries.filter(e => e.isFile() && e.name.endsWith('.jsonl')).length;

  if (!fs.existsSync(to)) {
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      moveEntry(from, to);
      result.moved = true;
    } catch (e) {
      result.warnings.push(`Could not move session dir: ${e.message}`);
    }
    return result;
  }

  // Target exists → merge entry by entry.
  result.merged = true;
  for (const ent of entries) {
    const src = path.join(from, ent.name);
    const dst = path.join(to, ent.name);
    try {
      if (ent.name === 'memory' && ent.isDirectory()) {
        mergeMemory(src, dst, result.warnings);
        continue;
      }
      if (fs.existsSync(dst)) {
        result.warnings.push(`Skipped "${ent.name}" — already exists under the new key`);
        continue;
      }
      moveEntry(src, dst);
    } catch (e) {
      result.warnings.push(`Could not migrate "${ent.name}": ${e.message}`);
    }
  }
  try { if (fs.readdirSync(from).length === 0) fs.rmdirSync(from); } catch { /* residue left behind */ }
  return result;
}

function findLastSession(taskDir) {
  const dir = path.join(os.homedir(), '.claude', 'projects', encodeProjectPath(taskDir));
  if (!fs.existsSync(dir)) return null;
  const latest = fs.readdirSync(dir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => {
      try {
        const stat = fs.statSync(path.join(dir, f));
        return stat.isFile() ? { id: f.slice(0, -6), mtime: stat.mtimeMs } : null;
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime)[0];
  return latest || null;
}

function launch(dirs, cwd, resumeId = null) {
  const parts = ['claude'];
  if (resumeId) parts.push(`--resume ${resumeId}`);
  for (const dir of dirs) {
    parts.push(`--add-dir "${toPosix(dir)}"`);
  }

  // Use bash (via PATH lookup) in Unix-like environments; fall back to the system
  // default (cmd.exe on Windows) everywhere else.
  const shell = process.env.SHELL ? 'bash' : true;
  const env = { ...process.env, CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1' };
  const result = spawnSync(parts.join(' '), [], { stdio: 'inherit', cwd, shell, env });
  process.exit(result.status ?? 0);
}

module.exports = { launch, findLastSession, encodeProjectPath, sessionDirsFor, migrateSessionDir };
