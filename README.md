# @countinghouse/ch-pack-ci-failure-triage

countinghouse scenario: one call answers "why did CI fail?" with the failing step, the error lines, the cross-run history and a measured receipt of what was read and what reached the model.

**Status: preview.** Runs on [countinghouse](https://github.com/mchen6/countinghouse)
8.0 or later. A scenario module of the countinghouse client packs: the one tool
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
  ch-pack-ci-failure-triage.defaultRepo <owner/name>` in your own terminal).
  Without either the call fails with the runtime's `SETTING_REQUIRED`, naming
  `defaultRepo`.
- **Which run:** with no `run_id`, the newest failed run of the repository,
  in any workflow and on any branch (a `branch` argument is not built yet).
  A `run_id` naming a run that did not fail (a success, a run still in
  progress, a cancelled run with no failed job) is answered as such.
- **Arguments, all optional:** `run_id` (digits, as a string or a number;
  default: the newest failed run),
  `repo`, `window` (default 50 runs), `max_logs` (default 20 logs per
  call), `owner_hint` (default true; false leaves the logins out).
  `run_id` is one of the repository's last `window` runs (default 50, at
  most 100): an older run is refused (`RUN_NOT_FOUND`). In a repository with
  many runs, a failure can leave that window within hours.

**What it returns** (declared in `schema.json` as a closed object of one of
three shapes). The triage result has exactly these fields:
- **`summary`:** the pack's own words, a fixed sentence that the fields are
  data, then the receipt sentence when the runtime has `ctx.usage()` (below); at
  most 821 characters.
- **`run`:** `{id, url, branch, commit, workflow, job, step}`.
- **`failed_jobs`:** every failed job of the run (at most 50 listed), each
  `{job, step, first_error, history}`, and `values`, `values_omitted` or
  `values_same_as` when it has them; the pack cannot tell which of them gate
  the run. `first_error` is the failing step's first error line, or `null`
  when its log was not read.
  - `history` is that job's own verdict, against the job of the same name in
    the window's other runs that did not pass: `{verdict, count, runIds,
    firstSeen, lastSeen, notCompared, why}`. `runIds` has up to
    ten of the newest, and `count` counts them all.
  - `verdict` is `new`, `flaky`, `recurring` or `unknown`:
    - `new`: this job's failure is in no other run compared in the window, and
      no failure after it went unread.
    - `flaky`: the same failure is on a commit that also passed in the window
      (a re-run that passed counts), or on one branch it alternated with
      passing runs at least twice (failed, passed, failed), even when a fix
      came in between.
    - `recurring`: the same failure is in more than one run compared, and it
      is not flaky. Runs after this one count too.
    - `unknown` does not say whether the failure is new: `why` says whether
      this job's own log was not read (`own_log_not_read`), some runs could
      not be compared (`history_not_compared`; `notCompared` counts the runs),
      or a job of another name is known to have failed the same way
      (`seen_under_another_job_name`).

    "The same failure" means the same signature from ch-step-failure-signature,
    for the job of the same name. Only runs that did not pass are listed, so
    when the triaged run is itself a success, the window's other successes
    could not be compared. A run that passed on a re-run counts as not compared
    too, unless what it failed before was read. A run that did not pass and whose
    workflow can't be told counts as not compared, so it never makes a failure new.
- **`errors`:** at most 40 error lines of the triaged job, the failing step's
  first. The expected and actual values it finds for a failed assertion follow
  its line; a format it does not recognise gives none. The values have one
  limit across the whole answer: 40 lines and 4,000 characters, as sent, the
  notes included. It counts the assertion's own line, and each value, only
  where that isn't an error line already. A note says when any of the triaged
  job's were left out, and `values_omitted` how many of another job's failed
  assertions may not have all their values shown. A value the screen judges not
  to be words, a number or a name shows as `<withheld>`, or, for a whole line,
  `<value line withheld>`. A short secret, one written in groups, or one that
  reads like ordinary words or a plain number can still pass, and occasionally
  a longer one, whole or in part (see Privacy).
- **`failed_jobs[].values`:** another job's failed assertions with their
  values, under the same limit. `values_same_as` instead names the place in
  `failed_jobs` of an earlier job with the same ones (place 0 is the
  triaged job, whose values are in `errors`).
- **`history`:** `{signature, count, window, verdict, firstSeen, lastSeen,
  runIds}` of the run's one failed job. It is `null` when several jobs failed
  (no one verdict stands for them: each has its own, and the summary counts
  them), when that job's verdict is `unknown`, or when the run failed before
  any job ran. A run that failed still counts its failure after "Re-run
  jobs", whatever the re-run did, when the cache knew it.
  - `firstSeen` and `lastSeen` are `{runId, commit, createdAt}`.
  - `verdict` is `new`, `flaky` or `recurring`.
- **`owner_hint`:** `{logins, why}`, at most three GitHub logins with one
  reason each, or `null`; or no logins and one reason, when the runtime refused
  reading a commit's author.
- **`coverage`:** `{runsListed, failedRuns, logsFetched, logsExpired,
  logsTruncated, logsUnavailable, cacheHits, capHit, historyRebuilt}`.
  - `logsUnavailable` is a list of `{runId, job}`.
  - `capHit` says the history was not read in full: max_logs was reached, 50
    logs or job lists could not be had, or GitHub answered with a rate limit,
    after which the triage asks GitHub nothing more. The runs not read count as
    not compared.

When no run in the window failed, the answer has exactly `{status:
'no-failed-run', summary, lastSuccess, coverage}`. `lastSuccess` is `{id,
url, branch, commit, workflow, createdAt}`, or `null`. When a `run_id`
names a run that did not fail, it has exactly `{status: 'run-not-failed',
summary, run, coverage}`, with `run` as `{id, conclusion}` (`conclusion` is
`null` while the run is in progress).

The runtime adds the receipt in the result's `_meta` and as a second text
block: `_meta['countinghouse/receipt']` is `{calls, bytesIn, bytesOut,
servers}`, and the text block is its one sentence. This
module never sets a receipt field. The model reads the summary, though, so
the summary ends with the receipt's sentence, written from `ctx.usage()`
(the call's counts so far, every part's GitHub calls included), in the
runtime's own words for what was read, for example:

> Receipt: read 3.1 MB in 14 calls to github; only this answer reached the
> model.

Bytes only. A token estimate is the usage report's
(`countinghouse_usage_report`), labelled as one there, never the receipt's.

The sentence is left out when the runtime has no `ctx.usage()`, when it
answers null or refuses, when it answers anything but counts and a
one-line sentence, or when the whole would be over 300 characters (the
summary's declared length allows for the report's 520 and these 300).

**Coverage, stated, never hidden:**
- runs considered (the failing run's workflow only, so a Pages deploy is not
  in a CI window). A run's window is the runs of the same workflow, by
  GitHub's workflow id where it gives one, else by the same name. A renamed
  workflow keeps its window where GitHub gives the id; a moved workflow file
  may start a new one. A failed run is one that failed, timed out or failed to
  start;
- failed runs;
- logs fetched;
- logs expired (past GitHub's retention), truncated by the server, or
  unavailable for another reason, by run and job. An older run GitHub cannot
  give, or gives in a shape that can't be used, is counted here; a refusal of
  the runtime's own (a busy runtime, a validation deadline) fails the call,
  named, rather than being read as not compared;
- cache hits;
- whether a bound stopped a log, or a run's list of failed jobs, being read:
  `max_logs` logs, as many lists, or 50 of either unavailable, or GitHub
  answered with a rate limit. The run's own jobs
  take at most half of `max_logs` (the triaged job's log always), so the
  history gets the rest, each failed job's history read in turn, and a later
  call reads on from the cache. With
  `max_logs` 1 that one log is the triaged job's;
- whether history was rebuilt, because the cache, or part of it, was made
  with another failure-signature algorithm, other error-extraction rules or
  another pack key, or by a version of the pack that kept it differently.

The pack's own words in the summary say the gaps when there are any.

**Privacy:**
- Text taken from the run or its log goes through
  [ch-step-redact](https://github.com/mchen6/ch-step-redact) before it reaches
  the model: error lines, a failed assertion's values, step, job, workflow and
  branch names, the run's URL, the owner logins and a triage's summary (before
  its receipt sentence is added). Run ids, commit SHAs, dates, GitHub's
  conclusions, the failure signature where `history` has one, and the counts are
  sent as they are.
- **Redaction and the value screen are best effort, not a guarantee.** A failed
  test's expected and actual values are log text and can hold what the test
  compared. Known secret formats are masked, and a value the screen judges not
  to be words, a number or a name is withheld. The screen covers a failed
  assertion shown with its values: its own line and those values, also where
  they are error lines. It does not cover one without values, in another step
  or left out by the limits, a line of JSON cut short, any other error line, or
  `first_error`: those are redacted only. A short secret, one written in
  groups, or one that reads like ordinary words or a plain number can still
  pass and reach the model, and occasionally a longer one, whole or in part.
- The owner hint is GitHub logins only, never a name or an address: the author
  of the commit where the failure first appeared, then the authors of the
  other commits it failed on. It is a suggestion, and there is no blame call.
- The cache, `/data/<owner>__<name>/fingerprints.json`, holds run ids,
  job ids, signatures, commit SHAs, dates, GitHub's conclusions and sha256
  hashes of the normalised error lines and of step names, and job names by
  the pack's keyed hash; never a raw line or a token. It remembers logs that
  have expired or had nothing to compare, failed runs that had no job, and the jobs a run failed before
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
`dependencies`. Only ch-access-github declares a remote (GitHub); this module
and the step modules declare none. That is what they declare, not a
confinement: countinghouse does not enforce a network permission yet (its
[security model](https://github.com/mchen6/countinghouse/blob/master/docs/security-model.md)),
so their code could still open a connection. The tests use each part's tarball, recorded in
[test/fixtures/parts](test/fixtures/parts/README.md).

## Known limits

A failure that happened before can still read as `new` in these cases:

- **On another leg of a matrix, or under a renamed job.** A job is compared
  with the jobs of the same name, and a matrix leg is usually part of a job's
  name. When the same failure was seen only on another leg, the verdict is
  `unknown` (why: `seen_under_another_job_name`) if the pack has already read
  that leg's failure, in this call or an earlier one, and it has the same
  signature; otherwise it can read as `new`.
- **Beside another failure.** The signature covers the failing step and its
  error lines. When a second failure in the same step adds error lines, for
  example a second test failing beside it, the signature usually differs from
  the one from the runs where it failed alone, so it can read as `new`.
- **With a random word.** A failing line that names a random word (a generated
  temporary file's name, say, or one of letters only) still changes the
  signature, so a recurring failure can read as new.
- **After the failing step is renamed.** The step's name is part of the
  signature, so the same failure under a renamed step reads as `new`.

### Text outside ASCII in assertion values

In the values shown under a failed assertion, and in the assertion's own line,
any token containing a character outside ASCII (other scripts, accented
letters, symbols other than `…`) is shown as `<withheld>`, a token being the
text between spaces and punctuation such as quotes, brackets, commas, colons
and `=`. In a token with a slash or backslash, usually only those characters
are withheld. A line with an invisible formatting character is withheld whole.
Other error lines are not affected.

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
  - A run's entry lists its failed jobs, each as the pack's keyed hash of the
    job's name and GitHub's job id, with GitHub's `conclusion` word, the commit
    SHA, the time, a short id of the key, and the attempt number when GitHub
    gives it. A job's entry holds its id, commit SHA and time, and the
    failure's signature with the `algorithm` that signed it.
  - The step's name and the error lines are kept as SHA-256 hashes, not keyed,
    so a line you already know can be confirmed by hashing it. Job names, and
    step names over 200 characters, are hashed with the pack's key.
  - Some entries carry flags: `noJobs` for a failed run with no job, `earlier`
    and `lost` for jobs an earlier attempt of the run failed (`earlier` holds
    their ids), `notFailed` for a run that was a success when listed,
    `unsigned` for a log with nothing to compare, and `expired` for a log past
    GitHub's retention.
  - Beside the caches are the pack's key, `/data/.pack-key` (above). A cache
    that could not be read, or one of an older version, is moved aside as
    `fingerprints.json.unreadable-<time>`; an older version's step names are
    hashed first, and otherwise it holds whatever that file held.
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
CI runs Node 24 on Linux, macOS and Windows, and Node 22.16, the floor, on Linux.

## Publishing

Releases are published by `.github/workflows/publish.yml` under npm
trusted publishing: a `v<version>` tag on a `main` commit whose
package.json carries that version. No npm token exists anywhere and no 2FA
code is typed for a release. One-time setup on npmjs.com, by the
maintainer: the package is first published by hand, as a placeholder: in an empty
directory, a package.json holding only name, version "0.0.1-placeholder.0"
and description "Placeholder for the first release; not for use. Install a
released version.", then `npm publish --access public --tag placeholder`
(2FA). The one-time placeholder publish uses a throwaway pre-release
version (e.g. 0.0.1-placeholder.0) under a dist-tag other than latest
(e.g. `--tag placeholder`), never the release's version; deprecate it once
the real version is out. Then check `npm dist-tag ls <package>`: if
`latest` names the placeholder, `npm install <package>` installs it until
the real version is published (publishing the real version without
`--tag` moves `latest` to it), so publish the real version before the
package's name is given to anyone. Then **Settings → Trusted publishing → GitHub
Actions** with owner `mchen6`, repository `ch-pack-ci-failure-triage`, workflow
`publish.yml`, allowing `npm publish` as well as `npm stage publish`;
then **Settings → Publishing access → Require two-factor authentication
and disallow tokens**. A new trusted-publisher configuration must publish
once within two days or it expires.

## License

Apache-2.0.
