import { PROTOCOL_VERSION, requireThat } from './protocol.mjs'

const schema = [
  'CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, state TEXT NOT NULL, due INTEGER NOT NULL, data TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS runnable_tasks ON tasks(state, due)',
  'CREATE TABLE IF NOT EXISTS messages (n INTEGER PRIMARY KEY, task TEXT NOT NULL, data TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS task_messages ON messages(task, n)',
  "CREATE INDEX IF NOT EXISTS task_message_ids ON messages(task, json_extract(data,'$.messageId'))",
  'CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, digest TEXT NOT NULL, result TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS timings (n INTEGER PRIMARY KEY, metric TEXT NOT NULL, ms REAL NOT NULL)',
  'CREATE TABLE IF NOT EXISTS streams (messageId TEXT PRIMARY KEY, taskId TEXT NOT NULL, runId TEXT NOT NULL, text TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, state TEXT NOT NULL, due INTEGER NOT NULL, resource TEXT NOT NULL, task TEXT, data TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS runnable_ops ON operations(state,due)',
  'CREATE INDEX IF NOT EXISTS op_resource ON operations(resource,state)',
  'CREATE INDEX IF NOT EXISTS task_ops ON operations(task,state)',
  'CREATE TABLE IF NOT EXISTS revisions (resource TEXT PRIMARY KEY, revision INTEGER NOT NULL, providerId TEXT)',
  'CREATE TABLE IF NOT EXISTS mail_observations (resource TEXT PRIMARY KEY, providerVersion TEXT NOT NULL)',
]

export function taskView(t) {
  const {id, runId, profile, mailboxId, state, version, priority, createdAt, updatedAt, error, waitingOperationId, timeZone, context} = t
  return {taskId:id, runId, modelProfile:profile, mailboxId, state, taskVersion:version, priority, createdAt, updatedAt, error, waitingOperationId, timeZone, context}
}

export function operationView(op) {
  const {id, taskId, commandId, mailboxId, state, version, prepared, receipt, scheduledAt, revision, retryAt} = op
  return {operationId:id, taskId, commandId, mailboxId, state, approvalVersion:version, action:prepared.action,
    resource:prepared.resource, preview:prepared.summary, receipt, scheduledAt, revision, retryAt}
}

export function publicMessage(message) {
  const {providerState, historyEpoch, ...rest} = message
  return rest
}

