'use strict';
// ch-pack-ci-failure-triage/triageService.triage: the tool ci_failure_triage.
const {triage} = require('../../lib/chain');
const {resolveRepo} = require('../../lib/repo');

const INPUT = ['run_id', 'repo', 'window', 'max_logs', 'owner_hint'];
const invalid = (message) => new DeviceError('ARGUMENTS_INVALID', message);
const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

module.exports = async (input, ctx) => {
  const i = input == null ? {} : input;
  if (typeof i !== 'object' || Array.isArray(i) || !Object.keys(i).every((k) => INPUT.includes(k))) throw invalid(`the arguments are ${INPUT.join(', ')}, all optional`);
  if (i.run_id !== undefined && !(typeof i.run_id === 'string' && /^[1-9]\d{0,15}$/.test(i.run_id))) throw invalid('run_id must be a run id, as digits');
  if (i.window !== undefined && !intIn(i.window, 1, 100)) throw invalid('window must be an integer from 1 to 100');
  if (i.max_logs !== undefined && !intIn(i.max_logs, 1, 50)) throw invalid('max_logs must be an integer from 1 to 50');
  if (i.owner_hint !== undefined && typeof i.owner_hint !== 'boolean') throw invalid('owner_hint must be true or false');
  if (i.repo !== undefined && resolveRepo({repo: i.repo}, null) == null) throw invalid('repo must be "owner/name"');
  const repo = resolveRepo(i, typeof DeviceConfig === 'undefined' ? null : DeviceConfig);
  if (repo == null) throw ctx.error('REPO_REQUIRED', "pass repo: 'owner/name'; the launcher found no origin remote in its working directory");
  const output = await triage({repo, runId: i.run_id, window: i.window === undefined ? 50 : i.window, maxLogs: i.max_logs === undefined ? 20 : i.max_logs, ownerHint: i.owner_hint !== false}, ctx);
  return {output};
};
