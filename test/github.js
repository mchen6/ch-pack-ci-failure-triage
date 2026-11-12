'use strict';
// GitHub's MCP server as recorded (test/fixtures/mcp-results), and a small
// synthetic world in the same shapes for the cases one recorded failure cannot
// show: several failures, expired, truncated and unavailable logs, a token in
// a log.
const path = require('node:path');

const DIR = path.join(__dirname, 'fixtures', 'mcp-results');
const recorded = (name) => require(path.join(DIR, `${name}.json`)).result;
const text = (obj) => ({content: [{type: 'text', text: JSON.stringify(obj)}]});
const failure = (message) => ({isError: true, content: [{type: 'text', text: message}]});

// The recorded server: the last fifty runs of mchen6/countinghouse, one failed.
function recordedServer() {
  const seen = [];
  const serve = (tool, args) => {
    seen.push({tool, args});
    if (tool === 'actions_list' && args.method === 'list_workflow_runs') return recorded('list_workflow_runs');
    if (tool === 'actions_list' && args.method === 'list_workflow_jobs' && args.resource_id === '42775507169') return recorded('list_workflow_jobs');
    if (tool === 'get_job_logs') return recorded(`get_job_logs-${args.job_id}`);
    if (tool === 'list_commits') return recorded('list_commits');
    throw new Error(`recorded server: no fixture for ${tool} ${JSON.stringify(args)}`);
  };
  serve.seen = seen;
  return serve;
}

// A runner log: one step that fails with `lines` before the exit line.
function runnerLog(step, lines, exitCode = 1) {
  const at = (i) => `2026-11-10T07:30:${String(i % 60).padStart(2, '0')}.0000000Z `;
  const body = [`##[group]Run actions/checkout@v4`, `Syncing repository`, `##[endgroup]`, `##[group]${step}`, `npm test`, `##[endgroup]`, ...lines, `##[error]Process completed with exit code ${exitCode}.`];
  return body.map((l, i) => at(i) + l).join('\n');
}

const sha = (n) => n.toString(16).padStart(40, '0');

// runs: [{id, conclusion, workflow?, branch?, at, sha?, jobs?: [{id, name, step, log: string | 'expired' | 'unavailable', truncate?}]}]
// commits: {sha: login | null}
function world({runs, commits = {}}) {
  const template = recorded('list_workflow_runs');
  const base = JSON.parse(template.content[0].text).workflow_runs[0];
  const jobTemplate = JSON.parse(recorded('list_workflow_jobs').content[0].text).jobs.jobs[1];
  const seen = [];
  const byJob = new Map();
  for (const r of runs) for (const j of r.jobs || []) byJob.set(String(j.id), j);
  const serve = (tool, args) => {
    seen.push({tool, args});
    if (tool === 'actions_list' && args.method === 'list_workflow_runs') {
      const list = runs.slice(0, args.perPage).map((r) => ({...base, id: r.id, name: r.workflow || 'CI', conclusion: r.conclusion, status: r.conclusion == null ? 'in_progress' : 'completed',
        head_branch: r.branch === undefined ? 'main' : r.branch, head_sha: r.sha || sha(r.id), created_at: r.at, html_url: `https://github.com/acme/widgets/actions/runs/${r.id}`}));
      return text({total_count: runs.length, workflow_runs: list});
    }
    if (tool === 'actions_list' && args.method === 'list_workflow_jobs') {
      const run = runs.find((r) => String(r.id) === args.resource_id);
      const jobs = (run.jobs || []).map((j) => ({...jobTemplate, id: j.id, run_id: run.id, name: j.name, conclusion: 'failure',
        steps: [{name: 'Set up job', status: 'completed', conclusion: 'success', number: 1}, {name: j.step, status: 'completed', conclusion: 'failure', number: 2}]}));
      return text({jobs: {total_count: jobs.length, jobs}});
    }
    if (tool === 'get_job_logs') {
      const job = byJob.get(String(args.job_id));
      if (job.log === 'expired') return failure(`failed to get job logs: failed to get job logs for job ${args.job_id}: unexpected status code: 410 Gone`);
      if (job.log === 'unavailable') return failure(`failed to get job logs: failed to get job logs for job ${args.job_id}: unexpected status code: 502 Bad Gateway`);
      const lines = job.log.split('\n').length;
      return text({job_id: args.job_id, logs_content: job.log, message: 'Job logs content retrieved successfully', original_length: lines + (job.truncate || 0)});
    }
    if (tool === 'list_commits') {
      const login = Object.prototype.hasOwnProperty.call(commits, args.sha) ? commits[args.sha] : 'octocat';
      return text([{sha: args.sha, html_url: '', commit: {}, author: login == null ? null : {login}, committer: null}]);
    }
    throw new Error(`world: unexpected ${tool}`);
  };
  serve.seen = seen;
  serve.logsFetched = () => seen.filter((s) => s.tool === 'get_job_logs').length;
  return serve;
}

module.exports = {recordedServer, world, runnerLog, sha};
