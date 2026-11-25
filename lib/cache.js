'use strict';
// The fingerprint cache: <root>/<owner>__<name>/fingerprints.json, where root
// is the module's /data. {version: 2, runs: {[runId]: {failedJobs: [[name key, jobId]],
// keyId, conclusion, commit, createdAt, attempt?, earlier?, lost?, notFailed?} | {noJobs: true, conclusion, commit,
// createdAt, attempt?}, ['<runId>/<jobId>']: {jobId, signature, algorithm, step, commit,
// createdAt, errorLineHashes} | {jobId, unsigned: true, algorithm, commit, createdAt} (a log with nothing
// to sign) | {jobId, expired: true, commit, createdAt}}}:
// a run's failed jobs, those of its earlier attempts the cache knew included, each by the pack's
// keyed hash of its name (earlier: the ids GitHub's latest list no longer had; lost: an earlier
// list under another key held others; notFailed: the run was a success when listed), then each job read. Version 1
// held one signature per run, of whichever job GitHub listed first; such a cache is
// set aside and rebuilt, never read as any one job's. Hashes only: never a raw line, and the step by its SHA-256
// (a step's name can hold its command, and a token in it). Written by temp file and rename,
// merged with what is on disk at write time, and read back: a write another
// launcher overtook is merged and written again, so two launchers writing at
// once lose nothing. A cache that cannot be written costs fetches, never the
// answer; one that cannot be read costs a "new" too: it may hold what a run
// failed before its re-run, which no fetch can recover, so the chain answers
// "unknown". A signed run also records the failure-signature
// `algorithm` that signed it; the chain reads again a run signed by another
// one (cache-gap part 3).
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const VERSION = 2;
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
// One key for a whole call: keyOf can answer a throwaway key for a moment
// (a transient open error), and names hashed under one key must never be
// stored with the id of another. -> {id, hash(s)}
const keySnapshot = (root = config.root) => {
  const key = keyOf(root);
  const hmac = (s) => crypto.createHmac('sha256', key).update(String(s)).digest('hex');
  return {id: hmac('ch-pack-ci-failure-triage key id').slice(0, 8), hash: hmac};
};

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
// (a cache of another version, set aside: the history is being rebuilt)
const REBUILT = Symbol('rebuilt');
// Each entry held to its shape on read, before anything walks it (the
// reviewer's high on #18, round 2: a signature nested 3,000 arrays deep made
// canonical() throw on every call): a signed run {jobId, signature (64 hex),
// algorithm?, step? (64 hex, or a raw string still to be scrubbed),
// commit, createdAt, errorLineHashes? (64 hex each)}, one whose log had nothing to sign {jobId,
// unsigned: true, algorithm?, commit, createdAt}, an expired one {jobId, expired: true, commit,
// createdAt}, a failed run with no job {noJobs: true, conclusion (GitHub's
// word or null), commit, createdAt, attempt?}, or a run's list of failed jobs
// {failedJobs ([64 hex, job id] each), keyId, conclusion, commit, createdAt, attempt?,
// earlier? (job ids), lost?, notFailed?}, exactly. Anything else is dropped, and its run is read again.
const HEX64 = /^[0-9a-f]{64}$/;
const isText = (v) => typeof v === 'string';
const SHAPE = {
  jobId: (v) => isText(v) || Number.isSafeInteger(v),
  signature: (v) => isText(v) && HEX64.test(v),
  algorithm: (v) => v === null || isText(v),
  step: (v) => v === null || isText(v),
  commit: isText,
  createdAt: isText,
  expired: (v) => v === true,
  unsigned: (v) => v === true,
  noJobs: (v) => v === true,
  conclusion: (v) => v === null || (typeof v === 'string' && /^[a-z_]{1,32}$/.test(v)),
  notFailed: (v) => v === true,
  lost: (v) => v === true,
  earlier: (v) => Array.isArray(v) && v.every((id) => isText(id) && /^\d{1,32}$/.test(id)),
  errorLineHashes: (v) => Array.isArray(v) && v.every((h) => isText(h) && HEX64.test(h)),
  failedJobs: (v) => Array.isArray(v) && v.every((p) => Array.isArray(p) && p.length === 2 && isText(p[0]) && HEX64.test(p[0]) && isText(p[1]) && /^\d{1,32}$/.test(p[1])),
  keyId: (v) => isText(v) && /^[0-9a-f]{8}$/.test(v),
  attempt: (v) => Number.isSafeInteger(v) && v >= 1
};
const NO_JOBS = new Set(['noJobs', 'conclusion', 'commit', 'createdAt', 'attempt']);
const RUN_LIST = new Set(['failedJobs', 'keyId', 'conclusion', 'commit', 'createdAt', 'attempt', 'earlier', 'lost', 'notFailed']);
function entryOk(e) {
  if (e == null || typeof e !== 'object' || Array.isArray(e)) return false;
  for (const k of Object.keys(e)) if (!Object.prototype.hasOwnProperty.call(SHAPE, k) || !SHAPE[k](e[k])) return false;
  // (a no-jobs entry is exactly its four fields: the medium)
  if (e.noJobs === true) return Object.keys(e).every((k) => NO_JOBS.has(k)) && e.conclusion !== undefined && typeof e.commit === 'string';
  if (e.failedJobs !== undefined) return Object.keys(e).every((k) => RUN_LIST.has(k)) && typeof e.keyId === 'string' && e.conclusion !== undefined && typeof e.commit === 'string' && typeof e.createdAt === 'string';
  if (e.conclusion !== undefined) return false;
  if (e.attempt !== undefined || e.keyId !== undefined || e.earlier !== undefined || e.lost !== undefined || e.notFailed !== undefined) return false;
  if (e.unsigned === true) return e.signature === undefined && e.expired === undefined;
  return e.expired === true || e.signature !== undefined;
}
function dropMisshapen(c) {
  for (const id of Object.keys(c.runs)) if (!entryOk(c.runs[id])) delete c.runs[id];
}
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
  if (isCache(c)) dropMisshapen(c);
  if (!isCache(c)) {
    // (one that can't be parsed, or another version's, is moved aside and a
    // fresh one started: never caching off for good; if it can't be moved,
    // it is left, and not written over)
    const file = fileOf(repo, root);
    const empty = {version: VERSION, runs: {}};
    // (another version's raw step names are hashed before it is set aside:
    // it is never read again, so nothing else would clean them; one that
    // can't be written back, as one nested too deep, is removed instead)
    let clean = true;
    try {
      if (c != null && typeof c === 'object' && c.runs != null && typeof c.runs === 'object' && !Array.isArray(c.runs) && scrub(c)) fs.writeFileSync(file, JSON.stringify(c));
    } catch { clean = false; }
    try {
      if (clean) fs.renameSync(file, `${file}.unreadable-${Date.now()}`);
      else fs.rmSync(file);
    } catch { Object.defineProperty(empty, UNREADABLE, {value: true}); }
    if (c != null && typeof c === 'object' && !Array.isArray(c) && Number.isInteger(c.version) && c.version !== VERSION) Object.defineProperty(empty, REBUILT, {value: true});
    return empty;
  }
  if (scrub(c)) Object.defineProperty(c, SCRUBBED, {value: true});
  return c;
}
// What the cache knows a run failed (not a success's list: a job that failed
// there did not fail the run), or null.
const failedList = (e) => (e != null && Array.isArray(e.failedJobs) && e.notFailed !== true ? e : null);
// A run's entry, with the jobs an entry of the same run from before knew it
// failed. "Re-run jobs" keeps the run id and GitHub lists the latest attempt
// only, so a failure of an earlier one is known from here or not at all.
// `earlier` is the ids the latest list no longer has: their logs can't be read
// any more, only what was signed of them counts. A list under another key
// can't be told by name: when it holds a job the new one does not, the new one
// is marked lost. A success is never put over a failure: it passed on a re-run.
function withEarlier(before, entry) {
  const known = failedList(before);
  if (known == null || (entry.failedJobs === undefined && entry.noJobs !== true)) return entry;
  if (entry.notFailed === true) return known;
  const {noJobs, earlier = [], lost, ...rest} = entry;
  const list = entry.failedJobs || [];
  const ids = new Set(list.map(([, id]) => id));
  const missing = known.failedJobs.filter(([, id]) => !ids.has(id));
  const keyed = noJobs !== true && known.keyId !== entry.keyId;
  const gone = [...earlier, ...(keyed ? [] : missing.map(([, id]) => id))];
  return {...rest, failedJobs: keyed ? list : [...list, ...missing], keyId: keyed ? entry.keyId : known.keyId,
    ...(gone.length > 0 ? {earlier: gone} : {}), ...(lost === true || known.lost === true || (keyed && missing.length > 0) ? {lost: true} : {})};
}
const scrubbed = (c) => c != null && c[SCRUBBED] === true;
const unreadable = (c) => c != null && c[UNREADABLE] === true;
const rebuilt = (c) => c != null && c[REBUILT] === true;

// Adds `runs` to the cache on disk (and, with scrub, writes it even with
// none, so a raw step found by a read leaves the disk) -> true when they
// are all there afterwards and no raw step is. A failed write, or a failed
// cleanup after it, costs fetches, never the answer: nothing here throws.
function writeCache(repo, runs, root = config.root, {scrub: force = false} = {}) {
  const ids = Object.keys(runs);
  if (ids.length === 0 && !force) return true;
  const file = fileOf(repo, root);
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const temp = `${file}.${process.pid}.${Date.now()}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    try {
      const merged = readCache(repo, root);
      if (unreadable(merged)) return false;
      for (const id of ids) merged.runs[id] = withEarlier(merged.runs[id], runs[id]);
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

module.exports = {readCache, writeCache, withEarlier, failedList, scrubbed, rebuilt, unreadable, hash, keyedHash, keyId, keySnapshot, config, testHooks};
