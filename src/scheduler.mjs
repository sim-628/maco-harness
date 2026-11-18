import { withDeadline } from './deadline.mjs'
import { errorCode } from './protocol.mjs'

const dueTime = value => Number.isFinite(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER ? value : null
const earliest = values => {
  const times = values.filter(value => dueTime(value) !== null)
  return times.length ? Math.min(...times) : null
}

export class ExecutionHost {
  constructor(ctx,store,harness,mail,{maintenance=[]} = {}) {
    Object.assign(this,{ctx,store,harness,mail,maintenance})
    this.tasks = new Map()
    this.ops = new Map()
    this.jobs = new Map()
    this.pump = null
    // A reconstructed DO is the sole owner. Never replay an in-flight provider write.
    store.tx(() => {
      mail.recover()
      for (const job of maintenance) job.recover?.()
      for (const {data} of store.rows("SELECT data FROM tasks WHERE state='running'")) {
        const t = JSON.parse(data)
        if (t.attempt) store.event('attempt.abandoned',{taskId:t.id,runId:t.runId,messageId:t.attempt,usage:t.lastUsage})
        t.attempt = null
        t.state = 'queued'
        t.due = 0
        store.saveTask(t)
      }
    })
  }
  async arm(at = Date.now()+5000) {
    // Both alarm APIs belong to the same storage transaction. A later wake cannot
    // overwrite an earlier one when two devices accept work concurrently.
    await this.ctx.storage.transaction(async tx => {
      const previous = await tx.getAlarm()
      if (previous === null || previous > at) await tx.setAlarm(at)
    })
  }
  kick() {
    if (this.pump) { this.rerun = true; return }
    this.pump = Promise.resolve().then(async () => {
      do {
        this.rerun = false
        await this.dispatch()
      } while (this.rerun)
    }).finally(() => {
      this.pump = null
      // A completion can request another pass after the loop's last condition
      // but before this finally runs. Do not defer that work to the repair alarm.
      if (this.rerun) this.kick()
    })
    this.ctx.waitUntil(this.pump)
  }
  abort(taskId) { this.tasks.get(taskId)?.controller.abort() }
  launch(map,id,entry,run) {
    map.set(id,entry)
    const finished = Promise.resolve().then(run).finally(() => {
      map.delete(id)
      this.kick()
    })
    this.ctx.waitUntil(finished)
  }
  maintenanceDue(job) {
    const due = dueTime(job.nextDue())
    return due === null ? null : Math.max(due,job.retryAfter || 0)
  }
  async dispatch() {
    // Register repair before starting I/O. Alarm is the only durable wake owner.
    await this.arm(Date.now()+30000)
    for (const {data} of this.store.rows("SELECT data FROM tasks WHERE state='queued' AND due<=? ORDER BY (json_extract(data,'$.priority')='background'), rowid LIMIT 32", Date.now())) {
      if (this.tasks.size >= 2) break
      const t = JSON.parse(data)
      if (this.tasks.has(t.id)) continue
      if (t.priority === 'background' && [...this.tasks.values()].some(entry => entry.background)) continue
      const controller = new AbortController()
      t.state = 'running'
      t.claimedAt = Date.now()
      this.store.tx(() => this.store.saveTask(t))
      this.launch(this.tasks,t.id,{controller,background:t.priority==='background'},
        () => withDeadline(120000,controller.signal,signal => this.harness.run(t,signal)))
    }
    const available = 4 - this.ops.size
    if (available > 0) {
      const due = this.store.rows(`SELECT o.id,o.resource FROM operations o WHERE o.state='queued' AND o.due<=?
        AND NOT EXISTS(SELECT 1 FROM operations p WHERE p.resource=o.resource AND
         (p.state='dispatching' OR (p.state='queued' AND p.due<=? AND p.rowid<o.rowid)))
        ORDER BY o.rowid LIMIT 8`, Date.now(),Date.now())
      for (const {id,resource} of due) {
        if (this.ops.size >= 4) break
        if (this.ops.has(id) || [...this.ops.values()].some(entry => entry.resource === resource)) continue
        this.launch(this.ops,id,{resource},() => this.mail.run(id))
      }
    }
    // Maintenance uses the same durable alarm and never occupies a foreground
    // task slot. Start auxiliary model extraction only while task slots are idle.
    if (!this.jobs.size) {
      const job = this.maintenance.map(job => ({job,due:this.maintenanceDue(job)}))
        .filter(({job,due}) => due !== null && due <= Date.now() && (!job.idleOnly || !this.tasks.size))
        .sort((a,b) => a.due-b.due)[0]?.job
      if (job) this.launch(this.jobs,job.name,{},async () => {
        try {
          await withDeadline(60000,null,signal => job.run(signal))
          job.retryAfter = 0
        } catch (error) {
          // Domain jobs persist normal retries. Unexpected bugs are cooled down
          // here as a last resort so a malformed job cannot spin the event loop.
          job.retryAfter = Date.now()+30000
          this.store.event('maintenance.failed',{name:job.name,code:errorCode(error,'maintenance_failed')})
        }
      })
    }
    const future = this.store.one(`SELECT MIN(due) AS due FROM (
      SELECT due FROM tasks WHERE state='queued' AND due>? UNION ALL
      SELECT due FROM operations WHERE state='queued' AND due>?)`,Date.now(),Date.now()).due
    const next = earliest([future,...this.maintenance.map(job => this.maintenanceDue(job))].filter(value => value > Date.now()))
    if (next !== null) await this.arm(next)
  }
  async alarm() {
    // An idle schedule far in the future should hibernate until the due time.
    const taskDue = this.store.one(`SELECT MIN(due) AS due FROM (
      SELECT due FROM tasks WHERE state IN ('running','queued') UNION ALL
      SELECT due FROM operations WHERE state IN ('dispatching','queued'))`).due
    const next = earliest([taskDue,...this.maintenance.map(job => this.maintenanceDue(job))])
    if (next === null) return
    if (next > Date.now()) { await this.arm(next); return }
    this.kick()
    await this.pump
  }
}
