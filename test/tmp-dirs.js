'use strict';
// Every temporary directory a test makes is removed when its test process
// ends (as ch-local's test/tmp-dirs.js, #89/#93). Every test file requires
// it as its second line (test/tmp-dirs-loaded checks that), so a file run on
// its own gets it too. fs.mkdtemp, fs.mkdtempSync and fs.promises.mkdtemp are wrapped, and each
// directory they make directly under the temporary directory with a name
// that begins `ch-` (every test's prefix) is registered, then removed at
// the process's exit, after its last test. A test that removes its own first
// loses nothing (force).
//
// No signal handler, on purpose: a listener for SIGINT or SIGTERM changes how
// a process ends on one, and a test that emits one itself (process.emit
// ('SIGINT')) would have its directories removed mid-run and, re-raised, end
// the process on Windows (ch-local #89's Windows legs). A file killed by a
// signal, or by the test runner's timeout, leaves its directories.
//
// Why at the process's end, not each test's: it covers every mkdtemp in the
// test files and their tmp() helpers with no call site changed
// (scripts/validate.js removes its own in a finally).
//
// Why: tests made tens of thousands of ch-* directories on a shared /tmp
// and left them (the Reviewer, 11-19: hundreds of ch-triage-* in two hours).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PREFIX = 'ch-';
const KEY = Symbol.for('ch-pack-ci-failure-triage.test.tmp-dirs');
if (global[KEY] == null) {
  const made = new Set();
  const TMP = [path.resolve(os.tmpdir())];
  try { const real = fs.realpathSync(os.tmpdir()); if (!TMP.includes(real)) TMP.push(real); } catch (err) { /* the given one */ }
  const ours = (dir) => {
    try {
      const d = path.resolve(String(dir));
      // (under the temporary directory as given, or its real path: macOS's
      // /var and /private/var)
      return TMP.includes(path.dirname(d)) && path.basename(d).startsWith(PREFIX);
    } catch (err) { return false; }
  };
  // (resolved now: a later chdir never sends the removal elsewhere)
  const keep = (dir) => { if (ours(dir)) made.add(path.resolve(String(dir))); return dir; };

  const syncMade = fs.mkdtempSync;
  fs.mkdtempSync = function(...args) { return keep(syncMade.apply(fs, args)); };
  const cbMade = fs.mkdtemp;
  fs.mkdtemp = function(...args) {
    // no callback: Node's own error, never one made up (the medium, 3)
    if (typeof args[args.length - 1] !== 'function') return cbMade.apply(fs, args);
    const cb = args.pop();
    return cbMade.call(fs, ...args, (err, dir) => { if (err == null) keep(dir); cb(err, dir); });
  };
  const promiseMade = fs.promises.mkdtemp;
  fs.promises.mkdtemp = async function(...args) { return keep(await promiseMade.apply(fs.promises, args)); };

  // removes what this process made; a directory still in use (Windows, a
  // child still exiting) is tried for about 5 s, and one that cannot be
  // removed is left
  const removeMade = () => {
    for (const dir of made) {
      try { fs.rmSync(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 100}); } catch (err) { /* left: counted after the run */ }
    }
    made.clear();
  };
  process.on('exit', removeMade);
  global[KEY] = {removeMade, made, PREFIX};
}

module.exports = global[KEY];
