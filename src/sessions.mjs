import { requireThat, identifier, checkedVersion } from './protocol.mjs'

// Local, immediate revocation complements short-lived Supabase JWTs. There is
// no per-token Supabase round trip. App logout/revoke calls this service before
// discarding its JWT; an unrelated Supabase logout is effective at JWT expiry.
export class SessionService {
  constructor(store,{onRevoke=()=>{}}={}) {
    Object.assign(this,{store,onRevoke})
    store.rows('CREATE TABLE IF NOT EXISTS account_sessions (id TEXT PRIMARY KEY,state TEXT NOT NULL,version INTEGER NOT NULL,issued INTEGER NOT NULL,expires INTEGER NOT NULL,seen INTEGER NOT NULL)')
    store.rows('CREATE TABLE IF NOT EXISTS session_policy (singleton INTEGER PRIMARY KEY,revoked_before INTEGER NOT NULL)')
    store.rows('INSERT OR IGNORE INTO session_policy VALUES (1,0)')
  }
  accept({sessionId,issuedAt=0,expires}) {
    identifier(sessionId,'session_id')
    requireThat(Number.isSafeInteger(issuedAt) && issuedAt>=0 && Number.isSafeInteger(expires) && expires>Math.floor(Date.now()/1000),'unauthorized',401)
    const cutoff=this.store.one('SELECT revoked_before FROM session_policy WHERE singleton=1').revoked_before
    requireThat(!cutoff || issuedAt>cutoff,'session_revoked',401)
    const row=this.store.one('SELECT * FROM account_sessions WHERE id=?',sessionId)
    requireThat(!row || row.state==='active','session_revoked',401)
    if (!row) requireThat(this.store.one("SELECT COUNT(*) AS n FROM account_sessions WHERE state='active' AND expires>?",Math.floor(Date.now()/1000)).n<256,'session_capacity_reached',429)
    this.store.rows("INSERT INTO account_sessions VALUES (?,'active',1,?,?,?) ON CONFLICT(id) DO UPDATE SET expires=MAX(expires,excluded.expires),seen=excluded.seen",sessionId,issuedAt,expires,Date.now())
    return {sessionId,issuedAt,expires}
  }
  assertActive(id) {
    // Background work remains authorized across JWT refresh/expiry. Explicit
    // revocation, not loss of a browser socket, stops that work.
    if (!id) return
    const row=this.store.one('SELECT state FROM account_sessions WHERE id=?',id)
    requireThat(row?.state==='active','session_revoked',401)
  }
  list() {
    return {sessions:this.store.rows('SELECT id AS sessionId,state,version,issued AS issuedAt,expires,seen AS lastSeenAt FROM account_sessions ORDER BY seen DESC LIMIT 256')}
  }
  revoke({sessionId,expectedVersion}) {
    const row=this.store.one('SELECT * FROM account_sessions WHERE id=?',identifier(sessionId,'session_id'))
    requireThat(row,'session_not_found',404)
    checkedVersion(expectedVersion,row.version)
    return this.store.tx(()=>{
      this.store.rows("UPDATE account_sessions SET state='revoked',version=version+1 WHERE id=?",sessionId)
      this.onRevoke(sessionId)
      this.store.event('session.revoked',{sessionId,version:row.version+1})
      return {sessionId,state:'revoked',version:row.version+1}
    })
  }
  revokeAll() {
    return this.store.tx(()=>{
      this.store.rows('UPDATE session_policy SET revoked_before=MAX(revoked_before,?) WHERE singleton=1',Math.floor(Date.now()/1000))
      for (const row of this.store.rows("SELECT id,version FROM account_sessions WHERE state='active'")) this.revoke({sessionId:row.id,expectedVersion:row.version})
      return {revoked:true}
    })
  }
}
