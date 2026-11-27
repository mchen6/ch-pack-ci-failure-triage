'use strict';
require('./tmp-dirs');
// The window's other runs are listed for their failed jobs a few at a time
// (at most four calls at once), each batch within what is left of the
// budget, and accounted in run order once it settles: the same runs listed,
// the same calls, the same cache and verdicts as one at a time. A refusal
// GitHub gives for a rate limit (ch-access-github's details.rateLimited) stops
// every further GitHub call of the triage, as GitHub asks: the runs left are
// not compared (capHit), so no verdict can come of them. Only the access
// module's own codes, and the remote not answering, count a run as not
// compared; anything the runtime refuses fails the triage, named.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {CountinghouseError} = require('countinghouse/lib/countinghouse-error');
const {makeCtx} = require('./fake-ctx');
const {world, runnerLog} = require('./github');
const {triage} = require('../lib/chain');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ch-triage-'));
const at = (m) => `2026-11-10T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00Z`;
const run = (id, conclusion, m, extra = {}) => ({id, conclusion, at: at(m), ...extra});
const job = (id, log, extra = {}) => ({id, name: 'test (24)', step: 'Run npm test', log, ...extra});
const FAIL = (n) => runnerLog('Run npm test', [`✖ adds two numbers (${n}.1ms)`, `  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: ${n} !== ${n + 1}`, '      at TestContext.<anonymous> (/home/runner/work/w/w/test/add.test.js:7:10)']);
const refused = (text) => ({isError: true, content: [{type: 'text', text}]});
const TOO_MANY = (id) => `failed to list workflow jobs: GET https://github.invalid/repos/acme/widgets/actions/runs/${id}/jobs: 429 Too Many Requests []`;
const BAD_GATEWAY = (id) => `failed to list workflow jobs: GET https://github.invalid/repos/acme/widgets/actions/runs/${id}/jobs: 502 Bad Gateway []`;

// runs 30 (the triaged one) down to 19, each failed with one job of the same
// name; a success at the end
const runs = () => [...Array.from({length: 12}, (_, i) => run(30 - i, 'failure', 100 - i, {jobs: [job(300 - i * 10, FAIL(i % 3))]})), run(18, 'success', 80)];

// the world, its job listings answered after a delay, counted while in flight;
// answer(runId) may replace a listing's answer
function slow(gh, {answer = () => null, ms = 15} = {}) {
  let now = 0;
  const served = async (tool, args) => {
    if (tool === 'actions_list' && args.method === 'list_workflow_jobs') {
      now += 1;
      served.max = Math.max(served.max, now);
      served.order.push(args.resource_id);
      await new Promise((resolve) => setTimeout(resolve, ms));
      now -= 1;
      const own = answer(args.resource_id);
      if (own != null) { gh.seen.push({tool, args}); return own; }
    }
    return gh(tool, args);
  };
  served.max = 0;
  served.order = [];
  served.seen = gh.seen;
  return served;
}

async function go(github, input, {listAtOnce, wrap} = {}) {
  const ctx = makeCtx(github);
  if (wrap != null) { const call = ctx.call; ctx.call = (address, args) => wrap(address, args, call); }
  const dataRoot = tmp();
  // (one key for every run, so two caches can be compared byte for byte)
  fs.writeFileSync(path.join(dataRoot, '.pack-key'), Buffer.alloc(32, 7), {mode: 0o600});
  const output = await triage({repo: 'acme/widgets', window: 50, maxLogs: 20, ownerHint: true, ...input}, ctx, {dataRoot, ...(listAtOnce == null ? {} : {listAtOnce})});
  return {output, ctx, dataRoot};
}
const filesOf = (dir) => Object.fromEntries(fs.readdirSync(dir, {recursive: true}).filter((f) => fs.statSync(path.join(dir, f)).isFile()).sort().map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));
const callsOf = (seen) => seen.map((s) => JSON.stringify([s.tool, s.args])).sort();

test('the window\'s other runs are listed at most four at once', async () => {
  const gh = slow(world({runs: runs()}));
  await go(gh, {});
  assert.strictEqual(gh.order.length, 12, 'the triaged run and the eleven others, each listed once');
  assert.strictEqual(gh.max, 4);
});

