'use strict';
// Best-effort forge (GitHub) merge detection via the `gh` CLI.
//
// Git alone cannot tell a squash-/rebase-merged branch from an abandoned one:
// either way the branch's commits are not on the default branch, so an ancestry
// check reports "not merged." The authoritative signal lives in the forge — the
// state of the branch's pull request.
//
// `gh` is NOT a hard dependency. Everything here is feature-detected and never
// throws: if gh is missing, the remote isn't GitHub, or gh errors / is offline,
// callers get `'unknown'` and should degrade silently.
//
// Every external seam — running a command, and reading the repo's origin URL — is
// injectable via `deps`, so tests need no real gh, network, or GitHub remote.
const { execSync } = require('child_process');

function defaultExec(cmd) {
  try {
    return { ok: true, output: execSync(cmd, { encoding: 'utf8', stdio: 'pipe' }).trim() };
  } catch (e) {
    return { ok: false, output: ((e && (e.stdout || e.message)) || '').toString() };
  }
}

// Is `gh` on PATH? `gh --version` is offline and cheap.
function ghAvailable(exec = defaultExec) {
  return exec('gh --version').ok;
}

// Parse a git origin URL into { owner, repo } when it points at github.com, else
// null. Handles https, ssh, and scp-style (git@github.com:owner/repo.git) forms.
function parseGitHubSlug(url) {
  if (!url) return null;
  const m = String(url).trim().match(/github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

// Classify the JSON emitted by `gh pr list ... --json number,state,mergedAt`.
// Returns { state, pr? } where state is:
//   'merged'   — a MERGED PR exists for the branch (authoritative)
//   'unmerged' — gh answered, and the branch's PR is OPEN (genuinely not merged)
//   'unknown'  — no PR found, or the payload was unparseable (can't confirm)
function classifyPrList(jsonText) {
  let prs;
  try { prs = JSON.parse(jsonText); } catch { return { state: 'unknown' }; }
  if (!Array.isArray(prs)) return { state: 'unknown' };
  const merged = prs.find(p => p && (p.state === 'MERGED' || p.mergedAt));
  if (merged) return { state: 'merged', pr: { number: merged.number, mergedAt: merged.mergedAt } };
  const open = prs.find(p => p && p.state === 'OPEN');
  if (open) return { state: 'unmerged', pr: { number: open.number } };
  return { state: 'unknown' };
}

// prMergeState(baseRepo, branch, deps) -> { state: 'merged'|'unmerged'|'unknown', pr? }
// Best-effort; never throws. `deps.exec` and `deps.remoteUrl` are independently
// stubbable so the gh invocation and the GitHub-remote detection can be tested
// in isolation.
function prMergeState(baseRepo, branch, deps = {}) {
  const exec      = deps.exec      || defaultExec;
  const remoteUrl = deps.remoteUrl || require('./git').getRemoteUrl;
  if (!branch) return { state: 'unknown' };
  if (!ghAvailable(exec)) return { state: 'unknown' };            // gh absent → degrade
  const slug = parseGitHubSlug(remoteUrl(baseRepo));
  if (!slug) return { state: 'unknown' };                         // not a GitHub remote → degrade
  const r = exec(
    `gh pr list --head "${branch}" --state all --json number,state,mergedAt ` +
    `--repo "${slug.owner}/${slug.repo}" --limit 30`
  );
  if (!r.ok) return { state: 'unknown' };                         // gh errored / offline → degrade
  return classifyPrList(r.output);
}

module.exports = { prMergeState, ghAvailable, parseGitHubSlug, classifyPrList, defaultExec };
