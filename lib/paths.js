'use strict';
const fs   = require('fs');
const path = require('path');
const os   = require('os');

function toPosix(p) {
  const resolved = path.resolve(p);
  if (process.platform === 'win32') {
    const m = resolved.match(/^([A-Za-z]):(.*)/);
    if (m) return '/' + m[1].toLowerCase() + m[2].replace(/\\/g, '/');
  }
  return resolved;
}

function normalizePath(p) {
  p = p.trim();
  if (process.platform === 'win32' && /^\/[a-zA-Z]\//.test(p)) {
    p = p[1].toUpperCase() + ':' + p.slice(2);
  }
  return path.resolve(p);
}

// Containment test for the teardown guards: true when `child` IS `parent` or sits
// anywhere under it.
//
// path.relative does the platform-correct comparison for free — case-insensitive on
// win32, case-sensitive elsewhere — and unlike comparing the two strings with
// startsWith it can't be fooled by a sibling that shares a prefix: …/tasks/foo-bar
// relative to …/tasks/foo is "../foo-bar", which is outside. Only a leading ".."
// SEGMENT means outside (a real directory named "..foo" is inside), and a different
// Windows drive makes relative() hand back an absolute path.
function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  if (rel === '')             return true;   // the same directory
  if (path.isAbsolute(rel))   return false;  // different root / drive letter
  return rel.split(path.sep)[0] !== '..';
}

// True when both paths name the same directory, with the same platform-correct
// casing rules as isInside.
function samePath(a, b) {
  return path.relative(path.resolve(a), path.resolve(b)) === '';
}

// ─── canonicalisation ─────────────────────────────────────────────────────────
//
// isInside/samePath above compare RESOLVED paths — path.resolve only cleans up
// "..", separators and a relative prefix. It cannot tell that two different
// strings name the same directory on disk, and on Windows one directory routinely
// has several names:
//
//   C:\Users\RUNNER~1\...   the 8.3 short name, which Windows generates for any
//                           component longer than 8 characters (or containing a
//                           space) — %TEMP% is served this way on the GitHub
//                           Windows runner, and on any machine whose username is
//                           longer than 8 characters
//   C:\Users\runneradmin\.. the long name, which is what git reports
//
// git always reports the long form, so every comparison between "the path wksp
// built" and "the path git just told us about" is a comparison between two
// spellings of one directory. Left uncanonicalised those comparisons are simply
// wrong, and a safety guard that compares paths wrongly is a guard that does not
// guard (see the git.js / repo.js / archive.js call sites, and PLANNING #25).
//
// NOTE fs.realpathSync — the JS implementation — does NOT expand 8.3 short names;
// it hands `C:\Users\RUNNER~1\x` straight back. Only fs.realpathSync.native does,
// which is why the previous "compare the resolved forms too" fallback in
// teardown-guard.js silently did nothing for exactly the case it named.
function realpathOf(p) {
  // .native resolves 8.3 short names, junctions and symlinks; it has existed since
  // Node 9.2 but is guarded anyway because it is documented as platform-dependent.
  const native = fs.realpathSync.native;
  if (typeof native === 'function') {
    try { return native(p); }
    catch (e) {
      // A path that is not there is not there for either implementation, so rethrow
      // rather than paying for a second failure — and the JS one is expensive to
      // fail: it lstat-walks the whole path and builds a stack trace, ~1.7ms against
      // ~0.07ms for native, on a call this makes for every path that does not exist
      // yet. The fallback is for native failing for some OTHER reason.
      if (e && e.code === 'ENOENT') throw e;
      /* otherwise fall through to the JS implementation */
    }
  }
  return fs.realpathSync(p);
}

// The canonical, on-disk name of `p`: 8.3 short components expanded, junctions and
// symlinks followed, casing as the filesystem stores it.
//
// NEVER THROWS, and non-existent paths are the normal case, not an error — wksp
// spends most of its time reasoning about paths BEFORE it creates them (the
// worktree directory it is about to add, the archive folder it is about to rename
// into). When `p` itself cannot be resolved, the deepest ancestor that CAN be is
// canonicalised and the remaining tail re-attached, so a not-yet-created directory
// under a short-named parent still canonicalises correctly. If even the root cannot
// be read, the plain resolved path comes back.
//
// DELIBERATELY NOT MEMOISED. A cache here looks free and is not: Windows RECYCLES 8.3
// aliases. Delete `…\Temp\wksp-project-aaa` (whose alias is `WKSP-P~1`) and the next
// `…\Temp\wksp-project-bbb` is handed `WKSP-P~1` in turn — so a cached entry does not
// merely age, it starts naming a different directory, which is precisely the class of
// wrong answer this whole change exists to remove. wksp deletes and creates
// directories constantly (every teardown, every probe), and validating a cache entry
// costs the same syscall as just resolving it, so a validated cache saves nothing and
// an unvalidated one is a latent bug. The uncached cost is a realpath per comparison
// — tens of microseconds — against loops bounded by the number of worktrees in a
// project; where a loop compares many paths against ONE fixed path, the caller hoists
// that side's canonicalPath out of the loop instead (see lib/commands/repo.js).
function canonicalPath(p) {
  return canonicalizeResolved(path.resolve(p));
}