test('a few at a time gives what one at a time gives: the same calls, cache and verdicts, failures and the budget included', async () => {
  for (const [maxLogs, failing] of [[20, []], [20, ['26', '23']], [6, ['29', '25', '24']], [3, ['29', '28', '27', '26']], [5, ['22', '21', '20', '19']]]) {
    const answer = (id) => (failing.includes(id) ? refused(BAD_GATEWAY(id)) : null);
    const one = slow(world({runs: runs()}), {answer});
    const few = slow(world({runs: runs()}), {answer});
    const a = await go(one, {maxLogs}, {listAtOnce: 1});
    const b = await go(few, {maxLogs});
    const label = JSON.stringify({maxLogs, failing});
    assert.strictEqual(one.max, 1, label);
    assert.deepStrictEqual(b.output, a.output, label);
    assert.deepStrictEqual(callsOf(few.seen), callsOf(one.seen), label);
    assert.deepStrictEqual(filesOf(b.dataRoot), filesOf(a.dataRoot), label);
  }
});

test('a listing refused for a rate limit stops every further GitHub call: the calls under way finish, the runs left are not compared', async () => {
  const gh = slow(world({runs: runs(), commits: {}}), {answer: (id) => (id === '26' ? refused(TOO_MANY(id)) : null)});
  const {output} = await go(gh, {});
  // the triaged run's listing, then the batch that met the limit (29-26); none after it
  assert.deepStrictEqual(gh.order, ['30', '29', '28', '27', '26']);
  const after = gh.seen.slice(gh.seen.findIndex((s) => s.args.resource_id === '26') + 1);
  assert.deepStrictEqual(after.filter((s) => s.tool !== 'actions_list' || s.args.method !== 'list_workflow_jobs').map((s) => s.tool), [], 'no log, no commit read after it');
  assert.strictEqual(output.coverage.capHit, true);
  assert.deepStrictEqual(output.coverage.logsUnavailable, [{runId: '26', job: '(jobs unavailable)'}]);
  assert.strictEqual(output.failed_jobs[0].history.verdict, 'unknown');
  assert.strictEqual(output.owner_hint, null, 'no commit asked for');
});

test('a history log refused for a rate limit stops every further GitHub call too', async () => {
  const gh = world({runs: runs()});
  const limited = async (tool, args) => (tool === 'get_job_logs' && String(args.job_id) === '280'
    ? (gh.seen.push({tool, args}), refused(`failed to get job logs: GET https://github.invalid/repos/acme/widgets/actions/jobs/280/logs: 429 Too Many Requests []`))
    : gh(tool, args));
  limited.seen = gh.seen;
  const {output} = await go(limited, {});
  const i = gh.seen.findIndex((s) => s.tool === 'get_job_logs' && String(s.args.job_id) === '280');
  assert.ok(i > 0);
  assert.deepStrictEqual(gh.seen.slice(i + 1).map((s) => s.tool), [], 'nothing asked of GitHub after it');
  assert.strictEqual(output.coverage.capHit, true);
  // what was read stands (run 29 failed the same way: the signature has no
  // numbers), and every run left counts as not compared: never "new"
  const h = output.failed_jobs[0].history;
  assert.deepStrictEqual([h.verdict, h.count, h.notCompared], ['recurring', 2, 10]);
});

test('a listing the remote does not answer (REMOTE_TIMEOUT, REMOTE_UNREACHABLE) counts its run as not compared, as GitHub\'s refusal does', async () => {
  for (const code of ['REMOTE_TIMEOUT', 'REMOTE_UNREACHABLE']) {
    const gh = world({runs: runs()});
    const wrap = (address, args, call) => (address.endsWith('githubService.failedJobs') && args.runId === '27' ? Promise.reject(new CountinghouseError(code)) : call(address, args));
    const {output} = await go(gh, {}, {wrap});
    assert.deepStrictEqual(output.coverage.logsUnavailable, [{runId: '27', job: '(jobs unavailable)'}], code);
  }
});

test('anything the runtime refuses of a listing or a history log fails the triage, named, never "not compared"', async () => {
  // (UPSTREAM_ERROR: no code the access module raises -- older tests faked a
  // failed listing with it; it is a fault, never "not compared")
  for (const [code, where] of [['VALIDATION_TIMEOUT', 'failedJobs'], ['RUNTIME_BUSY', 'failedJobs'], ['UPSTREAM_ERROR', 'failedJobs'], ['OUTPUT_DATA_VALIDATION_FAIL', 'failedJobs'], ['VALIDATION_TIMEOUT', 'jobLog'], ['RUNTIME_BUSY', 'jobLog']]) {
    const gh = world({runs: runs()});
    const wrap = (address, args, call) => {
      if (where === 'failedJobs' && address.endsWith('githubService.failedJobs') && args.runId === '27') return Promise.reject(new CountinghouseError(code));
      if (where === 'jobLog' && address.endsWith('githubService.jobLog') && args.jobId === '280') return Promise.reject(new CountinghouseError(code));
      return call(address, args);
    };
    await assert.rejects(go(gh, {}, {wrap}), (err) => err.code === code, `${code} on ${where}`);
  }
});

