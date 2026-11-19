import { failure, nonce, VaultCipher } from '../connections/crypto.mjs'
import { errorCode } from '../protocol.mjs'
import { apnsConfiguration, sendAPNS } from './apns.mjs'
import { createRegistryPort } from './registry.mjs'
import { check, digest, email, key, ownerId, providerJSON, publicURL } from './common.mjs'
import { verifyGraphItem } from './webhooks.mjs'

export { NotificationRegistryService,createRegistryPort } from './registry.mjs'
export { graphValidationResponse,verifyGmailPush,parseGraphPush,verifyGraphItem } from './webhooks.mjs'
const TABLES=[
  'CREATE TABLE IF NOT EXISTS notification_identity (id INTEGER PRIMARY KEY,binding TEXT NOT NULL,generation TEXT NOT NULL,delivery_epoch INTEGER NOT NULL DEFAULT 1)',
  'CREATE TABLE IF NOT EXISTS notification_installations (id TEXT PRIMARY KEY,status TEXT NOT NULL,epoch INTEGER NOT NULL,sealed TEXT,topic TEXT NOT NULL,environment TEXT NOT NULL,updated INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS notification_outbox (id TEXT PRIMARY KEY,dedupe TEXT NOT NULL,installation TEXT NOT NULL,state TEXT NOT NULL,due INTEGER NOT NULL,data TEXT NOT NULL,UNIQUE(dedupe,installation))',
  'CREATE INDEX IF NOT EXISTS notification_outbox_due ON notification_outbox(state,due)',
  'CREATE TABLE IF NOT EXISTS notification_subscriptions (mailbox TEXT PRIMARY KEY,provider TEXT NOT NULL,epoch INTEGER NOT NULL,state TEXT NOT NULL,due INTEGER NOT NULL,version INTEGER NOT NULL,data TEXT NOT NULL,sealed TEXT)',
  'CREATE TABLE IF NOT EXISTS notification_inbox (id TEXT PRIMARY KEY,created INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS notification_registry_jobs (id TEXT PRIMARY KEY,due INTEGER NOT NULL,attempts INTEGER NOT NULL,data TEXT NOT NULL)',
]
function viewWatch(row) {
  if(!row)return null
  const data=JSON.parse(row.data)
  return {mailboxId:row.mailbox,provider:row.provider,epoch:row.epoch,state:row.state,version:row.version,
    watchId:data.watchId,expiresAt:data.expiresAt??null,nextRenewAt:row.due||null,error:data.error??null,
    ...(data.subscriptionId?{subscriptionId:data.subscriptionId}:{})}
}

/** Per-account notification state. NotificationRegistry owns routing and the
 * shared APNs JWT; AccountScheduler owns every wake-up and bounded attempt. */
