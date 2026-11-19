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

test('every ch-* directory a test makes is gone when its process ends, by each mkdtemp; any other is left', async () => {
  const {spawnSync} = require('node:child_process');
  const os = require('node:os');
  const script = `require(${JSON.stringify(path.join(__dirname, 'tmp-dirs.js'))}); const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
    const t = os.tmpdir();
    (async () => {
      const made = [fs.mkdtempSync(path.join(t, 'ch-tmp-dirs-sync-')), fs.mkdtempSync(path.join(fs.realpathSync(t), 'ch-tmp-dirs-real-')),
        await new Promise((res, rej) => fs.mkdtemp(path.join(t, 'ch-tmp-dirs-cb-'), (e, d) => (e ? rej(e) : res(d)))),
        await fs.promises.mkdtemp(path.join(t, 'ch-tmp-dirs-promise-'))];
      const other = fs.mkdtempSync(path.join(t, 'not-ch-tmp-dirs-'));
      process.stdout.write(JSON.stringify({made, other}));
    })();`;
  const r = spawnSync(process.execPath, ['-e', script], {encoding: 'utf8'});
  assert.strictEqual(r.status, 0, r.stderr);
  const {made, other} = JSON.parse(r.stdout);
  for (const d of made) assert.ok(!fs.existsSync(d), `${d} left behind`);
  try {
    assert.ok(fs.existsSync(other), 'a directory not named ch-* is not ours');
  } finally {
    fs.rmSync(other, {recursive: true, force: true});
  }
});
