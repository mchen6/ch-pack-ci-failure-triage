'use strict';
require('./tmp-dirs');
// A failed assertion's expected and actual values reach the answer: the
// triaged job's under their verdicts in `errors`, another job's on its entry in
// `failed_jobs`. Redacted, bounded, and saying so when anything is cut. The
// values come from ch-step-error-patterns' `details`; here a wrapper supplies
// them, so this file holds at any pinned version of that part.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Ajv = require('ajv/dist/2020');
const {makeCtx} = require('./fake-ctx');
const {world, runnerLog} = require('./github');
const {triage} = require('../lib/chain');
const {ADDRESSES} = require('../lib/addresses');
const {BOUNDS, VALUES_CUT, omittedNote, firstOfNote} = require('../lib/assertion-values');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ch-values-'));
const at = (m) => `2026-11-10T00:${String(m).padStart(2, '0')}:00Z`;
const FAIL = (name) => runnerLog('Run npm test', [`not ok - ${name}`, `  AssertionError [ERR_ASSERTION]: ${name} differs`, '  more output']);
let nextJob = 5000;
const job = (name, testName = name) => ({id: nextJob++, name, step: 'Test', log: FAIL(testName)});
const run = (jobs) => ({id: 2, conclusion: 'failure', at: at(20), branch: 'b', jobs});

// (the lines of a log that are in `lines` have their place there: places)
// table: test name -> {values, cut?, omitted?, repeats?, verdictOutOfLines?, at?}
const detailsFrom = (table) => (input, output) => {
  const text = input.steps.flatMap((s) => s.lines).join('\n');
  for (const [name, spec] of Object.entries(table)) {
    if (!text.includes(name)) continue;
    const line = spec.at === undefined ? output.lines.findIndex((l) => l.text.includes('AssertionError')) : spec.at(output.lines);
    const v = output.lines[line];
    const out = spec.verdictOutOfLines === true;
    return {blocks: [{step: v.step, index: v.index, ...(out ? {} : {line}), ...(spec.repeats === undefined ? {} : {repeats: spec.repeats}),
      verdict: out ? 'AssertionError: the one the cap left out' : spec.verdict || v.text, values: spec.values, places: spec.values.map((x) => output.lines.findIndex((l) => l.text === x)), cut: spec.cut === true}], omittedBlocks: spec.omitted || 0};
  }
  return undefined;
};
const withDetails = (ctx, detailsFor) => {
  const call = ctx.call;
  ctx.call = async (address, input) => {
    const r = await call(address, input);
    if (address !== ADDRESSES.extract || !Array.isArray(input.steps) || input.steps.length === 0) return r;
    const details = detailsFor(input, r.output);
    return details === undefined ? r : {output: {...r.output, details}};
  };
  return ctx;
};
const go = (jobs, table, input = {}) => triage({repo: 'acme/widgets', window: 50, maxLogs: 20, ownerHint: false, ...input},
  withDetails(makeCtx(world({runs: [run(jobs)]})), table == null ? () => undefined : detailsFrom(table)), {dataRoot: tmp()});

test('the triaged job\'s values sit right under their verdict in errors', async () => {
  const out = await go([job('test', 't one')], {'t one': {values: ["+ 'actual-one'", "- 'expected-one'", '  at x (test/a.js:3:1)']}});
  const at = out.errors.findIndex((l) => l.includes('AssertionError'));
  assert.deepStrictEqual(out.errors.slice(at + 1, at + 4), ["+ 'actual-one'", "- 'expected-one'", '  at x (test/a.js:3:1)']);
});

test('a verdict the line cap left out comes with its values', async () => {
  const out = await go([job('test', 't one')], {'t one': {values: ["+ 'actual-one'"], verdictOutOfLines: true}});
  const at = out.errors.indexOf('AssertionError: the one the cap left out');
  assert.ok(at !== -1, JSON.stringify(out.errors));
  assert.strictEqual(out.errors[at + 1], "+ 'actual-one'");
});

test('with no details the answer is what it was', async () => {
  const jobs = () => [job('test', 't one'), job('other', 't two')];
  const plain = await go(jobs(), null);
  assert.ok(plain.errors.length > 0);
  assert.ok(plain.failed_jobs.every((j) => !('values' in j) && !('values_same_as' in j)));
  assert.ok(!plain.errors.some((l) => l === VALUES_CUT));
});

test('values never move a signature', async () => {
  const a = await go([job('test', 't one')], null);
  const b = await go([job('test', 't one')], {'t one': {values: ["+ 'actual-one'"]}});
  assert.strictEqual(b.history.signature, a.history.signature);
});

