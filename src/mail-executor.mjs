import { withDeadline } from './deadline.mjs'
import { prepareMailCommand, executeMailCommand, mailCapabilities } from './mail/index.mjs'
import { checkedVersion, requireThat, errorCode } from './protocol.mjs'
import { operationView } from './store.mjs'

export const finishedOps = new Set(['succeeded','failed','unknown','rejected','cancelled'])

export class MailCommandExecutor {
  constructor(store, connections, {prepare = prepareMailCommand, execute = executeMailCommand, resolveInput, onSettled, maxPending = 256} = {}) {
    Object.assign(this, {store, connections, prepare, execute, resolveInput, onSettled, maxPending})
  }
  metadata(mailboxId, epoch) {
    const c = this.connections.get(mailboxId)
    requireThat(c?.kind === 'mail' && c.status === 'active', 'mailbox_unavailable', 403)
    if (epoch !== undefined) this.connections.assertEpoch(mailboxId, epoch)
    return c
  }
  async context(mailboxId, epoch) {
    const c = this.metadata(mailboxId, epoch)
    const accessToken = await this.connections.credential(mailboxId, c.epoch)
    this.metadata(mailboxId, c.epoch)
    return {mailboxId,epoch:c.epoch, credential:{provider:c.provider, scopes:c.scopes, actions:c.actions, accessToken}}
  }
  authorize(meta, action) {
    const cap = mailCapabilities(meta).find(item => item.action === action)
    requireThat(cap?.supported, 'unsupported_action', 422)
    requireThat(cap.authorized, 'scope_required', 403)
    requireThat(meta.actions.includes(action), 'action_not_granted', 403)
  }
  async plan(input, {mailboxId, epoch, scheduledAt, expectedRevision, expectedProviderVersion, signal}) {
    const meta = this.metadata(mailboxId, epoch)
    input = this.resolveInput ? this.resolveInput(mailboxId,input) : input
    this.authorize(meta, input?.action)
    requireThat(scheduledAt === undefined || (Number.isSafeInteger(scheduledAt) && scheduledAt >= 0), 'invalid_schedule')
    requireThat(expectedRevision === undefined || (Number.isSafeInteger(expectedRevision) && expectedRevision >= 0), 'invalid_revision')
    const context = await this.context(mailboxId, meta.epoch)
    requireThat(expectedProviderVersion === undefined ||
      (typeof expectedProviderVersion === 'string' && expectedProviderVersion.length > 0 && expectedProviderVersion.length <= 2048),'invalid_provider_version')
    const prepared = await withDeadline(60000,signal,deadline => this.prepare(input,{...context,expectedProviderVersion,signal:deadline}))
    this.metadata(mailboxId, meta.epoch)
    const resourceKey = JSON.stringify([mailboxId, prepared.resource])
    this.checkRevision(resourceKey, expectedRevision)
    return {mailboxId, epoch:meta.epoch, prepared, resourceKey, scheduledAt, expectedRevision}
  }
  checkRevision(key, expected) {
    const rev = this.store.one('SELECT revision FROM revisions WHERE resource=?', key)?.revision || 0
    if (expected !== undefined) requireThat(expected === rev, 'stale_mail_revision', 409)
    return rev
  }
  checkCapacity(extra = 1) {
    const pending = this.store.one("SELECT COUNT(*) AS count FROM operations WHERE state IN ('queued','dispatching','waiting_approval','unknown')").count
    requireThat(pending + extra <= this.maxPending,'operation_capacity_reached',429)
  }
  accept(plan, {id, commandId, taskId}) {
    const old = this.store.getOp(id)
    if (old) return old
    this.checkCapacity()
    this.metadata(plan.mailboxId, plan.epoch)
    this.checkRevision(plan.resourceKey, plan.expectedRevision)
    const op = {...plan, id, commandId, taskId, version:1,
      state:plan.prepared.requiresApproval ? 'waiting_approval' : 'queued'}
    this.store.saveOp(op)
    return op
  }
  decide(opId, expected, approve) {
    const op = this.store.getOp(opId)
    requireThat(op, 'operation_not_found', 404)
    checkedVersion(expected, op.version)
    requireThat(op.state === 'waiting_approval', 'approval_closed', 409)
    if (approve) this.authorize(this.metadata(op.mailboxId, op.epoch), op.prepared.action)
    op.version++
    op.state = approve ? 'queued' : 'rejected'
    if (!approve) delete op.prepared.payload
    op.decidedAt = Date.now()
    this.store.saveOp(op)
    this.wakeTask(op)
    return operationView(op)
  }
  wakeTask(op) {
    if (!op.taskId || !finishedOps.has(op.state)) return
    const task = this.store.getTask(op.taskId)
    if (task.waitingOperationId !== op.id || !['waiting_mail','needs_review'].includes(task.state)) return
    task.state = op.state === 'unknown' ? 'needs_review' : 'queued'
    task.due = 0
    this.store.saveTask(task)
  }
  settle(op, receipt) {
    this.store.tx(() => {
      op.receipt = receipt
      op.state = receipt.status
      // The approval preview/digests survive for audit. Retire frozen attachment bytes.
      delete op.prepared.payload
      op.version++
      if (op.state === 'succeeded') {
        const row = this.store.one('INSERT INTO revisions VALUES (?,1,?) ON CONFLICT(resource) DO UPDATE SET revision=revision+1,providerId=excluded.providerId RETURNING revision',
          op.resourceKey, receipt.providerId || null)
        op.revision = row.revision
        this.store.rows('DELETE FROM mail_observations WHERE resource=?',op.resourceKey)
      }
      this.store.saveOp(op)
      this.onSettled?.(op)
      this.wakeTask(op)
    })
  }
  finishOrRetry(op,receipt) {
    // Only an explicit refusal or a failed read-only preflight is safe to retry.
    const transient = ['rate_limited','oauth_provider_unavailable','provider_unavailable'].includes(receipt.code)
    if (receipt.status === 'failed' && transient && (op.retryCount || 0)<2) {
      op.expectedRevision ??= this.checkRevision(op.resourceKey)
      op.retryCount = (op.retryCount || 0)+1
      op.retryAt = Date.now() + Math.max(2000 * 2 ** op.retryCount,receipt.retryAfterMs || 0)
      op.state = 'queued'
      op.receipt = receipt
      op.version++
      this.store.tx(() => this.store.saveOp(op))
      return
    }
    this.settle(op,receipt)
  }
  // After remote submission, even loss of our runtime is an ambiguous outcome.
  recover() {
    for (const row of this.store.rows("SELECT data FROM operations WHERE state='dispatching'")) {
      this.settle(JSON.parse(row.data), {status:'unknown', code:'interrupted_after_dispatch'})
    }
  }
  async run(id) {
    let op = this.store.getOp(id)
    if (op.state !== 'queued' || Math.max(op.retryAt||0,op.scheduledAt||0)>Date.now()) return
    let context
    try {
      context = await this.context(op.mailboxId, op.epoch)
      op = this.store.getOp(id)
      if (op.state !== 'queued') return
      this.authorize(this.metadata(op.mailboxId, op.epoch), op.prepared.action)
      this.checkRevision(op.resourceKey, op.expectedRevision)
      const lock = this.store.one("SELECT state FROM operations WHERE resource=? AND state IN ('dispatching','unknown') AND id<>? LIMIT 1", op.resourceKey,id)
      if (lock?.state === 'dispatching') return
      requireThat(!lock, 'resource_needs_reconciliation', 409)
      op.state = 'dispatching'
      delete op.retryAt
      this.store.tx(() => this.store.saveOp(op))
    } catch (error) {
      if (this.store.getOp(id).state === 'queued') this.finishOrRetry(op, {status:'failed',code:errorCode(error,'authorization_failed')})
      return
    }
    let receipt
    const started = Date.now()
    try {
      const beforeWrite = () => {
        this.authorize(this.metadata(op.mailboxId, op.epoch), op.prepared.action)
        if (op.taskId) {
          const t = this.store.getTask(op.taskId)
          requireThat(t.state === 'waiting_mail' && t.waitingOperationId === op.id, 'run_superseded',409)
          this.connections.assertEpoch(t.profile.connectionId,t.modelEpoch)
        }
      }
      beforeWrite()
      receipt = await withDeadline(60000,null,signal => this.execute(op.prepared, {...context,beforeWrite,signal}))
      if (!['succeeded','failed','unknown'].includes(receipt?.status)) throw new Error('invalid receipt')
    } catch (error) {
      receipt = error.status ? {status:'failed', code:errorCode(error)} : {status:'unknown', code:'dispatch_outcome_unknown'}
    }
    this.finishOrRetry(op, receipt)
    this.store.timing('mail_dispatch',Date.now()-started)
  }
}
