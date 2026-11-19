import { identifier, requireThat, checkedVersion } from './protocol.mjs'

const boundedText = (value,max,empty=true) => typeof value==='string' && value.length<=max && (empty || value.trim().length>0)

// This module only accepts results computed by the user's device. It has no
// model client, inference fallback, scheduler, or provider-specific AI endpoint.
export class ClientStateService {
  constructor(store,{mail,index}) {
    Object.assign(this,{store,mail,index})
    store.rows('CREATE TABLE IF NOT EXISTS device_analysis (mailbox TEXT NOT NULL,message TEXT NOT NULL,version INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(mailbox,message))')
    store.rows('CREATE TABLE IF NOT EXISTS work_items (id TEXT PRIMARY KEY,state TEXT NOT NULL,version INTEGER NOT NULL,data TEXT NOT NULL)')
  }
  analysisBatch({mailboxId,items}) {
    const meta=this.mail.metadata(identifier(mailboxId,'mailbox_id'))
    requireThat(Array.isArray(items) && items.length>0 && items.length<=50,'invalid_analysis_batch')
    return this.store.tx(()=>({analyses:items.map(item=>{
      const id=identifier(item.messageId,'message_id')
      const known=this.index.index.lookup(mailboxId,this.index.index.providerId(mailboxId,id))
      requireThat(known,'message_not_indexed',409)
      const old=this.store.one('SELECT version FROM device_analysis WHERE mailbox=? AND message=?',mailboxId,known.id)
      checkedVersion(item.expectedVersion,old?.version || 0)
      requireThat(boundedText(item.providerVersion,2048,false),'provider_version_required')
      requireThat(item.summary===undefined || boundedText(item.summary,8000),'invalid_summary')
      requireThat(item.categories===undefined || Array.isArray(item.categories) && item.categories.length<=16 &&
        item.categories.every(value=>boundedText(value,100,false)),'invalid_categories')
      requireThat(boundedText(item.analyzer || 'device',100,false),'invalid_analyzer')
      const value={mailboxId,messageId:known.id,providerVersion:item.providerVersion,source:'on_device',
        summary:item.summary || '',categories:[...new Set(item.categories || [])],analyzer:item.analyzer || 'device',
        connectionEpoch:meta.epoch,version:(old?.version || 0)+1,updatedAt:Date.now()}
      this.store.rows('INSERT INTO device_analysis VALUES (?,?,?,?) ON CONFLICT(mailbox,message) DO UPDATE SET version=excluded.version,data=excluded.data',mailboxId,known.id,value.version,JSON.stringify(value))
      this.store.event('mail.analysis.updated',{analysis:value})
      return value
    })}))
  }
  analysis({mailboxId,messageIds}) {
    const meta=this.mail.metadata(identifier(mailboxId,'mailbox_id'))
    requireThat(Array.isArray(messageIds) && messageIds.length<=100,'invalid_message_ids')
    return {analyses:messageIds.map(id=>{
      const providerId=this.index.index.providerId(mailboxId,identifier(id,'message_id'))
      const known=this.index.index.lookup(mailboxId,providerId)
      if (!known) return {messageId:id,status:'not_synced'}
      const row=this.store.one('SELECT data FROM device_analysis WHERE mailbox=? AND message=?',mailboxId,known.id)
      if (!row) return {messageId:known.id,status:'not_analyzed'}
      const value=JSON.parse(row.data)
      const resource=JSON.stringify([mailboxId,'message:'+providerId])
      const observed=this.store.one('SELECT providerVersion FROM mail_observations WHERE resource=?',resource)?.providerVersion
      return {...value,status:value.connectionEpoch!==meta.epoch || observed && observed!==value.providerVersion ? 'stale' : 'available'}
    })}
  }
  workItem({id=crypto.randomUUID(),expectedVersion=0,title,detail='',state='open',dueAt=null,taskId=null}) {
    identifier(id,'work_item_id')
    requireThat(boundedText(title,300,false) && boundedText(detail,8000) && ['open','completed','cancelled'].includes(state),'invalid_work_item')
    requireThat(dueAt===null || Number.isSafeInteger(dueAt) && dueAt>0,'invalid_due_at')
    if (taskId) this.store.getTask(identifier(taskId,'task_id'))
    const old=this.store.one('SELECT version,data FROM work_items WHERE id=?',id)
    checkedVersion(expectedVersion,old?.version || 0)
    const value={id,title,detail,state,dueAt,taskId,version:(old?.version || 0)+1,updatedAt:Date.now(),createdAt:old ? JSON.parse(old.data).createdAt : Date.now()}
    this.store.rows('INSERT INTO work_items VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,version=excluded.version,data=excluded.data',id,state,value.version,JSON.stringify(value))
    this.store.event('work_item.updated',{workItem:value})
    return {workItem:value}
  }
  workItems({before=Number.MAX_SAFE_INTEGER,active=false}={}) {
    const rows=this.store.rows(`SELECT rowid AS n,data FROM work_items WHERE rowid<? ${active ? "AND state='open'" : ''} ORDER BY rowid DESC LIMIT 101`,before)
    return {workItems:rows.slice(0,100).map(row=>JSON.parse(row.data)),nextBefore:rows.length>100 ? rows[99].n : null}
  }
}