test('another job\'s values are on its entry; the same values name the job that shows them', async () => {
  // (the first and third fail alike, their stacks at each runner's own path)
  const verdict = 'AssertionError: alike';
  const table = {'t one': {verdict, values: ["+ 'one'", '  at x (/home/runner/work/app/app/test/a.js:3:1)']}, 't two': {values: ["+ 'two'"]}, 't same': {verdict, values: ["+ 'one'", '  at x (D:\\a\\app\\app\\test\\a.js:3:1)']}};
  const out = await go([job('first', 't one'), job('second', 't two'), job('third', 't same')], table);
  const [first, second, third] = out.failed_jobs;
  assert.ok(!('values' in first) && !('values_same_as' in first), 'the triaged job\'s are in errors');
  assert.ok(second.values.some((l) => l.includes("+ 'two'")), JSON.stringify(second));
  assert.ok(second.values.some((l) => l.includes('AssertionError')), 'with its verdict');
  assert.ok(!('values' in third), JSON.stringify(third));
  assert.strictEqual(third.values_same_as, 0);
});

test('the same values on a later job: values_same_as is the earlier job\'s place, stack locations aside', async () => {
  const table = {'t same': {values: ["+ 'one'", '  at x (/home/a.js:3:1)']}};
  const a = job('first', 't same');
  const b = job('second', 't same');
  const out = await go([a, b], table);
  assert.strictEqual(out.failed_jobs[1].values_same_as, 0);
  assert.ok(!('values' in out.failed_jobs[1]));
});

test('what goes on a job\'s entry passes redaction', async () => {
  const token = `gh${'p'}_${crypto.randomBytes(18).toString('hex').slice(0, 36)}`;
  const mail = ['someone', 'mail.invalid'].join('@');
  const table = {'t one': {values: ["+ 'one'"]}, 't two': {values: [`+ '${token}'`, `- ${mail}`]}};
  const out = await go([job('first', 't one'), job('second', 't two')], table);
  const text = JSON.stringify(out);
  assert.ok(!text.includes(token), 'the token');
  assert.ok(!text.includes(mail), 'the address');
  assert.ok(out.failed_jobs[1].values.length > 0);
});

test('a block cut short says so, and so do the blocks left out', async () => {
  const out = await go([job('test', 't one')], {'t one': {values: ["+ 'one'"], cut: true, omitted: 2}});
  const at = out.errors.indexOf("+ 'one'");
  assert.strictEqual(out.errors[at + 1], VALUES_CUT);
  assert.ok(out.errors.includes(omittedNote(2)), JSON.stringify(out.errors));
  const other = await go([job('first', 't one'), job('second', 't two')], {'t one': {values: ["+ 'a'"]}, 't two': {values: ["+ 'b'"], cut: true, omitted: 1}});
  assert.ok(other.failed_jobs[1].values.includes(VALUES_CUT));
  assert.strictEqual(other.failed_jobs[1].values_omitted, 1);
  assert.ok(!('values_omitted' in other.failed_jobs[0]));
});

test('the answer\'s bound holds across jobs, and a job past it says so', async () => {
  const names = Array.from({length: 8}, (_, i) => `t number${i}`);
  const table = Object.fromEntries(names.map((n, i) => [n, {values: Array.from({length: 12}, (_, j) => `+ value ${i} ${j} ${'word '.repeat(10)}`)}]));
  const out = await go(names.map((n, i) => job(`job${i}`, n)), table, {maxLogs: 50});
  const fromJobs = out.failed_jobs.flatMap((j) => j.values || []);
  const inErrors = out.errors.filter((l) => l.startsWith('+ value'));
  const shown = [...inErrors, ...fromJobs.filter((l) => l.startsWith('+ value'))];
  assert.ok(shown.length <= BOUNDS.LINES, `${shown.length}`);
  assert.ok(shown.join('').length <= BOUNDS.CHARS, `${shown.join('').length}`);
  assert.ok(out.failed_jobs.some((j) => j.values_omitted === 1 && !('values' in j)), JSON.stringify(out.failed_jobs));
});

test('a job whose log was not read this call has no values', async () => {
  const names = ['t a', 't b', 't c', 't d'];
  const table = Object.fromEntries(names.map((n) => [n, {values: [`+ '${n.slice(2)}-value'`]}]));
  const out = await go(names.map((n, i) => job(`job${i}`, n)), table, {maxLogs: 2});
  const unread = out.failed_jobs.filter((j) => j.first_error == null);
  assert.ok(unread.length > 0, 'the budget left some unread');
  assert.ok(unread.every((j) => !('values' in j) && !('values_same_as' in j)));
});

test('the answer with values matches the schema', async () => {
  const output = require('../schema.json').triageService.ci_failure_triage.output;
  const valid = new Ajv({strict: false}).compile(output);
  const out = await go([job('first', 't one'), job('second', 't two'), job('third', 't one')], {'t one': {values: ["+ 'a'"], cut: true}, 't two': {values: ["+ 'b'"], omitted: 3}});
  assert.ok(valid(out), JSON.stringify(valid.errors));
  assert.ok(out.failed_jobs.some((j) => 'values' in j) && out.failed_jobs.some((j) => 'values_same_as' in j));
});

