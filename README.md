# @countinghouse/ch-pack-ci-failure-triage

countinghouse scenario: one call answers "why did CI fail?" with the failing step, the error lines, the cross-run history and a measured receipt of what was read and what reached the model.

**Status: preview.** Runs on [countinghouse](https://github.com/mchen6/countinghouse)
8.0 or later (unreleased; the release that carries the remote client and
local mode). A scenario module of the countinghouse client packs: the one tool
the model sees.

## What it does

The chain is tested in-process here, and end to end on a live runtime by
[ch-local](https://github.com/mchen6/ch-local)'s acceptance test, against a
recorded GitHub stand-in.

One tool, `ci_failure_triage`. Chain kind: **carrying: the logs cross the
runtime, not the model.** One call does what would take the model dozens of
GitHub calls and thousands of log lines, and only the few lines that explain
the failure reach it.

- **Server:** GitHub, through [ch-access-github](https://github.com/mchen6/ch-access-github),
  which owns the remote. This module declares no remote and never sees a token.
- **Credentials:** none of its own. The GitHub token is ch-access-github's
  credential (`ch-local credentials add ch-access-github`): a fine-grained
  token with Metadata, Contents and Actions read on the repository. Without
  it ch-access-github does not load, and neither does this module, which
  calls it.
- **The repository:** the input's `repo: 'owner/name'`, which the tool's
  description asks the agent to pass (the project it is working in); else the
  module's setting `defaultRepo` (a repository, set with `ch-local settings set
  ch-pack-ci-failure-triage.defaultRepo` or in conversation). Without either
  the call fails with the runtime's `SETTING_REQUIRED`, naming `defaultRepo`.
- **Which run:** with no `run_id`, the newest failed run of the repository,
  in any workflow and on any branch (a `branch` argument is not built yet).
  A `run_id` naming a run that did not fail (a success, a run still in
  progress, a cancelled run with no failed job) is answered as such.
- **Arguments, all optional:** `run_id` (digits, as a string or a number;
  default: the newest failed run),
  `repo`, `window` (default 50 runs), `max_logs` (default 20 logs per
  call), `owner_hint` (default true; false leaves the logins out).

**What it returns** (declared in `schema.json` as a closed object of one of
three shapes). The triage result has exactly these fields:
- **`summary`:** one sentence, then the receipt sentence when the runtime
  has `ctx.usage()` (below); at most 801 characters.
- **`run`:** `{id, url, branch, commit, workflow, job, step}`.
- **`failed_jobs`:** every failed job of the run (at most 50 listed), each
  `{job, step, first_error}`; the pack cannot tell which of them gate the
  run. `first_error` is the failing step's first error line, or `null` when
  its log was not read.
- **`errors`:** at most 40 strings, the error lines of the triaged job, the
  failing step's first.
- **`history`:** `{signature, count, window, verdict, firstSeen, lastSeen,
  runIds}`, or `null` when the run's log could not be read and the cache does
  not know it, or when the run failed before any job ran. A run that failed
  and then passed on "Re-run jobs" still counts its failure.
  - `firstSeen` and `lastSeen` are `{runId, commit, createdAt}`.
  - `verdict` is `new`, `flaky` or `recurring`.
- **`owner_hint`:** `{logins, why}`, at most three GitHub logins with one
  reason each, or `null`.
- **`coverage`:** `{runsListed, failedRuns, logsFetched, logsExpired,
  logsTruncated, logsUnavailable, cacheHits, capHit, historyRebuilt}`.
  - `logsUnavailable` is a list of `{runId, job}`.

When no run in the window failed, the answer has exactly `{status:
'no-failed-run', summary, lastSuccess, coverage}`. `lastSuccess` is `{id,
url, branch, commit, workflow, createdAt}`, or `null`. When a `run_id`
names a run that did not fail, it has exactly `{status: 'run-not-failed',
summary, run, coverage}`, with `run` as `{id, conclusion}` (`conclusion` is
`null` while the run is in progress).

The runtime adds the receipt in the result's `_meta` and as a second text
block: `_meta['countinghouse/receipt']` is `{calls, linesIn, bytesIn,
linesOut, bytesOut, servers}`, and the text block is its one sentence. This
module never sets a receipt field. The model reads the summary, though, so
the summary ends with the receipt's sentence, written from `ctx.usage()`
(the call's counts so far, every part's GitHub calls included), in the
runtime's own words for what was read:

> Receipt: read 48,210 lines (3.1 MB) in 14 calls to github; only this
> answer reached the model.

Bytes and lines only. A token estimate is the usage report's
(`countinghouse_usage_report`), labelled as one there, never the receipt's.

The sentence is left out when the runtime has no `ctx.usage()`, when it
answers null or refuses, when it answers anything but counts and a
one-line sentence, or when the whole would be over 300 characters (the
summary's declared length allows for the report's 500 and these 300).

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
- whether the `max_logs` cap stopped a log being read. The run's own jobs
  take at most half of `max_logs` (the triaged job's log always), so the
  history gets the rest, and a later call reads on from the cache. With
  `max_logs` 1 that one log is the triaged job's;
- whether the history was rebuilt, because the cache was made with another
  failure-signature algorithm.

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
  It also remembers failed runs that had no job. A second call fetches only
  the failed runs it has not seen, plus the latest one for its error lines. When that one's log can no longer be read, its
  cached signature still gives the history.
- The pack's key, `/data/.pack-key`: 32 random bytes, owner-only, made on
  first use. It keys the hashes the pack makes of branch names (for
  ch-step-dedupe, which only tells branches apart) and of step names over
  200 characters, so neither a part nor the cache holds a hash of a name
  that can be guessed and checked.
- Each cached run records the failure-signature algorithm that signed it, as
  ch-step-failure-signature names it. A run signed by another algorithm, or
  cached before the field, would never match, so it is read again within
  `max_logs`; `historyRebuilt` is then true, and the summary says so. Expired
  logs stay remembered, whatever the algorithm.

**Example prompts.** The pack declares four prompts (`promptList`), which a
client such as Claude Code shows as slash commands. Each asks only for what
`ci_failure_triage` does, and asks for its receipt line as it is:

- `ci_triage_latest`: Triage the latest failed CI run.
- `ci_triage_run`: Triage a specific CI run (its `run_id`).
- `ci_new_or_recurring`: Is this CI failure new, flaky or recurring?
- `ci_who_touched`: Who wrote the commits the CI failure occurred on?

Each takes an optional `repo` (owner/name); without one the agent uses the
repository it is working in.

**The parts** are named in `countinghouse.calls`: ch-access-github and the seven
`ch-step-*` modules. The launcher installs them, and this package has no
`dependencies`. Only ch-access-github declares a remote (GitHub); this module
and the step modules declare none. That is what they declare, not a
confinement: countinghouse does not enforce a network permission yet (its
[security model](https://github.com/mchen6/countinghouse/blob/master/docs/security-model.md)),
so their code could still open a connection. The tests use each part's tarball, recorded in
[test/fixtures/parts](test/fixtures/parts/README.md).

## Verify it yourself

Three facts you can check on your own machine, with your ch-local home as
`<home>` (`$COUNTINGHOUSE_HOME`, or `~/.countinghouse`):

- **The pack's only remote host is `https://api.githubcopilot.com`**,
  GitHub's MCP server, reached by ch-access-github with your token. The
  remote is declared in `countinghouse.remotes` of
  `<home>/module-store/@countinghouse/ch-access-github/<version>/package.json`,
  and no other installed module of the pack declares one. `node
  <home>/bin/ch-local.js credentials list` shows where each stored key may
  be sent.
- **The triage cache holds no log text.** It is one `fingerprints.json` per
  repository (`/data/<owner>__<name>/fingerprints.json` inside the pack).
  - Each run's entry holds the run and job ids, commit SHAs, times and the
    failure's signature, with the `algorithm` that signed it.
  - The step's name and the error lines are kept as SHA-256 hashes, not
    keyed, so a line you already know can be confirmed by hashing it. Only
    a step name over 200 characters is hashed with the pack's key.
  - Some entries carry flags: `expired: true` for a log past GitHub's
    retention, and `notFailed: true` for a run that did not fail.
  - A failed run with no job has no job id; its entry holds GitHub's
    `conclusion` word for it.
  - Beside the caches are the pack's key, `/data/.pack-key` (above). A
    cache that could not be read is moved aside as
    `fingerprints.json.unreadable-<time>` and kept as it was, so it holds
    whatever that file held.
  - `find <home>/module_data \( -name 'fingerprints.json*' -o -name .pack-key \)`
    lists them all.
- **Usage is recorded on this machine**, in `<home>/store/usage`. `node
  <home>/app/node_modules/countinghouse/bin/countinghouse-usage.js
  --usageDir <home>/store/usage` prints the report outside any conversation
  (`--since 7d`, `--groupBy tool`, `--json` or `--csv`).

Part of the countinghouse client packs. Each package has its own repository. The family's design and plan are in
[ch-packs](https://github.com/mchen6/ch-packs) (public); the end-to-end acceptance test, which installs every package
and calls the tool, runs in [ch-local](https://github.com/mchen6/ch-local)'s CI.

## Development

```
npm ci
npm test
npm run validate   # packs the module and runs countinghouse-validate on the tarball
```

Pure JavaScript, no native module. Node 22.16 or later, as countinghouse.
CI runs Node 24 on Linux, macOS and Windows.

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
