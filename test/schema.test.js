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

const schema = require('../schema.json').triageService.triage;
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
