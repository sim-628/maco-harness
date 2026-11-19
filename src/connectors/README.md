# Remote MCP connectors

`ConnectorService` is account-local. It uses the host `Store` for atomic state/events and never owns an alarm. Register `recover`, `nextDue`, and `runNext({signal})` with the account scheduler. `onSettled(publicOperation)` is synchronous and runs inside the Store transaction; wake only the matching task/run. `unknown` requires review, never replay.

## Operator configuration

Absent `MCP_SERVERS` means disabled. The value is a JSON object (a JSON string in Worker variables):

```json
{
  "notes": {
    "endpoint": "https://mcp.example.com/mcp",
    "protocolVersion": "2026-07-28",
    "tools": {
      "search": {"access": "read", "approval": "never", "mailWrite": false},
      "create": {"access": "write", "mailWrite": false}
    },
    "oauth": {
      "issuer": "https://auth.example.com",
      "resourceMetadataUrl": "https://mcp.example.com/.well-known/oauth-protected-resource",
      "metadataUrls": ["https://auth.example.com/.well-known/oauth-authorization-server"],
      "allowedEndpoints": ["https://auth.example.com/authorize", "https://auth.example.com/token"],
      "clientIdEnv": "NOTES_CLIENT_ID",
      "scopes": ["notes:read", "notes:write"]
    }
  }
}
```

These are illustrative endpoints and tool names, not a built-in provider registration. Pin actual operator-approved endpoints and the actual server tool catalog. Users submit `serverId`, never an arbitrary destination or a tool policy. All configured tools must explicitly declare `mailWrite:false`; mailbox modification belongs to MailExecutor. Unknown tools are excluded. MCP annotations do not grant access. Approval defaults to `always`; only an explicitly read-only operator policy may use `never`. This is a trust decision about the remote implementation, not a property inferred from its description.

OAuth requires `MCP_OAUTH_REDIRECT_URI` (or the shared `OAUTH_REDIRECT_URI`) and a real callback frontend that sends `state`, `code`, and, when present, `iss` to the authenticated completion endpoint. Pre-registered clients may use `clientId` or `clientIdEnv`, `clientSecretEnv`, and `tokenEndpointAuthMethod` (`none`, `client_secret_post`, `client_secret_basic`). For CIMD, configure an existing `clientMetadataUrl` served by the application. Dynamic client registration is optional and requires `allowDynamicRegistration:true` plus its exact endpoint in `allowedEndpoints`. The client never follows discovery/registration redirects or accepts a different issuer. Missing S256 support fails closed.

Credentials are encrypted with `CONNECTOR_ENCRYPTION_KEY`, falling back to `CONNECTION_ENCRYPTION_KEY`, and bound to the account vault, server and connection ID. A reconstructed in-progress rotating-token refresh requires reauthorization; the old refresh token is not blindly replayed. Local revoke erases the credential and invalidates its epoch; it does not claim to revoke all copies of a grant at the remote issuer.

## Integration surface

- Connections: `servers`, `list`, `get`, `put`, `beginOAuth`, `completeOAuth`, `revoke`.
- Catalog/read: `discover({connectionId,expectedEpoch})`, `tools(connectionId?)`, `read({connectionId,expectedEpoch,tool,arguments,taskId?,runId?,signal?})`.
- Operations: `plan` then `accept(plan,{id,commandId,taskId?,runId?})`; `decide({operationId,approvalVersion,approve})`, `cancel`, `reconcile`, `operation`, `operationPage`.
- Execution: `run(id,{signal})`, `runNext({signal})`, `recover`, `nextDue`.
- Lifecycle: `fence({revokeConnections=false})`, `activeCount`, `pendingStatus`, `erase`.

HTTP handlers pass an optional second argument `{assertAuthorized}` to `put`, `beginOAuth`, `completeOAuth`, `discover`, and `read`. This is a **server-created synchronous callback**, bound to the authenticated session and account lifecycle generation; never read it from the request body. It runs before external I/O and before committing credentials/catalogs or returning results after an asynchronous boundary. `assertOwner` governs persisted background execution ownership; it does not substitute for request-session validation.

For reset, call `fence()` synchronously, wait for active work to drain, and retain the connection records. The fence clears pending OAuth states, cancels unstarted operations and marks dispatched operations `unknown`; late results cannot replace the fence. For delete, call `fence({revokeConnections:true})`, preserve any required minimal unknown-operation audit until the account lifecycle service has captured it, drain active work, then call `erase()`. `erase()` is final cleanup and destroys the operation ledger; it is not the reset API. A rotating OAuth refresh that was already accepted but cannot be committed safely requires reauthorization.

Operation states are `waiting_approval`, `queued`, `dispatching`, `succeeded`, `failed`, `unknown`, `rejected`, `cancelled`. Public views contain `operationId`, `kind:'connector'`, `connectionId`, `taskId`, `runId`, `commandId`, `tool`, frozen `arguments`, `state`, `approvalVersion`, and `receipt`. The host's `assertOwner` callback receives connection/task/run/operation IDs before external calls and must reject obsolete execution ownership. Never expose `credential()` as a public endpoint.

Modern MCP `2026-07-28` is the default. Explicit `2025-11-25`, `2025-06-18`, and `2025-03-26` select legacy Streamable HTTP initialization and per-connection sessions. JSON and request-scoped SSE replies are supported. This module does not implement stdio, the deprecated 2024 separate HTTP+SSE transport, sampling, roots, elicitation/MRTR, MCP Tasks, arbitrary custom authorization headers, or automatic protocol downgrade. Such requests fail closed. A write with an ambiguous result becomes `unknown`.

Boundaries: 1 MiB response, 64 KiB input/schema, 512 KiB tool catalog, 128 tools / 8 pages, 25-second MCP request deadline, 32 connections, 256 pending/ambiguous operations per account. Schema validation supports bounded objects/arrays, composition, local references and common size/numeric constraints; external references, recursive references, regex validation and unknown assertion keywords are excluded. Structured output is checked when an output schema is supplied. Catalog/schema changes invalidate pending approvals.

## Normative references

- https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
- https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
- https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery
- https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration
- https://modelcontextprotocol.io/specification/2026-07-28/server/tools
- https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
