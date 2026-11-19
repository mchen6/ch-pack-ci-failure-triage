'use strict';
require('./tmp-dirs');
// Every test file loads test/tmp-dirs.js itself, as its second line, so a
// file run on its own (node --test test/x.test.js, a memory-capped one-file
// run) removes the ch-* temporary directories it makes: the tests left
// hundreds of ch-triage-* directories in a shared /tmp (the Reviewer, 11-19;
// as ch-local #89 and #93).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('every test file requires ./tmp-dirs as its second line, before anything else', () => {
  const missing = fs.readdirSync(__dirname).filter((n) => n.endsWith('.test.js'))
    .filter((n) => { const lines = fs.readFileSync(path.join(__dirname, n), 'utf8').split('\n'); return lines[0] !== "'use strict';" || lines[1] !== "require('./tmp-dirs');"; });
  assert.deepStrictEqual(missing, [], `'use strict' then require('./tmp-dirs') as the first two lines of: ${missing.join(', ')}`);
});

test('a ch-* directory a test makes is gone when its process ends', () => {
  const {spawnSync} = require('node:child_process');
  const os = require('node:os');
  const script = `require(${JSON.stringify(path.join(__dirname, 'tmp-dirs.js'))}); const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
    process.stdout.write(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-tmp-dirs-check-')));`;
  const r = spawnSync(process.execPath, ['-e', script], {encoding: 'utf8'});
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.startsWith(path.join(os.tmpdir(), 'ch-tmp-dirs-check-')), r.stdout);
  assert.ok(!fs.existsSync(r.stdout), `${r.stdout} left behind`);
});
