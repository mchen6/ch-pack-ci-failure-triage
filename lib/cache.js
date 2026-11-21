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
// (the caller writes it back through writeCache with {scrub: true}).
function readCache(repo, root = config.root) {
  let c = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(fileOf(repo, root), 'utf8'));
    if (parsed != null && parsed.version === VERSION && parsed.runs != null && typeof parsed.runs === 'object') c = parsed;
  } catch { /* none yet, or unreadable: start empty */ }
  if (c == null) return {version: VERSION, runs: {}};
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
    if (onDisk != null && onDisk.runs != null && ids.every((id) => onDisk.runs[id] != null) && !rawLeft(onDisk)) return true;
  }
  return false;
}

module.exports = {readCache, writeCache, scrubbed, hash, config};
