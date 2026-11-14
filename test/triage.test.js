'use strict';
// ch-pack-ci-failure-triage/triageService.ci_failure_triage, run end to end in-process:
// the real parts from their tarballs, GitHub as recorded or as a small world.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
require('./support');
const {makeCtx} = require('./fake-ctx');
const {recordedServer, world, runnerLog, sha} = require('./github');
const {triage} = require('../lib/chain');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ch-triage-'));
const at = (m) => `2026-11-10T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00Z`;
const run = (id, conclusion, m, extra = {}) => ({id, conclusion, at: at(m), ...extra});
const job = (id, log, extra = {}) => ({id, name: 'test (24)', step: 'Run npm test', log, ...extra});
const FAIL = (n) => runnerLog('Run npm test', [`✖ adds two numbers (${n}.1ms)`, `  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: ${n} !== ${n + 1}`, '      at TestContext.<anonymous> (/home/runner/work/w/w/test/add.test.js:7:10)']);

async function go(github, input, dataRoot = tmp()) {
  const ctx = makeCtx(github);
  const output = await triage({repo: 'acme/widgets', window: 50, maxLogs: 20, ownerHint: true, ...input}, ctx, {dataRoot});
  return {output, ctx, dataRoot};
}

test('the latest failed run is triaged end to end, from the recorded server', async () => {
  const gh = recordedServer();
  const {output} = await go(gh, {repo: 'mchen6/countinghouse'});
  assert.deepStrictEqual(Object.keys(output), ['summary', 'run', 'failed_jobs', 'errors', 'history', 'owner_hint', 'coverage']);
  assert.strictEqual(output.run.id, '42775507169');
  assert.strictEqual(output.run.step, 'Run functional tests');
  assert.strictEqual(output.run.workflow, 'CI');
  assert.strictEqual(output.history.count, 1);
  assert.strictEqual(output.history.verdict, 'new');
  // the recorded run failed in three jobs: all listed, all read (0.3.0)
  assert.match(output.summary, /^3 jobs failed; the pack cannot tell which ones gate the run\. Step 'Run functional tests' failed with a new signature, seen only in this run of the last 39 runs\.$/);
  assert.strictEqual(output.failed_jobs.length, 3);
  assert.deepStrictEqual(output.coverage, {runsListed: 39, failedRuns: 1, logsFetched: 3, logsExpired: 0, logsTruncated: 0, logsUnavailable: [], cacheHits: 0, capHit: false, historyRebuilt: false});
  // The recorded logs are synthetic (no raw line is kept), so they hold no error line;
  // the world below triages real-looking failures.
  assert.deepStrictEqual(output.errors, []);
});

test('runs of another workflow are not in the window', async () => {
  const gh = world({runs: [run(9, 'failure', 9, {jobs: [job(90, FAIL(1))]}), run(8, 'failure', 8, {workflow: 'pages build and deployment', jobs: [job(80, FAIL(1))]}), run(7, 'success', 7)]});
  const {output} = await go(gh, {});
  assert.strictEqual(output.coverage.runsListed, 2);
  assert.strictEqual(output.coverage.failedRuns, 1);
  assert.strictEqual(gh.logsFetched(), 1);
});

test('no failed run in the window: the last success, said plainly', async () => {
  const gh = world({runs: [run(3, 'success', 3), run(2, null, 2), run(1, 'success', 1)]});
  const {output} = await go(gh, {});
  assert.strictEqual(output.status, 'no-failed-run');
  assert.strictEqual(output.lastSuccess.id, '3');
  assert.deepStrictEqual(Object.keys(output), ['status', 'summary', 'lastSuccess', 'coverage']);
  assert.match(output.summary, /^No failed run in the last 3 runs; the latest success is run 3/);
  assert.strictEqual(output.coverage.failedRuns, 0);
  assert.strictEqual(gh.logsFetched(), 0);
});

