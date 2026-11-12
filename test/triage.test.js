'use strict';
// ch-pack-ci-failure-triage/triageService.triage, run end to end in-process:
// the real parts from their tarballs, GitHub as recorded or as a small world.
const test = require('node:test');
const assert = require('node:assert');
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
  assert.deepStrictEqual(Object.keys(output), ['summary', 'run', 'errors', 'history', 'owner_hint', 'coverage']);
  assert.strictEqual(output.run.id, '42775507169');
  assert.strictEqual(output.run.step, 'Run functional tests');
  assert.strictEqual(output.run.workflow, 'CI');
  assert.strictEqual(output.history.count, 1);
  assert.strictEqual(output.history.verdict, 'new');
  assert.match(output.summary, /^Step 'Run functional tests' failed with a new signature, seen only in this run of the last 39 runs\.$/);
  assert.deepStrictEqual(output.coverage, {runsListed: 39, failedRuns: 1, logsFetched: 1, logsExpired: 0, logsTruncated: 0, logsUnavailable: [], cacheHits: 0, capHit: false});
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
  assert.strictEqual(second.output.coverage.cacheHits, first.output.coverage.logsFetched);
  assert.strictEqual(again.logsFetched(), 1, 'only the latest failed run, for its error lines');
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
  const token = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
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