// What the second medium found.
const withLines = (name, testName, lines) => ({id: nextJob++, name, step: 'Test', log: runnerLog('Run npm test', [`not ok - ${testName}`, `  AssertionError [ERR_ASSERTION]: ${testName} differs`, ...lines, '  more output'])});
test('another job\'s values are the whole failure, its lines in `lines` too; jobs that differ only there are not the same', async () => {
  const jest = (n) => ({verdict: 'AssertionError: expect(received).toBe(expected)', values: ['Expected: 5', `Received: ${n}`]});
  const of = (name, testName, n) => withLines(name, testName, ['Expected: 5', `Received: ${n}`]);
  const out = await go([of('first', 't one', 6), of('second', 't two', 7), of('third', 't three', 7)], {'t one': jest(6), 't two': jest(7), 't three': jest(7)});
  assert.deepStrictEqual(out.failed_jobs[1].values.slice(1), ['Expected: 5', 'Received: 7'], JSON.stringify(out.failed_jobs));
  assert.strictEqual(out.failed_jobs[2].values_same_as, 1);
  // the triaged job's are in errors already: never twice
  for (const l of ['Expected: 5', 'Received: 6']) assert.strictEqual(out.errors.filter((x) => x === l).length, 1, JSON.stringify(out.errors));
});

test('the triaged job\'s added lines are in the log\'s order, and the notes are after the last of them', async () => {
  const lines = ['Expected: first', 'detail one', 'Received: second', 'detail two'];
  const inOrder = async (spec, over) => {
    const out = await go([withLines('test', 't one', ['Expected: first', 'Received: second'])], {'t one': {values: lines, ...spec}}, over);
    return out.errors.slice(out.errors.findIndex((l) => l.includes('AssertionError')));
  };
  const plain = await inOrder({});
  assert.deepStrictEqual(plain.slice(0, 5), [plain[0], ...lines], JSON.stringify(plain));
  assert.ok(plain[0].includes('t one differs'));
  const noted = await inOrder({cut: true, repeats: 2});
  assert.deepStrictEqual(noted.slice(1, 7), [...lines, VALUES_CUT, firstOfNote(2)], JSON.stringify(noted));
  // (all its lines in `lines`: only the notes are added, after the last)
  const kept = await go([withLines('test', 't one', ['Expected: first', 'Received: second'])], {'t one': {values: ['Expected: first', 'Received: second'], cut: true}});
  const at = kept.errors.indexOf('Received: second');
  assert.deepStrictEqual(kept.errors.slice(at - 1, at + 2), ['Expected: first', 'Received: second', VALUES_CUT], JSON.stringify(kept.errors));
  assert.strictEqual(kept.errors.filter((l) => l === 'Expected: first').length, 1);
  // (the verdict left out by the line cap, its values not: it comes before them)
  const out = await go([withLines('test', 't one', ['Expected: first', 'Received: second'])], {'t one': {values: lines, verdictOutOfLines: true}});
  const v = out.errors.indexOf('AssertionError: the one the cap left out');
  assert.deepStrictEqual(out.errors.slice(v + 1, v + 5), lines, JSON.stringify(out.errors));
});

test('two steps of one name: a block goes under its own verdict, and is shown once', async () => {
  const step = (name) => ({name: 'Run npm test', lines: ['not ok - x', `  AssertionError [ERR_ASSERTION]: ${name} differs`, '##[error]Process completed with exit code 1.']});
  const ctx = makeCtx(world({runs: [run([job('test', 't one')])]}));
  const call = ctx.call;
  ctx.call = async (address, input) => {
    const r = await call(address, input);
    return address === ADDRESSES.clean ? {output: {...r.output, steps: [step('t early'), step('t one')]}} : r;
  };
  const out = await triage({repo: 'acme/widgets', window: 50, maxLogs: 20, ownerHint: false},
    withDetails(ctx, detailsFrom({'t one': {values: ["+ 'mine'"], at: (all) => all.findIndex((l) => l.text.includes('t one differs'))}})), {dataRoot: tmp()});
  const at = out.errors.indexOf("+ 'mine'");
  assert.ok(at > 0 && out.errors[at - 1].includes('t one differs'), JSON.stringify(out.errors));
  assert.strictEqual(out.errors.filter((l) => l === "+ 'mine'").length, 1);
});

