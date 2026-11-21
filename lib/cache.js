'use strict';
// The fingerprint cache: <root>/<owner>__<name>/fingerprints.json, where root
// is the module's /data. {version: 1, runs: {[runId]: {jobId, signature, algorithm, step,
// commit, createdAt, errorLineHashes} | {jobId, expired: true, commit,
// createdAt}}}. Hashes only: never a raw line, and the step by its SHA-256
// (a step's name can hold its command, and a token in it). Written by temp file and rename,
// merged with what is on disk at write time, and read back: a write another
// launcher overtook is merged and written again, so two launchers writing at
// once lose nothing. A cache that cannot be read or written costs fetches,
// never the answer. A signed run also records the failure-signature
// `algorithm` that signed it; the chain reads again a run signed by another
// one (cache-gap part 3).
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const VERSION = 1;
const ATTEMPTS = 5;
const config = {root: '/data'};
const fileOf = (repo, root) => path.join(root, repo.replace('/', '__'), 'fingerprints.json');
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');

// The pack's own key, 32 random bytes in <root>/.pack-key, made once: a
// keyed hash of a value no one can search for without it -- a cut step name
// that ends in a token's head, a branch name (the fourth and fifth mediums
// on pack 1's round).
// - Made atomically: written to a private temp file, then linked into place
//   (a link fails when the name exists), so no launcher reads it half made.
// - Read only by O_NOFOLLOW as this user's own regular file, owner-only
//   (POSIX), of exactly 32 bytes; a link, another user's file or a loose or
//   short one is never used (whoever planted or can read it knows it).
// - No usable key (none can be made, or one is refused): a key of this
//   process's own, at once and kept for the process, never a plain hash
//   and never a pause per hash (the reviewer's high on #18, M3). Its
//   signatures differ from the cache's, and keyId puts that in the cache's
//   marker, so the history is rebuilt and said, never silently split.
// Only a create that loses the race to link the file waits, briefly, and
// reads again.
const KEY_FILE = '.pack-key';
const KEY_BYTES = 32;
const keys = new Map();
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
// Tests only: a pause to count, and a step before the link (another
// launcher linking first).
const testHooks = {pause: null, beforeLink: null};
// -> {key} | {missing} | {refused} (a link, another's, loose) | {short} |
// {transient} (an open that failed for another reason: tried again later)
function readKey(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
  } catch (e) {
    const code = e != null ? e.code : null;
    if (code === 'ENOENT') return {missing: true};
    if (code === 'ELOOP') return {refused: true};
    return {transient: true};
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return {refused: true};
    if (process.platform !== 'win32' && typeof process.getuid === 'function' && (st.uid !== process.getuid() || (st.mode & 0o077) !== 0)) return {refused: true};
    if (st.size !== KEY_BYTES) return {short: true};
    const b = Buffer.alloc(KEY_BYTES);
    return fs.readSync(fd, b, 0, KEY_BYTES, 0) === KEY_BYTES ? {key: b} : {short: true};
  } catch {
    return {refused: true};
  } finally {
    try { fs.closeSync(fd); } catch { /* closed */ }
  }
}
// -> {key} when this call made it (read back after the link), {raced} when
// another made it first, else {} (none can be made). The temp file's name
// is random: two threads of one process never share it (the high, L4).
function makeKey(root, file) {
  const temp = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.mkdirSync(root, {recursive: true});
    fs.writeFileSync(temp, crypto.randomBytes(KEY_BYTES), {mode: 0o600, flag: 'wx'});
    try {
      if (typeof testHooks.beforeLink === 'function') testHooks.beforeLink(file);
      fs.linkSync(temp, file);
    } catch (e) {
      return e != null && e.code === 'EEXIST' ? {raced: true} : {};
    }
    const back = readKey(file);
    return back.key != null ? {key: back.key} : {};
  } catch {
    return {};
  } finally {
    try { fs.rmSync(temp, {force: true}); } catch { /* left */ }
  }
}
const pause = (ms) => {
  if (typeof testHooks.pause === 'function') return testHooks.pause(ms);
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no wait */ }
  return undefined;
};
// the process's own key per data root, when the pack's can't be had: kept
// for the process after a definite failure (keys), only for the moment
// after a transient one, which the next hash tries again (the medium on
// the high round: an EMFILE must not pin a throwaway key for good)
const own = new Map();
const ownKey = (root) => {
  if (!own.has(root)) own.set(root, crypto.randomBytes(KEY_BYTES));
  return own.get(root);
};
function keyOf(root) {
  if (keys.has(root)) return keys.get(root);
  const file = path.join(root, KEY_FILE);
  for (let attempt = 0; attempt < 5; attempt++) {
    const got = readKey(file);
    if (got.key != null) { keys.set(root, got.key); return got.key; }
    // (an open that failed just now: this hash only, the next tries again)
    if (got.transient) return ownKey(root);
    // (a link, another's, a loose or a short file: never used, no waiting)
    if (!got.missing) break;
    const made = makeKey(root, file);
    if (made.key != null) { keys.set(root, made.key); return made.key; }
    if (!made.raced) break;
    pause(20);
  }
  keys.set(root, ownKey(root));
  return keys.get(root);
}
const keyedHash = (s, root = config.root) => crypto.createHmac('sha256', keyOf(root)).update(String(s)).digest('hex');
// The key's own id, for the cache's marker: which key signed (8 hex of an
// HMAC of a constant, so it names the key and tells nothing of it).
const keyId = (root = config.root) => keyedHash('ch-pack-ci-failure-triage key id', root).slice(0, 8);

