'use strict';
// Every part the chain calls, by address: the one place a part or an action is
// named. package.json's countinghouse.calls declares exactly these.
const ADDRESSES = {
  listRuns: 'ch-access-github/githubService.listRuns',
  failedJobs: 'ch-access-github/githubService.failedJobs',
  jobLog: 'ch-access-github/githubService.jobLog',
  runCommits: 'ch-access-github/githubService.runCommits',
  clean: 'ch-step-log-clean/cleanService.clean',
  extract: 'ch-step-error-patterns/patternService.extract',
  sign: 'ch-step-failure-signature/signatureService.sign',
  group: 'ch-step-dedupe/dedupeService.group',
  hint: 'ch-step-owner-hint/ownerService.hint',
  redact: 'ch-step-redact/redactService.redact',
  assemble: 'ch-step-report/reportService.assemble'
};

module.exports = {ADDRESSES};
