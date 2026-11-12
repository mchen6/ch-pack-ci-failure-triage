'use strict';
// The fingerprint cache: <root>/<owner>__<name>/fingerprints.json, where root
// is the module's /data. {version: 1, runs: {[runId]: {jobId, signature, step,
// commit, createdAt, errorLineHashes}}}. Hashes only: never a raw line. Written
// by temp file and rename, merged with what is on disk at write time, so two
// launchers writing at once lose nothing. A cache that cannot be read or
// written costs fetches, never the answer.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const VERSION = 1;
const config = {root: '/data'};
const fileOf = (repo, root) => path.join(root, repo.replace('/', '__'), 'fingerprints.json');
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');

function readCache(repo, root = config.root) {
  try {
    const c = JSON.parse(fs.readFileSync(fileOf(repo, root), 'utf8'));
    if (c != null && c.version === VERSION && c.runs != null && typeof c.runs === 'object') return c;
  } catch { /* none yet, or unreadable: start empty */ }
  return {version: VERSION, runs: {}};
}

// Adds `runs` to the cache on disk -> true when written.
function writeCache(repo, runs, root = config.root) {
  if (Object.keys(runs).length === 0) return true;
  const file = fileOf(repo, root);
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    const merged = readCache(repo, root);
    Object.assign(merged.runs, runs);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(temp, JSON.stringify(merged) + '\n');
    fs.renameSync(temp, file);
    return true;
  } catch {
    fs.rmSync(temp, {force: true});
    return false;
  }
}

module.exports = {readCache, writeCache, hash, config};
