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

// A blackholed remote must not hang finish. Cap every gh invocation; on timeout
// execSync throws ETIMEDOUT, which is caught below and degrades to `unknown`.
const GH_TIMEOUT_MS = 10000;

function defaultExec(cmd) {
  try {
    return { ok: true, output: execSync(cmd, { encoding: 'utf8', stdio: 'pipe', timeout: GH_TIMEOUT_MS }).trim() };
  } catch (e) {
    return { ok: false, output: ((e && (e.stdout || e.message)) || '').toString() };
  }
}

// Memoized answer for the real `gh --version` probe, so a multi-repo task spawns
// it once, not once per repo. Only the default exec is cached — an injected exec
// (tests) is always called, so stubbing stays deterministic across cases.
let ghAvailableCache;

// Is `gh` on PATH? `gh --version` is offline and cheap.
function ghAvailable(exec = defaultExec) {
  if (exec !== defaultExec) return exec('gh --version').ok;
  if (ghAvailableCache === undefined) ghAvailableCache = exec('gh --version').ok;
  return ghAvailableCache;
}

// Parse a git origin URL into { owner, repo } when it points at github.com, else
// null. Handles https, ssh, and scp-style (git@github.com:owner/repo.git) forms.
// GitHub Enterprise hosts (github.mycorp.com) are intentionally out of scope — the
// gh CLI would need a matching host config, so we degrade to `unknown` there.
function parseGitHubSlug(url) {
  if (!url) return null;
  const m = String(url).trim().match(/github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

// Classify the JSON emitted by
// `gh pr list ... --json number,state,mergedAt,headRefOid`, tied to `localTip`
// (the current local sha of the branch). Returns { state, pr? } where state is:
//   'merged'   — a MERGED PR whose head is the current tip (authoritative)
//   'unmerged' — the branch's PR is OPEN (genuinely not merged, or a live PR
//                under a reused head name we must not delete behind)
//   'unknown'  — no PR ties to this branch, or the payload was unparseable
//
// Why the tip check: `gh pr list --head <branch>` returns EVERY PR that ever used
// that head branch name — including an old, since-merged PR whose branch name was
// later reused for unrelated work. Trusting a bare MERGED state there would report
// `merged` for a branch whose real PR is still open, and finish would force-delete
// it. Only a PR whose head commit equals the current tip actually describes THIS
// branch (for a squash/rebase merge with no unmerged local work, the PR head oid —
// the pre-merge tip — equals the local tip).
function classifyPrList(jsonText, localTip) {
  let prs;
  try { prs = JSON.parse(jsonText); } catch { return { state: 'unknown' }; }
  if (!Array.isArray(prs)) return { state: 'unknown' };

  const atTip = localTip ? prs.filter(p => p && p.headRefOid === localTip) : [];
  const mergedAtTip = atTip.find(p => p.state === 'MERGED' || p.mergedAt);
  if (mergedAtTip) return { state: 'merged', pr: { number: mergedAtTip.number, mergedAt: mergedAtTip.mergedAt } };
  const openAtTip = atTip.find(p => p.state === 'OPEN');
  if (openAtTip) return { state: 'unmerged', pr: { number: openAtTip.number } };

  // No PR matches this exact tip. A MERGED PR for a different (reused) tip proves
  // nothing about this branch — but an OPEN PR under the same head name might be
  // this branch's live PR, so warn rather than force-delete behind it.
  const anyOpen = prs.find(p => p && p.state === 'OPEN');
  if (anyOpen) return { state: 'unmerged', pr: { number: anyOpen.number } };

  return { state: 'unknown' };
}

// prMergeState(baseRepo, branch, deps) -> { state: 'merged'|'unmerged'|'unknown', pr? }
// Best-effort; never throws. `deps.exec`, `deps.remoteUrl`, and `deps.revParse` are
// independently stubbable so the gh invocation, the GitHub-remote detection, and
// the local-tip lookup can each be tested in isolation without a real repo.
function prMergeState(baseRepo, branch, deps = {}) {
  const exec      = deps.exec      || defaultExec;
  const remoteUrl = deps.remoteUrl || require('./git').getRemoteUrl;
  const revParse  = deps.revParse  || require('./git').revParse;
  if (!branch) return { state: 'unknown' };
  if (!ghAvailable(exec)) return { state: 'unknown' };            // gh absent → degrade
  const slug = parseGitHubSlug(remoteUrl(baseRepo));
  if (!slug) return { state: 'unknown' };                         // not a GitHub remote → degrade
  const r = exec(
    `gh pr list --head "${branch}" --state all --json number,state,mergedAt,headRefOid ` +
    `--repo "${slug.owner}/${slug.repo}" --limit 30`
  );
  if (!r.ok) return { state: 'unknown' };                         // gh errored / offline → degrade
  const localTip = revParse(baseRepo, branch);                    // pre-merge tip; ties a PR to THIS branch
  return classifyPrList(r.output, localTip);
}

module.exports = { prMergeState, ghAvailable, parseGitHubSlug, classifyPrList, defaultExec };
