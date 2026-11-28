'use strict';
require('./tmp-dirs');
// One call's GitHub calls, as the README's "What it does" describes them
// ("within the default limits, and fewer once the pack's cache knows the
// window's runs"), counted at the GitHub stand-in with the default limits as
// schema.json declares them, so a number a README may give can be checked
// against these. Every run in the window failed, each job's history
// differing, the owner hint on:
// - the ordinary path, cold: 48 (one list of the runs, the triaged run's
//   jobs, max_logs listings, max_logs logs, and six commit reads for the
//   owner hint), then each call reads further back until the cache knows the
//   window's runs, and a call makes only the few it always makes;
// - job listings GitHub fails to give spend nothing of max_logs: they are
//   bounded by the report's 50 not compared, so more calls are made;
// - a run of more than 100 jobs is listed a page of 100 at a time
//   (ch-access-github), each page a call.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {makeCtx} = require('./fake-ctx');
const {world, runnerLog} = require('./github');
const {triage} = require('../lib/chain');

const DEFAULTS = require('../schema.json').triageService.ci_failure_triage.input.properties;
const README = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8').replace(/\s+/g, ' ');
const at = (m) => `2026-11-10T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00Z`;
const FAIL = (n) => runnerLog('Run npm test', [`AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: ${n} !== ${n + 1}`, `    at file${n}.js:${n}:1`]);
// 50 failed runs, each with `jobs` jobs
const runs = (jobs = 1) => Array.from({length: 50}, (_, i) => ({id: 500 - i, conclusion: 'failure', at: at(1000 - i),
  jobs: Array.from({length: jobs}, (_, k) => ({id: 500000 - i * 1000 - k, name: jobs === 1 ? 'test (24)' : `test ${k}`, step: 'Run npm test', log: FAIL(i % 2)}))}));

// one call with the defaults -> the GitHub calls it made; wrap(gh) may answer in its place
async function once(dataRoot, gh, wrap = (g) => g) {
  await triage({repo: 'acme/widgets', window: DEFAULTS.window.default, maxLogs: DEFAULTS.max_logs.default, ownerHint: DEFAULTS.owner_hint.default},
    makeCtx(wrap(gh)), {dataRoot});
  return gh.seen.length;
}
async function withRoot(fn) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-readme-calls-'));
  try { return await fn(dataRoot); } finally { fs.rmSync(dataRoot, {recursive: true, force: true}); }
}

test('the README says the pack does the reading, within the default limits', () => {
  assert.ok(README.includes('One call does the GitHub reading the model would otherwise do itself (the recent runs, their failed jobs and their logs, within the default limits, and fewer once the pack\'s cache knows the window\'s runs)'));
});

test('the ordinary path: 48 calls cold, then fewer once the cache knows the window\'s runs', async () => withRoot(async (dataRoot) => {
  assert.deepStrictEqual([DEFAULTS.window.default, DEFAULTS.max_logs.default, DEFAULTS.owner_hint.default], [50, 20, true], 'the defaults these counts are for');
  const counts = [];
  // (until the count has fallen and two calls in a row make it; while the cache still reads further back, a call may
  // make as many as the first)
  const settled = () => counts.length >= 2 && counts[counts.length - 1] < counts[0] && counts[counts.length - 1] === counts[counts.length - 2];
  while (!settled()) {
    assert.ok(counts.length < 20, `never settled: ${counts.join(' ')}`);
    counts.push(await once(dataRoot, world({runs: runs()})));
  }
  assert.strictEqual(counts[0], 1 + 1 + 20 + 20 + 6, counts.join(' '));
  assert.ok(counts.every((n) => n <= counts[0]), counts.join(' '));
  // settled: the list, the triaged run's jobs and its log, and the owner hint's six commit reads
  assert.strictEqual(counts[counts.length - 1], 1 + 1 + 1 + 6, counts.join(' '));
}));

test('job listings GitHub fails to give spend nothing of max_logs: more calls than the ordinary path', async () => withRoot(async (dataRoot) => {
  const gh = world({runs: runs()});
  const failing = (g) => (tool, args) => {
    if (tool === 'actions_list' && args.method === 'list_workflow_jobs' && args.resource_id !== '500') {
      g.seen.push({tool, args});
      return {isError: true, content: [{type: 'text', text: 'failed to list workflow jobs: unexpected status code: 502 Bad Gateway'}]};
    }
    return g(tool, args);
  };
  // the list, every run's listing (the triaged run's and 49 that fail), the triaged run's log
  assert.strictEqual(await once(dataRoot, gh, failing), 1 + 50 + 1);
}));

test('a run of more than 100 jobs is listed a page at a time: more calls than the ordinary path', async () => withRoot(async (dataRoot) => {
  const gh = world({runs: runs(150)});
  const paged = (g) => (tool, args) => {
    if (tool === 'actions_list' && args.method === 'list_workflow_jobs') {
      const body = JSON.parse(g(tool, args).content[0].text);
      const page = args.page || 1;
      const per = args.perPage || 100;
      body.jobs.jobs = body.jobs.jobs.slice((page - 1) * per, page * per);
      return {content: [{type: 'text', text: JSON.stringify(body)}]};
    }
    return g(tool, args);
  };
  const n = await once(dataRoot, gh, paged);
  const pages = gh.seen.filter((s) => s.tool === 'actions_list' && s.args.method === 'list_workflow_jobs').length;
  assert.strictEqual(pages % 2, 0, 'two pages a run');
  assert.ok(n > 48, `${n} calls`);
  assert.strictEqual(n, 63, `${n} calls, ${pages} of them pages`);
}));
