# @countinghouse/ch-pack-ci-failure-triage

countinghouse scenario: one call answers "why did CI fail?" with the failing step, the error lines, the cross-run history and a measured receipt of what was read and what reached the model.

**Status: preview.** Runs on [countinghouse](https://github.com/mchen6/countinghouse)
once it can call a remote MCP server (RC1-min) and load a scenario in local mode
(LM1); the tests run the whole chain in-process today. A scenario module of the
countinghouse client packs: the one tool the model sees.

## What it does

*Design, not yet built: this is what the tool does once countinghouse can
load it (RC1-min and LM1). The chain is tested in-process here; it has not
run on a live runtime.*

One tool, `ci_failure_triage`. Chain kind: **carrying: the logs cross the
runtime, not the model.** One call does what would take the model dozens of
GitHub calls and thousands of log lines, and only the few lines that explain
the failure reach it.

- **Server:** GitHub, through [ch-access-github](https://github.com/mchen6/ch-access-github),
  which owns the remote. This module declares no remote and never sees a token.
- **Credentials:** `COUNTINGHOUSE_GITHUB_TOKEN`, or else `GITHUB_TOKEN`: a
  fine-grained token with Metadata, Contents and Actions read on the
  repository.
- **The repository:** the one the agent is working in. The launcher reads its
  working directory's `origin` remote and passes it as
  `DeviceConfig.defaultRepo`; `repo: 'owner/name'` overrides it. Without
  either, the call fails with `REPO_REQUIRED`.
- **Arguments, all optional:** `run_id` (default: the latest failed run),
  `repo`, `window` (default 50 runs), `max_logs` (default 20 logs per
  call), `owner_hint` (default true; false leaves the logins out).

**What it returns** (declared in `schema.json` as a closed object of one of
two shapes). The triage result has exactly these fields:
- **`summary`:** one sentence.
- **`run`:** `{id, url, branch, commit, workflow, job, step}`.
- **`errors`:** at most 40 strings, the error lines of the failing step.
- **`history`:** `{signature, count, window, verdict, firstSeen, lastSeen,
  runIds}`, or `null` when the run's log could not be read and the cache does
  not know it.
  - `firstSeen` and `lastSeen` are `{runId, commit, createdAt}`.
  - `verdict` is `new`, `flaky` or `recurring`.
- **`owner_hint`:** `{logins, why}`, at most three GitHub logins with one
  reason each, or `null`.
- **`coverage`:** `{runsListed, failedRuns, logsFetched, logsExpired,
  logsTruncated, logsUnavailable, cacheHits, capHit}`.
  - `logsUnavailable` is a list of `{runId, job}`.

When no run in the window failed, the answer has exactly `{status:
'no-failed-run', summary, lastSuccess, coverage}`. `lastSuccess` is `{id,
url, branch, commit, workflow, createdAt}`, or `null`.

The runtime adds the receipt in the result's `_meta` and as a second text
block: `_meta['countinghouse/receipt']` is `{calls, linesIn, bytesIn,
linesOut, bytesOut, servers}`, and the text block is its one sentence. The
answer above is the result's `structuredContent`, unchanged. This module
never sets the receipt.

**Coverage, stated, never hidden:**
- runs considered (the failing run's workflow only, so a Pages deploy is not
  in a CI window). A failed run is one that failed, timed out or failed to
  start;
- failed runs;
- logs fetched;
- logs expired (past GitHub's retention), truncated by the server, or
  unavailable for another reason, by run and job. An older run that cannot
  be read is counted here, never fatal;
- cache hits;
- whether the `max_logs` cap stopped it.

The summary ends with the gaps when there are any.

**Privacy:**
- Every string that reaches the model goes through
  [ch-step-redact](https://github.com/mchen6/ch-step-redact): error lines, step,
  job, workflow and branch names, the owner logins and the summary.
- The owner hint is GitHub logins only, never a name or an address: the author
  of the commit where the failure first appeared, then the authors of the
  other commits it failed on. It is a suggestion, and there is no blame call.
- The cache, `/data/<owner>__<name>/fingerprints.json`, holds run ids,
  signatures, commit SHAs, dates and sha256 hashes of the normalised error
  lines, never a raw line or a token, and remembers logs that have expired.
  A second call fetches only the failed runs it has not seen, plus the latest
  one for its error lines. When that one's log can no longer be read, its
  cached signature still gives the history.

**The parts** are named in `countinghouse.calls`: ch-access-github and the seven
`ch-step-*` modules. The launcher installs them, and this package has no
`dependencies`. The tests use each part's tarball, recorded in
[test/fixtures/parts](test/fixtures/parts/README.md).

Each package has its own repository; the family's design, plan and acceptance tests are in a repository that stays private until the first release.

## Development

```
npm ci
npm test
npm run validate   # packs the module and runs countinghouse-validate on the tarball
```

Pure JavaScript, Node 22.16 or later, no native module. CI runs on
Linux, macOS and Windows.

## Publishing

Releases are published by `.github/workflows/publish.yml` under npm
trusted publishing: a `v<version>` tag on a `main` commit whose
package.json carries that version. No npm token exists anywhere and no 2FA
code is typed for a release. One-time setup on npmjs.com, by the
maintainer: the package's first version is published by hand (`npm publish
--access public`, with 2FA); then **Settings → Trusted publishing → GitHub
Actions** with owner `mchen6`, repository `ch-pack-ci-failure-triage`, workflow
`publish.yml`, allowing `npm publish` as well as `npm stage publish`;
then **Settings → Publishing access → Require two-factor authentication
and disallow tokens**. A new trusted-publisher configuration must publish
once within two days or it expires.

## License

Apache-2.0.
