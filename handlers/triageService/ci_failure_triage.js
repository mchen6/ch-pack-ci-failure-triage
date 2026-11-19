'use strict';
// ch-pack-ci-failure-triage/triageService.ci_failure_triage: the tool ci_failure_triage
// (a scenario's action is listed under its bare name; countinghouse LM1).
const {triage} = require('../../lib/chain');
const {resolveRepo} = require('../../lib/repo');

const INPUT = ['run_id', 'repo', 'window', 'max_logs', 'owner_hint'];
// a check of its own: the module's own code through the runtime's ctx.error
// (countinghouse's logger step 1 removed the DeviceError global, and a
// catalogue code such as ARGUMENTS_INVALID is the runtime's, not a module's)
const invalid = (ctx, message) => ctx.error('INPUT_REJECTED', message);
const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

module.exports = async (input, ctx) => {
  const i = input == null ? {} : input;
  if (typeof i !== 'object' || Array.isArray(i) || !Object.keys(i).every((k) => INPUT.includes(k))) throw invalid(ctx, `the arguments are ${INPUT.join(', ')}, all optional`);
  if (i.run_id !== undefined && !(typeof i.run_id === 'string' && /^[1-9]\d{0,15}$/.test(i.run_id))) throw invalid(ctx, 'run_id must be a run id, as digits');
  if (i.window !== undefined && !intIn(i.window, 1, 100)) throw invalid(ctx, 'window must be an integer from 1 to 100');
  if (i.max_logs !== undefined && !intIn(i.max_logs, 1, 50)) throw invalid(ctx, 'max_logs must be an integer from 1 to 50');
  if (i.owner_hint !== undefined && typeof i.owner_hint !== 'boolean') throw invalid(ctx, 'owner_hint must be true or false');
  if (i.repo !== undefined && resolveRepo({repo: i.repo}, null) == null) throw invalid(ctx, 'repo must be "owner/name"');
  const repo = resolveRepo(i, typeof DeviceConfig === 'undefined' ? null : DeviceConfig);
  if (repo == null) throw ctx.error('REPO_REQUIRED', "pass repo: 'owner/name'; the launcher found no origin remote in its working directory");
  const output = await triage({repo, runId: i.run_id, window: i.window === undefined ? 50 : i.window, maxLogs: i.max_logs === undefined ? 20 : i.max_logs, ownerHint: i.owner_hint !== false}, ctx);
  return {output};
};
