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

// (the fourth and fifth mediums) a cache that can't be read just now is
// never written over; one that can't be parsed, or is another version's,
// is moved aside and a fresh one started (never caching off for good)
test('a cache that cannot be read now is left alone; one that cannot be parsed is moved aside and started afresh', () => {
  for (const make of [(root) => fs.writeFileSync(fileOf(root), '{not json'), (root) => fs.writeFileSync(fileOf(root), JSON.stringify({version: 2, runs: {1: {jobId: 1}}}))]) {
    const root = tmp();
    seed(root, {});
    make(root);
    const before = fs.readFileSync(fileOf(root), 'utf8');
    assert.strictEqual(writeCache('acme/widgets', {9: {jobId: 9}}, root), true);
    assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(fileOf(root), 'utf8')).runs), ['9']);
    const aside = fs.readdirSync(path.dirname(fileOf(root))).filter((n) => n.startsWith('fingerprints.json.unreadable-'));
    assert.strictEqual(aside.length, 1, 'moved aside');
    assert.strictEqual(fs.readFileSync(path.join(path.dirname(fileOf(root)), aside[0]), 'utf8'), before);
  }
  if (process.platform !== 'win32' && process.getuid() !== 0) {
    const root = tmp();
    seed(root, {1: {jobId: 1}});
    fs.chmodSync(fileOf(root), 0);
    try {
      assert.strictEqual(writeCache('acme/widgets', {9: {jobId: 9}}, root), false);
    } finally { fs.chmodSync(fileOf(root), 0o600); }
    assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(fileOf(root), 'utf8')).runs), ['1'], 'left as it was');
  }
});

// (the fifth medium) the pack's key: made atomically, read only as this
// user's own owner-only 32-byte file, never a link; anything else, and no
// key at all, gives a key of this process's own, never a plain hash
const crypto = require('node:crypto');
const {keyedHash, keyId} = require('../lib/cache');
const hmac = (key, s) => crypto.createHmac('sha256', key).update(s).digest('hex');
test('the pack key is made once and read back; a link, a loose file or a short one is never used', () => {
  const root = tmp();
  const first = keyedHash('x', root);
  const key = fs.readFileSync(path.join(root, '.pack-key'));
  assert.strictEqual(key.length, 32);
  assert.strictEqual(first, hmac(key, 'x'));
  if (process.platform === 'win32') return;
  const theirs = crypto.randomBytes(32);
  for (const plant of [(file) => { fs.writeFileSync(`${file}.target`, theirs); fs.symlinkSync(`${file}.target`, file); },
    (file) => { fs.writeFileSync(file, theirs); fs.chmodSync(file, 0o644); }, (file) => fs.writeFileSync(file, theirs.subarray(0, 7), {mode: 0o600})]) {
    const r = tmp();
    plant(path.join(r, '.pack-key'));
    const got = keyedHash('x', r);
    assert.ok(typeof got === 'string' && /^[0-9a-f]{64}$/.test(got));
    assert.notStrictEqual(got, hmac(theirs, 'x'), 'a planted key was used');
    assert.notStrictEqual(got, crypto.createHash('sha256').update('x').digest('hex'), 'a plain hash');
    assert.notStrictEqual(keyId(r), keyId(root));
  }
});

// (the reviewer's high on #18, M3) no makeable key costs no waiting: the
// process's own key at once, never a pause per hash
const {testHooks} = require('../lib/cache');
test('with no key to be had, keyed hashes do not wait; a transient open error is retried by the next hash', () => {
  if (process.platform === 'win32' || process.getuid() === 0) return;
  let pauses = 0;
  testHooks.pause = () => { pauses += 1; };
  try {
    const root = tmp();
    fs.chmodSync(root, 0o500);
    try {
      for (let i = 0; i < 100; i++) keyedHash(`b${i}`, root);
      assert.strictEqual(pauses, 0, 'no pause when no key can be made');
      assert.strictEqual(keyedHash('x', root), keyedHash('x', root), 'one key for the process');
    } finally { fs.chmodSync(root, 0o700); }
    // a key file that can't be opened just now (EACCES), then can: the real key
    const later = tmp();
    const real = crypto.randomBytes(32);
    fs.writeFileSync(path.join(later, '.pack-key'), real, {mode: 0o600});
    fs.chmodSync(path.join(later, '.pack-key'), 0);
    const before = keyedHash('y', later);
    fs.chmodSync(path.join(later, '.pack-key'), 0o600);
    assert.notStrictEqual(before, hmac(real, 'y'));
    assert.strictEqual(keyedHash('y', later), hmac(real, 'y'), 'the real key once it can be read');
    // the race: another launcher links the key first; this one pauses and reads it
    const raced = tmp();
    const theirs = crypto.randomBytes(32);
    testHooks.beforeLink = (file) => { fs.writeFileSync(file, theirs, {mode: 0o600}); };
    assert.strictEqual(keyedHash('z', raced), hmac(theirs, 'z'), 'the winner\'s key');
    assert.ok(pauses >= 1, 'the race paused');
  } finally {
    testHooks.pause = null;
    testHooks.beforeLink = null;
  }
});
