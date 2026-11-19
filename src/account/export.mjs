import { requireThat } from '../protocol.mjs'

const encoder = new TextEncoder()
const pick = (value,keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key,value[key]]))
const data = row => JSON.parse(row.data)
const receipt = value => pick(value,['status','code','providerId','httpStatus','accepted','at'])
const task = value => ({...pick(value,['id','runId','conversationId','state','version','priority','createdAt','updatedAt','timeZone']),
  modelProfile:pick(value.profile,['provider','model','effort','connectionId']),
  mailboxIds:value.mailboxIds || (value.mailboxId ? [value.mailboxId] : []),
  connectorIds:value.connectorIds || [],assetIds:value.assetIds || []})
const operation = (value,kind) => ({...pick(value,['id','taskId','runId','commandId','mailboxId','connectionId','state','version','createdAt','updatedAt','scheduledAt']),
  kind,...(kind === 'mail' ? {action:value.prepared?.action,resource:value.prepared?.resource} : {tool:value.tool}),
  receipt:receipt(value.receipt)})
const asset = value => pick(value,['id','name','mimeType','size','sha256','createdAt','taskId','state'])

// These are deliberate public projections. In particular: no SQL dump, vault,
// OAuth state, model checkpoints, raw tool arguments/results, R2 object keys,
// provider reasoning state, remote session/file identifiers, or secret values.
const sections = [
  {table:'tasks',kind:'task',project:row => task(data(row))},
  {table:'messages',kind:'message',where:"json_extract(data,'$.role') IN ('user','assistant')",
    project:row => ({taskId:row.task,...pick(data(row),['messageId','runId','role','content','createdAt'])})},
  {table:'personal_memory',kind:'memory',project:row => pick(row,['key','kind','value','status','version','createdAt','updatedAt'])},
  {table:'work_items',kind:'work_item',project:row => pick(data(row),['id','title','detail','state','dueAt','taskId','version','createdAt','updatedAt'])},
  {table:'task_schedules',kind:'schedule',project:row => {
    const value=data(row)
    return {...pick(value,['id','name','message','enabled','intervalMinutes','maxRunsPerDay','timeZone','conversationId','nextAt','version','lastTaskId','lastRunAt','error']),
      modelProfile:pick(value.binding?.profile,['provider','model','effort','connectionId']),mailboxIds:value.binding?.mailboxIds || [],connectorIds:value.binding?.connectorIds || []}
  }},
  {table:'model_usage',kind:'model_usage',project:row => {
    const value=data(row)
    return {...pick(value,['id','taskId','kind','provider','model','payer','state','at','updatedAt']),
      usage:pick(value.usage,['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens','reasoningTokens','totalTokens']),costUSD:null,billingComplete:false}
  }},
  {table:'device_analysis',kind:'device_analysis',project:row => pick(data(row),['mailboxId','messageId','summary','categories','source','analyzer','version','updatedAt'])},
  {table:'mail_index',kind:'mail_preview',where:'deleted=0',project:row => ({
    id:row.id,mailboxId:row.mailbox,providerId:row.providerId,receivedAt:row.received,subject:row.subject,
    sender:row.sender,snippet:row.snippet,folderId:row.folder,isUnread:!!row.unread,coverage:'snippet_only'})},
  {table:'operations',kind:'mail_operation',project:row => operation(data(row),'mail')},
  {table:'connector_operations',kind:'connector_operation',project:row => operation(data(row),'connector')},
  {table:'connections',kind:'connection',project:row => ({...pick(row,['id','kind','provider','status','epoch']),
    accountId:row.account_id,actions:JSON.parse(row.actions),scopes:JSON.parse(row.scopes)})},
  {table:'connector_connections',kind:'connector_connection',project:row => ({...pick(row,['id','server','endpoint','status','epoch']),
    authType:row.auth,scopes:JSON.parse(row.scopes)})},
  {table:'maco_assets',kind:'asset',where:"state='ready'",project:row => asset(data(row))},
  {table:'delegations',kind:'execution',project:row => {
    const value=data(row)
    return {...pick(value,['id','parentTaskId','runId','runVersion','state','createdAt','updatedAt','deadline','error']),
      provider:'openai-agents',model:value.profile?.model,cleanup:value.cleanupStatus,
      usage:pick(value.usage,['available','incomplete','inputTokens','outputTokens','reasoningTokens','totalTokens','billingComplete']),
      ...(value.deliveredAt && !value.discarded && value.result ? {result:{text:value.result.text,artifacts:(value.result.artifacts || []).map(asset)}} : {})}
  }},
  {table:'interactions',kind:'interaction',project:row => pick(data(row),['interactionId','taskId','runId','question','fields','answer','state','version','createdAt','updatedAt'])},
  {table:'account_sessions',kind:'session',project:row => ({sessionId:row.id,state:row.state,version:row.version,issuedAt:row.issued,expires:row.expires,lastSeenAt:row.seen})},
  {table:'account_uncertainty',kind:'uncertain_operation',project:row => data(row)},
]