test('coverage reports expired, truncated and unavailable logs, never hides them', async () => {
  const gh = world({runs: [
    run(6, 'failure', 6, {jobs: [job(60, FAIL(1))]}),
    run(5, 'failure', 5, {jobs: [job(50, 'expired')]}),
    run(4, 'failure', 4, {jobs: [job(40, FAIL(1), {truncate: 500})]}),
    run(3, 'failure', 3, {jobs: [job(30, 'unavailable', {name: 'lint'})]})
  ]});
  const {output} = await go(gh, {});
  assert.strictEqual(output.coverage.logsExpired, 1);
  assert.strictEqual(output.coverage.logsTruncated, 1);
  assert.deepStrictEqual(output.coverage.logsUnavailable, [{runId: '3', job: 'lint'}]);
  assert.strictEqual(output.coverage.logsFetched, 4);
  assert.match(output.summary, /; 1 log expired, 1 truncated, 1 unavailable\.$/);
});

test('the cache makes the second call fetch only new runs', async () => {
  const runs = [run(5, 'failure', 5, {jobs: [job(50, FAIL(1))]}), run(4, 'failure', 4, {jobs: [job(40, FAIL(2))]}), run(3, 'failure', 3, {jobs: [job(30, FAIL(3))]}), run(2, 'success', 2)];
  const first = await go(world({runs}), {});
  assert.strictEqual(first.output.coverage.logsFetched, 3);
  assert.strictEqual(first.output.history.count, 3, 'one signature: the numbers are normalised away');
  const again = world({runs});
  const second = await go(again, {}, first.dataRoot);
  // The latest failed run is fetched again for its error lines; the others come from the cache.
  assert.strictEqual(again.logsFetched(), 1, 'only the latest failed run, for its error lines');
  assert.strictEqual(second.output.coverage.logsFetched, 1);
  assert.strictEqual(second.output.coverage.cacheHits + second.output.coverage.logsFetched, first.output.coverage.logsFetched);
  assert.strictEqual(second.output.history.count, 3);
  const cache = JSON.parse(fs.readFileSync(path.join(first.dataRoot, 'acme__widgets', 'fingerprints.json'), 'utf8'));
  assert.strictEqual(cache.version, 1);
  assert.deepStrictEqual(Object.keys(cache.runs).sort(), ['3', '4', '5']);
  assert.ok(!JSON.stringify(cache).includes('AssertionError'), 'never a raw line in the cache');
});

test('the cap stops fetching and says so', async () => {
  const runs = Array.from({length: 8}, (_, i) => run(10 - i, 'failure', 60 - i, {jobs: [job(100 + i, FAIL(i))]}));
  const gh = world({runs});
  const {output} = await go(gh, {maxLogs: 3});
  assert.strictEqual(gh.logsFetched(), 3);
  assert.strictEqual(output.coverage.logsFetched, 3);
  assert.strictEqual(output.coverage.capHit, true);
  assert.strictEqual(output.coverage.failedRuns, 8);
});

test('error lines are redacted, and so is every other string that reaches the model', async () => {
  // Built from a repeated character: no token-shaped literal lives in this repository.
  const token = `ghp_${'A'.repeat(36)}`;
  const gh = world({runs: [run(2, 'failure', 2, {branch: `fix-${token}`, jobs: [job(20, runnerLog('Run npm test', [`Error: request failed with token ${token}`]), {name: `deploy ${token}`})]})]});
  const {output} = await go(gh, {});
  assert.ok(!JSON.stringify(output).includes(token));
  assert.ok(output.errors.some((l) => l.includes('<githubToken>')));
  assert.ok(output.run.branch.includes('<githubToken>'));
  assert.ok(output.run.job.includes('<githubToken>'));
});