export class Store {
  constructor(storage, emit = () => {}) {
    this.storage = storage
    this.emit = emit
    storage.transactionSync(() => {
      for (const statement of schema) storage.sql.exec(statement)
    })
  }
  rows(query, ...args) { return this.storage.sql.exec(query, ...args).toArray() }
  one(query, ...args) { return this.rows(query, ...args)[0] }
  tx(fn) {
    // Events and the state transition commit atomically. Broadcast only after commit.
    if (this.pending) return fn()
    const pending = []
    this.pending = pending
    let result
    try { result = this.storage.transactionSync(fn) } finally { this.pending = null }
    for (const event of pending) this.emit(event)
    return result
  }
  event(type, fields) {
    if (!this.pending) return this.tx(() => this.event(type, fields))
    const data = {protocolVersion:PROTOCOL_VERSION, type, at:Date.now(), ...fields}
    // A snapshot taken mid-stream must include all deltas at its cursor.
    if (type === 'attempt.started') {
      this.rows("INSERT INTO streams VALUES (?,?,?,'')",fields.messageId,fields.taskId,fields.runId)
    } else if (type === 'message.delta') {
      this.rows('UPDATE streams SET text=text||? WHERE messageId=?',fields.text,fields.messageId)
    } else if (type === 'attempt.finished' || type === 'attempt.abandoned') {
      this.rows('DELETE FROM streams WHERE messageId=?',fields.messageId)
    }
    const {seq} = this.one('INSERT INTO events(data) VALUES (?) RETURNING seq', JSON.stringify(data))
    this.pending.push({...data, seq})
  }
  seen(id, digest) {
    const row = this.one('SELECT * FROM commands WHERE id=?', id)
    if (!row) return undefined
    requireThat(row.digest === digest, 'command_id_conflict', 409)
    return JSON.parse(row.result)
  }
  command(id, digest, apply) {
    return this.tx(() => {
      const old = this.seen(id, digest)
      if (old) return old
      const result = apply()
      this.rows('INSERT INTO commands VALUES (?,?,?)', id, digest, JSON.stringify(result))
      return result
    })
  }
  getTask(id) {
    const row = this.one('SELECT data FROM tasks WHERE id=?', id)
    requireThat(row, 'task_not_found', 404)
    return JSON.parse(row.data)
  }
  saveTask(t, announce = true) {
    t.updatedAt = Date.now()
    this.rows('INSERT INTO tasks VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,due=excluded.due,data=excluded.data',
      t.id, t.state, t.due ?? 0, JSON.stringify(t))
    if (announce) this.event('task.updated', taskView(t))
  }
  appendMessage(t, message) {
    const value = {messageId:crypto.randomUUID(), runId:t.runId, createdAt:Date.now(), ...message}
    this.rows('INSERT INTO messages(task,data) VALUES (?,?)', t.id, JSON.stringify(value))
    this.event('message.committed', {taskId:t.id, message:publicMessage(value)})
    return value
  }
  messages(taskId, limit = 80) {
    return this.rows('SELECT data FROM messages WHERE task=? ORDER BY n DESC LIMIT ?', taskId, limit).reverse().map(row => JSON.parse(row.data))
  }
  contextMessages(taskId) {
    // Keep an ordered suffix, dropping only leading results whose call fell outside it.
    const suffix = this.rows('SELECT n,data FROM messages WHERE task=? ORDER BY n DESC LIMIT 80', taskId)
      .reverse().map(row => ({n:row.n, message:JSON.parse(row.data)}))
    const start = suffix.findIndex(row => row.message.role !== 'tool')
    if (start < 0) return []
    const history = suffix.slice(start).map(row => row.message)
    const first = this.one('SELECT data FROM messages WHERE task=? ORDER BY n LIMIT 1', taskId)
    const goal = JSON.parse(first.data)
    if (history[0].messageId === goal.messageId) return history
    // Preserve the user turn that gave the retained calls their meaning.
    const anchor = this.one(`SELECT data FROM messages WHERE task=? AND n<=?
      AND json_extract(data,'$.role')='user' ORDER BY n DESC LIMIT 1`, taskId, suffix[start].n)
    const user = anchor && JSON.parse(anchor.data)
    const includeAnchor = user && user.messageId !== goal.messageId && user.messageId !== history[0].messageId
    return includeAnchor ? [goal,user,...history] : [goal,...history]
  }
  getOp(id) {
    const row = this.one('SELECT data FROM operations WHERE id=?', id)
    return row && JSON.parse(row.data)
  }
  saveOp(op) {
    this.rows('INSERT INTO operations VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,due=excluded.due,data=excluded.data',
      op.id, op.state, Math.max(op.scheduledAt || 0,op.retryAt || 0), op.resourceKey, op.taskId || null, JSON.stringify(op))
    this.event('mail.updated', operationView(op))
  }
  events(after, limit = 128) {
    return this.rows('SELECT seq,data FROM events WHERE seq>? ORDER BY seq LIMIT ?', after, limit)
      .map(row => ({...JSON.parse(row.data), seq:row.seq}))
  }
  cursor() { return this.one('SELECT COALESCE(MAX(seq),0) AS seq FROM events').seq }
  timing(metric,ms) {
    if (!Number.isFinite(ms) || ms < 0) return
    const {n} = this.one('INSERT INTO timings(metric,ms) VALUES (?,?) RETURNING n',metric,ms)
    if (n % 256 === 0) this.rows('DELETE FROM timings WHERE n<=?',n-4096)
  }
  timings() {
    const groups = new Map()
    for (const {metric,ms} of this.rows('SELECT metric,ms FROM timings ORDER BY ms')) {
      if (!groups.has(metric)) groups.set(metric,[])
      groups.get(metric).push(ms)
    }
    return Object.fromEntries([...groups].map(([metric,values]) => [metric,{
      count:values.length, p50Ms:values[Math.ceil(values.length * 0.50)-1], p95Ms:values[Math.ceil(values.length * 0.95)-1]
    }]))
  }
  taskPage(before = Number.MAX_SAFE_INTEGER, activeOnly = false) {
    const filter = activeOnly ? "AND state IN ('running','waiting_mail','queued','needs_review')" : ''
    const rows = this.rows(`SELECT rowid AS n,data FROM tasks WHERE rowid<? ${filter} ORDER BY rowid DESC LIMIT 101`,before)
    return {tasks:rows.slice(0,100).map(r => taskView(JSON.parse(r.data))), nextTaskBefore:rows.length>100 ? rows[99].n : null}
  }
  operationPage(before = Number.MAX_SAFE_INTEGER) {
    const rows = this.rows("SELECT rowid AS n,json_remove(data,'$.prepared.payload') AS data FROM operations WHERE rowid<? ORDER BY rowid DESC LIMIT 51",before)
    return {operations:rows.slice(0,50).map(r => operationView(JSON.parse(r.data))), nextOperationBefore:rows.length>50 ? rows[49].n : null}
  }
  pendingPage(before = Number.MAX_SAFE_INTEGER) {
    // Compact, separate paging keeps old approvals visible even after months of newer history.
    const rows = this.rows(`SELECT rowid AS n,id AS operationId,task AS taskId,state,
        json_extract(data,'$.version') AS approvalVersion
      FROM operations WHERE rowid<? AND state IN ('waiting_approval','queued','dispatching','unknown')
      ORDER BY rowid DESC LIMIT 101`,before)
    return {pendingOperations:rows.slice(0,100).map(({n,...value})=>value),
      nextPendingBefore:rows.length>100 ? rows[99].n : null}
  }
  snapshot() {
    const active = this.taskPage(Number.MAX_SAFE_INTEGER,true)
    return {protocolVersion:PROTOCOL_VERSION, snapshotCursor:this.cursor(), ...this.taskPage(), ...this.operationPage(), ...this.pendingPage(),
      activeTasks:active.tasks, nextActiveBefore:active.nextTaskBefore,
      streams:this.rows('SELECT * FROM streams'),
      messages:this.rows('SELECT task,data FROM messages ORDER BY n DESC LIMIT 40').reverse().map(r => ({taskId:r.task,...publicMessage(JSON.parse(r.data))}))}
  }
}
