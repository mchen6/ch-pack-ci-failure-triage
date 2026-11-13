'use strict';
// The chain (spec §5): listRuns -> the latest failed run (or run_id) ->
// failedJobs -> jobLog -> log-clean -> error-patterns -> failure-signature, the
// same for every other failed run in the window that the cache does not know
// (up to max_logs logs per call) -> dedupe -> runCommits and owner-hint ->
// redact -> report. Every string that reaches the model goes through
// ch-step-redact, each log step whole before its lines are picked and the
// picked lines again. Coverage says what was not seen: expired, truncated and
// unavailable logs, the cap. A part of the history that cannot be read is
// counted, never fatal; only the latest failed run itself must be listed.
// No receipt: the runtime adds it.
const {ADDRESSES: A} = require('./addresses');
const {readCache, writeCache, hash, config} = require('./cache');

const MAX_ERROR_LINES = 40;
const MAX_STEP_COMMITS = 5;
const SHA = /^[0-9a-f]{40}$/;
// A run that failed: GitHub's conclusions for a run that did not pass.
const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);

const out = async (ctx, address, input) => (await ctx.call(address, input)).output;
const short = (commit) => String(commit).slice(0, 7);
const conclusionOf = (c) => (FAILED.has(c) ? 'failure' : c === 'success' ? 'success' : 'other');

// The error lines, redacted as one list: a key block spread over several lines
// is seen whole and becomes one line, so the list may be shorter.
const redactLines = async (ctx, lines) => (lines.length === 0 ? [] : (await out(ctx, A.redact, {lines})).lines);

// Field values, which must keep their places: redacted together, or one at a
// time if redaction merged two of them.
async function redactFields(ctx, fields) {
  if (fields.length === 0) return [];
  const {lines} = await out(ctx, A.redact, {lines: fields});
  if (lines.length === fields.length) return lines;
  return Promise.all(fields.map(async (f) => (await out(ctx, A.redact, {lines: [f]})).lines.join(' ')));
}