test('the owner hint names logins of the first-seen commit and the group\'s other commits, never an address', async () => {
  const runs = [run(3, 'failure', 3, {jobs: [job(30, FAIL(1))]}), run(2, 'failure', 2, {jobs: [job(20, FAIL(2))]})];
  const gh = world({runs, commits: {[sha(2)]: 'first-author', [sha(3)]: 'later-author'}});
  const {output} = await go(gh, {});
  assert.deepStrictEqual(output.owner_hint.logins, ['first-author', 'later-author']);
  const none = await go(world({runs}), {ownerHint: false});
  assert.strictEqual(none.output.owner_hint, null);
});

test('the output holds no email, no token and no raw log line', async () => {
  const gh = recordedServer();
  const {output} = await go(gh, {repo: 'mchen6/countinghouse'});
  const text = JSON.stringify(output);
  assert.ok(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text), 'no address');
  assert.ok(!/gh[pousr]_[A-Za-z0-9]{20,}|github_pat_/.test(text), 'no token');
  assert.ok(!/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{7}Z /.test(text), 'no raw, timestamped log line');
  assert.ok(output.errors.length <= 40);
});

test('no receipt: the runtime adds it', async () => {
  const {output} = await go(recordedServer(), {repo: 'mchen6/countinghouse'});
  assert.ok(!('receipt' in output));
});

test('a 60,000-line log triages in under 3 seconds in-process', async () => {
  const lines = Array.from({length: 60000}, (_, i) => `ok ${i} - case ${i} passed (${i % 97}.0ms) ${'x'.repeat(40)}`);
  const big = runnerLog('Run npm test', [...lines, 'not ok 60001 - the last case']);
  assert.ok(Buffer.byteLength(big) > 5 * 1024 * 1024, 'over 5 MB');
  const gh = world({runs: [run(2, 'failure', 2, {jobs: [job(20, big)]})]});
  const started = process.hrtime.bigint();
  const {output} = await go(gh, {});
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  process.stdout.write(`# a 60,000-line log: ${ms.toFixed(0)} ms through the chain\n`);
  assert.ok(ms < 3000, `${ms} ms`);
  assert.ok(output.errors.length > 0);
});

// From /code-review medium on #1.
test('a private key block in the error lines is masked whole', async () => {
  // A key made for this test (crypto.generateKeyPairSync), never a literal: its body
  // lines are what must not reach the model.
  const pem = crypto.generateKeyPairSync('rsa', {modulusLength: 1024}).privateKey.export({type: 'pkcs1', format: 'pem'});
  const key = pem.trim().split('\n');
  const body = key.slice(1, -1);
  const gh = world({runs: [run(2, 'failure', 2, {jobs: [job(20, runnerLog('Run npm test', ['Error: bad key', ...key]))]})]});
  const {output} = await go(gh, {});
  const text = JSON.stringify(output);
  for (const line of body) assert.ok(!text.includes(line.slice(0, 24)), 'a key body line reached the output');
});

test('a history run that cannot be read is counted, not fatal', async () => {
  const runs = [run(3, 'failure', 3, {jobs: [job(30, FAIL(1))]}), run(2, 'failure', 2, {jobs: [job(20, FAIL(2))]})];
  const base = world({runs});
  const flaky = (tool, args) => (tool === 'actions_list' && args.method === 'list_workflow_jobs' && args.resource_id === '2'
    ? {isError: true, content: [{type: 'text', text: 'failed to list jobs: 502 Bad Gateway'}]} : base(tool, args));
  const {output} = await go(flaky, {});
  assert.strictEqual(output.run.id, '3');
  assert.deepStrictEqual(output.coverage.logsUnavailable, [{runId: '2', job: '(jobs unavailable)'}]);
});

test('an owner hint that cannot be read is left out, not fatal', async () => {
  const base = world({runs: [run(2, 'failure', 2, {jobs: [job(20, FAIL(1))]})]});
  const broken = (tool, args) => (tool === 'list_commits' ? {isError: true, content: [{type: 'text', text: '503 Service Unavailable'}]} : base(tool, args));
  const {output} = await go(broken, {});
  assert.ok(output.history != null);
  assert.deepStrictEqual(output.owner_hint, {logins: [], why: []});
});

