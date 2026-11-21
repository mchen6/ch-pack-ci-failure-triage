'use strict';
require('./tmp-dirs');
// lib/cache.js: hashes only, and a cache that can't be read or written costs
// fetches, never the answer (the third medium on pack 1's round).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {readCache, writeCache} = require('../lib/cache');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ch-triage-'));
const fileOf = (root) => path.join(root, 'acme__widgets', 'fingerprints.json');
const seed = (root, runs) => { fs.mkdirSync(path.dirname(fileOf(root)), {recursive: true}); fs.writeFileSync(fileOf(root), JSON.stringify({version: 1, runs})); };

test('a raw step is hashed through writeCache\'s merge, never by a read: another writer\'s entries survive', () => {
  const root = tmp();
  seed(root, {1: {jobId: 1, signature: 's', step: 'Run git push secret', commit: 'c', createdAt: 't'}});
  const c = readCache('acme/widgets', root);
  assert.ok(/^[0-9a-f]{64}$/.test(c.runs[1].step), 'hashed in memory');
  assert.ok(fs.readFileSync(fileOf(root), 'utf8').includes('Run git push secret'), 'a read writes nothing');
  writeCache('acme/widgets', {2: {jobId: 2, signature: 't', step: null, commit: 'd', createdAt: 'u'}}, root);
  const after = JSON.parse(fs.readFileSync(fileOf(root), 'utf8'));
  assert.deepStrictEqual(Object.keys(after.runs).sort(), ['1', '2']);
  assert.ok(!fs.readFileSync(fileOf(root), 'utf8').includes('Run git push secret'));
  // and a scrub alone: written with no fresh entries, merged and read back
  seed(root, {3: {jobId: 3, signature: 's', step: 'Run raw', commit: 'c', createdAt: 't'}});
  assert.strictEqual(writeCache('acme/widgets', {}, root, {scrub: true}), true);
  assert.ok(!fs.readFileSync(fileOf(root), 'utf8').includes('Run raw'));
});

test('a cache write whose cleanup fails costs nothing: no throw', () => {
  const root = tmp();
  seed(root, {});
  const {writeFileSync, rmSync} = fs;
  fs.writeFileSync = () => { throw Object.assign(new Error('read-only'), {code: 'EROFS'}); };
  fs.rmSync = () => { throw Object.assign(new Error('denied'), {code: 'EACCES'}); };
  try {
    assert.strictEqual(writeCache('acme/widgets', {1: {jobId: 1}}, root), false);
    assert.strictEqual(writeCache('acme/widgets', {}, root, {scrub: true}), false);
  } finally {
    fs.writeFileSync = writeFileSync;
    fs.rmSync = rmSync;
  }
});

// (the fourth medium, pre-existing) a cache that can't be read is never
// written over: only one that isn't there yet is started afresh
test('an unreadable or other-version cache is never written over', () => {
  for (const make of [(root) => { seed(root, {1: {jobId: 1}}); fs.writeFileSync(fileOf(root), '{not json'); }, (root) => fs.writeFileSync(fileOf(root), JSON.stringify({version: 2, runs: {1: {jobId: 1}}}))]) {
    const root = tmp();
    seed(root, {});
    make(root);
    const before = fs.readFileSync(fileOf(root), 'utf8');
    assert.strictEqual(writeCache('acme/widgets', {9: {jobId: 9}}, root), false);
    assert.strictEqual(fs.readFileSync(fileOf(root), 'utf8'), before, 'left as it was');
  }
});