async function triage({repo, runId, window, maxLogs, ownerHint}, ctx, {dataRoot = config.root} = {}) {
  const listed = (await out(ctx, A.listRuns, {repo, limit: window})).runs;
  let target;
  if (runId != null) {
    target = listed.find((r) => r.runId === runId);
    if (target == null) throw ctx.error('RUN_NOT_FOUND', `run ${runId} is not among the last ${listed.length} runs of ${repo}`);
  } else {
    target = listed.find((r) => FAILED.has(r.conclusion));
  }
  if (target == null) return noFailedRun(ctx, listed);

  const considered = listed.filter((r) => r.workflow === target.workflow);
  const failed = considered.filter((r) => FAILED.has(r.conclusion));
  const cache = readCache(repo, dataRoot);
  const fresh = {};
  const coverage = {runsListed: considered.length, failedRuns: failed.length, logsFetched: 0, logsExpired: 0, logsTruncated: 0, logsUnavailable: [], cacheHits: 0, capHit: false, historyRebuilt: false};

  // One run's first failed job, its log, its error lines and signature.
  // `strict`: the latest failed run's errors propagate; any other run's are counted.
  const read = async (r, strict) => {
    let jobs;
    try {
      jobs = (await out(ctx, A.failedJobs, {repo, runId: r.runId})).jobs;
    } catch (err) {
      if (strict) throw err;
      coverage.logsUnavailable.push({runId: r.runId, job: '(jobs unavailable)'});
      return {job: null};
    }
    const job = jobs[0];
    if (job == null) return {job: null};
    const failingStep = (job.steps.find((s) => FAILED.has(s.conclusion)) || {}).name || null;
    coverage.logsFetched += 1;
    let log;
    try {
      log = await out(ctx, A.jobLog, {repo, jobId: job.jobId});
    } catch (err) {
      if (strict && (err == null || err.code !== 'LOG_UNAVAILABLE')) throw err;
      coverage.logsUnavailable.push({runId: r.runId, job: job.name});
      return {job, failingStep};
    }
    if (log.expired) {
      coverage.logsExpired += 1;
      fresh[r.runId] = {jobId: job.jobId, expired: true, commit: r.commit, createdAt: r.createdAt};
      return {job, failingStep};
    }
    if (log.truncated) coverage.logsTruncated += 1;
    const cleaned = (await out(ctx, A.clean, {text: log.text})).steps;
    // Every step redacted whole before any line is picked: a key block is only
    // seen as one between its BEGIN and END lines, and error-patterns may keep
    // the tail of a block without its BEGIN line.
    const steps = await Promise.all(cleaned.map(async (s) => ({name: s.name, lines: await redactLines(ctx, s.lines)})));
    const extracted = await out(ctx, A.extract, {steps, maxLines: MAX_ERROR_LINES, stepConclusions: job.steps.map((s) => ({name: s.name, conclusion: s.conclusion}))});
    const signed = await out(ctx, A.sign, extracted);
    fresh[r.runId] = {jobId: job.jobId, signature: signed.signature, algorithm: signed.algorithm, step: signed.step, commit: r.commit, createdAt: r.createdAt, errorLineHashes: signed.normalised.map(hash)};
    return {job, failingStep, signature: signed.signature, algorithm: signed.algorithm, lines: extracted.lines.map((l) => l.text)};
  };

  const signatures = {};
  // The latest failed run is always read, for its error lines; when its log
  // can no longer be read, the signature the cache knows stands in.
  const mine = await read(target, true);

  // Which cached signatures still count (cache-gap part 3). Each cached run
  // records the algorithm that signed it, and a signature from another one
  // (or from before the field) would never match today's: that run is read
  // again, within max_logs like any other, and coverage says the history was
  // rebuilt. An expired-log marker does not depend on the algorithm and is
  // kept. The algorithm in use is the target's own sign output's; when the
  // target's log cannot be signed, an empty probe names it, and a probe that
  // fails leaves it unknown, which trusts no cached signature and claims no
  // change. A step that names no algorithm matches the runs it cached, as
  // before the field.
  const UNKNOWN = Symbol('unknown');
  let algorithm = mine.signature != null ? mine.algorithm : UNKNOWN;
  if (algorithm === UNKNOWN) {
    try { algorithm = (await out(ctx, A.sign, {failingStep: null, lines: []})).algorithm; } catch { algorithm = UNKNOWN; }
  }
  const norm = (a) => (typeof a === 'string' ? a : null);
  const usable = (entry) => entry.expired === true || (algorithm !== UNKNOWN && norm(entry.algorithm) === norm(algorithm));
  const setAside = (entry) => {
    if (algorithm !== UNKNOWN && typeof entry.signature === 'string') coverage.historyRebuilt = true;
  };

  const cachedTarget = cache.runs[target.runId];
  let standIn = null;
  if (mine.signature == null && cachedTarget != null && typeof cachedTarget.signature === 'string') {
    if (usable(cachedTarget)) standIn = cachedTarget.signature;
    else setAside(cachedTarget);
  }
  const targetSignature = mine.signature != null ? mine.signature : standIn;
  if (targetSignature != null) signatures[target.runId] = targetSignature;
  for (const r of failed) {
    if (r.runId === target.runId) continue;
    let known = cache.runs[r.runId];
    if (known != null && !usable(known)) { setAside(known); known = null; }
    if (known != null) {
      coverage.cacheHits += 1;
      if (known.expired === true) coverage.logsExpired += 1;
      else if (typeof known.signature === 'string') signatures[r.runId] = known.signature;
      continue;
    }
    if (coverage.logsFetched >= maxLogs) { coverage.capHit = true; continue; }
    const got = await read(r, false);
    if (got.signature != null) signatures[r.runId] = got.signature;
  }
  writeCache(repo, fresh, dataRoot);

  const dedupeRuns = considered
    .filter((r) => typeof r.branch === 'string' && SHA.test(r.commit))
    .map((r) => ({runId: r.runId, conclusion: conclusionOf(r.conclusion), commit: r.commit, branch: r.branch, createdAt: r.createdAt,
      ...(FAILED.has(r.conclusion) && signatures[r.runId] != null ? {signature: signatures[r.runId]} : {})}));
  const {groups} = await out(ctx, A.group, {window, runs: dedupeRuns});
  const group = targetSignature == null ? null : groups.find((g) => g.signature === targetSignature) || null;
  const history = group == null ? null : {signature: group.signature, count: group.count, window: Math.min(window, considered.length), verdict: group.verdict,
    firstSeen: group.firstSeen, lastSeen: group.lastSeen, runIds: group.runIds};

  let hint = null;
  if (ownerHint && history != null) {
    // A best-effort suggestion: a commit that cannot be read has no login.
    const login = async (commit) => {
      try { return (await out(ctx, A.runCommits, {repo, commit})).authorLogin; } catch { return null; }
    };
    const byRun = new Map(considered.map((r) => [r.runId, r]));
    const others = [...history.runIds].reverse().map((id) => byRun.get(id)).filter((r) => r != null && r.commit !== history.firstSeen.commit)
      .map((r) => r.commit).filter((c, i, all) => all.indexOf(c) === i).slice(0, MAX_STEP_COMMITS);
    const firstSeen = {commit: history.firstSeen.commit, authorLogin: await login(history.firstSeen.commit)};
    const stepCommits = [];
    for (const commit of others) stepCommits.push({commit, authorLogin: await login(commit)});
    hint = await out(ctx, A.hint, {firstSeen, stepCommits});
  }

  // Everything that reaches the model, through ch-step-redact.
  const errors = await redactLines(ctx, (mine.lines || []).slice(0, MAX_ERROR_LINES));
  const jobName = mine.job != null ? mine.job.name : '(no failed job)';
  const step = mine.failingStep || null;
  const fields = [target.url, target.branch == null ? '' : target.branch, target.workflow, jobName, ...(step == null ? [] : [step]),
    ...(hint == null ? [] : [...hint.logins, ...hint.why]), ...coverage.logsUnavailable.map((u) => u.job)];
  const clean = await redactFields(ctx, fields);
  let i = 0;
  const next = () => clean[i++];
  const run = {id: target.runId, url: next(), branch: next(), commit: target.commit, workflow: next(), job: next(), step: step == null ? null : next()};
  const ownerOut = hint == null ? null : {logins: hint.logins.map(next), why: hint.why.map(next)};
  coverage.logsUnavailable = coverage.logsUnavailable.map((u) => ({runId: u.runId, job: next()}));

  const result = await out(ctx, A.assemble, {run, errors, history, ownerHint: ownerOut, coverage});
  result.summary = (await redactFields(ctx, [result.summary]))[0];
  return result;
}

// No failed run in the window: the last success, said plainly.
async function noFailedRun(ctx, listed) {
  const ok = listed.find((r) => r.conclusion === 'success');
  const coverage = {runsListed: listed.length, failedRuns: 0, logsFetched: 0, logsExpired: 0, logsTruncated: 0, logsUnavailable: [], cacheHits: 0, capHit: false, historyRebuilt: false};
  let lastSuccess = null;
  let summary = `No failed run in the last ${listed.length} runs, and no successful one either.`;
  if (ok != null) {
    const [url, branch, workflow] = await redactFields(ctx, [ok.url, ok.branch == null ? '' : ok.branch, ok.workflow]);
    lastSuccess = {id: ok.runId, url, branch, commit: ok.commit, workflow, createdAt: ok.createdAt};
    summary = `No failed run in the last ${listed.length} runs; the latest success is run ${ok.runId} (${workflow}) on ${branch} at ${short(ok.commit)}.`;
  }
  return {status: 'no-failed-run', summary, lastSuccess, coverage};
}

module.exports = {triage};
