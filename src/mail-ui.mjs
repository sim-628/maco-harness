import { withDeadline } from './deadline.mjs'
import { request, segment, unbase64, validId, string } from './mail/common.mjs'
import { readMailTool } from './mail/read.mjs'
import { checkRead } from './mail/policy.mjs'
import { requireThat } from './protocol.mjs'

const maxMime=10*1024*1024
const applyGraphCursor=(query,value,provider=false)=>{
  if (!value) return
  const match=/^(\$skiptoken|\$skip)=(.+)$/.exec(value)
  requireThat(match && value.length<=4096 && !/[\x00-\x1f\x7f]/.test(value) &&
    (match[1]!=='$skip' || /^\d{1,15}$/.test(match[2])),provider ? 'invalid_provider_response' : 'invalid_cursor',provider ? 502 : 400)
  query[match[1]]=match[2]
}
const graphContinuation=(link,path)=>{
  if (link===undefined || link===null) return null
  requireThat(typeof link==='string' && link.length<=8192,'invalid_provider_response',502)
  let url,valid=false
  try {
    url=new URL(link)
    valid=url.origin==='https://graph.microsoft.com' && !url.username && !url.password && !url.hash &&
      decodeURIComponent(url.pathname)===decodeURIComponent('/v1.0/me/'+path)
  } catch {}
  requireThat(valid,'invalid_provider_response',502)
  const keys=['$skiptoken','$skip'].filter(key=>url.searchParams.has(key))
  requireThat(keys.length===1 && url.searchParams.getAll(keys[0]).length===1,'invalid_provider_response',502)
  const value=keys[0]+'='+url.searchParams.get(keys[0])
  applyGraphCursor({},value,true)
  return value
}

/** Native mailbox UI reads share the credential owner and the same normalized
 * message IDs as agent tools. Message bodies remain provider/R2 reads, never a
 * second full-text mailbox database. */
export class MailReadService {
  constructor(service) { this.service=service }
  async withMailbox(mailboxId,run,assertAuthorized=()=>{}) {
    assertAuthorized()
    const service=this.service,meta=service.mail.metadata(mailboxId)
    const generation=service.lifecycle?.generation()
    checkRead(meta)
    return withDeadline(60000,null,async signal=>{
      const context=await service.mail.context(mailboxId,meta.epoch)
      const assertCurrent=()=>{
        assertAuthorized()
        service.assertAvailable(generation)
        service.connections.assertEpoch(mailboxId,meta.epoch)
        signal.throwIfAborted()
      }
      assertCurrent()
      const result=await run({...context,clientPage:true,signal,assertCurrent})
      assertCurrent()
      return result
    })
  }
  list({mailboxId,query='',folderId,cursor,limit=30,after,before,unread},assertAuthorized) {
    return this.withMailbox(mailboxId,ctx=>this.service.readProvider('mail_search',{
      query,cursor,limit,filters:{folderId,after,before,unread}},ctx,readMailTool),assertAuthorized)
  }
  async folders({mailboxId,parentId,cursor='',limit=50},assertAuthorized) {
    requireThat(Number.isSafeInteger(limit) && limit>=1 && limit<=100,'invalid_limit')
    string(cursor,'cursor',4096,true)
    return this.withMailbox(mailboxId,async ctx=>{
      if (ctx.credential.provider==='gmail') {
        requireThat(!parentId,'folders_not_nested',422)
        requireThat(!cursor || /^labels:\d{1,5}$/.test(cursor),'invalid_cursor')
        const {data}=await request(ctx,'labels')
        requireThat(Array.isArray(data?.labels) && data.labels.length<=5000,'invalid_provider_response',502)
        const offset=cursor ? Number(cursor.slice(7)) : 0
        return {folders:data.labels.slice(offset,offset+limit).map(label=>({id:label.id,name:label.name,type:label.type})),
          nextCursor:data.labels.length>offset+limit ? 'labels:'+(offset+limit) : null}
      }
      const path=parentId ? 'mailFolders/'+segment(parentId)+'/childFolders' : 'mailFolders'
      const query={$select:'id,displayName,parentFolderId,childFolderCount,totalItemCount,unreadItemCount',$top:limit,includeHiddenFolders:true}
      applyGraphCursor(query,cursor)
      const {data}=await request(ctx,path,{query})
      requireThat(Array.isArray(data?.value) && data.value.length<=limit,'invalid_provider_response',502)
      return {folders:data.value.map(value=>({id:value.id,name:value.displayName,parentId:value.parentFolderId,childFolderCount:value.childFolderCount,
        totalItemCount:value.totalItemCount,unreadItemCount:value.unreadItemCount})),nextCursor:graphContinuation(data['@odata.nextLink'],path)}
    },assertAuthorized)
  }
  async raw({mailboxId,messageId},assertAuthorized) {
    return this.withMailbox(mailboxId,async ctx=>{
      const id=this.service.index.resolveInput(mailboxId,{messageId}).messageId
      validId(id)
      let bytes
      if (ctx.credential.provider==='gmail') {
        const {data}=await request(ctx,'messages/'+segment(id),{query:{format:'raw'},max:Math.ceil(maxMime*4/3)+65536})
        requireThat(data?.id===id,'invalid_provider_response',502)
        bytes=unbase64(data.raw,maxMime)
      } else ({data:bytes}=await request(ctx,'messages/'+segment(id)+'/$value',{binary:true,max:maxMime}))
      return {messageId,bytes,mimeType:'message/rfc822'}
    },assertAuthorized)
  }
  async aliases({mailboxId},assertAuthorized) {
    return this.withMailbox(mailboxId,async ctx=>{
      if (ctx.credential.provider==='gmail') {
        const {data}=await request(ctx,'settings/sendAs')
        requireThat(Array.isArray(data?.sendAs),'invalid_provider_response',502)
        return {aliases:data.sendAs.slice(0,100).map(value=>({address:value.sendAsEmail,name:value.displayName,
          primary:value.isPrimary===true,default:value.isDefault===true,verificationStatus:value.verificationStatus})),
          truncated:data.sendAs.length>100,sendAsSupported:false}
      }
      const {data}=await request(ctx,'',{query:{$select:'mail,userPrincipalName,proxyAddresses'}})
      const primary=data.mail || data.userPrincipalName
      const addresses=[...new Set([primary,...(data.proxyAddresses || []).filter(value=>/^smtp:/i.test(value)).map(value=>value.slice(5))])]
      return {aliases:addresses.filter(value=>typeof value==='string').slice(0,100).map(address=>({address,primary:address===primary,
        verificationStatus:'directory_value'})),truncated:addresses.length>100,sendAsSupported:false}
    },assertAuthorized)
  }
  delta({mailboxId,...options}) {
    this.service.assertAvailable()
    checkRead(this.service.mail.metadata(mailboxId))
    return this.service.index.index.changes(mailboxId,options)
  }
}
