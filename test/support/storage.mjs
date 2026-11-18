import { DatabaseSync } from 'node:sqlite'

export function createStorage() {
  const db = new DatabaseSync(':memory:')
  let alarm = null
  return {
    sql:{exec(sql,...args) {
      const items = db.prepare(sql).all(...args)
      return {toArray:() => items, one:() => items[0], [Symbol.iterator]:() => items[Symbol.iterator]()}
    }},
    transactionSync(fn) {
      db.exec('BEGIN')
      try { const value = fn(); db.exec('COMMIT'); return value }
      catch (err) { db.exec('ROLLBACK'); throw err }
    },
    async transaction(fn) { return fn(this) },
    async getAlarm() { return alarm },
    async setAlarm(at) { alarm = at },
    close() { db.close() }
  }
}
