'use strict';
// The chain (spec §5): listRuns -> the latest failed run (or run_id) ->
// failedJobs -> jobLog -> log-clean -> error-patterns -> failure-signature, the
// same for every other failed run in the window that the cache does not know
// (up to max_logs logs per call) -> dedupe -> runCommits and owner-hint ->
// redact -> report. Every string that reaches the model goes through
// ch-step-redact. Coverage says what was not seen: expired, truncated and
// unavailable logs, the cap. No receipt: the runtime adds it.
const {ADDRESSES: A} = require('./addresses');
const {readCache, writeCache, hash, config} = require('./cache');

const MAX_ERROR_LINES = 40;
const MAX_STEP_COMMITS = 5;
const SHA = /^[0-9a-f]{40}$/;

const out = async (ctx, address, input) => (await ctx.call(address, input)).output;
const short = (commit) => String(commit).slice(0, 7);
const conclusionOf = (c) => (c === 'failure' ? 'failure' : c === 'success' ? 'success' : 'other');

// Redacts strings; a field list keeps its length (a key block spread over
// fields would otherwise merge them), so a list that changes length is
// redacted one string at a time.
async function redact(ctx, strings) {
  if (strings.length === 0) return [];
  const {lines} = await out(ctx, A.redact, {lines: strings});
  if (lines.length === strings.length) return lines;
  return Promise.all(strings.map(async (s) => (await out(ctx, A.redact, {lines: [s]})).lines.join(' ')));
}