function bounded(value,budget={bytes:20000,limited:false},depth=0) {
  if (depth > 6 || budget.bytes < 32) {budget.limited=true;return null}
  if (typeof value === 'string') {
    const raw=encoder.encode(value),limit=Math.min(12000,budget.bytes)
    const text=raw.length<=limit ? value : new TextDecoder().decode(raw.slice(0,Math.max(0,limit-4)))
    budget.bytes-=encoder.encode(text).length
    if (text !== value) budget.limited=true
    return text
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (Array.isArray(value)) {
    if(value.length>64)budget.limited=true
    return value.slice(0,64).map(item=>bounded(item,budget,depth+1))
  }
  if (value && typeof value === 'object') {
    const entries=Object.entries(value).filter(([,item])=>item!==undefined)
    if(entries.length>40)budget.limited=true
    return Object.fromEntries(entries.slice(0,40).map(([key,item])=>[key,bounded(item,budget,depth+1)]))
  }
  return null
}
const exists = (store,table) => !!store.one("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",table)
const encodeCursor = value => btoa(JSON.stringify(value))
function decodeCursor(value) {
  requireThat(typeof value==='string' && value.length<=2048,'invalid_account_export_cursor')
  let decoded
  try {decoded=JSON.parse(atob(value))} catch {requireThat(false,'invalid_account_export_cursor')}
  requireThat(decoded?.v===1 && Number.isSafeInteger(decoded.g) && Number.isSafeInteger(decoded.i) && decoded.i>=0 && decoded.i<=sections.length &&
    Number.isSafeInteger(decoded.a) && decoded.a>=0 && Number.isSafeInteger(decoded.at) &&
    Array.isArray(decoded.c) && decoded.c.length===sections.length && decoded.c.every(n=>Number.isSafeInteger(n)&&n>=0),'invalid_account_export_cursor')
  return decoded
}

/** A bounded live export, not an MVCC database backup. High-water marks exclude
 * newly appended records; updates within the same generation may still appear.
 * A reset/delete invalidates every existing cursor immediately. */
export function exportAccount(store,{generation,assertActive,now=Date.now},{cursor,limit=50}={}) {
  requireThat(Number.isSafeInteger(limit) && limit>=1 && limit<=100,'invalid_account_export_limit')
  assertActive()
  const position=cursor ? decodeCursor(cursor) : {v:1,g:generation(),i:0,a:0,at:now(),
    c:sections.map(section=>exists(store,section.table) ? store.one('SELECT COALESCE(MAX(rowid),0) AS n FROM '+section.table).n : 0)}
  requireThat(position.g===generation(),'account_export_generation_changed',409)
  const records=[]
  let bytes=0,truncated=0,full=false
  while(position.i<sections.length && records.length<limit && !full) {
    const section=sections[position.i],ceiling=position.c[position.i]
    if(!ceiling || !exists(store,section.table)){position.i++;position.a=0;continue}
    const rows=store.rows(`SELECT rowid AS _cursor,* FROM ${section.table} WHERE rowid>? AND rowid<=?${section.where?' AND '+section.where:''} ORDER BY rowid LIMIT ?`,position.a,ceiling,limit-records.length+1)
    if(!rows.length){position.i++;position.a=0;continue}
    for(const row of rows) {
      const budget={bytes:20000,limited:false}
      const projected=bounded(section.project(row),budget)
      let record={type:section.kind,data:projected,...(budget.limited?{truncated:true}:{})}
      let size=encoder.encode(JSON.stringify(record)).length
      if(size>24576){record={type:section.kind,data:{omitted:'record_size_limit'},truncated:true};size=encoder.encode(JSON.stringify(record)).length}
      if(records.length>=limit || bytes+size>112*1024){full=true;break}
      records.push(record);bytes+=size;truncated+=record.truncated?1:0;position.a=row._cursor
    }
  }
  assertActive(position.g)
  return {format:'maco-account-v1',generation:position.g,startedAt:position.at,records,
    nextCursor:position.i<sections.length?encodeCursor(position):null,
    coverage:{consistency:'bounded_live',truncatedRecords:truncated,attachmentBytesIncluded:false,
      excluded:['credentials','oauth_state','provider_reasoning','tool_arguments_and_raw_results','checkpoints','internal_object_and_remote_ids']}}
}
