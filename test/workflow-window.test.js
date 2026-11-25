'use strict';
require('./tmp-dirs');
// Which runs are the triaged run's workflow: the same workflowId; by the same
// name only when an id is missing on either side; a run with neither is its
// own window, never "new" and never matched. (ch-access-github's newer listRuns
// is stood in for: workflow "" for a nameless run, branch null, workflowId.)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Ajv2020 = require('ajv/dist/2020');
const {makeCtx} = require('./fake-ctx');
const {world, runnerLog} = require('./github');
const {triage} = require('../lib/chain');

const validOutput = new Ajv2020({strict: false, allErrors: true}).compile(require('../schema.json').triageService.ci_failure_triage.output);
const FAIL = (name) => runnerLog('Run npm test', [`✖ ${name} (1ms)`, '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:', '  1 !== 2']);
let nextJob = 1000;
// as: {workflow, workflowId?, branch?}, as listRuns gives them; a run given none of it is of today's shape
const run = (id, as, {conclusion = 'failure', test: name = 't one'} = {}) => ({id, conclusion, at: `2026-11-10T00:${String(id).padStart(2, '0')}:00Z`, branch: 'b', as,
  jobs: conclusion === 'success' ? [] : [{id: nextJob++, name: 'test', step: 'Test', log: FAIL(name)}]});
