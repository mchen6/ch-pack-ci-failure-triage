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