test('the same values: only a checkout\'s own path before a location is set aside', async () => {
  const pair = async (a, b) => (await go([job('first', 't one'), job('second', 't two')], {'t one': {verdict: 'AssertionError: alike', values: a}, 't two': {verdict: 'AssertionError: alike', values: b}})).failed_jobs[1];
  const where = (root, rest) => [`  at x (${root}${rest})`];
  for (const [a, b] of [[['at least 3'], ['at least 4']], [where('/home/runner/work/app/app/', 'test/a.js:3:1'), where('/home/runner/work/app/app/', 'test/b.js:9:1')],
    [where('/home/runner/work/app/app/', 'x/test/a.js:3:1'), where('/home/runner/work/app/app/', 'y/test/a.js:3:1')], [where('/srv/one/', 'test/a.js:3:1'), where('/srv/two/', 'test/a.js:3:1')],
    [["+ '/home/runner/work/app/app/a'"], ["+ 'D:\\a\\app\\app\\a'"]]]) {
    const j = await pair(a, b);
    assert.ok('values' in j && !('values_same_as' in j), JSON.stringify([a, b, j]));
  }
  for (const root of ['D:\\a\\app\\app\\', '/Users/runner/work/app/app/', 'file:///home/runner/work/app/app/']) {
    const j = await pair(where('/home/runner/work/app/app/', 'test/a.js:3:1'), where(root, root.includes('\\') ? 'test\\a.js:3:1' : 'test/a.js:3:1'));
    assert.strictEqual(j.values_same_as, 0, root);
  }
});

const spentOn = (out, isOwn) => [...out.errors.filter((l) => !isOwn(l)), ...out.failed_jobs.flatMap((j) => j.values || [])];
test('the bound is what is sent: the notes count, and 50 jobs stay within it', async () => {
  const names = Array.from({length: 50}, (_, i) => `t number${i} end`);
  const table = Object.fromEntries(names.map((n, i) => [n, {values: [`+ value ${i}`], cut: true, omitted: 1}]));
  const plain = await go(names.map((n, i) => job(`job${i}`, n)), null, {maxLogs: 100});
  const own = new Set(plain.errors);
  const out = await go(names.map((n, i) => job(`job${i}`, n)), table, {maxLogs: 100});
  const sent = spentOn(out, (l) => own.has(l));
  assert.ok(sent.length <= BOUNDS.LINES, `${sent.length} lines`);
  assert.ok(sent.join('').length <= BOUNDS.CHARS, `${sent.join('').length} characters`);
  assert.ok(out.failed_jobs.filter((j) => j.first_error != null).slice(1).every((j) => 'values' in j || 'values_same_as' in j || j.values_omitted > 0), JSON.stringify(out.failed_jobs));
});

test('the bound is charged after redaction, which can make a line longer', async () => {
  const names = Array.from({length: 8}, (_, i) => `t number${i} end`);
  const table = Object.fromEntries(names.map((n, i) => [n, {values: Array.from({length: 4}, (_, k) => `+ GROW ${i} ${k}`)}]));
  const grow = (ctx) => {
    const call = ctx.call;
    ctx.call = async (address, input) => {
      const r = await call(address, input);
      return address === ADDRESSES.redact ? {output: {...r.output, lines: r.output.lines.map((l) => (l.includes('GROW') ? `${l.replace('GROW', 'grown')} ${'word '.repeat(60)}` : l))}} : r;
    };
    return ctx;
  };
  const out = await triage({repo: 'acme/widgets', window: 50, maxLogs: 50, ownerHint: false}, withDetails(grow(makeCtx(world({runs: [run(names.map((n, i) => job(`job${i}`, n)))]}))), detailsFrom(table)), {dataRoot: tmp()});
  const sent = spentOn(out, (l) => !l.includes('grown'));
  assert.ok(sent.length > 0 && sent.join('').length <= BOUNDS.CHARS, `${sent.join('').length} characters`);
  assert.ok(sent.every((l) => l.length <= 500));
});

test('a repeated record: its values are said to be the first one\'s', async () => {
  const table = {'t one': {values: ["+ 'one'"], repeats: 3}, 't two': {values: ["+ 'two'"], repeats: 4}};
  const out = await go([job('first', 't one'), job('second', 't two')], table);
  assert.strictEqual(out.errors[out.errors.indexOf("+ 'one'") + 1], firstOfNote(3));
  const v = out.failed_jobs[1].values;
  assert.strictEqual(v[v.indexOf("+ 'two'") + 1], firstOfNote(4), JSON.stringify(v));
});