// A step kept raw by a cache from before steps were hashed (a name can hold
// its command, and a token in it) is hashed in memory on every read, and
// on disk only through writeCache's merge-and-read-back, never by a read: a
// read that wrote could put an older snapshot over another launcher's
// entries (the third medium on pack 1's round).
const HASHED = /^[0-9a-f]{64}$/;
const SCRUBBED = Symbol('scrubbed');
function scrub(c) {
  let changed = false;
  for (const r of Object.values(c.runs)) {
    if (r != null && typeof r === 'object' && typeof r.step === 'string' && !HASHED.test(r.step)) { r.step = hash(r.step); changed = true; }
  }
  return changed;
}
const rawLeft = (c) => Object.values(c.runs).some((r) => r != null && typeof r === 'object' && typeof r.step === 'string' && !HASHED.test(r.step));

// -> the cache, its steps hashed; c[SCRUBBED] when a raw one was found
// (the caller writes it back through writeCache with {scrub: true}). One
// that isn't there starts empty; one that can't be read just now starts
// empty too but is marked UNREADABLE, and writeCache never writes over it
// (the fourth medium: a transient read failure erased every other
// launcher's entries).
const UNREADABLE = Symbol('unreadable');
const isCache = (c) => c != null && c.version === VERSION && c.runs != null && typeof c.runs === 'object' && !Array.isArray(c.runs);
function readCache(repo, root = config.root) {
  let text;
  try {
    text = fs.readFileSync(fileOf(repo, root), 'utf8');
  } catch (e) {
    const empty = {version: VERSION, runs: {}};
    if (e == null || e.code !== 'ENOENT') Object.defineProperty(empty, UNREADABLE, {value: true});
    return empty;
  }
  let c = null;
  try { c = JSON.parse(text); } catch { c = null; }
  if (!isCache(c)) {
    // (one that can't be parsed, or another version's, is moved aside and a
    // fresh one started: never caching off for good; if it can't be moved,
    // it is left, and not written over)
    const file = fileOf(repo, root);
    const empty = {version: VERSION, runs: {}};
    try { fs.renameSync(file, `${file}.unreadable-${Date.now()}`); } catch { Object.defineProperty(empty, UNREADABLE, {value: true}); }
    return empty;
  }
  if (scrub(c)) Object.defineProperty(c, SCRUBBED, {value: true});
  return c;
}
const scrubbed = (c) => c != null && c[SCRUBBED] === true;

// Adds `runs` to the cache on disk (and, with scrub, writes it even with
// none, so a raw step found by a read leaves the disk) -> true when they
// are all there afterwards and no raw step is. A failed write, or a failed
// cleanup after it, costs fetches, never the answer: nothing here throws.
function writeCache(repo, runs, root = config.root, {scrub: force = false} = {}) {
  const ids = Object.keys(runs);
  if (ids.length === 0 && !force) return true;
  const file = fileOf(repo, root);
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const temp = `${file}.${process.pid}.${Date.now()}.${attempt}.tmp`;
    try {
      const merged = readCache(repo, root);
      if (merged[UNREADABLE] === true) return false;
      Object.assign(merged.runs, runs);
      fs.mkdirSync(path.dirname(file), {recursive: true});
      fs.writeFileSync(temp, JSON.stringify(merged) + '\n');
      fs.renameSync(temp, file);
    } catch {
      try { fs.rmSync(temp, {force: true}); } catch { /* left as it was */ }
      return false;
    }
    let onDisk = null;
    try { onDisk = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { onDisk = null; }
    if (isCache(onDisk) && ids.every((id) => onDisk.runs[id] != null) && !rawLeft(onDisk)) return true;
  }
  return false;
}

module.exports = {readCache, writeCache, scrubbed, hash, keyedHash, keyId, config, testHooks};