test('a target whose log has expired keeps the history the cache knows', async () => {
  const runs = (log) => [run(3, 'failure', 3, {jobs: [job(30, log)]}), run(2, 'failure', 2, {jobs: [job(20, FAIL(2))]})];
  const first = await go(world({runs: runs(FAIL(1))}), {});
  assert.strictEqual(first.output.history.count, 2);
  const later = await go(world({runs: runs('expired')}), {}, first.dataRoot);
  assert.strictEqual(later.output.coverage.logsExpired, 1);
  assert.ok(later.output.history != null, 'the cached signature stands in');
  assert.strictEqual(later.output.history.count, 2);
});

test('an expired log is remembered: the next call does not fetch it again', async () => {
  const runs = [run(3, 'failure', 3, {jobs: [job(30, FAIL(1))]}), run(2, 'failure', 2, {jobs: [job(20, 'expired')]})];
  const first = await go(world({runs}), {});
  assert.strictEqual(first.output.coverage.logsExpired, 1);
  const again = world({runs});
  const second = await go(again, {}, first.dataRoot);
  assert.strictEqual(again.logsFetched(), 1, 'only the latest');
  assert.strictEqual(second.output.coverage.logsExpired, 1, 'still said');
});

test('the history window is the runs considered, not the runs listed', async () => {
  const runs = [run(9, 'failure', 9, {jobs: [job(90, FAIL(1))]}), run(8, 'success', 8, {workflow: 'pages build and deployment'}), run(7, 'failure', 7, {jobs: [job(70, FAIL(2))]})];
  const {output} = await go(world({runs}), {});
  assert.strictEqual(output.history.window, 2);
  assert.match(output.summary, /in the last 2 runs/);
});

test('a run that timed out, or failed to start, is a failed run', async () => {
  for (const conclusion of ['timed_out', 'startup_failure']) {
    const {output} = await go(world({runs: [run(2, conclusion, 2, {jobs: [job(20, FAIL(1))]}), run(1, 'success', 1)]}), {});
    assert.strictEqual(output.run.id, '2', conclusion);
    assert.strictEqual(output.coverage.failedRuns, 1, conclusion);
  }
});

test('two writers at once lose nothing: a write overtaken by another is merged again', () => {
  const {writeCache, readCache} = require('../lib/cache');
  const root = tmp();
  const real = fs.renameSync;
  let overtaken = false;
  fs.renameSync = (a, b) => {
    real(a, b);
    if (!overtaken && String(b).endsWith('fingerprints.json')) {
      overtaken = true; // another launcher's write lands right after ours, without our entry
      fs.writeFileSync(b, JSON.stringify({version: 1, runs: {other: {signature: 'b'.repeat(64)}}}));
    }
  };
  try {
    assert.strictEqual(writeCache('acme/widgets', {mine: {signature: 'a'.repeat(64)}}, root), true);
  } finally {
    fs.renameSync = real;
  }
  assert.deepStrictEqual(Object.keys(readCache('acme/widgets', root).runs).sort(), ['mine', 'other']);
});