// What the narrow medium found.
test('values that could not be compared are never the same: a placeholder hides what differs', async () => {
  for (const hidden of ['<withheld>', '<value line withheld>', '<secret>', '<githubToken>', '<email>', '(a line of 21000 characters, omitted)', '(withheld: it holds an e-mail address)']) {
    const table = {'t one': {verdict: 'AssertionError: alike', values: [`+ '${hidden}'`]}, 't two': {verdict: 'AssertionError: alike', values: [`+ '${hidden}'`]}};
    const j = (await go([job('first', 't one'), job('second', 't two')], table)).failed_jobs[1];
    assert.ok('values' in j && !('values_same_as' in j), `${hidden}: ${JSON.stringify(j)}`);
  }
  const frame = {verdict: 'AssertionError: alike', values: ['  at Object.<anonymous> (test/a.js:3:1)']};
  assert.strictEqual((await go([job('first', 't one'), job('second', 't two')], {'t one': frame, 't two': frame})).failed_jobs[1].values_same_as, 0);
});

test('a value that ends like a location is compared as it is', async () => {
  const at = (root) => ({verdict: 'AssertionError: alike', values: [`open (${root}x.js:1:1)`]});
  const j = (await go([job('first', 't one'), job('second', 't two')], {'t one': at('D:\\a\\app\\app\\'), 't two': at('/home/runner/work/app/app/')})).failed_jobs[1];
  assert.ok(!('values_same_as' in j), JSON.stringify(j));
});

test('a key split across an error line and its values stays hidden, and what that took with it is said', async () => {
  const body = crypto.randomBytes(48).toString('base64');
  const begin = ['-----BEGIN', 'RSA', 'PRIVATE', 'KEY-----'].join(' ');
  const ctx = makeCtx(world({runs: [run([job('test', 't one'), job('other', 't two')])]}));
  const call = ctx.call;
  ctx.call = async (address, input) => {
    const r = await call(address, input);
    if (address !== ADDRESSES.extract || input.steps.length === 0) return r;
    return {output: {...r.output, lines: r.output.lines.map((l) => (l.text.includes('AssertionError') ? {...l, text: `  AssertionError: ${begin}`} : l))}};
  };
  const same = {verdict: `  AssertionError: ${begin}`, values: [`+ ${body}`, '+ one']};
  const out = await triage({repo: 'acme/widgets', window: 50, maxLogs: 20, ownerHint: false}, withDetails(ctx, detailsFrom({'t one': same, 't two': same})), {dataRoot: tmp()});
  assert.ok(!JSON.stringify(out.errors).includes(body) && !JSON.stringify(out.errors).includes(body.slice(0, 24)), JSON.stringify(out.errors));
  assert.strictEqual(out.errors[out.errors.length - 1], omittedNote(1), JSON.stringify(out.errors));
  // (values that were dropped are nobody's same ones)
  assert.ok(!('values_same_as' in out.failed_jobs[1]), JSON.stringify(out.failed_jobs[1]));
});

test('a line the pack cuts is said to be cut', async () => {
  const long = `AssertionError: ${'word '.repeat(96)}`.slice(0, 498);
  const table = {'t one': {values: ["+ 'a'"]}, 't two': {verdict: long, values: ["+ GROW"], repeats: 3}};
  const ctx = makeCtx(world({runs: [run([job('first', 't one'), job('second', 't two')])]}));
  const call = ctx.call;
  ctx.call = async (address, input) => {
    const r = await call(address, input);
    return address === ADDRESSES.redact ? {output: {...r.output, lines: r.output.lines.map((l) => (l.includes('GROW') ? `+ ${'word '.repeat(110)}` : l))}} : r;
  };
  const v = (await triage({repo: 'acme/widgets', window: 50, maxLogs: 20, ownerHint: false}, withDetails(ctx, detailsFrom(table)), {dataRoot: tmp()})).failed_jobs[1].values;
  assert.strictEqual(v[0], long, 'the verdict whole: its count is in the note');
  assert.ok(v.every((l) => l.length <= 500) && v.includes(VALUES_CUT) && v.includes(firstOfNote(3)), JSON.stringify(v));
});

test('a job with nothing to sign still shows its values, triaged or listed', async () => {
  const ctx = makeCtx(world({runs: [run([job('first', 't one'), job('second', 't two')])]}));
  const call = ctx.call;
  ctx.call = async (address, input) => {
    const r = await call(address, input);
    return address === ADDRESSES.sign ? {output: {...r.output, normalised: r.output.normalised.map(() => '')}} : r;
  };
  const out = await triage({repo: 'acme/widgets', window: 50, maxLogs: 20, ownerHint: false}, withDetails(ctx, detailsFrom({'t one': {values: ["+ 'one'"]}, 't two': {values: ["+ 'two'"]}})), {dataRoot: tmp()});
  assert.ok(out.failed_jobs.every((j) => j.history.verdict === 'unknown'), JSON.stringify(out.failed_jobs));
  const at = out.errors.indexOf("+ 'one'");
  assert.ok(at > 0 && out.errors[at - 1].includes('AssertionError'), JSON.stringify(out.errors));
  assert.ok(out.failed_jobs[1].values.includes("+ 'two'"), JSON.stringify(out.failed_jobs[1]));
});

