# Hosted task execution

`HostedExecutionService` delegates one bounded child task to OpenAI **Agents
Sessions**. The account Durable Object remains the owner of task state,
authorization, result delivery and artifacts. A delegation gets a fresh session;
it never reuses a global conversation or inherits mailbox/MCP tools, credentials,
account context, plugins or network access.

## Configuration

Disabled unless `HOSTED_AGENT_ENABLED=true`, `OPENAI_AGENTS_API_KEY` and
`HOSTED_AGENT_MODEL` are configured on the Worker. The optional
`HOSTED_AGENT_PROFILE` names the one server-owned profile (default
`document-analysis`); the optional `HOSTED_AGENT_EFFORT` defaults to `medium`.
Clients select that profile name, not a provider URL, secret, package list or
tools. The default hosted environment is `small`, with networking and desktop
disabled and a fixed document-library allowlist.

`OPENAI_AGENTS_API_KEY` accepts either an ordinary Worker Secret string or a
Cloudflare Secrets Store binding. The client reads the binding before each
provider request, including background polling and cleanup, without retaining a
raw key in durable job state. Keep a replacement key authorized for the same
provider project so existing sessions and uploaded files remain accessible.
Lookup failures before dispatch retry the prepared intent; they do not create an
ambiguous upload/session receipt. Execution authority is checked again after
lookup and the dispatch receipt is committed immediately before provider I/O.

`HOSTED_AGENT_TIMEOUT_MS` defaults to five minutes (1 second–30 minutes),
`HOSTED_AGENT_REQUEST_TIMEOUT_MS` to 20 seconds (1–30 seconds),
`HOSTED_AGENT_POLL_MS` to 3 seconds (1–30 seconds), and
`MAX_OPEN_HOSTED_TASKS` to 2 (1–8). Unresolved creation/cancellation and cleanup
occupy admission capacity. Deadlines cause cancellation, but are **not a provider
billing hard cap**. Usage reports preserve reported tokens and explicitly mark
missing data; they do not fabricate environment charges or dollar totals.

## Integration

```js
const executions = new HostedExecutionService(store, env, {
  assets, connections,
  assertCurrent(job) { /* synchronous account/run/epoch validation */ },
  onComplete(job) { /* synchronous writes to this same Store */ },
  onInvalidated(job, reason) { /* close only a matching waiting parent */ },
})
```

`start({parentTaskId,runId,runVersion,instructions,input,attachmentIds,profile,
requestId,authority})` is synchronous and only persists an intent. `authority` is
trusted server metadata for the authorization hook; never copy it from an HTTP
request. It is not sent upstream. `requestId` should be the parent's tool-call or
command ID. Identical retries return the same execution; changed content conflicts.

`find({parentTaskId,runId,runVersion,requestId})`, `inspect(id)`, and paginated
`list({parentTaskId,before,limit})` return public projections. `cancel(id)`,
`cancelForTask(taskId)`, and `cancelAll()` persist stop requests. The existing DO
scheduler calls `recover()`, `nextDue()` and `await runNext(signal)`. Each invocation
performs a bounded phase, and the scheduler owns all alarms. No webhook setup is
required for this polling adapter.

`assertCurrent` is checked around external operations and synchronously again at
delivery. Completion and its receipt commit in the same Store transaction. Hooks
must not perform external side effects or return promises. A parent normally
remains `waiting_external`, becomes `queued` in `onComplete`, then reads the same
execution's terminal result. A changed parent run/version or revoked authority
discards late results. Imported artifacts belong to the parent task and must be
added to its authorized asset references before subsequent model work.
`onInvalidated` receives a public record without text/artifacts when authority no
longer matches. It commits with the delivery receipt, must be synchronous, and
must ignore cancelled or newer parent runs. A matching parent can record an
unavailable tool receipt and fail without another model call; this prevents a
revoked resource from leaving the parent permanently waiting.

## Files and recovery

Inputs are scoped asset IDs, at most four files of 10 MiB each. Files API copies
request a one-hour expiry and are explicitly deleted after the session. Upload and
session creation intents are committed before I/O. A lost acknowledgement is
reconciled by unique metadata/filename; it never causes a blind second creation.
An unconfirmed creation or cancellation becomes `unknown`, retains cleanup
evidence, and is not automatically resubmitted.

For account teardown, `cleanupStatus()` reports pending/unknown work and
`retryCleanup()` makes existing cleanup intents due without creating new work.
After the account's local barrier drains, `redactAll()` removes task text, results
and original filenames while retaining the opaque metadata needed to reconcile
and delete remote sessions/files. `erase()` is allowed only after remote cleanup
completes; it preserves the account executor identity. The lifecycle service may
drive `runNext()` while ordinary tasks and maintenance are disabled. Trusted
artifact cleanup uses `assets.retire()` and does not require an active account.

Completed `/workspace/outputs` artifacts use the real session Artifacts API.
Metadata must match the session and completed turn, names must be safe paths,
and contents must meet byte/type bounds. Imports use a stable asset idempotency
key and SHA-256. Up to four files, 10 MiB each and 20 MiB total are retained.
Unsupported or excessive outputs have explicit coverage omissions. Text, CSV,
JSON, PDF, common raster images and OOXML outputs are supported; Office validation
checks the ZIP signature, not a full application-level document proof. Originals
remain private; upstream URLs and filesystem paths are not authorization tokens.

Artifacts and completed text are copied before remote session deletion. Only
completed final-answer text is published; raw reasoning is not stored. Source
retention, account deletion and asset parsing remain the parent services' jobs.

## Protocol sources

Verified against OpenAI's official documentation on 2026-11-19:

- [Agents architecture](https://developers.openai.com/api/docs/guides/agents-api/architecture)
- [Create session](https://developers.openai.com/api/reference/resources/beta/subresources/agents/subresources/sessions/methods/create)
- [Input and cancellation events](https://developers.openai.com/api/reference/resources/beta/subresources/agents/subresources/sessions/subresources/events/methods/create)
- [Files and artifacts](https://developers.openai.com/api/docs/guides/agents-api/environments/files)
- [List artifacts](https://developers.openai.com/api/reference/resources/beta/subresources/agents/subresources/sessions/subresources/artifacts/methods/list)
- [Artifact content](https://developers.openai.com/api/reference/resources/beta/subresources/agents/subresources/sessions/subresources/artifacts/methods/content)

Protocol and crash/recovery tests use fake HTTP and private storage. Real account
access to Agents Sessions, a permitted model and actual billing must be verified
in deployment; passing these tests does not assert entitlement or production use.
