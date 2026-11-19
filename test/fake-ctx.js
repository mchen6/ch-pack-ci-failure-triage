'use strict';
// A fake ctx for the scenario: ctx.call('<part>/<service>.<action>', input) runs
// the part's real handler from its tarball (test/fixtures/parts) and resolves
// with what the handler returns ({output}), as the runtime's ctx.call does
// without {detail}. The access module's own ctx.call('remote:github/<tool>')
// is answered by `github(tool, args)`. Every address called is recorded.
const path = require('node:path');
const {CountinghouseError} = require('countinghouse/lib/countinghouse-error');

const PARTS = path.join(__dirname, '..', 'node_modules', '@countinghouse');
const error = (code, message, details) => CountinghouseError.module(code, message, details);

// settings: the module's effective settings for the call (ctx.settings, frozen
// as the runtime gives them); settingRequired answers the runtime's claim.
function makeCtx(github, {settings = {}} = {}) {
  const calls = [];
  const partCtx = {
    error,
    call: async (address, args) => {
      const m = /^remote:github\/(.+)$/.exec(address);
      if (m == null) throw new Error(`fake ctx: a part called ${address}`);
      return github(m[1], args);
    }
  };
  return {
    calls,
    error,
    settings: Object.freeze({__proto__: null, ...settings}),
    // as the runtime answers it (lib/handler-ctx.js: SETTING_REQUIRED, the
    // name as its message), and only as the main thread accepts the claim:
    // the setting declared by this module and unset in this call's values;
    // any other claim is a module fault
    settingRequired: (name) => {
      const declared = require('../package.json').countinghouse.settings || {};
      if (!Object.prototype.hasOwnProperty.call(declared, name) || settings[name] != null) {
        return Object.assign(new Error(`a SETTING_REQUIRED claim for ${name}, which is not declared or is set`), {code: 'DEVICE_INVOKE_EXCEPTION'});
      }
      return Object.assign(new CountinghouseError('SETTING_REQUIRED'), {message: name});
    },
    call: async (address, input) => {
      calls.push(address);
      const m = /^(ch-[a-z-]+)\/(\w+)\.(\w+)$/.exec(address);
      if (m == null) throw new Error(`fake ctx: not an address: ${address}`);
      const handler = require(path.join(PARTS, m[1], 'handlers', m[2], `${m[3]}.js`));
      return handler(input, partCtx);
    }
  };
}

module.exports = {makeCtx};
