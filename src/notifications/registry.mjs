import { failure } from '../connections/crypto.mjs'
import { APNsTokenProvider } from './apns.mjs'
import { boundedJSON, check, email, key, ownerId } from './common.mjs'

// Only a Worker-internal DO binding may call these endpoints. The public Worker
// must never forward a user-supplied registry payload or owner ID.
export class NotificationRegistryService {
  constructor(storage,env={}, {now=Date.now}={}) {
    Object.assign(this,{storage,env,now})
    storage.transactionSync(()=>{
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS notification_routes (
        owner TEXT NOT NULL,mailbox TEXT NOT NULL,provider TEXT NOT NULL,generation TEXT NOT NULL,
        watch TEXT NOT NULL,epoch INTEGER NOT NULL,version INTEGER NOT NULL,lookup TEXT NOT NULL,
        expires INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(owner,mailbox))`)
      storage.sql.exec('CREATE INDEX IF NOT EXISTS notification_route_lookup ON notification_routes(provider,lookup,expires)')
      storage.sql.exec('CREATE TABLE IF NOT EXISTS notification_revoked_generations (owner TEXT NOT NULL,generation TEXT NOT NULL,PRIMARY KEY(owner,generation))')
      storage.sql.exec('CREATE TABLE IF NOT EXISTS notification_route_fences (owner TEXT NOT NULL,mailbox TEXT NOT NULL,generation TEXT NOT NULL,epoch INTEGER NOT NULL,version INTEGER NOT NULL,PRIMARY KEY(owner,mailbox,generation))')
    })
    this.tokens=new APNsTokenProvider(storage,env,{now})
  }
  one(sql,...args) {return this.storage.sql.exec(sql,...args).toArray()[0]}
  register(route) {
    ownerId(route.ownerId);key(route.mailboxId);key(route.watchId);key(route.generation)
    check(['gmail','outlook'].includes(route.provider)&&Number.isSafeInteger(route.epoch)&&route.epoch>=1&&
      Number.isSafeInteger(route.version)&&route.version>=1&&Number.isFinite(route.expiresAt)&&route.expiresAt>this.now(),'invalid_notification_route')
    const lookup=route.provider==='gmail'?email(route.email):key(route.subscriptionId,'subscription_id')
    if(route.provider==='outlook')check(/^[a-f0-9]{64}$/.test(route.clientStateHash),'invalid_graph_client_state')
    const stored={ownerId:route.ownerId,mailboxId:route.mailboxId,watchId:route.watchId,generation:route.generation,
      epoch:route.epoch,version:route.version,provider:route.provider,expiresAt:route.expiresAt,
      ...(route.provider==='gmail'?{email:lookup}:{subscriptionId:lookup,clientStateHash:route.clientStateHash})}
    return this.storage.transactionSync(()=>{
      check(!this.one('SELECT 1 FROM notification_revoked_generations WHERE owner=? AND generation=?',route.ownerId,route.generation),'notification_route_revoked',409)
      const fence=this.one('SELECT epoch,version FROM notification_route_fences WHERE owner=? AND mailbox=? AND generation=?',route.ownerId,route.mailboxId,route.generation)
      check(!fence||route.epoch>fence.epoch||route.epoch===fence.epoch&&route.version>fence.version,'notification_route_revoked',409)
      const prior=this.one('SELECT * FROM notification_routes WHERE owner=? AND mailbox=?',route.ownerId,route.mailboxId)
      if(prior&&prior.generation!==route.generation)check(this.one('SELECT 1 FROM notification_revoked_generations WHERE owner=? AND generation=?',route.ownerId,prior.generation),'notification_generation_conflict',409)
      if(prior?.generation===route.generation) {
        check(route.epoch>prior.epoch||route.epoch===prior.epoch&&route.version>=prior.version,'notification_route_stale',409)
        if(route.epoch===prior.epoch&&route.version===prior.version) {
          check(prior.watch===route.watchId&&prior.lookup===lookup&&JSON.parse(prior.data).clientStateHash===stored.clientStateHash,'notification_route_conflict',409)
          check(route.expiresAt>=prior.expires,'notification_route_stale',409)
        }
      }
      this.storage.sql.exec('INSERT INTO notification_routes VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner,mailbox) DO UPDATE SET provider=excluded.provider,generation=excluded.generation,watch=excluded.watch,epoch=excluded.epoch,version=excluded.version,lookup=excluded.lookup,expires=excluded.expires,data=excluded.data',
        route.ownerId,route.mailboxId,route.provider,route.generation,route.watchId,route.epoch,route.version,lookup,route.expiresAt,JSON.stringify(stored))
      return {registered:true}
    })
  }
  unregister({ownerId:owner,mailboxId,watchId,generation,epoch,version}) {
    ownerId(owner);key(mailboxId);key(watchId);key(generation)
    check(Number.isSafeInteger(epoch)&&epoch>=1&&Number.isSafeInteger(version)&&version>=1,'invalid_notification_route')
    return this.storage.transactionSync(()=>{
      const fence=this.one('SELECT epoch,version FROM notification_route_fences WHERE owner=? AND mailbox=? AND generation=?',owner,mailboxId,generation)
      if(!fence||epoch>fence.epoch||epoch===fence.epoch&&version>fence.version)this.storage.sql.exec('INSERT INTO notification_route_fences VALUES (?,?,?,?,?) ON CONFLICT(owner,mailbox,generation) DO UPDATE SET epoch=excluded.epoch,version=excluded.version',owner,mailboxId,generation,epoch,version)
      const prior=this.one('SELECT * FROM notification_routes WHERE owner=? AND mailbox=?',owner,mailboxId)
      if(!prior||prior.watch!==watchId||prior.generation!==generation||prior.epoch>epoch||prior.epoch===epoch&&prior.version>version)return {removed:false}
      this.storage.sql.exec('DELETE FROM notification_routes WHERE owner=? AND mailbox=?',owner,mailboxId)
      return {removed:true}
    })
  }
  lookup({provider,email:address,subscriptionId}) {
    check(['gmail','outlook'].includes(provider),'invalid_notification_provider')
    const lookup=provider==='gmail'?email(address):key(subscriptionId,'subscription_id')
    const rows=this.storage.sql.exec('SELECT data FROM notification_routes WHERE provider=? AND lookup=? AND expires>? ORDER BY owner,mailbox LIMIT 101',provider,lookup,this.now()).toArray()
    check(rows.length<=100,'notification_route_fanout_exceeded',503)
    return {routes:rows.map(row=>JSON.parse(row.data))}
  }
  forgetOwner({ownerId:owner,generation}) {
    ownerId(owner);key(generation)
    return this.storage.transactionSync(()=>{
      this.storage.sql.exec('INSERT OR IGNORE INTO notification_revoked_generations VALUES (?,?)',owner,generation)
      this.storage.sql.exec('DELETE FROM notification_routes WHERE owner=? AND generation=?',owner,generation)
      this.storage.sql.exec('DELETE FROM notification_route_fences WHERE owner=? AND generation=?',owner,generation)
      return {removed:true}
    })
  }
  async fetch(request) {
    try {
      check(request.method==='POST','method_not_allowed',405)
      const body=await boundedJSON(request,65536),path=new URL(request.url).pathname
      let result
      if(path==='/register')result=this.register(body)
      else if(path==='/unregister')result=this.unregister(body)
      else if(path==='/lookup')result=this.lookup(body)
      else if(path==='/forget-owner')result=this.forgetOwner(body)
      else if(path==='/apns-token')result=await this.tokens.token()
      else throw failure('not_found',404)
      return Response.json(result,{headers:{'Cache-Control':'no-store'}})
    } catch(error) {return Response.json({error:error.code||'notification_registry_error'},{status:error.status||500})}
  }
}
export function createRegistryPort(env) {
  const request=async(path,body)=>{
    check(env.NOTIFICATIONS,'notification_registry_not_configured',503)
    const stub=env.NOTIFICATIONS.getByName('global')
    const response=await stub.fetch(new Request('https://registry.internal'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}))
    const result=await boundedJSON(response,262144)
    if(!response.ok)throw failure(typeof result.error==='string'?result.error:'notification_registry_error',response.status)
    return result
  }
  return {register:body=>request('/register',body),unregister:body=>request('/unregister',body),lookup:body=>request('/lookup',body),
    forgetOwner:body=>request('/forget-owner',body),apnsToken:()=>request('/apns-token',{})}
}