async function triage({repo, runId, window, maxLogs, ownerHint}, ctx, {dataRoot = config.root} = {}) {
  const listed = (await out(ctx, A.listRuns, {repo, limit: window})).runs;
  let target;
  if (runId != null) {
    target = listed.find((r) => r.runId === runId);
    if (target == null) throw ctx.error('RUN_NOT_FOUND', `run ${runId} is not among the last ${listed.length} runs of ${repo}`);
  } else {
    target = listed.find((r) => r.conclusion === 'failure');
  }
  if (target == null) return noFailedRun(ctx, listed);

  const considered = listed.filter((r) => r.workflow === target.workflow);
  const failed = considered.filter((r) => r.conclusion === 'failure');
  const cache = readCache(repo, dataRoot);
  const fresh = {};
  const coverage = {runsListed: considered.length, failedRuns: failed.length, logsFetched: 0, logsExpired: 0, logsTruncated: 0, logsUnavailable: [], cacheHits: 0, capHit: false};

  // One run's first failed job, its log, its error lines and signature.
  const read = async (r) => {
    const jobs = (await out(ctx, A.failedJobs, {repo, runId: r.runId})).jobs;
    const job = jobs[0];
    if (job == null) return {job: null};
    const failingStep = (job.steps.find((s) => s.conclusion === 'failure') || {}).name || null;
    coverage.logsFetched += 1;
    let log;
    try {
      log = await out(ctx, A.jobLog, {repo, jobId: job.jobId});
    } catch (err) {
      if (err == null || err.code !== 'LOG_UNAVAILABLE') throw err;
      coverage.logsUnavailable.push({runId: r.runId, job: job.name});
      return {job, failingStep};
    }
    if (log.expired) { coverage.logsExpired += 1; return {job, failingStep}; }
    if (log.truncated) coverage.logsTruncated += 1;
    const {steps} = await out(ctx, A.clean, {text: log.text});
    const extracted = await out(ctx, A.extract, {steps, maxLines: MAX_ERROR_LINES, stepConclusions: job.steps.map((s) => ({name: s.name, conclusion: s.conclusion}))});
    const signed = await out(ctx, A.sign, extracted);
    fresh[r.runId] = {jobId: job.jobId, signature: signed.signature, step: signed.step, commit: r.commit, createdAt: r.createdAt, errorLineHashes: signed.normalised.map(hash)};
    return {job, failingStep, signature: signed.signature, lines: extracted.lines.map((l) => l.text)};
  };

  const signatures = {};
  const mine = await read(target);
  if (cache.runs[target.runId] != null) coverage.cacheHits += 1;
  if (mine.signature != null) signatures[target.runId] = mine.signature;
  for (const r of failed) {
    if (r.runId === target.runId) continue;
    if (cache.runs[r.runId] != null) { signatures[r.runId] = cache.runs[r.runId].signature; coverage.cacheHits += 1; continue; }
    if (coverage.logsFetched >= maxLogs) { coverage.capHit = true; continue; }
    const got = await read(r);
    if (got.signature != null) signatures[r.runId] = got.signature;
  }
  writeCache(repo, fresh, dataRoot);

  const dedupeRuns = considered
    .filter((r) => typeof r.branch === 'string' && SHA.test(r.commit))
    .map((r) => ({runId: r.runId, conclusion: conclusionOf(r.conclusion), commit: r.commit, branch: r.branch, createdAt: r.createdAt,
      ...(r.conclusion === 'failure' && signatures[r.runId] != null ? {signature: signatures[r.runId]} : {})}));
  const {groups} = await out(ctx, A.group, {window, runs: dedupeRuns});
  const group = mine.signature == null ? null : groups.find((g) => g.signature === mine.signature) || null;
  const history = group == null ? null : {signature: group.signature, count: group.count, window, verdict: group.verdict, firstSeen: group.firstSeen, lastSeen: group.lastSeen, runIds: group.runIds};

  let hint = null;
  if (ownerHint && history != null) {
    const login = async (commit) => {
      try { return (await out(ctx, A.runCommits, {repo, commit})).authorLogin; } catch (err) { if (err != null && err.code === 'COMMIT_NOT_FOUND') return null; throw err; }
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
  const errors = await redact(ctx, (mine.lines || []).slice(0, MAX_ERROR_LINES));
  const jobName = mine.job != null ? mine.job.name : '(no failed job)';
  const step = mine.failingStep || null;
  const fields = [target.url, target.branch == null ? '' : target.branch, target.workflow, jobName, ...(step == null ? [] : [step]),
    ...(hint == null ? [] : [...hint.logins, ...hint.why]), ...coverage.logsUnavailable.map((u) => u.job)];
  const clean = await redact(ctx, fields);
  let i = 0;
  const next = () => clean[i++];
  const run = {id: target.runId, url: next(), branch: next(), commit: target.commit, workflow: next(), job: next(), step: step == null ? null : next()};
  const ownerOut = hint == null ? null : {logins: hint.logins.map(next), why: hint.why.map(next)};
  coverage.logsUnavailable = coverage.logsUnavailable.map((u) => ({runId: u.runId, job: next()}));

  const result = await out(ctx, A.assemble, {run, errors, history, ownerHint: ownerOut, coverage});
  result.summary = (await redact(ctx, [result.summary]))[0];
  return result;
}

// No failed run in the window: the last success, said plainly.
async function noFailedRun(ctx, listed) {
  const ok = listed.find((r) => r.conclusion === 'success');
  const coverage = {runsListed: listed.length, failedRuns: 0, logsFetched: 0, logsExpired: 0, logsTruncated: 0, logsUnavailable: [], cacheHits: 0, capHit: false};
  let lastSuccess = null;
  let summary = `No failed run in the last ${listed.length} runs, and no successful one either.`;
  if (ok != null) {
    const [url, branch, workflow] = await redact(ctx, [ok.url, ok.branch == null ? '' : ok.branch, ok.workflow]);
    lastSuccess = {id: ok.runId, url, branch, commit: ok.commit, workflow, createdAt: ok.createdAt};
    summary = `No failed run in the last ${listed.length} runs; the latest success is run ${ok.runId} (${workflow}) on ${branch} at ${short(ok.commit)}.`;
  }
  return {status: 'no-failed-run', summary, lastSuccess, coverage};
}

module.exports = {triage};
