'use strict';
require('./tmp-dirs');
// lib/address.js is ch-step-report's address check, copied: the two must
// answer alike (the reviewer's high on #18, round 2).
const test = require('node:test');
const assert = require('node:assert');
const mine = require('../lib/address');
const theirs = require('@countinghouse/ch-step-report/handlers/reportService/assemble');

test('the pack\'s address check answers as ch-step-report\'s', () => {
  const probes = ['bob@corp.example', 'ssh://git@github.com/o/r.git', 'postgres://svc@corp.com:hunter2@db/app', 'https://alice@corp.com@nexus/r',
    'git@github.com:o/r.git', 'react@16.8.0', 'https://<basicAuth>@github.com/o/r', 'bob%40corp.com%26', '\x1b[31mbob@corp.com\x1b[0m',
    'bob＠corp.example', 'see <b>@evil.com', 'Deploy to prod', 'mailto:git@corp.example', 'bob@corp.भारत'];
  for (const p of probes) assert.strictEqual(mine.hasAddress(p), theirs.hasAddress(p), p);
  assert.strictEqual(mine.WITHHELD, theirs.WITHHELD);
});
