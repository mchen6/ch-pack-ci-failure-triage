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
  `{job, step, first_error, history}`; the pack cannot tell which of them gate
  the run. `first_error` is the failing step's first error line, or `null`
  when its log was not read.
  - `history` is that job's own verdict, against the job of the same name in
    the window's other runs that did not pass: `{verdict, count, runIds,
    firstSeen, lastSeen, notCompared, why}`. `runIds` has up to
    ten of the newest, and `count` counts them all.
  - `verdict` is `new`, `flaky`, `recurring` or `unknown`. `new` means no job
    of this name failed the same way in the runs compared. `unknown` does not
    say whether the failure is new: `why` says whether this job's own log was not
    read (`own_log_not_read`), some runs could not be compared
    (`history_not_compared`; `notCompared` counts the runs), or a job of
    another name is known to have failed the same way
    (`seen_under_another_job_name`). Only runs that did not pass are listed,
    so when the triaged run is itself a success, the window's other successes
    could not be compared.
- **`errors`:** at most 40 strings, the error lines of the triaged job, the
  failing step's first.
- **`history`:** `{signature, count, window, verdict, firstSeen, lastSeen,
  runIds}` of the run's one failed job. It is `null` when several jobs failed
  (no one verdict stands for them: each has its own, and the summary counts
  them), when that job's verdict is `unknown`, or when the run failed before
  any job ran. A run that failed still counts its failure after "Re-run
  jobs", whatever the re-run did, when the cache knew it.
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
- whether a bound stopped a log, or a run's list of failed jobs, being read:
  `max_logs` logs, as many lists, or 50 of either unavailable. The run's own jobs
  take at most half of `max_logs` (the triaged job's log always), so the
  history gets the rest, each failed job's history read in turn, and a later
  call reads on from the cache. With
  `max_logs` 1 that one log is the triaged job's;
- whether history was rebuilt, because the cache, or part of it, was made
  with another failure-signature algorithm, other error-extraction rules or
  another pack key, or by a version of the pack that kept it differently.

The summary ends with the gaps when there are any.

**Privacy:**
- Every string that reaches the model goes through
  [ch-step-redact](https://github.com/mchen6/ch-step-redact): error lines, step,
  job, workflow and branch names, the owner logins and the summary.
- The owner hint is GitHub logins only, never a name or an address: the author
  of the commit where the failure first appeared, then the authors of the
  other commits it failed on. It is a suggestion, and there is no blame call.
- The cache, `/data/<owner>__<name>/fingerprints.json`, holds run ids,
  job ids, signatures, commit SHAs, dates, GitHub's conclusions and sha256
  hashes of the normalised error lines and of step names, and job names by
  the pack's keyed hash; never a raw line or a token. It remembers logs that
  have expired, failed runs that had no job, and the jobs a run failed before
  it was re-run. A second call fetches only the logs it has not read, plus
  the triaged run's for their error lines, and lists a run's jobs again when
  the run is in progress, finished differently, or has a new attempt (where
  ch-access-github gives it). When the
  triaged run's log can no longer be read, its cached signature still gives
  the history.
- The pack's key, `/data/.pack-key`: 32 random bytes, owner-only, made on
  first use. It keys the hashes the pack makes of branch names (for
  ch-step-dedupe, which only tells branches apart), of job names (how the
  cache knows a job by its name) and of step names over 200 characters, so
  neither a part nor the cache holds a hash of a name
  that can be guessed and checked.
- Each cached job records the failure-signature algorithm that signed it, as
  ch-step-failure-signature names it, with the extraction's rules and the
  pack key's id. A job signed under any other, or a cache from before jobs
  were kept apart, would never match, so it is read again within
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
`dependencies`. The tests use each part's tarball, recorded in
[test/fixtures/parts](test/fixtures/parts/README.md).

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
