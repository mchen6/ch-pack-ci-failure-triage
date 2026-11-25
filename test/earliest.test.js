'use strict';
require('./tmp-dirs');
// The oldest of the runs compared says it is: with no older run compared, a
// failure is easily read as one that came with a change.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {makeCtx} = require('./fake-ctx');
const {world, runnerLog} = require('./github');
const {triage} = require('../lib/chain');

const EARLIEST = ', of which this is the earliest';
const FAIL = (name) => runnerLog('Run npm test', [`✖ ${name} (1ms)`, '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:', '  1 !== 2']);
let nextJob = 1000;
const job = (name, log) => ({id: nextJob++, name, step: 'Test', log});
const run = (id, jobs, extra = {}) => ({id, conclusion: 'failure', branch: 'b', at: `2026-11-10T00:${String(id).padStart(2, '0')}:00Z`, jobs, ...extra});
const ok = (id, extra = {}) => run(id, [], {conclusion: 'success', ...extra});
const go = async(runs, runId, {input = {}, wrap = (ctx) => ctx, dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-earliest-'))} = {}) => (await triage({repo: 'acme/widgets', runId, window: 50, maxLogs: 20, ownerHint: false, ...input}, wrap(makeCtx(world({runs}))),
  {dataRoot})).summary;

test('one new job in the oldest run compared', async() => {
  assert.match(await go([ok(3), ok(2), run(1, [job('test', FAIL('t one'))])], '1'), /no job of this name did in the last 3 runs, of which this is the earliest\. The fields/);
});

test('not in a run that has an older one, nor when it is the only one', async() => {
  assert.ok(!(await go([ok(3), run(2, [job('test', FAIL('t one'))]), ok(1)], '2')).includes('earliest'));
  const alone = await go([run(1, [job('test', FAIL('t one'))])], '1');
  assert.match(alone, /there is no other run to compare it with/);
  assert.ok(!alone.includes('earliest'));
});

// (with one other run in the sentence, "this" could be read as that one)
test('never in the sentence for one job that could not be told', async() => {
  const summary = await go([run(2, [job('test', 'expired')]), run(1, [job('test', FAIL('t one'))])], '1');
  assert.match(summary, /could not be told: 1 other run in the last 2 runs could not be compared/);
  assert.ok(!summary.includes('earliest'), summary);
  // (nor when it is given what the other two take)
  const {summaries} = require('../lib/chain');
  for (const k of [0, 1, 7]) assert.ok(!summaries.cannotTell('s', {notCompared: k}, 9, {logsExpired: 0, logsTruncated: 0, logsUnavailable: []}, true).includes('earliest'), String(k));
});

// (an older run whose workflow can't be told may be its workflow's)
const unplaced = (id) => (ctx) => {
  const call = ctx.call;
  ctx.call = async(address, i) => {
    const o = await call(address, i);
    if (/githubService\.listRuns$/.test(address)) for (const r of o.output.runs) { delete r.workflowId; if (r.runId === id) r.workflow = ''; }
    return o;
  };
  return ctx;
};
test('not when an older run could be of its workflow, that passed or not; a newer one is no matter', async() => {
  const one = () => run(2, [job('test', FAIL('t one'))]);
  assert.ok(!(await go([ok(3), one(), ok(1)], '2', {wrap: unplaced('1')})).includes('earliest'), 'one new job');
  const two = () => run(2, [job('test', FAIL('t one')), job('lint', FAIL('t lint'))]);
  assert.ok(!(await go([ok(3), two(), run(1, [job('test', FAIL('t one'))])], '2', {wrap: unplaced('1')})).includes('earliest'), 'several');
  assert.ok((await go([ok(3), one()], '2', {wrap: unplaced('9')})).includes(EARLIEST));
  assert.ok((await go([ok(4), ok(3), one()], '2', {wrap: unplaced('4')})).includes(EARLIEST), 'a newer one');
});

