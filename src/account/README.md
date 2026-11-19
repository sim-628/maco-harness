# Account lifecycle

`AccountLifecycleService` implements durable chat reset, local account deletion,
and a bounded account export inside the user's Durable Object. It never deletes
Google/Microsoft mail, revokes a provider's entire account, deletes a Supabase
login identity, drops tables, or calls `storage.deleteAll()`.

## Host integration

```js
const lifecycle = new AccountLifecycleService(store, {
  assets, connections, connectors, executors, memory, sessions,
  onFence() {
    host.abortAll()
    for (const socket of ctx.getWebSockets()) socket.close(1008, 'account changed')
  },
  activeCount() {
    // Count all in-flight tasks, mail dispatches, ordinary maintenance jobs,
    // and HTTP mutations. Exclude this lifecycle job and status/retry requests.
    return app.activeRequests + host.tasks.size + host.ops.size +
      [...host.jobs.keys()].filter(name => name !== 'lifecycle').length
  },
  participants: cleanupParticipants,
})
```

Here `host`, `ctx` and `app` are the existing account execution host, Durable
Object context and request tracker. Each optional cleanup participant supplies
`name`, synchronous `fence({mode,generation})`, optional `activeCount()`, and
asynchronous `cleanup({mode,generation,signal})` returning
`{complete:boolean,nextDue?:number,unknown?:boolean}`. Cleanup is called again
until it confirms completion; errors and unknown outcomes retain the account
fence. Participants must be idempotent and must not claim success on a lost
external acknowledgement. Gate HTTP, WebSockets, commands, tasks and maintenance with
`assertActive()`. Capture `generation()` at the start of an asynchronous request
and call `assertActive(capturedGeneration)` before publishing its result. The
connection, MCP and asset services additionally check their own durable fences
before committing asynchronous credential or object writes.

`reset({requestId,expectedGeneration?,resetMemories:false})` and
`delete({requestId,expectedGeneration?})` commit the next lifecycle generation and
memory epoch before cancellation. `requestId` is durable across resets; retries
cannot accidentally initiate another reset. Changed parameters with the same ID
conflict. Both calls return immediately with public status.

The host registers one lifecycle maintenance entry with `recover()`, `nextDue()`
and `runNext(signal)`. While the account is inactive, the host must permit only
this entry to run. It advances the local drain barrier, remote session/file
cancellation, private R2 cleanup and optional participants itself. Each execution
is a bounded phase; it does not hold a poll loop or create a separate alarm.

## Reset and deletion

Default reset preserves explicit account facts/preferences, model/mail/MCP
connections, mailbox preview indexes and device-generated mail analyses. It
removes conversations, task checkpoints, work items, interactions, schedules,
usage history, history indexes and **all private uploaded/generated assets**.
`resetMemories:true` also removes facts/preferences. Preserved memories lose old
chat source text/references. History watermarks reset for the new empty log,
while memory and account epochs remain monotonic.

Deletion additionally revokes local credentials and sessions, removes connection
metadata and mailbox/device-analysis indexes, and invokes participants' deletion
cleanup. Account, vault, asset and session tombstones remain so old callbacks,
JWT sessions and idempotency keys cannot recreate deleted content. This is
logical erasure of application-owned data, not deletion of the authentication
provider's user record.

Queued mail/MCP operations are cancelled. Already dispatched effects cannot be
assumed undone: they settle before local deletion, or retain a minimal `unknown`
receipt. Reset retains content-free resource locks for unresolved operations;
deletion retains only opaque uncertainty receipts. No in-flight mail operation
row is deleted before the host's local barrier reaches zero. Old command digests
receive content-free retired results, preventing replay of a successful mail
command after reset.

Remote cleanup failure never becomes false success. Unknown hosted or
participant cleanup lets other independent cleanup finish, then changes status
to `blocked` with a reason. `retry({operationId})` resumes the existing cleanup
intent; it does not launch a new hosted execution. The default 15-minute lifecycle
deadline also blocks with an explicit status. It is a retry deadline, not a
provider billing limit. A deleted account cannot be reactivated through reset.

## Export

`export({cursor?,limit:50})` returns at most 100 explicitly projected records and
less than 128 KiB per page. It covers public conversations, facts/preferences,
work items, schedules, token usage, mailbox snippets, operation receipts,
connection metadata, assets, hosted results, interactions and local session
metadata. Binary attachments are downloaded separately through their authorized
asset endpoint.

Exports exclude vaults, OAuth state, hidden provider reasoning, raw tool
arguments/results, model checkpoints, R2 keys and remote session/file references.
They do include the user's visible conversation text, so they are private account
exports. Large individual records are explicitly marked truncated. Pagination
captures per-section append watermarks and rejects a cursor after any lifecycle
generation change. The consistency guarantee is `bounded_live`: records updated
between pages can reflect those updates; this is not an MVCC database backup.

Tests exercise real local storage/services and fake HTTP/R2 responses only. They
cover persistent fences, interrupted cleanup, late uploads, uncertain remote
effects, same-Store callback boundaries, data projection and reset replay safety.