function canonicalizeResolved(resolved) {
  try {
    return realpathOf(resolved);
  } catch (e) {
    // Only "this path is not there" is worth walking up for. ENOENT (a component that
    // does not exist) and ENOTDIR (a file where a directory was expected) are the
    // not-yet-created case this function is built around, and the ancestor above them
    // may well resolve. Anything else — EACCES, EPERM, UNKNOWN, EBUSY — is a property
    // of the volume or the permissions, not of this component: the ancestor fails the
    // same way, so retrying once per level buys nothing and costs a syscall per level.
    if (!e || (e.code !== 'ENOENT' && e.code !== 'ENOTDIR')) return resolved;
    const parent = path.dirname(resolved);
    // A root maps to itself, which would otherwise recurse forever.
    if (parent === resolved) return resolved;
    return path.join(canonicalizeResolved(parent), path.basename(resolved));
  }
}

// IDENTITY / LOOKUP comparison: "is the directory git (or the registry, or a
// manifest) is telling me about the same one I am holding?" There is exactly one
// right answer, the two strings are two spellings of it, so the CANONICAL forms decide
// it. Treating a literal spelling that canonicalises elsewhere as a match would only add
// false positives to a question that has a definite answer.
//
// The literal comparison is a pure FAST PATH, not a second semantics: samePath(a, b)
// means the two resolve to one string, and one string canonicalises to one answer, so
// a literal match is already a canonical match — existent, non-existent, or differing
// only in case on win32. Skipping the two realpath syscalls when it hits therefore
// cannot change an answer, and it is worth having because those syscalls are not
// always cheap: addRepo compares the incoming path against every existing entry
// (lib/repos.js), and an entry naming an unreachable UNC share blocks
// realpathSync.native on SMB name resolution for seconds per call. It bounds the
// common case rather than removing that cost — an entry the spellings disagree on is
// still canonicalised, because there the fast path cannot answer.
function samePathCanonical(a, b) {
  return samePath(a, b) || samePath(canonicalPath(a), canonicalPath(b));
}

// GUARD comparison for CONTAINMENT: deliberately NOT the lookup comparison, and
// deliberately more eager.
//
// A guard's failure modes are not symmetric. Matching when it should not costs a
// refusal the user works around by cd'ing somewhere else; failing to match costs a
// deleted worktree. So this answers true when EITHER form matches:
//
//   · the LITERAL form catches a junction that points OUT of the task folder — the
//     canonical forms would be unrelated there, and comparing only those would make
//     the guard MISS a shell that is, by every name it knows, inside the directory
//     about to be removed
//   · the CANONICAL form catches the reverse — an 8.3 short name or a symlinked
//     temp dir that names the same directory in two ways
//
// Keeping both is the whole point HERE, and only here: literal-inside genuinely does
// not imply canonical-inside, so collapsing this into one comparison reintroduces one
// of the two holes whichever way it is collapsed. (It does not carry over to equality
// — see samePathEitherForm.)
function isInsideEitherForm(child, parent) {
  return isInside(child, parent) ||
         isInside(canonicalPath(child), canonicalPath(parent));
}

// samePathCanonical with a literal fast path — exactly that, and nothing more. Unlike
// containment, EQUALITY cannot disagree between the two forms: a literal match implies
// a canonical one (see samePathCanonical), and the junction argument above is vacuous
// for it, since a junction and its target are never the same literal string. The name
// is kept so a guard call site reads consistently with isInsideEitherForm rather than
// looking like it asks a lookup question.
function samePathEitherForm(a, b) {
  return samePathCanonical(a, b);
}

// True at the top of a filesystem: "/" on posix, "C:\" or a UNC share root on win32.
// path.dirname is the portable test — a root is the only path it maps to itself.
function isFilesystemRoot(p) {
  const resolved = path.resolve(p);
  return path.dirname(resolved) === resolved;
}

// The two locations no wksp command may ever treat as a project folder, in one place so
// the guards in init/delete/migrate cannot drift apart. Returns a human-readable reason,
// or null when the path is fine.
//
// The home directory is on the list because the global config is `~/.wksp` and a project
// marker is also `.wksp` — the same filename. Creating a project at the home directory
// would overwrite the global config with a project marker, and "migrating" it would write
// project fields (schemaVersion) into the global config. A project *inside* the home
// directory (~/projects/foo) is perfectly normal and not affected.
//
// Both checks are guards, so both use the either-form comparison: a home directory
// reachable under an 8.3 short name (any Windows username over 8 characters, or one
// containing a space) must not slip past them by being spelled differently.
function unsafeProjectDirReason(p) {
  if (samePathEitherForm(p, os.homedir())) {
    return 'it is your home directory, where wksp keeps its global config (~/.wksp — the same filename as a project marker)';
  }
  if (isFilesystemRoot(p)) return 'it is a filesystem root';
  return null;
}

module.exports = {
  toPosix, normalizePath, isInside, samePath, isFilesystemRoot, unsafeProjectDirReason,
  canonicalPath, samePathCanonical, isInsideEitherForm, samePathEitherForm,
};