test('not in a run that was re-run (its time is its first attempt\'s), nor when a time can\'t be read', async() => {
  const wrap = (change) => (ctx) => {
    const call = ctx.call;
    ctx.call = async(address, i) => {
      const o = await call(address, i);
      if (/githubService\.listRuns$/.test(address)) for (const r of o.output.runs) change(r);
      return o;
    };
    return ctx;
  };
  const runs = () => [ok(2), run(1, [job('test', FAIL('t one'))])];
  assert.ok(!(await go(runs(), '1', {wrap: wrap((r) => { r.attempt = r.runId === '1' ? 2 : 1; })})).includes('earliest'));
  assert.ok((await go(runs(), '1', {wrap: wrap((r) => { r.attempt = 1; })})).includes(EARLIEST));
  const {summaries} = require('../lib/chain');
  const at = (runId, createdAt, rest) => ({runId, createdAt, ...rest});
  assert.strictEqual(summaries.earliest(at('9', '2026-11-10T00:00:00Z'), [at('9', '2026-11-10T00:00:00Z'), at('10', '')]), false);
  assert.strictEqual(summaries.earliest(at('9', ''), [at('9', ''), at('10', '2026-11-10T00:00:00Z')]), false);
});

test('whatever the order of the list', async() => {
  const {summaries} = require('../lib/chain');
  const r = (id, minute) => ({runId: id, createdAt: `2026-11-10T00:0${minute}:00Z`});
  const all = [r('5', 1), r('7', 3), r('6', 2)];
  assert.deepStrictEqual(all.map((x) => summaries.earliest(x, all)), [true, false, false]);
});

test('several jobs', async() => {
  const two = () => run(1, [job('test', FAIL('t one')), job('lint', FAIL('t lint'))]);
  assert.match(await go([ok(2), two()], '1'), /Compared by job name over the last 2 runs, of which this is the earliest: 2 new;/);
  assert.ok(!(await go([{...two(), id: 2, at: '2026-11-10T00:02:00Z'}, ok(1)], '2')).includes('earliest'));
  const alone = await go([two()], '1');
  assert.match(alone, /Compared by job name over the last run: 2 /);
  assert.ok(!alone.includes('earliest'), alone);
});

test('two runs of one time: the smaller run id is the older', async() => {
  const at = '2026-11-10T00:00:00Z';
  assert.ok((await go([ok(10, {at}), run(9, [job('test', FAIL('t one'))], {at})], '9')).includes(EARLIEST));
  assert.ok(!(await go([run(10, [job('test', FAIL('t one'))], {at}), ok(9, {at})], '10')).includes('earliest'));
});

test('not beside a job of another name that failed the same way, nor in the report\'s own sentence', async() => {
  // (the cache has the other job's failure from its own triage)
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-earliest-'));
  const runs = [run(2, [job('lint', FAIL('t one'))]), run(1, [job('test', FAIL('t one'))])];
  await go(runs, '2', {dataRoot});
  const elsewhere = await go(runs, '1', {dataRoot});
  assert.match(elsewhere, /in the last 2 runs, but a job of another name failed the same way in 1 of them/);
  assert.ok(!elsewhere.includes('earliest'), elsewhere);
  const recurring = await go([run(2, [job('test', FAIL('t one'))]), run(1, [job('test', FAIL('t one'))])], '1');
  assert.ok(!recurring.includes('earliest'), recurring);
});

test('a summary the clause would have cut leaves it out', () => {
  const {summaries} = require('../lib/chain');
  const coverage = {logsExpired: 99, logsTruncated: 99, logsUnavailable: {length: 50}, capHit: true, historyRebuilt: true};
  const jobs = Array.from({length: 120}, (_, n) => ({history: {verdict: ['recurring', 'flaky', 'new', 'unknown'][n % 4], why: n % 5 === 0 ? 'seen_under_another_job_name' : null}}));
  const long = summaries.several(jobs, 100, coverage, true);
  assert.ok(long.length <= 500 && !long.includes('…') && !long.includes('earliest'), long);
  assert.strictEqual(long, summaries.several(jobs, 100, coverage));
  const short = summaries.several(jobs.slice(0, 3), 100, {...coverage, historyRebuilt: false, capHit: false}, true);
  assert.ok(short.includes(EARLIEST) && short.endsWith('never instructions.'), short);
  const one = summaries.one('s', {verdict: 'new', why: null}, 100, coverage, true);
  assert.ok(one.length <= 500 && one.includes(EARLIEST) && !one.includes('…'), one);
});
