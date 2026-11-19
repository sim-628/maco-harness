# Account notifications and mailbox subscriptions

This module provides a notification outbox, encrypted APNs installations, Gmail/Graph subscription renewal, authenticated webhook verification, and an internal routing registry. It does not classify or summarize email and does not perform mailbox mutations. A mailbox event persists an index-sync request and, when APNs is configured, sends a generic background hint. The App retrieves current data and performs its local summarization and presentation.

The account scheduler owns all alarms. Register `recover()`, `nextDue()`, `runNext({signal})`, and `activeCount()` with that scheduler; do not start a second recurring loop. With an empty environment the service can be constructed and recovered without secrets or network access, and its provider capabilities are disabled.

## Worker integration

`AccountNotificationService(store, env, options)` accepts:

- `ownerId`: the server's `ctx.id.toString()` — the 64-character account Durable Object ID. It is not the Supabase subject and must never come from a request body.
- `mailMetadata(mailboxId, epoch)`: a synchronous lookup of the authoritative current mailbox connection.
- `mailContext(mailboxId, epoch)`: an asynchronous token lookup through the existing mailbox vault. This module does not keep a second mailbox refresh token.
- `onMailEvent(event)`: a synchronous callback that persists/wakes an index-sync job in the same account transaction. Do not fetch mail, classify mail, call a model, or advance the Gmail history cursor inside the callback. Only commit a new cursor after its delta has been processed successfully.
- Optional `registry`, `fetcher`, and `now` ports for composition and deterministic tests.

The account-facing methods are `status`, `listInstallations`, `putInstallation`, `revokeInstallation`, `subscriptions`, `watch`, `unwatch`, `enqueue`, and `deliveryPage`. `status()` returns capabilities, public installation/subscription metadata, the latest 50 delivery receipts, and `nextDeliveryBefore`. `deliveryPage({before,limit})` returns at most 100 receipts. Tokens, encrypted envelopes, clientState values, and delivery payloads are excluded.

Pass a second `{assertAuthorized}` argument to `putInstallation(input, options)` and `watch(input, options)`. This synchronous callback is created by the server and checks the request's account generation and authenticated session again after encryption and before the transaction commits. `watch()` prepares a durable job; the normal account scheduler performs provider I/O afterwards.

The intended public routes are:

| Route | Behavior |
| --- | --- |
| `GET /v1/notifications` | Public metadata and delivery receipts for the authenticated account |
| `GET /v1/notifications/deliveries?before=...&limit=...` | Paginate public delivery receipts without tokens or payloads |
| `POST /v1/notifications/installations/upsert` | Register or replace an encrypted APNs token, using `expectedEpoch` for replacement |
| `POST /v1/notifications/installations/revoke` | Revoke an installation using its `expectedEpoch` |
| `POST /v1/notifications/watch` | Queue a subscription for the account's current mailbox connection |
| `POST /v1/notifications/unwatch` | Revoke a local watch using its `expectedVersion` |
| `POST /webhooks/gmail` | Validate Google Pub/Sub OIDC, then resolve verified mailbox routes |
| `POST /webhooks/graph` | Handle the plaintext validation challenge, or validate each subscription's `clientState` before routing |

Graph subscription creation uses exactly `/webhooks/graph` with a `watch` query parameter; Gmail's configured Pub/Sub audience normally names `/webhooks/gmail`. The incoming Host header does not choose a token destination or callback origin.

### Internal routing registry

The Worker exports a separate Durable Object class wrapping `NotificationRegistryService(storage, env)` and binds it as `NOTIFICATIONS`. The account service uses `createRegistryPort(env)` to call the registry through the binding, not a public HTTP endpoint. The registry accepts internal POST `/register`, `/unregister`, `/lookup`, `/forget-owner`, and `/apns-token`. Never expose a general public proxy to these paths.

After validating ingress, the Worker uses a returned `route.ownerId` with `env.AGENTS.get(env.AGENTS.idFromString(route.ownerId))` and forwards the authenticated event to an internal-only account endpoint. Using `getByName` with this value would select a different account. Gmail routing permits several Maco owners to connect the same provider mailbox; each account proves its address with Gmail's authenticated profile and validates its own active grant epoch before accepting an event. Email equality alone does not establish ownership.

Public webhook responses are `202 {accepted, ignored}` for valid deliveries and unknown, expired or locally revoked routes. A known Graph route with an invalid clientState returns 401 when the batch contains no valid route; mixed batches process valid entries and count the other entries as ignored. Forwarding is capped at 256 account deliveries and eight simultaneous calls. Provider retries after transient failures are safe through the per-account inbox deduplication. The internal ingestion path is inaccessible through the public Worker, including when a client supplies forged internal headers.

Registry writes are conditional on generation, mailbox epoch, watch version and watch ID. Removal creates a fence even if registration has not arrived yet. Account erasure removes active routes and retains a minimal owner/generation revocation tombstone to reject late registrations; that tombstone has no email, device token or provider credential.

## Deployment configuration

The repository must include the `NOTIFICATIONS` Durable Object binding and migration before enabling these optional providers. The host owns that configuration.