export class AccountNotificationService {
  constructor(store,env={}, {ownerId:owner,registry,mailContext,mailMetadata,onMailEvent=()=>{},fetcher=fetch,now=Date.now}={}) {
    Object.assign(this,{store,env,owner,mailContext,mailMetadata,onMailEvent,fetcher,now})
    this.registry=registry??createRegistryPort(env)
    this.apns=apnsConfiguration(env);this.running=new Map()
    store.tx(()=>{
      for(const statement of TABLES)store.rows(statement)
      store.rows('INSERT OR IGNORE INTO notification_identity(id,binding,generation) VALUES (1,?,?)',crypto.randomUUID(),nonce())
    })
    this.cipher=new VaultCipher(env.NOTIFICATION_ENCRYPTION_KEY??env.CONNECTION_ENCRYPTION_KEY,this.identity().binding)
  }
  identity() {return this.store.one('SELECT * FROM notification_identity WHERE id=1')}
  current(generation) {check(this.identity()?.generation===generation,'notification_lifecycle_changed',409)}
  capabilities() {
    return {apns:this.apns.enabled,gmail:!!(this.env.GMAIL_PUBSUB_TOPIC&&this.env.GMAIL_PUBSUB_SUBSCRIPTION&&this.env.GMAIL_PUBSUB_AUDIENCE&&this.env.GMAIL_PUBSUB_SERVICE_ACCOUNT),
      outlook:!!this.env.NOTIFICATION_BASE_URL,privatePreviews:true}
  }
  deliveryPage({before=Number.MAX_SAFE_INTEGER,limit=50}={}) {
    check(Number.isSafeInteger(before)&&before>=0&&Number.isSafeInteger(limit)&&limit>=1&&limit<=100,'invalid_notification_page')
    const rows=this.store.rows('SELECT rowid position,id,state,due,data FROM notification_outbox WHERE rowid<? ORDER BY rowid DESC LIMIT ?',before,limit+1)
    return {deliveries:rows.slice(0,limit).map(row=>{
      const data=JSON.parse(row.data),receipt=data.receipt
      return {id:row.id,state:row.state,kind:data.kind,attempts:data.attempts,due:row.due,
        ...(receipt?{receipt:{...Object.fromEntries(['status','code','httpStatus','ambiguous','providerId','invalidatedAt'].filter(key=>Object.hasOwn(receipt,key)).map(key=>[key,receipt[key]]))}}:{})}
    }),nextBefore:rows.length>limit?rows[limit-1].position:null}
  }
  status(options) {
    const page=this.deliveryPage(options)
    return {capabilities:this.capabilities(),installations:this.listInstallations(),subscriptions:this.subscriptions(),
      deliveries:page.deliveries,nextDeliveryBefore:page.nextBefore}
  }
  listInstallations() {return this.store.rows('SELECT id,status,epoch,topic,environment,updated FROM notification_installations ORDER BY id').map(row=>({...row,installationId:row.id}))}
  async putInstallation({installationId,token,expectedEpoch},{assertAuthorized}={}) {
    assertAuthorized?.()
    check(this.apns.enabled,'apns_not_configured',503);key(installationId,'installation_id')
    check(typeof token==='string'&&/^[a-fA-F0-9]{32,512}$/.test(token)&&token.length%2===0,'invalid_apns_device_token')
    const generation=this.identity().generation
    const previous=this.store.one('SELECT epoch FROM notification_installations WHERE id=?',installationId)
    check(previous?previous.epoch===expectedEpoch:expectedEpoch===undefined,'notification_installation_changed',409)
    const sealed=await this.cipher.seal(['installation',installationId],{token:token.toLowerCase()})
    return this.store.tx(()=>{
      assertAuthorized?.()
      this.current(generation)
      const current=this.store.one('SELECT epoch FROM notification_installations WHERE id=?',installationId)
      check(current?current.epoch===expectedEpoch:expectedEpoch===undefined,'notification_installation_changed',409)
      check(current||this.store.one('SELECT COUNT(*) count FROM notification_installations').count<16,'notification_installation_capacity',429)
      this.store.rows("INSERT INTO notification_installations VALUES (?,'active',1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status='active',epoch=epoch+1,sealed=excluded.sealed,topic=excluded.topic,environment=excluded.environment,updated=excluded.updated",
        installationId,sealed,this.apns.topic,this.apns.environment,this.now())
      const result=this.listInstallations().find(row=>row.id===installationId)
      this.store.event('notification.installation.updated',{installation:result});return result
    })
  }
  revokeInstallation({installationId,expectedEpoch}) {
    key(installationId,'installation_id')
    return this.store.tx(()=>{
      const row=this.store.one('SELECT * FROM notification_installations WHERE id=?',installationId)
      check(row,'notification_installation_not_found',404)
      check(row.epoch===expectedEpoch,'notification_installation_changed',409)
      this.store.rows("UPDATE notification_installations SET status='revoked',epoch=epoch+1,sealed=NULL,updated=? WHERE id=?",this.now(),installationId)
      for(const entry of this.running.values())if(entry.installationId===installationId)entry.controller.abort()
      this.store.rows("UPDATE notification_outbox SET state='cancelled' WHERE installation=? AND state='queued'",installationId)
      return {installationId,status:'revoked',epoch:row.epoch+1}
    })
  }
  enqueue({dedupeKey,kind,taskId}) {
    key(dedupeKey,'dedupe_key')
    check(['mail.updated','task.completed','approval.required'].includes(kind),'notification_kind_not_allowed')
    if(taskId!==undefined)key(taskId,'task_id')
    if(!this.apns.enabled)return {queued:0,disabled:true}
    return this.store.tx(()=>{
      this.store.rows("DELETE FROM notification_outbox WHERE state NOT IN ('queued','sending') AND due<?",this.now()-7*86400000)
      this.store.rows("DELETE FROM notification_outbox WHERE state NOT IN ('queued','sending') AND rowid<=(SELECT COALESCE(MAX(rowid),0)-2048 FROM notification_outbox)")
      const identity=this.identity(),devices=this.store.rows("SELECT id,epoch FROM notification_installations WHERE status='active'")
      const pending=this.store.one("SELECT COUNT(*) count FROM notification_outbox WHERE state IN ('queued','sending')").count
      const available=devices.filter(device=>!this.store.one('SELECT 1 FROM notification_outbox WHERE dedupe=? AND installation=?',dedupeKey,device.id))
      let queued=0
      for(const device of available.slice(0,Math.max(0,256-pending))) {
        const id=crypto.randomUUID(),expiresAt=this.now()+3600000
        const payload=kind==='mail.updated'?{aps:{'content-available':1},maco:{kind}}:
          {aps:{alert:{title:'Maco',body:kind==='task.completed'?'Your assistant task is ready.':'Your assistant needs your input.'}},maco:{kind,...(taskId?{taskId}:{})}}
        const data={id,installationId:device.id,installationEpoch:device.epoch,generation:identity.generation,deliveryEpoch:identity.delivery_epoch,
          kind,payload,expiresAt,attempts:0,createdAt:this.now()}
        this.store.rows("INSERT INTO notification_outbox VALUES (?,?,?,'queued',?,?)",id,dedupeKey,device.id,this.now(),JSON.stringify(data));queued++
      }
      return {queued,...(queued<available.length?{skipped:available.length-queued,reason:'capacity'}:{})}
    })
  }
  subscriptions() {return this.store.rows('SELECT * FROM notification_subscriptions ORDER BY mailbox').map(viewWatch)}
  watchRow(mailboxId) {return this.store.one('SELECT * FROM notification_subscriptions WHERE mailbox=?',mailboxId)}
  validateMail(mailboxId,epoch) {
    check(this.mailMetadata,'notification_mail_not_connected',503)
    const meta=this.mailMetadata(mailboxId,epoch)
    check(meta&&meta.status==='active'&&meta.epoch===epoch&&['gmail','outlook'].includes(meta.provider),'notification_mail_connection_changed',409)
    return meta
  }
  async watch({mailboxId,expectedEpoch},{assertAuthorized}={}) {
    assertAuthorized?.()
    ownerId(this.owner);key(mailboxId,'mailbox_id')
    const meta=this.validateMail(mailboxId,expectedEpoch)
    check(this.capabilities()[meta.provider],'notification_provider_not_configured',503)
    const prior=this.watchRow(mailboxId)
    if(prior&&prior.epoch===expectedEpoch&&['active','queued','renewing','creating'].includes(prior.state))return viewWatch(prior)
    check(!prior||prior.state!=='unknown','notification_watch_needs_reconciliation',409)
    const generation=this.identity().generation
    const old=prior?JSON.parse(prior.data):{}
    const watchId=old.watchId??crypto.randomUUID()
    // A mailbox connection ID has a stable provider account identity. A new
    // grant epoch can renew its existing subscription, without duplicate create.
    const state=prior?.sealed?await this.cipher.open(['watch',mailboxId,watchId],prior.sealed):{clientState:nonce()}
    const sealed=await this.cipher.seal(['watch',mailboxId,watchId],state)
    return this.store.tx(()=>{
      assertAuthorized?.()
      this.current(generation);this.validateMail(mailboxId,expectedEpoch)
      const current=this.watchRow(mailboxId)
      check((current?.version??0)===(prior?.version??0),'notification_watch_changed',409)
      check(current||this.store.one('SELECT COUNT(*) count FROM notification_subscriptions').count<32,'notification_watch_capacity',429)
      const data={...old,watchId,generation,attempts:0,error:null}
      this.store.rows("INSERT INTO notification_subscriptions VALUES (?,?,?,'queued',?,1,?,?) ON CONFLICT(mailbox) DO UPDATE SET provider=excluded.provider,epoch=excluded.epoch,state='queued',due=excluded.due,version=version+1,data=excluded.data,sealed=excluded.sealed",
        mailboxId,meta.provider,expectedEpoch,this.now(),JSON.stringify(data),sealed)
      const result=viewWatch(this.watchRow(mailboxId));this.store.event('notification.subscription.updated',{subscription:result});return result
    })
  }
  registryJob(method,payload) {
    const id=crypto.randomUUID()
    this.store.rows('INSERT INTO notification_registry_jobs VALUES (?,?,0,?)',id,this.now(),JSON.stringify({method,payload}))
    return id
  }
  unwatch({mailboxId,expectedVersion}) {
    key(mailboxId,'mailbox_id')
    return this.store.tx(()=>{
      const row=this.watchRow(mailboxId);check(row,'notification_watch_not_found',404)
      check(row.version===expectedVersion,'notification_watch_changed',409)
      if(row.state==='revoked')return viewWatch(row)
      const data=JSON.parse(row.data)
      this.store.rows("UPDATE notification_subscriptions SET state='revoked',due=0,version=version+1 WHERE mailbox=?",mailboxId)
      this.registryJob('unregister',{ownerId:this.owner,mailboxId,watchId:data.watchId,generation:data.generation,epoch:row.epoch,version:row.version})
      this.running.get('watch:'+mailboxId)?.controller.abort()
      return viewWatch(this.watchRow(mailboxId))
    })
  }
  async ingest({route,notification}) {
    check(route?.ownerId===this.owner,'notification_owner_mismatch',403)
    const row=this.watchRow(route.mailboxId)
    if(!row||!['active','renewing'].includes(row.state))return {accepted:false,stale:true}
    const data=JSON.parse(row.data)
    this.current(data.generation)
    this.validateMail(row.mailbox,row.epoch)
    check(route.generation===data.generation&&route.watchId===data.watchId&&route.epoch===row.epoch,'notification_route_stale',409)
    check(notification.provider===row.provider,'notification_provider_mismatch',403)
    if(row.provider==='gmail')check(email(notification.email)===data.email,'notification_mailbox_mismatch',403)
    else {
      check(notification.subscriptionId===data.subscriptionId&&await verifyGraphItem(notification,{...route,clientStateHash:data.clientStateHash}),'notification_push_unauthorized',401)
    }
    const dedupe=await digest(data.watchId+':'+key(notification.messageId,'message_id'))
    return this.store.tx(()=>{
      this.current(data.generation);this.validateMail(row.mailbox,row.epoch)
      const current=this.watchRow(row.mailbox)
      check(current?.epoch===row.epoch&&['active','renewing'].includes(current.state),'notification_watch_changed',409)
      if(this.store.one('SELECT 1 FROM notification_inbox WHERE id=?',dedupe))return {accepted:true,duplicate:true}
      this.store.rows('INSERT INTO notification_inbox VALUES (?,?)',dedupe,this.now())
      this.store.rows('DELETE FROM notification_inbox WHERE created<?',this.now()-7*86400000)
      this.store.rows('DELETE FROM notification_inbox WHERE rowid<=(SELECT COALESCE(MAX(rowid),0)-10000 FROM notification_inbox)')
      if(notification.lifecycleEvent==='subscriptionRemoved') {
        const next=JSON.parse(current.data);delete next.subscriptionId;next.attempts=0
        this.store.rows("UPDATE notification_subscriptions SET state='queued',due=?,version=version+1,data=? WHERE mailbox=?",this.now(),JSON.stringify(next),row.mailbox)
      } else if(notification.lifecycleEvent==='reauthorizationRequired') {
        this.store.rows("UPDATE notification_subscriptions SET state='queued',due=? WHERE mailbox=?",this.now(),row.mailbox)
      }
      // This callback must be synchronous: persist an index-sync request in this
      // same transaction; do not fetch mail or call a model from a webhook.
      this.onMailEvent({mailboxId:row.mailbox,provider:row.provider,...(notification.historyId?{historyId:notification.historyId}:{}),resync:notification.lifecycleEvent==='missed'})
      this.enqueue({dedupeKey:'mail:'+dedupe,kind:'mail.updated'})
      return {accepted:true}
    })
  }
  async runRegistryJob(row) {
    const job=JSON.parse(row.data)
    try {
      await this.registry[job.method](job.payload)
      this.store.tx(()=>this.store.rows('DELETE FROM notification_registry_jobs WHERE id=?',row.id))
    } catch(error) {
      this.store.tx(()=>this.store.rows('UPDATE notification_registry_jobs SET attempts=attempts+1,due=? WHERE id=?',this.now()+Math.min(3600000,10000*2**Math.min(row.attempts,8)),row.id))
      throw error
    }
  }
  async runDelivery(row,{signal}={}) {
    const data=JSON.parse(row.data),controller=new AbortController()
    this.running.set(row.id,{controller,installationId:row.installation})
    const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal
    try {
      const installation=this.store.one('SELECT * FROM notification_installations WHERE id=?',row.installation)
      const identity=this.identity()
      if(!installation||installation.status!=='active'||installation.epoch!==data.installationEpoch||identity.generation!==data.generation||identity.delivery_epoch!==data.deliveryEpoch||data.expiresAt<=this.now()) {
        this.store.tx(()=>this.store.rows("UPDATE notification_outbox SET state='cancelled' WHERE id=?",row.id));return
      }
      const device=await this.cipher.open(['installation',row.installation],installation.sealed)
      const provider=await this.registry.apnsToken()
      const current=this.store.one('SELECT * FROM notification_installations WHERE id=?',row.installation)
      check(current?.epoch===data.installationEpoch&&current.status==='active'&&this.identity().delivery_epoch===data.deliveryEpoch&&this.identity().generation===data.generation,'notification_installation_changed',409)
      data.attempts++
      this.store.tx(()=>this.store.rows("UPDATE notification_outbox SET state='sending',data=? WHERE id=?",JSON.stringify(data),row.id))
      const receipt=await sendAPNS({deviceToken:device.token,providerToken:provider.token,topic:installation.topic,environment:installation.environment,
        payload:data.payload,id:row.id,collapseId:data.kind==='mail.updated'?'maco-mail-update':row.id,expiresAt:data.expiresAt,signal:combined},{fetcher:this.fetcher})
      this.store.tx(()=>{
        const latest=this.store.one('SELECT state FROM notification_outbox WHERE id=?',row.id)
        if(latest?.state!=='sending')return
        data.receipt=receipt
        const retry=receipt.status==='retry'&&data.attempts<5&&data.expiresAt>this.now()+10000
        this.store.rows('UPDATE notification_outbox SET state=?,due=?,data=? WHERE id=?',retry?'queued':receipt.status==='accepted'?'accepted':'failed',
          retry?this.now()+Math.min(600000,5000*2**data.attempts):this.now(),JSON.stringify(data),row.id)
        if(receipt.status==='invalid') {
          const active=this.store.one('SELECT * FROM notification_installations WHERE id=?',row.installation)
          if(active?.epoch===data.installationEpoch&&(!receipt.invalidatedAt||active.updated<=receipt.invalidatedAt)) {
            this.store.rows("UPDATE notification_installations SET status='invalid',epoch=epoch+1,sealed=NULL,updated=? WHERE id=?",this.now(),row.installation)
          }
        }
      })
    } catch(error) {
      this.store.tx(()=>{
        const latest=this.store.one('SELECT state FROM notification_outbox WHERE id=?',row.id)
        if(!latest||!['queued','sending'].includes(latest.state))return
        data.attempts++;data.receipt={code:errorCode(error,'notification_delivery_failed')}
        const retry=data.attempts<5&&data.expiresAt>this.now()+10000
        this.store.rows('UPDATE notification_outbox SET state=?,due=?,data=? WHERE id=?',retry?'queued':'failed',this.now()+Math.min(600000,5000*2**data.attempts),JSON.stringify(data),row.id)
      })
    } finally {this.running.delete(row.id)}
  }
  async graphFind(accessToken,state,url,{signal}={}) {
    let next='https://graph.microsoft.com/v1.0/subscriptions'
    for(let page=0;page<4;page++) {
      const list=await providerJSON(next,accessToken,{fetcher:this.fetcher,signal})
      check(Array.isArray(list.value),'invalid_graph_subscription_list',502)
      const found=list.value.find(item=>item.clientState===state.clientState&&item.notificationUrl===url&&item.resource==='me/messages'&&item.changeType==='created,updated,deleted')
      if(found)return found
      if(!list['@odata.nextLink'])return null
      const candidate=new URL(list['@odata.nextLink'])
      check(candidate.origin==='https://graph.microsoft.com'&&candidate.pathname==='/v1.0/subscriptions','notification_graph_cursor_forbidden',502)
      next=candidate.href
    }
    throw failure('notification_graph_reconciliation_incomplete',503)
  }
  async runWatch(row,{signal}={}) {
    const data=JSON.parse(row.data),controller=new AbortController(),name='watch:'+row.mailbox
    this.running.set(name,{controller})
    const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal
    const expectedVersion=row.version
    let phase='prepare'
    const assertCurrent=()=>{
      combined.throwIfAborted();this.current(data.generation);this.validateMail(row.mailbox,row.epoch)
      const current=this.watchRow(row.mailbox)
      check(current?.version===expectedVersion&&current.state!=='revoked','notification_watch_changed',409)
    }
    try {
      assertCurrent()
      const context=await this.mailContext(row.mailbox,row.epoch)
      const credential=context.credential??context
      check(credential.provider===row.provider&&typeof credential.accessToken==='string','notification_mail_connection_changed',409)
      const state=await this.cipher.open(['watch',row.mailbox,data.watchId],row.sealed)
      assertCurrent()
      let remote
      if(row.provider==='gmail') {
        check(/^projects\/[A-Za-z0-9_.:-]+\/topics\/[A-Za-z0-9_.~-]+$/.test(this.env.GMAIL_PUBSUB_TOPIC),'gmail_push_not_configured',503)
        const profile=await providerJSON('https://gmail.googleapis.com/gmail/v1/users/me/profile',credential.accessToken,{fetcher:this.fetcher,signal:combined})
        data.email=email(profile.emailAddress)
        assertCurrent()
        phase='watch'
        this.store.tx(()=>this.store.rows("UPDATE notification_subscriptions SET state='renewing' WHERE mailbox=? AND version=?",row.mailbox,expectedVersion))
        remote=await providerJSON('https://gmail.googleapis.com/gmail/v1/users/me/watch',credential.accessToken,{method:'POST',body:{topicName:this.env.GMAIL_PUBSUB_TOPIC},fetcher:this.fetcher,signal:combined})
        check(typeof remote.historyId==='string'&&/^\d+$/.test(remote.historyId)&&Number.isFinite(Number(remote.expiration)),'invalid_gmail_watch_response',502)
        data.historyId=remote.historyId;data.expiresAt=Number(remote.expiration)
      } else {
        const base=publicURL(this.env.NOTIFICATION_BASE_URL)
        const notificationUrl=new URL('/webhooks/graph',base);notificationUrl.searchParams.set('watch',data.watchId)
        const requestedExpiry=new Date(this.now()+6*86400000).toISOString()
        if(row.state==='unknown') {
          phase='reconcile'
          remote=await this.graphFind(credential.accessToken,state,notificationUrl.href,{signal:combined})
          check(remote,'notification_watch_outcome_unknown',409)
        } else if(data.subscriptionId) {
          assertCurrent()
          phase='renew'
          this.store.tx(()=>this.store.rows("UPDATE notification_subscriptions SET state='renewing' WHERE mailbox=? AND version=?",row.mailbox,expectedVersion))
          try {remote=await providerJSON('https://graph.microsoft.com/v1.0/subscriptions/'+encodeURIComponent(data.subscriptionId),credential.accessToken,
            {method:'PATCH',body:{expirationDateTime:requestedExpiry},fetcher:this.fetcher,signal:combined})}
          catch(error) {
            if(error.httpStatus===404) {
              delete data.subscriptionId;data.attempts=0
              this.store.tx(()=>this.store.rows("UPDATE notification_subscriptions SET state='queued',due=?,data=? WHERE mailbox=? AND version=?",this.now(),JSON.stringify(data),row.mailbox,expectedVersion))
              return
            }
            throw error
          }
        } else {
          assertCurrent()
          phase='create'
          this.store.tx(()=>this.store.rows("UPDATE notification_subscriptions SET state='creating' WHERE mailbox=? AND version=?",row.mailbox,expectedVersion))
          remote=await providerJSON('https://graph.microsoft.com/v1.0/subscriptions',credential.accessToken,{method:'POST',fetcher:this.fetcher,signal:combined,
            body:{changeType:'created,updated,deleted',resource:'me/messages',notificationUrl:notificationUrl.href,lifecycleNotificationUrl:notificationUrl.href,
              expirationDateTime:requestedExpiry,clientState:state.clientState,includeResourceData:false,latestSupportedTlsVersion:'v1_2'}})
        }
        key(remote.id,'subscription_id')
        data.subscriptionId=remote.id;data.expiresAt=Date.parse(remote.expirationDateTime);data.clientStateHash=await digest(state.clientState)
      }
      check(Number.isFinite(data.expiresAt)&&data.expiresAt>this.now()+60000,'invalid_notification_expiration',502)
      this.current(data.generation);this.validateMail(row.mailbox,row.epoch)
      check(this.watchRow(row.mailbox)?.version===expectedVersion&&this.watchRow(row.mailbox)?.state!=='revoked','notification_watch_changed',409)
      data.attempts=0;data.error=null
      // Persist the provider ID before calling the registry so a registry outage
      // never causes a second Graph subscription to be created.
      this.store.tx(()=>this.store.rows('UPDATE notification_subscriptions SET data=? WHERE mailbox=? AND version=?',JSON.stringify(data),row.mailbox,expectedVersion))
      const route={ownerId:this.owner,mailboxId:row.mailbox,watchId:data.watchId,generation:data.generation,epoch:row.epoch,version:expectedVersion,
        provider:row.provider,expiresAt:data.expiresAt,...(row.provider==='gmail'?{email:data.email}:{subscriptionId:data.subscriptionId,clientStateHash:data.clientStateHash})}
      phase='register'
      await this.registry.register(route)
      this.store.tx(()=>{
        this.current(data.generation);this.validateMail(row.mailbox,row.epoch)
        check(this.watchRow(row.mailbox)?.version===expectedVersion&&this.watchRow(row.mailbox)?.state!=='revoked','notification_watch_changed',409)
        this.store.rows("UPDATE notification_subscriptions SET state='active',due=?,data=? WHERE mailbox=?",Math.max(this.now()+60000,Math.min(this.now()+86400000,data.expiresAt-3600000)),JSON.stringify(data),row.mailbox)
        this.store.event('notification.subscription.updated',{subscription:viewWatch(this.watchRow(row.mailbox))})
        this.onMailEvent({mailboxId:row.mailbox,provider:row.provider,resync:false})
      })
    } catch(error) {
      this.store.tx(()=>{
        const current=this.watchRow(row.mailbox)
        if(!current||current.version!==expectedVersion||current.state==='revoked'||this.identity().generation!==data.generation)return
        data.attempts=(data.attempts??0)+1;data.error=errorCode(error,'notification_watch_failed')
        const unknown=row.provider==='outlook'&&((phase==='create'&&(error.ambiguous||!error.httpStatus||error.httpStatus===409))||phase==='reconcile')
        const retry=data.attempts<5&&![401,403].includes(error.httpStatus)
        this.store.rows('UPDATE notification_subscriptions SET state=?,due=?,data=? WHERE mailbox=?',unknown?'unknown':retry?'queued':'failed',
          retry?this.now()+Math.min(3600000,15000*2**data.attempts):0,JSON.stringify(data),row.mailbox)
      })
    } finally {this.running.delete(name)}
  }
  recover() {
    this.store.tx(()=>{
      this.store.rows("UPDATE notification_outbox SET state='queued',due=? WHERE state='sending'",this.now())
      this.store.rows("UPDATE notification_subscriptions SET state=CASE WHEN state='creating' THEN 'unknown' ELSE 'queued' END,due=? WHERE state IN ('creating','renewing')",this.now())
    })
  }
  nextDue() {
    return this.store.one(`SELECT MIN(due) due FROM (
      SELECT due FROM notification_outbox WHERE state='queued' UNION ALL
      SELECT due FROM notification_subscriptions WHERE state IN ('queued','active','unknown') AND due>0 UNION ALL
      SELECT due FROM notification_registry_jobs)`).due
  }
  async runNext({signal}={}) {
    if(this.running.size)return false
    const cleanup=this.store.one('SELECT * FROM notification_registry_jobs WHERE due<=? ORDER BY due LIMIT 1',this.now())
    if(cleanup) {await this.runRegistryJob(cleanup);return true}
    const watch=this.store.one("SELECT * FROM notification_subscriptions WHERE state IN ('queued','active','unknown') AND due>0 AND due<=? ORDER BY due LIMIT 1",this.now())
    const delivery=this.store.one("SELECT * FROM notification_outbox WHERE state='queued' AND due<=? ORDER BY due LIMIT 1",this.now())
    if(watch&&(!delivery||watch.due<=delivery.due)){await this.runWatch(watch,{signal});return true}
    if(delivery){await this.runDelivery(delivery,{signal});return true}
    return false
  }
  activeCount() {return this.running.size}
  fence({revokeInstallations=false,unsubscribe=false}={}) {
    for(const entry of this.running.values())if(revokeInstallations||entry.installationId)entry.controller.abort()
    return this.store.tx(()=>{
      this.store.rows('UPDATE notification_identity SET delivery_epoch=delivery_epoch+1 WHERE id=1')
      this.store.rows("UPDATE notification_outbox SET state=CASE WHEN state='sending' THEN 'unknown' ELSE 'cancelled' END WHERE state IN ('queued','sending')")
      if(revokeInstallations)this.store.rows("UPDATE notification_installations SET status='revoked',epoch=epoch+1,sealed=NULL")
      if(unsubscribe) {
        const generations=new Set(this.store.rows('SELECT data FROM notification_subscriptions').map(row=>JSON.parse(row.data).generation))
        this.store.rows('UPDATE notification_identity SET generation=? WHERE id=1',nonce())
        this.store.rows("UPDATE notification_subscriptions SET state='revoked',due=0,version=version+1")
        for(const generation of generations) {
          this.store.rows("DELETE FROM notification_registry_jobs WHERE json_extract(data,'$.method')='unregister' AND json_extract(data,'$.payload.generation')=?",generation)
          if(!this.store.one("SELECT 1 FROM notification_registry_jobs WHERE json_extract(data,'$.method')='forgetOwner' AND json_extract(data,'$.payload.generation')=?",generation))this.registryJob('forgetOwner',{ownerId:this.owner,generation})
        }
      }
      return {active:this.activeCount()}
    })
  }
  async erase() {
    this.fence({revokeInstallations:true,unsubscribe:true})
    // A failed registry cleanup remains durable and must block final physical
    // account deletion. The caller must await this promise before wiping the DO.
    for(const job of this.store.rows('SELECT * FROM notification_registry_jobs ORDER BY rowid LIMIT 100'))await this.runRegistryJob(job)
    check(!this.store.one('SELECT 1 FROM notification_registry_jobs'),'notification_cleanup_pending',409)
    this.store.tx(()=>{
      for(const table of ['notification_installations','notification_outbox','notification_subscriptions','notification_inbox'])this.store.rows('DELETE FROM '+table)
    })
  }
}
