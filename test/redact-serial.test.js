'use strict';
require('./tmp-dirs');
// One call of ch-step-redact at a time: the runtime checks a calling module's
// inputs one after another, so a long log's steps sent together wait for each
// other, and a busy machine refuses the ones that wait too long, and the triage
// with them.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {makeCtx} = require('./fake-ctx');
const {world} = require('./github');
const {triage} = require('../lib/chain');
const {ADDRESSES} = require('../lib/addresses');

const STEPS = 10;
// (a step's header as GitHub writes it: its command echoed in cyan)
const stamped = (lines) => lines.map((l, i) => `2026-11-10T07:30:${String(i % 60).padStart(2, '0')}.0000000Z ${l}`).join('\n');
const log = stamped(Array.from({length: STEPS}, (_, n) => [`##[group]Run step ${n + 1}`, `\x1b[36;1mstep ${n + 1}\x1b[0m`, '##[endgroup]',
  ...(n === STEPS - 1 ? ['✖ t one (1ms)', '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:', '  1 !== 2', '##[error]Process completed with exit code 1.'] : [`line of step ${n + 1}`])]).flat());
const gh = () => world({runs: [{id: 2, conclusion: 'failure', branch: 'b', at: '2026-11-10T00:02:00Z', jobs: [{id: 20, name: 'test', step: `Run step ${STEPS}`, log}, {id: 21, name: 'lint', step: 'Run lint', log}]}]});
// (redact's answers take a turn each, so that calls made together overlap;
// merged: what an answer that merges two lines is given for)
const counted = ({merged = () => false, extract = (o) => o} = {}) => {
  const ctx = makeCtx(gh());
  const call = ctx.call;
  const seen = {now: 0, most: 0, steps: []};
  ctx.call = async(address, input) => {
    if (address === ADDRESSES.extract) return {output: extract((await call(address, input)).output, input)};
    if (address !== ADDRESSES.redact) return call(address, input);
    const step = /^line of (step \d+)$/.exec(input.lines[0]);
    if (step != null && input.lines.length === 1) seen.steps.push(step[1]);
    seen.now += 1;
    seen.most = Math.max(seen.most, seen.now);
    try {
      await new Promise((r) => setImmediate(r));
      const answer = await call(address, input);
      return merged(input.lines) ? {output: {...answer.output, lines: answer.output.lines.slice(1)}} : answer;
    } finally {
      seen.now -= 1;
    }
  };
  return {ctx, seen};
};
const run = (ctx) => triage({repo: 'acme/widgets', runId: '2', window: 50, maxLogs: 20, ownerHint: false}, ctx, {dataRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'ch-serial-'))});

test('a log of many steps: one redaction at a time, and the answer as with a runtime that answers at once', async() => {
  const {ctx, seen} = counted();
  const output = await run(ctx);
  // (each of the two jobs' logs: its steps but the failing one, each once and in order)
  const each = Array.from({length: STEPS - 1}, (_, n) => `step ${n + 1}`);
  assert.deepStrictEqual(seen.steps, [...each, ...each]);
  assert.strictEqual(seen.most, 1);
  const plain = await run(makeCtx(gh()));
  assert.deepStrictEqual([output.errors, output.failed_jobs.map((j) => [j.job, j.step, j.first_error]), output.run], [plain.errors, plain.failed_jobs.map((j) => [j.job, j.step, j.first_error]), plain.run]);
  assert.ok(output.errors.some((l) => l.includes('AssertionError')), output.errors.join('\n'));
});

test('fields that redaction merges are redacted again one at a time, in their places', async() => {
  const {ctx, seen} = counted({merged: (lines) => lines.length > 1 && lines.some((l) => l.includes('/actions/runs/'))});
  const output = await run(ctx);
  assert.strictEqual(seen.most, 1);
  assert.deepStrictEqual([output.run.workflow, output.run.branch, output.failed_jobs.map((j) => j.job)], ['CI', 'b', ['test', 'lint']]);
});

test('a failed assertion\'s values that redaction merges are redacted again one at a time', async() => {
  const extract = (o, input) => {
    if (!Array.isArray(input.steps) || input.steps.length === 0) return o;
    const at = o.lines.map((l, i) => [l, i]).filter(([l]) => l.text.includes('AssertionError'));
    return {...o, details: {omittedBlocks: 0, blocks: at.flatMap(([l, line]) => ['a', 'b', 'c'].map((x) => ({step: l.step, index: l.index, line, verdict: l.text, values: [`+ 'actual-${x}'`, `- 'expected-${x}'`], places: [-1, -1], cut: false})))}};
  };
  const {ctx, seen} = counted({extract, merged: (lines) => lines.some((l) => l.includes('actual-a')) && lines.some((l) => l.includes('actual-b'))});
  const output = await run(ctx);
  assert.strictEqual(seen.most, 1);
  assert.deepStrictEqual(output.errors.filter((l) => /(?:actual|expected)-/.test(l)), ['a', 'b', 'c'].flatMap((x) => [`+ 'actual-${x}'`, `- 'expected-${x}'`]));
});