// The pack's high read. The part's answer is given whole here.
const STEP = 'Run npm test';
const answered = async (lines, blocks, {jobs = 1, redactToo} = {}) => {
  const ctx = makeCtx(world({runs: [run(Array.from({length: jobs}, (_, i) => job(`job${i}`, `t job${i}`)))]}));
  const call = ctx.call;
  ctx.call = async (address, input) => {
    const r = await call(address, input);
    if (address === ADDRESSES.redact && redactToo !== undefined) return {output: {...r.output, lines: r.output.lines.map(redactToo)}};
    if (address !== ADDRESSES.extract || !Array.isArray(input.steps) || input.steps.length === 0) return r;
    return {output: {failingStep: STEP, truncated: false, rules: r.output.rules, lines: lines.map((l) => ({step: STEP, kind: 'error', ...l})), details: {blocks: blocks.map((b) => ({step: STEP, cut: false, ...b, places: b.places || b.values.map(() => -1)})), omittedBlocks: 0}}};
  };
  return triage({repo: 'acme/widgets', window: 50, maxLogs: 20, ownerHint: false}, ctx, {dataRoot: tmp()});
};

test('a failure with nothing in `lines` goes where it was in the log, never between another verdict and its values', async () => {
  const early = {index: 10, verdict: 'AssertionError: first', values: ['+ first-value']};
  const late = {index: 30, line: 1, verdict: 'AssertionError: second', values: ['+ second-value']};
  const out = await answered([{index: 0, text: 'Error: early'}, {index: 30, text: 'AssertionError: second', kind: 'assert'}], [early, late]);
  assert.deepStrictEqual(out.errors, ['Error: early', 'AssertionError: first', '+ first-value', 'AssertionError: second', '+ second-value'], JSON.stringify(out.errors));
  // (forty lines before it, the last of them another failure's verdict)
  const noise = Array.from({length: 39}, (_, i) => ({index: i, text: `Error: noise ${i}`}));
  const capped = await answered([...noise, {index: 90, text: 'AssertionError: second', kind: 'assert'}], [{...early, index: 50}, {...late, index: 90, line: 39}]);
  assert.deepStrictEqual(capped.errors.slice(39), ['AssertionError: first', '+ first-value', 'AssertionError: second', '+ second-value'], JSON.stringify(capped.errors.slice(36)));
  // (after the other failure, when it was after it: after that one's values too)
  const after = await answered([{index: 0, text: 'Error: early'}, {index: 30, text: 'AssertionError: second', kind: 'assert'}], [late, {...early, index: 60}]);
  assert.deepStrictEqual(after.errors, ['Error: early', 'AssertionError: second', '+ second-value', 'AssertionError: first', '+ first-value'], JSON.stringify(after.errors));
  // (before every line shown)
  const before = await answered([{index: 30, text: 'AssertionError: second', kind: 'assert'}], [early, {...late, line: 0}]);
  assert.deepStrictEqual(before.errors.slice(0, 2), ['AssertionError: first', '+ first-value'], JSON.stringify(before.errors));
});

test('a failure with nothing in `lines` stays in its own step: a later step\'s lines come after it', async () => {
  const lines = [{index: 0, text: 'Error: one'}, {index: 5, text: 'Error: five'}, {step: 'Post cache', index: 2, text: 'Error: cache'}];
  const at = async (index) => (await answered(lines, [{index, verdict: 'AssertionError: x', values: ['+ the-value']}])).errors;
  assert.deepStrictEqual(await at(9), ['Error: one', 'Error: five', 'AssertionError: x', '+ the-value', 'Error: cache']);
  assert.deepStrictEqual(await at(3), ['Error: one', 'AssertionError: x', '+ the-value', 'Error: five', 'Error: cache']);
});

test('a value line that is an error line too is shown as the part screened it, in its own place', async () => {
  const raw = crypto.randomBytes(16).toString('hex');
  const lines = [{index: 0, text: 'AssertionError: keys differ', kind: 'assert'}, {index: 1, text: `+ '${raw}'`, kind: 'tail'}, {index: 2, text: "- 'expected'", kind: 'tail'}, {index: 3, text: 'more output', kind: 'tail'}];
  const block = {index: 0, line: 0, verdict: 'AssertionError: keys differ', values: ["+ '<withheld>'", "- 'expected'"], places: [1, 2]};
  const out = await answered(lines, [block], {jobs: 2});
  assert.deepStrictEqual(out.errors, ['AssertionError: keys differ', "+ '<withheld>'", "- 'expected'", 'more output'], JSON.stringify(out.errors));
  assert.ok(!JSON.stringify(out).includes(raw), 'nowhere in the answer');
  // (a repeated record's count stays with it)
  const twice = await answered([lines[0], {...lines[1], repeats: 3}], [{...block, values: ["+ '<withheld>'"], places: [1]}]);
  assert.strictEqual(twice.errors[1], "+ '<withheld>' (3 times)", JSON.stringify(twice.errors));
  // (it is no added line: the limit is not spent on it)
  const many = Array.from({length: 39}, (_, i) => ({index: i + 1, text: `+ value ${i}`, kind: 'tail'}));
  const full = await answered([lines[0], ...many], Array.from({length: 3}, (_, n) => ({index: 0, line: 0, verdict: 'AssertionError: keys differ', values: many.slice(n * 12, n * 12 + 12).map((l) => l.text), places: many.slice(n * 12, n * 12 + 12).map((_, k) => n * 12 + k + 1)})));
  assert.strictEqual(full.errors.length, 40, JSON.stringify(full.errors.length));
});