// Cache-gap part 3: each cached run records the failure-signature algorithm
// that signed it (ch-step-failure-signature's `algorithm`). A run signed by
// another algorithm, or cached before the field, would never match the current
// signatures, so it is read again within max_logs, and coverage says the
// history was rebuilt. Expired-log markers do not depend on the algorithm and
// are kept. The algorithm comes from the target's own sign output; only when
// that log cannot be signed is an empty probe signed for it.
const cacheFile = (root) => path.join(root, 'acme__widgets', 'fingerprints.json');
const THREE = () => [run(5, 'failure', 5, {jobs: [job(50, FAIL(1))]}), run(4, 'failure', 4, {jobs: [job(40, FAIL(2))]}), run(3, 'failure', 3, {jobs: [job(30, FAIL(3))]}), run(2, 'success', 2)];
const rewriteCache = (root, fn) => { const c = JSON.parse(fs.readFileSync(cacheFile(root), 'utf8')); fn(c); fs.writeFileSync(cacheFile(root), JSON.stringify(c)); };
const signCalls = (ctx) => ctx.calls.filter((a) => /failure-signature\//.test(a)).length;

test('each cached run records the algorithm that signed it; the same algorithm keeps the cache', async () => {
  const first = await go(world({runs: THREE()}), {});
  assert.strictEqual(first.output.coverage.historyRebuilt, false, 'a first call rebuilds nothing');
  assert.strictEqual(signCalls(first.ctx), 3, 'no probe: the target\'s own sign output names the algorithm');
  const cache = JSON.parse(fs.readFileSync(cacheFile(first.dataRoot), 'utf8'));
  assert.deepStrictEqual(Object.values(cache.runs).map((r) => r.algorithm), ['fs1+rules2', 'fs1+rules2', 'fs1+rules2']);
  const again = world({runs: THREE()});
  const second = await go(again, {}, first.dataRoot);
  assert.strictEqual(again.logsFetched(), 1, 'only the latest failed run, for its error lines');
  assert.strictEqual(second.output.coverage.cacheHits, 2);
  assert.strictEqual(second.output.coverage.historyRebuilt, false);
  assert.ok(!/history rebuilt/.test(second.output.summary));
});

for (const [why, set] of [['another algorithm', (r) => { r.algorithm = 'fs0+rules2'; }], ['no algorithm (cached before the field)', (r) => { delete r.algorithm; }],
  // 0.2.0's cache: the same signature algorithm, made from lines extracted by
  // error-patterns' rules 1 (its JSON records and repeats not yet noise)
  ['0.2.0\'s key (the signature algorithm alone, before the extraction rules joined it)', (r) => { r.algorithm = 'fs1'; }]]) {
  test(`runs cached with ${why} are read again, and coverage says the history was rebuilt`, async () => {
    const first = await go(world({runs: THREE()}), {});
    rewriteCache(first.dataRoot, (c) => { for (const r of Object.values(c.runs)) { set(r); r.signature = 'stale-signature'; } });
    const again = world({runs: THREE()});
    const second = await go(again, {}, first.dataRoot);
    assert.strictEqual(again.logsFetched(), 3, 'every failed run read again');
    assert.strictEqual(second.output.coverage.cacheHits, 0);
    assert.strictEqual(second.output.coverage.historyRebuilt, true);
    assert.strictEqual(second.output.history.count, 3, 'the history from the current signatures');
    assert.match(second.output.summary, /; history rebuilt \(the failure signature changed\)/);
    const rewritten = JSON.parse(fs.readFileSync(cacheFile(first.dataRoot), 'utf8'));
    assert.ok(!JSON.stringify(rewritten).includes('stale-signature'), 'every one rewritten with the current algorithm');
    assert.deepStrictEqual(Object.values(rewritten.runs).map((r) => r.algorithm), ['fs1+rules2', 'fs1+rules2', 'fs1+rules2']);
  });
}

test('expired-log markers do not depend on the algorithm: a rebuild does not fetch them again', async () => {
  const runs = [run(5, 'failure', 5, {jobs: [job(50, FAIL(1))]}), run(4, 'failure', 4, {jobs: [job(40, 'expired')]}), run(3, 'failure', 3, {jobs: [job(30, FAIL(3))]})];
  const first = await go(world({runs}), {});
  rewriteCache(first.dataRoot, (c) => { for (const r of Object.values(c.runs)) if (r.expired !== true) r.algorithm = 'fs0'; });
  const again = world({runs});
  const second = await go(again, {}, first.dataRoot);
  assert.strictEqual(again.logsFetched(), 2, 'the two signed runs, not the expired one');
  assert.strictEqual(second.output.coverage.historyRebuilt, true);
  assert.strictEqual(second.output.coverage.logsExpired, 1);
});

test('a rebuild stays within max_logs: the rest is the cap, as ever', async () => {
  const first = await go(world({runs: THREE()}), {});
  rewriteCache(first.dataRoot, (c) => { for (const r of Object.values(c.runs)) r.algorithm = 'fs0'; });
  const second = await go(world({runs: THREE()}), {maxLogs: 2}, first.dataRoot);
  assert.strictEqual(second.output.coverage.logsFetched, 2);
  assert.strictEqual(second.output.coverage.capHit, true);
  assert.strictEqual(second.output.coverage.historyRebuilt, true);
});

test('when the target\'s log cannot be signed, the algorithm comes from a probe; a probe that fails costs the cache, never the answer', async () => {
  const runs = [run(5, 'failure', 5, {jobs: [job(50, 'expired')]}), run(4, 'failure', 4, {jobs: [job(40, FAIL(2))]})];
  const first = await go(world({runs}), {});
  assert.strictEqual(signCalls(first.ctx), 2, 'one real run signed, and the probe for the expired target');
  const ctx = makeCtx(world({runs}));
  const real = ctx.call;
  ctx.call = async (address, input) => {
    if (/failure-signature\//.test(address) && Array.isArray(input.lines) && input.lines.length === 0) throw new Error('probe refused');
    return real(address, input);
  };
  const output = await triage({repo: 'acme/widgets', window: 50, maxLogs: 20, ownerHint: true}, ctx, {dataRoot: first.dataRoot});
  assert.ok(output.coverage != null, 'still an answer');
  assert.strictEqual(output.coverage.historyRebuilt, false, 'an unknown algorithm is not a changed one');
});

test('an older signature step that names no algorithm keeps the cache it made, as before', async () => {
  const strip = (ctx) => { const real = ctx.call; ctx.call = async (a, i) => { const r = await real(a, i); if (/failure-signature\//.test(a)) delete r.output.algorithm; return r; }; return ctx; };
  const dataRoot = tmp();
  const runOld = (w) => triage({repo: 'acme/widgets', window: 50, maxLogs: 20, ownerHint: true}, strip(makeCtx(w)), {dataRoot});
  await runOld(world({runs: THREE()}));
  const again = world({runs: THREE()});
  const second = await runOld(again);
  assert.strictEqual(again.logsFetched(), 1);
  assert.strictEqual(second.coverage.cacheHits, 2);
  assert.strictEqual(second.coverage.historyRebuilt, false);
});

test('no failed run: coverage still states historyRebuilt, false', async () => {
  const {output} = await go(world({runs: [run(2, 'success', 2)]}), {});
  assert.strictEqual(output.coverage.historyRebuilt, false);
});

// 0.3.0: every failed job of the run (dogfood of run 43497750749, the
// reviewer, 2026-11-13): listed in GitHub's order with its failing step and
// first error, with no gating mark, and a summary saying the pack cannot tell.
const MOCHA_FAIL = runnerLog('Run npm test', [
  '  27 passing (2m)', '  1 failing', '',
  '  1) remote 07: usage records for remote calls, and the call id across every hop',
  '       the call id is carried unchanged …:',
  "     TypeError: Cannot read properties of null (reading 'usageCall')",
  '      at Context.<anonymous> (test/remote/07-usage-records.js:212:31)']);
const WINDOWS = runnerLog('Run stdio tests', [
  JSON.stringify({name: 'countinghouse', hostname: 'runner', pid: 9612, level: 50, e: "worker exit on error: ENOENT: no such file or directory, realpath 'D:\\a\\lib\\cli-options.js'", msg: '', time: 't'}),
  JSON.stringify({name: 'countinghouse', hostname: 'runner', pid: 7600, level: 50, e: "worker exit on error: ENOENT: no such file or directory, realpath 'D:\\a\\lib\\cli-options.js'", msg: '', time: 't'}),
  JSON.stringify({name: 'countinghouse', hostname: 'runner', pid: 7600, level: 30, msg: 'module sandbox: m effective permissions {"fs":[]}', time: 't'})]);

test('every failed job is listed with its step and first error; the test (24) failure surfaces next to a failed Windows job', async () => {
  const runs = [run(9, 'failure', 9, {jobs: [
    {id: 91, name: 'stdio (windows-latest)', step: 'Run stdio tests', log: WINDOWS},
    {id: 92, name: 'test (24)', step: 'Run npm test', log: MOCHA_FAIL},
    {id: 93, name: 'sandbox-floor (22)', step: 'Run npm test', log: FAIL(1)}]}), run(8, 'success', 8)];
  const {output} = await go(world({runs}), {});
  assert.deepStrictEqual(output.failed_jobs.map((j) => j.job), ['stdio (windows-latest)', 'test (24)', 'sandbox-floor (22)']);
  assert.strictEqual(output.failed_jobs[1].first_error,
    "1) remote 07: usage records for remote calls, and the call id across every hop -- TypeError: Cannot read properties of null (reading 'usageCall')");
  assert.strictEqual(output.failed_jobs[0].first_error, "worker exit on error: ENOENT: no such file or directory, realpath 'D:\\a\\lib\\cli-options.js' (2 times)");
  assert.match(output.failed_jobs[2].first_error, /AssertionError/);
  assert.ok(output.summary.startsWith('3 jobs failed; the pack cannot tell which ones gate the run. '), output.summary);
  assert.ok(!JSON.stringify(output.errors).includes('effective permissions'), 'an info record is not an error line');
  assert.ok(output.errors.some((e) => e.endsWith('(2 times)')), JSON.stringify(output.errors));
});

test('a failed job\'s first error passes through ch-step-redact', async () => {
  const secret = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
  const runs = [run(9, 'failure', 9, {jobs: [job(91, FAIL(1)),
    {id: 92, name: 'deploy', step: 'Run deploy', log: runnerLog('Run deploy', [`Error: push refused for token ${secret}`])}]})];
  const {output} = await go(world({runs}), {});
  assert.ok(!JSON.stringify(output).includes(secret), JSON.stringify(output.failed_jobs));
  assert.match(output.failed_jobs[1].first_error, /Error: push refused for token <githubToken>/);
});

test('sign is given only its own fields (its input is closed): no rules, no repeats, no failure numbers', async () => {
  const runs = [run(9, 'failure', 9, {jobs: [{id: 92, name: 'test (24)', step: 'Run npm test', log: MOCHA_FAIL}]})];
  const given = [];
  const github = world({runs});
  const ctx = makeCtx(github);
  const call = ctx.call;
  ctx.call = async (address, input) => {
    if (/failure-signature\//.test(address)) given.push(input);
    return call(address, input);
  };
  await triage({repo: 'acme/widgets', window: 50, maxLogs: 20, ownerHint: false}, ctx, {dataRoot: tmp()});
  for (const input of given) {
    assert.deepStrictEqual(Object.keys(input).sort(), ['failingStep', 'lines', 'truncated']);
    for (const l of input.lines) assert.deepStrictEqual(Object.keys(l).sort(), ['index', 'kind', 'step', 'text']);
  }
  assert.ok(given.length > 0);
});

test('other jobs\' logs count toward max_logs: past it a job is listed with no first error', async () => {
  const runs = [run(9, 'failure', 9, {jobs: Array.from({length: 4}, (_, i) => ({id: 90 + i, name: `job ${i}`, step: 'Run npm test', log: FAIL(i + 1)}))})];
  const {output} = await go(world({runs}), {maxLogs: 2});
  assert.deepStrictEqual(output.failed_jobs.map((j) => j.first_error != null), [true, true, false, false]);
  assert.strictEqual(output.coverage.capHit, true);
});