test('the summary says a limit was reached, whichever stopped the reading: logs, listings, the 50 unavailable, a rate limit', async () => {
  const LINE = '; a limit was reached, so some logs or job lists were not read';
  const many = (n) => [...Array.from({length: n}, (_, i) => run(200 - i, 'failure', 300 - i, {jobs: [job(2000 - i * 10, FAIL(i % 3))]})), run(18, 'success', 80)];
  const cases = [
    ['max_logs, logs', world({runs: runs()}), {maxLogs: 2}],
    ['max_logs, listings', world({runs: many(30)}), {maxLogs: 5}],
    ['the 50 unavailable', slow(world({runs: many(60)}), {ms: 1, answer: (id) => (id !== '200' ? refused(BAD_GATEWAY(id)) : null)}), {window: 100, maxLogs: 50}],
    ['a rate limit', slow(world({runs: runs()}), {ms: 1, answer: (id) => (id === '26' ? refused(TOO_MANY(id)) : null)}), {}]
  ];
  for (const [cause, gh, input] of cases) {
    const {output} = await go(gh, input);
    assert.strictEqual(output.coverage.capHit, true, cause);
    assert.ok(output.summary.includes(LINE), `${cause}: ${output.summary}`);
  }
  const {output} = await go(world({runs: runs()}), {});
  assert.strictEqual(output.coverage.capHit, false);
  assert.ok(!output.summary.includes('a limit was reached'), output.summary);
});

test('every refusal from GitHub\'s side counts as not compared: a run of too many jobs, an answer over the remote bound or not MCP', async () => {
  for (const [code, where] of [['JOBS_INCOMPLETE', 'failedJobs'], ['REMOTE_RESULT_TOO_LARGE', 'failedJobs'], ['REMOTE_PROTOCOL', 'failedJobs'], ['REMOTE_RESULT_TOO_LARGE', 'jobLog'], ['REMOTE_PROTOCOL', 'jobLog']]) {
    const gh = world({runs: runs()});
    const wrap = (address, args, call) => {
      if (where === 'failedJobs' && address.endsWith('githubService.failedJobs') && args.runId === '27') return Promise.reject(new CountinghouseError(code));
      if (where === 'jobLog' && address.endsWith('githubService.jobLog') && args.jobId === '280') return Promise.reject(new CountinghouseError(code));
      return call(address, args);
    };
    const {output} = await go(gh, {}, {wrap});
    assert.deepStrictEqual(output.coverage.logsUnavailable, [where === 'failedJobs' ? {runId: '27', job: '(jobs unavailable)'} : {runId: '28', job: 'test (24)'}], `${code} on ${where}`);
  }
});

test('after a rate limit in a batch, what the rest of that batch met is never a fault: those calls would not have been made one at a time', async () => {
  const gh = world({runs: runs()});
  const limited = slow(gh, {answer: (id) => (id === '27' ? refused(TOO_MANY(id)) : null)});
  const wrap = (address, args, call) => (address.endsWith('githubService.failedJobs') && args.runId === '26' ? Promise.reject(new CountinghouseError('VALIDATION_TIMEOUT')) : call(address, args));
  const {output} = await go(limited, {}, {wrap});
  assert.strictEqual(output.coverage.capHit, true);
  assert.ok(output.coverage.logsUnavailable.some((u) => u.runId === '27'), JSON.stringify(output.coverage.logsUnavailable));
});

test('a rate limit met reading the owner hint\'s commits says a limit was reached', async () => {
  const gh = world({runs: [run(30, 'failure', 100, {jobs: [job(300, FAIL(1))]}), run(29, 'failure', 99, {jobs: [job(290, FAIL(1))]})]});
  const limited = async (tool, args) => (tool === 'list_commits' ? (gh.seen.push({tool, args}), refused('failed to list commits: GET https://github.invalid/repos/acme/widgets/commits: 429 Too Many Requests []')) : gh(tool, args));
  limited.seen = gh.seen;
  const {output} = await go(limited, {});
  assert.strictEqual(gh.seen.filter((s) => s.tool === 'list_commits').length, 1, 'one commit asked for, none after the limit');
  assert.strictEqual(output.coverage.capHit, true);
  assert.ok(output.summary.includes('; a limit was reached, so some logs or job lists were not read'), output.summary);
});