test('a value line the limit left out of the added ones keeps its screened copy', async () => {
  const raw = crypto.randomBytes(16).toString('hex');
  const long = Array.from({length: 12}, (_, k) => `+ ${'word '.repeat(60)}${k}`);
  const lines = [{index: 0, text: 'AssertionError: a', kind: 'assert'}, {index: 20, text: 'AssertionError: b', kind: 'assert'}, {index: 40, text: 'AssertionError: c', kind: 'assert'}, {index: 41, text: `+ '${raw}'`, kind: 'tail'}];
  const block = (index, line, values, places) => ({index, line, verdict: lines[line].text, values, places});
  const out = await answered(lines, [block(0, 0, long), block(20, 1, long), block(40, 2, ["+ '<withheld>'", ...long.slice(0, 11)], [3, ...Array(11).fill(-1)])]);
  assert.ok(!JSON.stringify(out).includes(raw) && out.errors.includes("+ '<withheld>'"), JSON.stringify(out.errors.map((l) => l.slice(0, 40))));
});

test('an assertion\'s own line is shown as the part screened it, with its count', async () => {
  const raw = crypto.randomBytes(16).toString('hex');
  const line = (more) => ({index: 0, text: `AssertionError: expected '${raw}' to equal 'x'`, kind: 'assert', ...more});
  const block = {index: 0, line: 0, verdict: "AssertionError: expected '<withheld>' to equal 'x'", values: ["+ 'y'"]};
  const once = await answered([line()], [block]);
  assert.deepStrictEqual(once.errors, ["AssertionError: expected '<withheld>' to equal 'x'", "+ 'y'"], JSON.stringify(once.errors));
  const thrice = await answered([line({repeats: 3})], [{...block, repeats: 3}]);
  assert.strictEqual(thrice.errors[0], "AssertionError: expected '<withheld>' to equal 'x' (3 times)", JSON.stringify(thrice.errors));
  // (the screen can take an ellipsis with the value it ends, and can withhold a whole line)
  const inside = `AssertionError: expected '${raw.slice(0, 12)}…' to equal 'b'`;
  for (const verdict of ["AssertionError: expected '<withheld>' to equal 'b'", '<value line withheld>']) {
    const out = await answered([line({text: inside})], [{...block, verdict}]);
    assert.strictEqual(out.errors[0], verdict, JSON.stringify(out.errors));
  }
  // (a line of JSON that `lines` cut short: its screened copy, as long as the line was there, never through a placeholder)
  const cut = 'AssertionError: {"property0":"some text","property1":"som…';
  const json = async (verdict) => (await answered([{index: 0, text: cut, kind: 'assert'}], [{...block, verdict}])).errors[0];
  const whole = 'AssertionError: {"property0":"some text","property1":"some text","last":9';
  assert.strictEqual(await json(`${whole}}`), cut);
  assert.strictEqual(await json(`${whole}${'9'.repeat(400)}…`), cut, 'the line bound cut the verdict too');
  const placeholder = await json('AssertionError: {"property0":"some text","property1":"<withheld>","last":9}');
  assert.ok(placeholder.length <= cut.length && placeholder.endsWith('…') && !/<[a-z ]*…$/.test(placeholder), placeholder);
  // (and one the log itself cut is screened like any other)
  const both = await answered([line({text: `AssertionError: ${raw} and the rest of it…`})], [{...block, verdict: 'AssertionError: <withheld> and the rest of <withheld>…'}]);
  assert.strictEqual(both.errors[0], 'AssertionError: <withheld> and the rest of <withheld>…', JSON.stringify(both.errors));
});

test('two steps of one name: a failure with nothing in `lines` keeps its lines together, wherever it goes', async () => {
  const lines = [{index: 0, text: 'Error: one'}, {index: 8, text: 'Error: two'}, {index: 1, text: 'Error: three'}];
  const out = await answered(lines, [{index: 4, verdict: 'AssertionError: x', values: ['+ the-value', '- other']}]);
  const at = out.errors.indexOf('AssertionError: x');
  assert.deepStrictEqual(out.errors.slice(at, at + 3), ['AssertionError: x', '+ the-value', '- other'], JSON.stringify(out.errors));
  assert.deepStrictEqual(out.errors.filter((l) => l.startsWith('Error:')), lines.map((l) => l.text));
});