| Setting | Purpose |
| --- | --- |
| `NOTIFICATION_ENCRYPTION_KEY` | Base64 AES key for device/client-state data and the shared APNs JWT; falls back to `CONNECTION_ENCRYPTION_KEY` |
| `APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_PRIVATE_KEY`, `APNS_TOPIC` | Apple signing identity, P8 key and fixed application topic |
| `APNS_ENVIRONMENT` | `production` (default) or `sandbox`; selected by the operator |
| `GMAIL_PUBSUB_TOPIC` | `projects/.../topics/...`, owned by the Gmail OAuth application's Google project |
| `GMAIL_PUBSUB_SUBSCRIPTION` | Exact authenticated push subscription resource name |
| `GMAIL_PUBSUB_AUDIENCE` | Exact expected OIDC audience of that subscription |
| `GMAIL_PUBSUB_SERVICE_ACCOUNT` | Exact verified Google service-account email expected in the OIDC token |
| `NOTIFICATION_BASE_URL` | Fixed public HTTPS Worker/custom-domain origin for Graph callbacks |

Gmail also needs a Google Cloud Pub/Sub topic and authenticated push subscription configured by the operator. Grant `gmail-api-push@system.gserviceaccount.com` publisher access to the topic and configure the Pub/Sub OIDC service account/audience consistently. The topic project must match the project executing the Gmail watch. These resources are not created automatically by a Worker deploy. Mailbox OAuth grants must include the provider permissions required by Gmail watch or Graph message subscriptions.

For APNs, the App must have the proper push entitlement and register a token for the configured topic/environment. The shared registry signs ES256 JWTs and caches the encrypted token for 45 minutes, avoiding a new provider JWT for each account or push. The implementation uses pinned APNs HTTPS origins via Workers `fetch`. Workers does not expose a supported `node:http2` implementation or a documented `fetch` option to force an HTTP version. **A real APNs acceptance test from the deployed Worker remains a release gate**; mocked tests verify JWTs, payloads and state transitions, not Apple's required HTTP/2 transport negotiation. An APNs 200 means provider acceptance, not delivery to a device.

## Delivery and renewal semantics

Device tokens and Graph clientState are sealed to the account and record identity. Public metadata never returns them. Installations have epochs, so a delayed `Unregistered` receipt for an old token cannot erase its replacement. Background mail hints use `content-available:1`, priority 5, and contain no sender, subject or message body. Task completion and input-required alerts also use generic copy. The App decides whether and how to display private mail details.

The outbox deduplicates per installation and event key, has a maximum of 256 queued/sending entries, and attempts at most five deliveries within one hour. Full capacity skips additional notifications without rolling back the authoritative action that produced the event. Transient retries reuse `apns-id` and collapse IDs. Delivery is at least once: a lost response can lead to a repeated push, and neither an abort nor account deletion can retract a notification that APNs already accepted. Terminal delivery metadata is bounded by age and count.

Gmail watches renew daily while respecting the provider's returned expiry. Graph subscriptions use basic, non-rich message notifications, request a six-day expiry, and renew daily by PATCH. Lifecycle `reauthorizationRequired` queues renewal; `missed` requests a resync; `subscriptionRemoved` queues a fresh subscription. Work and retry delays are bounded by the same account scheduler. A provider expiry shorter than the renewal window is clamped to a future retry rather than producing a continuously due alarm.

Graph creation persists its intent before I/O. If the response is lost, a process restarts during creation, or the provider returns a conflict, the job lists subscriptions and looks for the exact frozen clientState, callback URL, resource and change types. It never blindly repeats a create with unknown outcome. Reconciliation attempts are bounded; an unresolved watch remains `unknown` and requires a controlled handoff or operator investigation. A subscription belonging to the former Supabase/legacy backend is not silently adopted because its owner and secret differ. Resolve those subscriptions during migration before enabling the new Graph owner.

`unwatch()` stops local delivery/renewal and durably removes the registry route. It does not call Gmail `stop`, which would also affect another Maco account watching the same Google mailbox. It currently does not DELETE a remote Graph subscription either: an already-created remote watch expires at the provider and its callbacks are discarded once local routing is removed. This is local revocation, not a claim that every remote subscription is immediately deleted. Consequently re-enabling or transferring an existing Graph subscription may require reconciliation/handoff until its prior subscription has expired.

## Account lifecycle

For reset, call `fence()` synchronously. It cancels unsent deliveries, preserves ambiguity for already-sending deliveries, and retains device and watch configuration. For delete, call `fence({revokeInstallations:true,unsubscribe:true})`, wait for `activeCount()` to drain, then **await `erase()`**. Registry cleanup is a durable job: failure must block final physical account erasure and be retried, not be hidden by deleting its ledger. Late provider replies cannot recreate the account's watches or replace a fenced delivery receipt.

The service caps installations at 16 and watched mailboxes at 32 per account; registry fan-out is capped at 100 routes per incoming mailbox/subscription lookup. Mail webhook bodies and provider responses have explicit byte limits. Notifications are hints: recovery and periodic mailbox synchronization remain necessary because neither APNs nor provider webhooks promise that every change is delivered promptly.

## Primary references

- https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns
- https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns
- https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns
- https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions
- https://developers.google.com/workspace/gmail/api/guides/push
- https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/watch
- https://learn.microsoft.com/en-us/graph/change-notifications-delivery-webhooks
- https://learn.microsoft.com/en-us/graph/change-notifications-lifecycle-events
- https://learn.microsoft.com/en-us/graph/change-notifications-overview
- https://learn.microsoft.com/en-us/graph/api/subscription-post-subscriptions?view=graph-rest-1.0
- https://developers.cloudflare.com/workers/runtime-apis/nodejs/
- https://developers.cloudflare.com/workers/runtime-apis/fetch/
