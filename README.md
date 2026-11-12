# @countinghouse/ch-pack-ci-failure-triage

countinghouse scenario: one call answers "why did CI fail?" with the failing step, the error lines, the cross-run history and a measured receipt of what was read and what reached the model.

**Status: preview.** Runs on [countinghouse](https://github.com/mchen6/countinghouse)
once it can call a remote MCP server (RC1-min) and load a scenario in local mode
(LM1); the tests run the whole chain in-process today. A scenario module of the
countinghouse client packs: the one tool the model sees.

## What it does

One tool, `ci_failure_triage`. It is a carrying scenario: one call does what
would take the model dozens of GitHub calls and thousands of log lines.

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

**What it returns:**
- **`summary`:** one sentence.
- **`run`:** id, url, branch, commit, workflow, job and failing step.
- **`errors`:** at most 40 error lines from the failing step.
- **`history`:** the failure's signature, how often it was seen in the window,
  its first and last appearance with their commits, its verdict (`new`,
  `flaky` or `recurring`), and the runs it was seen in.
- **`owner_hint`:** at most three GitHub logins and why, or null.
- **`coverage`:** described below.

When no run in the window failed, it returns `status: 'no-failed-run'` with
the latest success. The runtime appends the receipt (lines and bytes read,
lines that reached the model); this module never sets it.

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

Part of the countinghouse client packs. The design, the plan and the
acceptance tests live in [ch-packs](https://github.com/mchen6/ch-packs);
each package has its own repository (maintainer's decision, 2026-11-11).

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
