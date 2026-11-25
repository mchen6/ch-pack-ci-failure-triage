'use strict';
require('./tmp-dirs');
// The pack's example prompts: four, each asking only what ci_failure_triage
// does, in the exact words that were checked. A change to any of them is a
// change to checked text: it is read again.
const test = require('node:test');
const assert = require('node:assert');
const Ajv2020 = require('ajv/dist/2020');

const api = require('../api.json');
const schema = require('../schema.json');
const pkg = require('../package.json');
const tool = schema.triageService.ci_failure_triage.input.properties;

const REPO_LINE = '\nRepository (owner/name; empty means the one I\'m working in): {{repo}}';
const EXPECTED = [
  {
    name: 'ci_triage_latest',
    title: 'Triage the latest failed CI run',
    description: 'Why the latest failed GitHub Actions run failed, and whether the failure is new, flaky or recurring.',
    text: 'Use ci_failure_triage on the latest failed CI run and tell me why it failed: the failing step, the error lines, and whether the failure is new, flaky or recurring. Show its receipt line as it is.' + REPO_LINE,
    required: []
  },
  {
    name: 'ci_triage_run',
    title: 'Triage a specific CI run',
    description: 'Why one GitHub Actions run failed, by its run id.',
    text: 'Use ci_failure_triage on CI run {{run_id}} and tell me why it failed: the failing step, the error lines, and whether the failure is new, flaky or recurring. Show its receipt line as it is.' + REPO_LINE,
    required: ['run_id']
  },
  {
    name: 'ci_new_or_recurring',
    title: 'Is this CI failure new, flaky or recurring?',
    description: 'Whether the latest failed run\'s failure is new, flaky or recurring, and the commit where it first appeared.',
    text: 'Use ci_failure_triage on the latest failed CI run and tell me only whether its failure is new, flaky or recurring, and the commit where it first appeared. Show its receipt line as it is.' + REPO_LINE,
    required: []
  },
  {
    name: 'ci_who_touched',
    title: 'Who wrote the commits the CI failure occurred on?',
    description: 'The GitHub logins of the authors of the commits the latest failed run\'s failure occurred on.',
    text: 'Use ci_failure_triage on the latest failed CI run and tell me the GitHub logins of the authors of the commits the failure occurred on. Show its receipt line as it is.' + REPO_LINE,
    required: []
  }
];

// the arguments schema a prompt's {schema} pointer names in schema.json
const argumentsOf = (prompt) => {
  let at = schema;
  for (const key of prompt.arguments.schema.split('/').filter(Boolean)) at = at[key];
  return at;
};

test('four example prompts, in the checked words, each one user message naming the tool and asking for its receipt', () => {
  const prompts = api.device.promptList;
  assert.deepStrictEqual(prompts.map((p) => p.name), EXPECTED.map((e) => e.name));
  for (const [i, e] of EXPECTED.entries()) {
    const p = prompts[i];
    assert.deepStrictEqual(Object.keys(p).sort(), ['arguments', 'description', 'messages', 'name', 'title'], e.name);
    assert.strictEqual(p.title, e.title, e.name);
    assert.strictEqual(p.description, e.description, e.name);
    assert.deepStrictEqual(p.messages, [{role: 'user', text: e.text}], e.name);
  }
});

test('each prompt\'s arguments are the tool\'s own: repo optional, run_id only where it names a run, with the tool\'s patterns', () => {
  const ajv = new Ajv2020({strict: false});
  for (const e of EXPECTED) {
    const p = api.device.promptList.find((x) => x.name === e.name);
    const args = argumentsOf(p);
    assert.strictEqual(args.type, 'object', e.name);
    assert.strictEqual(args.additionalProperties, false, e.name);
    assert.deepStrictEqual(Object.keys(args.properties).sort(), e.required.includes('run_id') ? ['repo', 'run_id'] : ['repo'], e.name);
    assert.deepStrictEqual(args.required || [], e.required, e.name);
    assert.strictEqual(args.properties.repo.type, 'string');
    // (the tool's own pattern, or empty: an empty repo is what the message
    // says it may be, the medium on (c), 1)
    assert.strictEqual(args.properties.repo.pattern, `^$|${tool.repo.pattern}`, `${e.name}: the tool's repo pattern, or empty`);
    assert.strictEqual(typeof args.properties.repo.description, 'string');
    if (args.properties.run_id != null) assert.strictEqual(args.properties.run_id.pattern, tool.run_id.pattern, `${e.name}: the tool's run_id pattern`);
    // every placeholder in the shipped messages is a declared argument (the
    // medium on (c), 7: the artifact itself, not the test's copy)
    for (const msg of p.messages) for (const m of msg.text.matchAll(/\{\{(\w+)\}\}/g)) assert.ok(m[1] in args.properties, `${e.name}: {{${m[1]}}}`);
    const valid = ajv.compile(args);
    const run = e.required.length ? {run_id: '123'} : {};
    assert.ok(valid({repo: 'acme/widgets', ...run}), e.name);
    // (repo optional: absent, or empty as a form-style client sends it; the
    // medium on (c), 1 and 2)
    assert.ok(valid({...run}), `${e.name}: no repo`);
    assert.ok(valid({repo: '', ...run}), `${e.name}: an empty repo`);
    assert.ok(!valid({repo: 'not a repo', ...run}), `${e.name}: a bad repo refused`);
    if (e.required.length) {
      assert.ok(!valid({repo: 'acme/widgets'}), `${e.name}: no run_id refused`);
      assert.ok(!valid({run_id: 'abc'}), `${e.name}: a bad run_id refused`);
    }
  }
});

test('the pack\'s version carries the prompts: 0.7.2', () => {
  assert.strictEqual(pkg.version, '0.7.2');
});
