'use strict';
// The outputs the chain produces match schema.json, checked with the runtime's
// own validator library (Ajv, 2020-12), as the runtime checks them at the boundary.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
require('./support');
const Ajv2020 = require('ajv/dist/2020');
const {makeCtx} = require('./fake-ctx');
const {recordedServer, world, runnerLog} = require('./github');
const {triage} = require('../lib/chain');

const schema = require('../schema.json').triageService.ci_failure_triage;
const ajv = new Ajv2020({strict: false, allErrors: true});
const validOutput = ajv.compile(schema.output);
const validInput = ajv.compile(schema.input);
const go = (gh, input = {}) => triage({repo: 'acme/widgets', window: 50, maxLogs: 20, ownerHint: true, ...input}, makeCtx(gh), {dataRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'ch-schema-'))});

test('a triage result matches the declared output', async () => {
  for (const out of [
    await go(recordedServer(), {repo: 'mchen6/countinghouse'}),
    await go(world({runs: [{id: 3, conclusion: 'failure', at: '2026-11-10T00:03:00Z', jobs: [{id: 30, name: 't', step: 'Run x', log: runnerLog('Run x', ['Error: boom'])}]},
      {id: 2, conclusion: 'failure', at: '2026-11-10T00:02:00Z', jobs: [{id: 20, name: 'lint', step: 'Run y', log: 'unavailable'}]}]}))
  ]) {
    assert.ok(validOutput(out), JSON.stringify(validOutput.errors));
  }
});

test('the report\'s longest summary (500 characters) with the longest receipt sentence still matches the declared output', async () => {
  const {RECEIPT_MAX} = require('../lib/chain');
  const out = await go(recordedServer(), {repo: 'mchen6/countinghouse'});
  out.summary = `${'s'.repeat(500)} ${'r'.repeat(RECEIPT_MAX)}`;
  assert.ok(validOutput(out), JSON.stringify(validOutput.errors));
  out.summary += 'r';
  assert.ok(!validOutput(out), 'and no longer');
});

test('the no-failed-run answer matches the declared output', async () => {
  const out = await go(world({runs: [{id: 1, conclusion: 'success', at: '2026-11-10T00:00:00Z'}]}));
  assert.ok(validOutput(out), JSON.stringify(validOutput.errors));
  assert.ok(!validOutput({...out, receipt: {}}), 'a receipt field is not this module\'s');
});

test('the declared input takes no arguments, or the five optional ones', () => {
  assert.ok(validInput({}));
  assert.ok(validInput({run_id: '42', repo: 'a/b', window: 50, max_logs: 20, owner_hint: false}));
  assert.ok(!validInput({extra: 1}));
  assert.ok(!validInput({window: 101}));
});

// Reviewer, #1: the output schema guarantees the shape: an object at the root
// (MCP's outputSchema), one of the two answers, every object closed.
test('the output schema is an object of one of two closed shapes, closed all the way down', () => {
  assert.strictEqual(schema.output.type, 'object');
  assert.strictEqual(schema.output.oneOf.length, 2);
  const open = [];
  const walk = (node, where) => {
    if (node == null || typeof node !== 'object') return;
    if (node.properties != null && node.additionalProperties !== false) open.push(where);
    for (const [k, v] of Object.entries(node)) walk(v, `${where}.${k}`);
  };
  walk(schema.output, 'output');
  assert.deepStrictEqual(open, []);
  const shapes = schema.output.oneOf.map((s) => Object.keys(s.properties).join(','));
  assert.deepStrictEqual(shapes, ['summary,run,failed_jobs,errors,history,owner_hint,coverage', 'status,summary,lastSuccess,coverage']);
});

test('the action is ci_failure_triage, the tool name the model sees', () => {
  const api = require('../api.json');
  const [service] = Object.values(api.device.serviceList);
  assert.deepStrictEqual(service.actionList.map((a) => a.name), ['ci_failure_triage']);
  assert.match(service.actionList[0].description, /^Call this first when a CI run failed\./);
});