test('a key split across a swapped line and the raw lines around it stays hidden, wherever the swapped line is in it', async () => {
  const mark = (word) => [`-----${word}`, 'RSA', 'PRIVATE', 'KEY-----'].join(' ');
  const body = () => crypto.randomBytes(48).toString('base64');
  const hidden = (out, parts, why) => {
    const text = JSON.stringify(out.errors);
    for (const part of parts) assert.ok(!text.includes(part) && !text.includes(part.slice(4, 20)), `${why}: ${text}`);
  };
  const verdict = {index: 0, text: 'AssertionError: keys differ', kind: 'assert'};
  const own = (values, places) => [{index: 0, line: 0, verdict: verdict.text, values, places}];
  const tail = (index, text) => ({index, text, kind: 'tail'});
  // the swapped line is the BEGIN one; the body and the END line are raw
  {
    const [a, b] = [body(), body()];
    const token = crypto.randomBytes(12).toString('hex');
    const out = await answered([verdict, tail(1, `+ ${token} ${mark('BEGIN')}`), tail(2, a), tail(3, b), tail(4, mark('END')), tail(5, 'the line after')], own([`+ <withheld> ${mark('BEGIN')}`], [1]));
    hidden(out, [a, b, token], 'BEGIN swapped');
    assert.ok(out.errors.includes('the line after'), JSON.stringify(out.errors));
  }
  // it is a line of the body, withheld by the screen, between two raw ones
  {
    const [a, b, c] = [body(), body(), body()];
    const out = await answered([verdict, tail(1, mark('BEGIN')), tail(2, a), tail(3, `+ ${b}`), tail(4, c), tail(5, mark('END')), tail(6, 'the line after')], own(['+ <withheld>'], [3]));
    hidden(out, [a, b, c], 'a body line withheld');
    assert.ok(out.errors.includes('the line after'), JSON.stringify(out.errors));
  }
  // it is the END line
  {
    const [a, b] = [body(), body()];
    const token = crypto.randomBytes(12).toString('hex');
    const out = await answered([verdict, tail(1, mark('BEGIN')), tail(2, a), tail(3, b), tail(4, `+ ${mark('END')} ${token}`), tail(5, 'the line after')], own([`+ ${mark('END')} <withheld>`], [4]));
    hidden(out, [a, b, token], 'END swapped');
    assert.ok(out.errors.includes('the line after'), JSON.stringify(out.errors));
  }
  // the assertion's own line is the BEGIN one, and a body line under it is withheld
  {
    const [a, b] = [body(), body()];
    const token = crypto.randomBytes(12).toString('hex');
    const out = await answered([{...verdict, text: `AssertionError: ${token} ${mark('BEGIN')}`}, tail(1, `+ ${a}`), tail(2, b), tail(3, mark('END'))], [{index: 0, line: 0, verdict: `AssertionError: <withheld> ${mark('BEGIN')}`, values: ['+ <withheld>'], places: [1]}]);
    hidden(out, [a, b, token], 'the verdict');
  }
});

test('a swapped value line keeps its runner\'s tag: one failure\'s value never reads as another\'s', async () => {
  const lines = [{index: 0, text: '[a] AssertionError: one differs', kind: 'assert'}, {index: 1, text: '[b] AssertionError: two differs', kind: 'assert'}, {index: 2, text: "[a]   + 'one'", kind: 'tail'}, {index: 3, text: "[b]   + 'two'", kind: 'tail'}];
  const block = (index, tag, verdict, value, place) => ({index, line: index, tag, verdict, values: [value], places: [place]});
  const out = await answered(lines, [block(0, '[a] ', '[a] AssertionError: one differs', "  + 'one'", 2), block(1, '[b] ', '[b] AssertionError: two differs', "  + '<withheld>'", 3)]);
  assert.deepStrictEqual(out.errors, ['[a] AssertionError: one differs', '[b] AssertionError: two differs', "[a]   + 'one'", "[b]   + '<withheld>'"], JSON.stringify(out.errors));
  // (a tag the screen withheld stays withheld)
  const hidden = await answered([lines[0], {...lines[2], text: "[a]   + 'one'"}], [{...block(0, '[<withheld>] ', '[<withheld>] AssertionError: one differs', "  + 'one'", 1)}]);
  assert.deepStrictEqual(hidden.errors, ['[<withheld>] AssertionError: one differs', "[<withheld>]   + 'one'"], JSON.stringify(hidden.errors));
});