const go = async(runs, input = {}, {gh = world({runs}), wrap = (ctx) => ctx, dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-window-'))} = {}) => {
  const ctx = wrap(makeCtx(gh));
  const call = ctx.call;
  ctx.call = async(address, i) => {
    const o = await call(address, i);
    if (/githubService\.listRuns$/.test(address)) for (const r of o.output.runs) { delete r.workflowId; Object.assign(r, runs.find((x) => String(x.id) === r.runId).as); }
    return o;
  };
  const output = await triage({repo: 'acme/widgets', window: 50, maxLogs: 20, ownerHint: false, ...input}, ctx, {dataRoot});
  assert.ok(validOutput(output), JSON.stringify(validOutput.errors));
  return output;
};
const CI = {workflow: 'CI', workflowId: '7'};
const ids = (output) => output.failed_jobs[0].history.runIds;
const verdict = (output) => output.failed_jobs[0].history.verdict;

test('the same workflowId under different names (a renamed workflow): one window', async() => {
  const output = await go([run(2, {workflow: 'Build', workflowId: '7'}), run(1, CI)]);
  assert.deepStrictEqual([verdict(output), ids(output), output.coverage.runsListed], ['recurring', ['1', '2'], 2]);
});

test('the same name under different workflowIds: two windows', async() => {
  const output = await go([run(2, {workflow: 'CI', workflowId: '8'}), run(1, CI)]);
  assert.deepStrictEqual([verdict(output), ids(output), output.coverage.runsListed], ['new', ['2'], 1]);
});

for (const [where, a, b] of [['the triaged run', {workflow: 'CI'}, CI], ['the other run', CI, {workflow: 'CI'}], ['both', {workflow: 'CI'}, {workflow: 'CI'}]]) {
  test(`an id missing on ${where}: the same name is one window, another name is not`, async() => {
    const same = await go([run(2, a), run(1, b)]);
    assert.deepStrictEqual([verdict(same), ids(same)], ['recurring', ['1', '2']]);
    const other = await go([run(2, a), run(1, {...b, workflow: 'Docs'})]);
    assert.deepStrictEqual([verdict(other), ids(other), other.coverage.runsListed], ['new', ['2'], 1]);
  });
}

test('nameless runs of one workflowId: one window', async() => {
  const output = await go([run(2, {workflow: '', workflowId: '7'}), run(1, {workflow: '', workflowId: '7'})]);
  assert.deepStrictEqual([verdict(output), ids(output)], ['recurring', ['1', '2']]);
  assert.strictEqual(output.run.workflow, '');
});

test('a triaged run with neither id nor name: its own window, never "new" and never matched', async() => {
  for (const others of [[run(1, {workflow: ''})], [run(1, CI)], []]) {
    const output = await go([run(2, {workflow: ''}), ...others]);
    const h = output.failed_jobs[0].history;
    assert.deepStrictEqual([h.verdict, h.why, h.runIds.includes('1'), output.coverage.runsListed], ['unknown', 'history_not_compared', false, 1]);
    assert.strictEqual(output.history, null);
    assert.match(output.summary, /whether it is new could not be told: its history could not be compared/);
    assert.strictEqual(h.notCompared, 0, 'no run is known to be its');
    assert.doesNotMatch(output.summary, /no other run to compare it with/);
  }
});

test('another run that cannot be placed and did not pass: never matched, and the triaged job is not "new"', async() => {
  for (const conclusion of ['failure', 'cancelled', null]) {
    const output = await go([run(2, CI), run(1, {workflow: ''}, {conclusion})], {runId: '2'});
    const h = output.failed_jobs[0].history;
    assert.deepStrictEqual([h.verdict, h.why, h.notCompared, h.runIds, output.coverage.runsListed], ['unknown', 'history_not_compared', 1, ['2'], 1], String(conclusion));
    // (beside the one run of its window: never "in the last run")
    assert.match(output.summary, /could not be told: 1 other run in the last 2 runs could not be compared/);
  }
});

test('another run that cannot be placed and passed: not counted', async() => {
  const output = await go([run(2, CI), run(1, {workflow: ''}, {conclusion: 'success'})]);
  assert.deepStrictEqual([verdict(output), output.failed_jobs[0].history.notCompared], ['new', 0]);
});

test('another run that cannot be placed: a match that was found stands', async() => {
  const output = await go([run(3, CI), run(2, {workflow: ''}), run(1, CI)]);
  assert.deepStrictEqual([verdict(output), ids(output), output.failed_jobs[0].history.notCompared], ['recurring', ['1', '3'], 1]);
});

test('a run whose branch is null is triaged, and is in the window of one that has its branch', async() => {
  const output = await go([run(2, {...CI, branch: null}), run(1, CI)]);
  assert.deepStrictEqual([verdict(output), ids(output), output.run.branch], ['recurring', ['1', '2'], '']);
});

test('the run-not-failed coverage counts the same window', async() => {
  const output = await go([run(3, {workflow: 'Build', workflowId: '7'}, {conclusion: 'success'}), run(2, CI), run(1, CI), run(0, {workflow: 'Build', workflowId: '8'})], {runId: '3'});
  assert.strictEqual(output.status, 'run-not-failed');
  assert.deepStrictEqual([output.coverage.runsListed, output.coverage.failedRuns], [3, 2]);
});

test('no workflowId anywhere (an older access module): by name, as before', async() => {
  const output = await go([run(3, {}), run(2, {workflow: 'Docs'}), run(1, {})]);
  assert.deepStrictEqual([verdict(output), ids(output), output.coverage.runsListed], ['recurring', ['1', '3'], 2]);
});

// A run that cannot be placed is said, never looked into: its jobs are not
// listed and no log of its is read (it may be another workflow's).
test('a run that cannot be placed costs no listing and no log', async() => {
  const runs = [run(3, CI), run(2, {workflow: ''}), run(1, CI)];
  const gh = world({runs});
  await go(runs, {}, {gh});
  const listed = gh.seen.filter((x) => x.tool === 'actions_list' && x.args.method === 'list_workflow_jobs').map((x) => x.args.resource_id);
  assert.deepStrictEqual(listed.sort(), ['1', '3']);
  assert.strictEqual(gh.logsFetched(), 2);
});

test('several runs that cannot be placed are each counted', async() => {
  const output = await go([run(4, CI), run(3, {workflow: ''}), run(2, {workflow: ''}, {conclusion: 'cancelled'}), run(1, {workflow: ''}, {conclusion: 'success'})]);
  const h = output.failed_jobs[0].history;
  assert.deepStrictEqual([h.verdict, h.notCompared], ['unknown', 2]);
  assert.match(output.summary, /could not be told: 2 other runs in the last 4 runs could not be compared/);
});

test('several failed jobs: a run that cannot be placed keeps none of them "new"', async() => {
  const two = run(2, CI);
  two.jobs.push({id: nextJob++, name: 'lint', step: 'Test', log: FAIL('t lint')});
  const output = await go([two, run(1, {workflow: ''})]);
  assert.deepStrictEqual(output.failed_jobs.map((j) => [j.history.verdict, j.history.notCompared]), [['unknown', 1], ['unknown', 1]]);
});

// The triage itself never depends on the window: the error lines, and a
// failed assertion's values under them, are answered whatever is missing.
test('a triaged run with no branch, name or id still gives its error lines and values', async() => {
  const {ADDRESSES} = require('../lib/addresses');
  const wrap = (ctx) => {
    const call = ctx.call;
    ctx.call = async(address, input) => {
      const r = await call(address, input);
      if (address !== ADDRESSES.extract || !Array.isArray(input.steps) || input.steps.length === 0) return r;
      const line = r.output.lines.findIndex((l) => l.text.includes('AssertionError'));
      const v = r.output.lines[line];
      return {output: {...r.output, details: {blocks: [{step: v.step, index: v.index, line, verdict: v.text, values: ["+ 'actual-one'", "- 'expected-one'"], places: [-1, -1], cut: false}], omittedBlocks: 0}}};
    };
    return ctx;
  };
  const output = await go([run(2, {workflow: '', branch: null})], {}, {wrap});
  const i = output.errors.findIndex((l) => l.includes('AssertionError'));
  assert.deepStrictEqual(output.errors.slice(i + 1, i + 3), ["+ 'actual-one'", "- 'expected-one'"]);
  assert.deepStrictEqual([output.run.workflow, output.run.branch], ['', '']);
});

// Whose verdict a success that cannot be placed holds back: a triaged
// success's only (its window's other successes are not compared either).
test('a success that cannot be placed: not compared when the triaged run is a success, not counted when it failed', async() => {
  for (const [conclusion, expected] of [['success', ['unknown', 1]], ['failure', ['new', 0]]]) {
    const target = {...run(2, CI), conclusion};
    const output = await go([target, run(1, {workflow: ''}, {conclusion: 'success'})], {runId: '2'});
    assert.deepStrictEqual([verdict(output), output.failed_jobs[0].history.notCompared], expected, conclusion);
  }
});

// "Re-run jobs" keeps the run id: a run listed as a success may have failed
// before, and the cache knows it. One that can't be placed is then not known
// to be another workflow's, for a job that failed there.
test('a success that cannot be placed, known to have failed this job before its re-run: not compared, so never "new"', async() => {
  for (const [as, name] of [[{workflow: '', workflowId: '7'}, 'nameless'], [CI, 'named']]) {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-window-'));
    const before = run(1, {workflow: ''});
    await go([before], {}, {dataRoot});
    const rerun = {...before, conclusion: 'success', jobs: []};
    const output = await go([run(2, as), rerun], {}, {dataRoot});
    const h = output.failed_jobs[0].history;
    assert.deepStrictEqual([h.verdict, h.why, h.notCompared, h.runIds], ['unknown', 'history_not_compared', 1, ['2']], name);
    // (another job's failure there says nothing of this one)
    const lint = run(3, as);
    lint.jobs[0].name = 'lint';
    const other = await go([lint, rerun], {}, {dataRoot});
    assert.deepStrictEqual([verdict(other), other.failed_jobs[0].history.notCompared], ['new', 0], name);
  }
});

test('a success that cannot be placed, whose failed jobs the cache has under another key: not compared', async() => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-window-'));
  const before = run(1, {workflow: ''});
  await go([before], {}, {dataRoot});
  const files = fs.readdirSync(dataRoot, {recursive: true}).map((f) => path.join(dataRoot, String(f))).filter((f) => f.endsWith('.json') && fs.readFileSync(f, 'utf8').includes('"failedJobs"'));
  assert.strictEqual(files.length, 1, files.join());
  const cached = JSON.parse(fs.readFileSync(files[0], 'utf8'));
  const entry = Object.values(cached.runs).find((e) => Array.isArray(e.failedJobs) && e.failedJobs.length > 0);
  entry.keyId = entry.keyId === '00000000' ? 'ffffffff' : '00000000';
  // (its names are that key's: none is this one's)
  entry.failedJobs = entry.failedJobs.map(([, id]) => ['0'.repeat(64), id]);
  fs.writeFileSync(files[0], JSON.stringify(cached));
  const output = await go([run(2, CI), {...before, conclusion: 'success', jobs: []}], {}, {dataRoot});
  assert.deepStrictEqual([verdict(output), output.failed_jobs[0].history.notCompared], ['unknown', 1]);
});
