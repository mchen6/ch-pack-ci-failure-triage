# GitHub MCP server fixtures

Recorded once by hand on 2026-11-11 from GitHub's remote MCP server
(`https://api.githubcopilot.com/mcp/`, header `X-MCP-Toolsets: actions,repos`,
`github-mcp-server/remote-c6a98818`) with a read-only fine-grained PAT, against
`mchen6/countinghouse`. Every file except `tools-list.json` is
`{_recorded, request, result}`: the `tools/call` request that was sent and the
JSON-RPC `result` that came back. `tools-list.json` is `{_recorded, tools}`:
the `tools/list` entries of the five tools this module may call.

| File | Call | What it shows |
|---|---|---|
| `tools-list.json` | `tools/list` | the input schemas of `actions_list`, `actions_get`, `get_job_logs`, `list_commits`, `get_commit` |
| `list_workflow_runs.json` | `actions_list` `list_workflow_runs`, `perPage: 50` | the last fifty runs of every workflow: CI 34 success, 4 cancelled, 1 failure (run 42775507169); "pages build and deployment" 11 success |
| `list_workflow_jobs.json` | `actions_list` `list_workflow_jobs` for run 42775507169 | 4 jobs, 3 failed at step "Run functional tests". The jobs come nested: `{jobs: {total_count, jobs: [...]}}` |
| `list_workflow_jobs-page.json` | the same call with `perPage: 2` | one page that is not the whole list: `total_count` 4, 2 jobs returned |
| `get_job_logs-<jobId>.json` | `get_job_logs`, `return_content: true`, `tail_lines: 200000` | the three failed jobs' logs. `original_length` (1539, 1535, 1533) equals the lines returned, and the content does not end with a newline |
| `list_commits.json` | `list_commits`, `sha` = the failed run's head, `perPage: 1` | a commit with `author.login` |
| `get_commit.json` | `get_commit`, `detail: none` | the same commit. Neither tool returns `parents`, and `list_commits`' `fields` cannot ask for them |
| `list_workflow_jobs-expired.json` | `list_workflow_jobs` for run 31256649524 (2026-08-08) | a failed run from before the 90-day log retention |
| `get_job_logs-expired.json` | `get_job_logs` for job 93100912193 | expired log: `isError: true`, text `... unexpected status code: 410 Gone` |
| `get_job_logs-expired-run.json` | `get_job_logs` with `run_id` and `failed_only: true` | the same 410, as a per-job `error` inside a result that is not `isError` |
| `get_job_logs-notfound.json` | `get_job_logs` for job 1 | a log that is not there: `isError: true`, text `... unexpected status code: 404 Not Found` |

## What was removed

- No token or `Authorization` header was recorded, and no MCP session id: only response bodies were kept.
- Every email is replaced by `removed@example.invalid`. The `name` of every git identity object (`{name, email, ...}`) is replaced by `Example Author`. These are sentinels a test can prove never pass through. Logins are kept. Commit messages are kept: their `Co-Authored-By:` trailers keep the model co-author names ("Claude Opus 5.5" and similar), with the email scrubbed.
- Claude Code session links in commit messages are replaced by `claude.ai/code/session_REMOVED`.
- No log line was kept. Each `logs_content` is a synthetic log (`synthetic line N`) with the recorded line count and the same no-trailing-newline ending. The real log survives only as `_recorded.logFingerprint` `{sha256, lines, bytes}`, which describes the real log. Its `bytes` is therefore not the synthetic text's size.
- Because no log text is kept, these logs carry no error lines. Tests of the step chain use their own synthetic failure text, not these files.
