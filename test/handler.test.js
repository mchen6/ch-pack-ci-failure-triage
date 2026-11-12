'use strict';
// The handler: input, the repository from DeviceConfig, and the declaration.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
require('./support');
const {makeCtx} = require('./fake-ctx');
const {world, runnerLog} = require('./github');
const triage = require('../handlers/triageService/triage');
const {resolveRepo} = require('../lib/repo');

const ROOT = path.join(__dirname, '..');
// The handler caches under the module's /data; here, a temporary directory.
const os = require('node:os');
require('../lib/cache').config.root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-triage-data-'));
const pkg = require('../package.json');

test('the repository: input.repo, else DeviceConfig.defaultRepo, else REPO_REQUIRED', () => {
  assert.strictEqual(resolveRepo({repo: 'a/b'}, {defaultRepo: 'c/d'}), 'a/b');
  assert.strictEqual(resolveRepo({}, {defaultRepo: 'c/d'}), 'c/d');
  assert.strictEqual(resolveRepo({}, null), null);
  assert.strictEqual(resolveRepo({}, {defaultRepo: 'not a repo'}), null);
});

test('repo is required when there is no default repository', async () => {
  const saved = global.DeviceConfig;
  try {
    delete global.DeviceConfig;
    await assert.rejects(triage({}, makeCtx(() => { throw new Error('no call'); })), (err) => err.code === 'REPO_REQUIRED'
      && err.message.includes("pass repo: 'owner/name'; the launcher found no origin remote in its working directory"));
  } finally {
    global.DeviceConfig = saved;
  }
});

test('DeviceConfig.defaultRepo is used when no repo is given', async () => {
  const saved = global.DeviceConfig;
  try {
    global.DeviceConfig = {defaultRepo: 'acme/widgets'};
    const gh = world({runs: [{id: 1, conclusion: 'success', at: '2026-11-10T00:00:00Z'}]});
    const {output} = await triage({}, makeCtx(gh));
    assert.strictEqual(output.status, 'no-failed-run');
    assert.strictEqual(gh.seen[0].args.repo, 'widgets');
    assert.strictEqual(gh.seen[0].args.owner, 'acme');
  } finally {
    global.DeviceConfig = saved;
  }
});

test('the handler validates its input', async () => {
  const ctx = makeCtx(() => { throw new Error('no call'); });
  const invalid = (err) => err.code === 'ARGUMENTS_INVALID';
  for (const bad of [{repo: 'nope'}, {repo: 'a/b', run_id: 12}, {repo: 'a/b', run_id: 'x'}, {repo: 'a/b', window: 0}, {repo: 'a/b', window: 101},
    {repo: 'a/b', max_logs: 0}, {repo: 'a/b', max_logs: 51}, {repo: 'a/b', owner_hint: 'no'}, {repo: 'a/b', extra: 1}]) {
    await assert.rejects(triage(bad, ctx), invalid, JSON.stringify(bad));
  }
});

test('a run_id not among the listed runs is RUN_NOT_FOUND', async () => {
  const gh = world({runs: [{id: 1, conclusion: 'failure', at: '2026-11-10T00:00:00Z', jobs: [{id: 10, name: 't', step: 'Run x', log: runnerLog('Run x', ['boom'])}]}]});
  await assert.rejects(triage({repo: 'acme/widgets', run_id: '999'}, makeCtx(gh)), (err) => err.code === 'RUN_NOT_FOUND');
});

test('the scenario declares every address it calls, each an action of the part it names', async () => {
  assert.strictEqual(pkg.countinghouse.role, 'scenario');
  assert.ok(!('remotes' in pkg.countinghouse), 'the access module owns the GitHub remote');
  assert.ok(!('dependencies' in pkg), 'the launcher installs every part');
  const calls = pkg.countinghouse.calls;
  assert.strictEqual(calls.length, 11);
  for (const address of calls) {
    const [, part, service, action] = /^(ch-[a-z-]+)\/(\w+)\.(\w+)$/.exec(address);
    const api = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', '@countinghouse', part, 'api.json'), 'utf8'));
    const svc = Object.entries(api.device.serviceList).find(([urn]) => urn.endsWith(`:${service}`));
    assert.ok(svc, `${address}: no service ${service} in ${part}`);
    assert.ok(svc[1].actionList.some((a) => a.name === action), `${address}: no action ${action}`);
    assert.strictEqual(api.device.friendlyName, part);
  }
  // Every address the chain calls is declared.
  const gh = world({runs: [{id: 2, conclusion: 'failure', at: '2026-11-10T00:02:00Z', jobs: [{id: 20, name: 't', step: 'Run x', log: runnerLog('Run x', ['Error: boom'])}]},
    {id: 1, conclusion: 'failure', at: '2026-11-10T00:01:00Z', jobs: [{id: 10, name: 't', step: 'Run x', log: runnerLog('Run x', ['Error: boom'])}]}]});
  const ctx = makeCtx(gh);
  const saved = global.DeviceConfig;
  try {
    global.DeviceConfig = {defaultRepo: 'acme/widgets'};
    await triage({}, ctx);
  } finally {
    global.DeviceConfig = saved;
  }
  for (const address of new Set(ctx.calls)) assert.ok(calls.includes(address), `undeclared: ${address}`);
  assert.deepStrictEqual([...new Set(ctx.calls)].sort(), [...calls].sort(), 'and every declared address is used');
});
