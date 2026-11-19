'use strict';
// The handler: input, the repository (input, setting, device config), and the declaration.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {makeCtx} = require('./fake-ctx');
const {world, runnerLog} = require('./github');
const triage = require('../handlers/triageService/ci_failure_triage');
const {resolveRepo, isRepo} = require('../lib/repo');

const ROOT = path.join(__dirname, '..');
// The handler caches under the module's /data; here, a temporary directory.
const os = require('node:os');
require('../lib/cache').config.root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-triage-data-'));
const pkg = require('../package.json');

// #413 rev 3 (P1): the repository is the input's repo, else the module's own
// setting defaultRepo, else (until P3 removes it) the device config the
// launcher writes, else the setting is asked for: SETTING_REQUIRED.
test('the repository: input.repo, else the defaultRepo setting, else DeviceConfig.defaultRepo, else none', () => {
  assert.strictEqual(resolveRepo({repo: 'a/b'}, {defaultRepo: 'e/f'}, {defaultRepo: 'c/d'}), 'a/b');
  assert.strictEqual(resolveRepo({}, {defaultRepo: 'e/f'}, {defaultRepo: 'c/d'}), 'e/f');
  assert.strictEqual(resolveRepo({}, {}, {defaultRepo: 'c/d'}), 'c/d');
  assert.strictEqual(resolveRepo({}, {}, null), null);
  assert.strictEqual(resolveRepo({}, {defaultRepo: 'not a repo'}, {defaultRepo: 'not a repo'}), null);
});

// the runtime's `repo` format (countinghouse lib/module-settings.js), so the
// input and the setting accept the same repositories
test('a repository is GitHub\'s grammar, as the runtime\'s repo format checks it', () => {
  for (const ok of ['a/b', 'acme-co/widgets.js', 'A1/x_y-z', `${'a'.repeat(39)}/r`]) assert.ok(isRepo(ok), ok);
  for (const bad of ['a--b/c', 'ab-/c', '-ab/c', `${'a'.repeat(40)}/r`, 'a/.', 'a/..', 'a/b/c', 'a', '/b', 'a/', `a/${'r'.repeat(101)}`]) assert.ok(!isRepo(bad), bad);
});

const withConfig = async (config, f) => {
  const saved = global.DeviceConfig;
  try {
    if (config === undefined) delete global.DeviceConfig; else global.DeviceConfig = config;
    return await f();
  } finally {
    global.DeviceConfig = saved;
  }
};

test('with no repo, no setting and no device config, the defaultRepo setting is asked for', async () => {
  await withConfig(undefined, () => assert.rejects(triage({}, makeCtx(() => { throw new Error('no call'); })),
    (err) => err.code === 'SETTING_REQUIRED' && err.message === 'defaultRepo'));
});

test('the defaultRepo setting is used when no repo is given, before the device config', async () => {
  await withConfig({defaultRepo: 'other/place'}, async () => {
    const gh = world({runs: [{id: 1, conclusion: 'success', at: '2026-11-10T00:00:00Z'}]});
    const {output} = await triage({}, makeCtx(gh, {settings: {defaultRepo: 'acme/widgets'}}));
    assert.strictEqual(output.status, 'no-failed-run');
    assert.strictEqual(gh.seen[0].args.owner, 'acme');
    assert.strictEqual(gh.seen[0].args.repo, 'widgets');
  });
});

test('DeviceConfig.defaultRepo is still read when neither is given (until P3)', async () => {
  await withConfig({defaultRepo: 'acme/widgets'}, async () => {
    const gh = world({runs: [{id: 1, conclusion: 'success', at: '2026-11-10T00:00:00Z'}]});
    await triage({}, makeCtx(gh));
    assert.strictEqual(gh.seen[0].args.owner, 'acme');
  });
});

test('the module declares defaultRepo, a repository, with no default and not required', () => {
  assert.deepStrictEqual(pkg.countinghouse.settings, {
    defaultRepo: {type: 'string', format: 'repo', title: 'Default repository', description: 'owner/name used when a call names no repository.'}
  });
});

test('the tool tells the agent to pass the repository of the project it works in', () => {
  const api = require('../api.json');
  const action = Object.values(api.device.serviceList)[0].actionList.find((a) => a.name === 'ci_failure_triage');
  assert.match(action.description, /Pass repo: 'owner\/name', the repository of the project you are working in/);
});

test('the handler validates its input', async () => {
  const ctx = makeCtx(() => { throw new Error('no call'); });
  const invalid = (err) => err.code === 'INPUT_REJECTED';
  for (const bad of [{repo: 'nope'}, {repo: 'a/b', run_id: 12}, {repo: 'a/b', run_id: 'x'}, {repo: 'a/b', window: 0}, {repo: 'a/b', window: 101},
    {repo: 'a/b', max_logs: 0}, {repo: 'a/b', max_logs: 51}, {repo: 'a/b', owner_hint: 'no'}, {repo: 'a/b', extra: 1}]) {
    await assert.rejects(triage(bad, ctx), invalid, JSON.stringify(bad));
  }
});

// countinghouse's logger step 1 removed the DeviceError and CHError globals:
// a module's own failure is ctx.error with its own code.
test('no handler or lib file reaches for an error global the runtime no longer gives', () => {
  const walk = (dir) => fs.readdirSync(dir, {withFileTypes: true}).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));
  const files = ['handlers', 'lib'].flatMap((d) => walk(path.join(ROOT, d)));
  assert.ok(files.length > 0);
  // any mention in code (comments aside): new, a call, instanceof, globalThis
  const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const file of files) assert.ok(!/\b(DeviceError|CHError)\b/.test(code(fs.readFileSync(file, 'utf8'))), `${path.relative(ROOT, file)} uses a removed error global`);
});

// The parts as this pack's fixtures hold them answer a bad input with their
// own INPUT_REJECTED through ctx.error, never a ReferenceError for the
// removed DeviceError global (the parts' own PRs; refreshed fixtures).
test('each part\'s refusal reaches the scenario as the part\'s own INPUT_REJECTED', async () => {
  const ctx = makeCtx(() => { throw new Error('no call'); });
  const bad = {
    'ch-step-log-clean/cleanService.clean': {text: 1},
    'ch-step-error-patterns/patternService.extract': {steps: 'x'},
    'ch-step-failure-signature/signatureService.sign': {lines: 'x'},
    'ch-step-dedupe/dedupeService.group': {runs: 'x', window: 0},
    'ch-step-owner-hint/ownerService.hint': {firstSeen: 'x'},
    'ch-step-redact/redactService.redact': {lines: 'x'},
    'ch-step-report/reportService.assemble': {}
  };
  for (const [address, input] of Object.entries(bad)) {
    await assert.rejects(ctx.call(address, input), (err) => err.code === 'INPUT_REJECTED', address);
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
