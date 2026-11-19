import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/store.mjs'
import { MailIndexService } from '../src/mail-index/index.mjs'
import { MailReadService } from '../src/mail-ui.mjs'
import { readMailTool } from '../src/mail/read.mjs'
import { createStorage } from './support/storage.mjs'

const encode=value=>new TextEncoder().encode(value)
const error=(code,status=403)=>Object.assign(Error(code),{code,status})
const view=(id,fields={})=>({citation:{mailboxId:'box',messageId:id},subject:'Invoice',from:'sender@example.com',
  date:'2026-11-18T12:00:00Z',preview:'Short preview',version:'v1',isRead:false,...fields})
const gmail=id=>({id,threadId:'thread',historyId:'v1',internalDate:String(Date.parse('2026-11-18T12:00:00Z')),
  labelIds:['INBOX','UNREAD'],snippet:'Short preview',payload:{headers:[{name:'Subject',value:'Invoice '+id},{name:'From',value:'sender@example.com'}]}})
const graph=id=>({id,conversationId:'thread',subject:'Invoice '+id,from:{emailAddress:{address:'sender@example.com'}},
  receivedDateTime:'2026-11-18T12:00:00Z',bodyPreview:'Short preview',changeKey:'v1',isRead:false,parentFolderId:'inbox'})

function fixture(provider='gmail',handler=()=>{throw Error('unexpected provider request')}) {
  const storage=createStorage(),store=new Store(storage),index=new MailIndexService(store)
  let generation=1,epoch=1,active=true
  const calls=[]
  const credential={provider,accessToken:'fixture-only',scopes:provider==='gmail' ? ['https://www.googleapis.com/auth/gmail.modify'] : ['Mail.ReadWrite']}
  const fetchImpl=async (url,init)=>{
    assert.equal(init.method,'GET')
    assert.equal(init.redirect,'manual')
    assert.equal(init.headers.Authorization,'Bearer fixture-only')
    assert.equal(new URL(url).origin,provider==='gmail' ? 'https://gmail.googleapis.com' : 'https://graph.microsoft.com')
    calls.push({url:new URL(url),init})
    return handler(new URL(url),init)
  }
  const service={store,index,
    lifecycle:{generation:()=>generation},
    assertAvailable:expected=>{if(!active || expected!==undefined && expected!==generation)throw error('account_generation_changed',409)},
    connections:{assertEpoch:(id,expected)=>{if(expected!==epoch)throw error('connection_changed')}},
    mail:{metadata:(id,expected)=>{
      if(!['box','other'].includes(id))throw error('connection_not_found',404)
      if(expected!==undefined && expected!==epoch)throw error('connection_changed')
      return {...credential,id,epoch}
    },context:async(id,expected)=>{
      if(expected!==epoch)throw error('connection_changed')
      return {mailboxId:id,epoch,credential,fetchImpl}
    }},
    readProvider:(name,input,ctx,implementation)=>index.read(name,input,ctx,implementation),
  }
  return {storage,store,index,service,credential,calls,ui:new MailReadService(service),
    context:{mailboxId:'box',credential,fetchImpl},setGeneration:()=>generation++,revoke:()=>epoch++,block:()=>{active=false}}
}

test('native Gmail listing permits 50 metadata rows while agent reads keep their 8-row bound',async()=>{
  let inFlight=0,peak=0
  const f=fixture('gmail',async url=>{
    if(url.pathname.endsWith('/messages')) {
      const count=Number(url.searchParams.get('maxResults'))
      assert.equal(url.searchParams.get('labelIds'),'INBOX')
      assert.equal(url.searchParams.get('includeSpamTrash'),'true')
      return Response.json({messages:Array.from({length:count},(_,i)=>({id:'message-'+i})),nextPageToken:'next-page'})
    }
    assert.equal(url.searchParams.get('format'),'metadata')
    inFlight++;peak=Math.max(peak,inFlight)
    await Promise.resolve()
    inFlight--
    return Response.json(gmail(url.pathname.split('/').at(-1)))
  })
  const page=await f.ui.list({mailboxId:'box',folderId:'INBOX',limit:50})
  assert.equal(page.matches.length,50)
  assert.equal(page.nextCursor,'next-page')
  assert.equal(peak,5,'native pages must use bounded parallel metadata requests')
  assert.ok(page.matches.every(item=>item.citation.messageId.startsWith('mail_') && item.contentCoverage==='snippet' && !('body' in item)))
  const before=f.calls.length
  await assert.rejects(f.ui.list({mailboxId:'box',limit:51}),{code:'invalid_input'})
  await assert.rejects(f.index.read('mail_search',{limit:9},f.context),{code:'invalid_input'})
  await assert.rejects(readMailTool('mail_search',{limit:9},f.context),{code:'invalid_input'})
  assert.equal(f.calls.length,before)
  const agent=await f.index.read('mail_search',{limit:8,filters:{folderId:'INBOX'}},f.context)
  assert.equal(agent.matches.length,8)
  assert.equal(agent.matches[0].citation.messageId,page.matches[0].citation.messageId)
  f.storage.close()
})

test('native Graph listing supports 50 rows and trusted message continuation without granting agent bulk access',async()=>{
  const f=fixture('outlook',url=>{
    assert.equal(url.pathname,'/v1.0/me/mailFolders/inbox/messages')
    assert.equal(url.searchParams.get('$top'),'50')
    const offset=Number(url.searchParams.get('$skip') || 0)
    return Response.json({value:Array.from({length:50},(_,i)=>graph('message-'+(offset+i))),
      ...(offset===0 ? {'@odata.nextLink':'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skip=50'} : {})})
  })
  const first=await f.ui.list({mailboxId:'box',folderId:'inbox',limit:50})
  assert.equal(first.matches.length,50)
  assert.equal(first.nextCursor,'$skip=50')
  const next=await f.ui.list({mailboxId:'box',folderId:'inbox',limit:50,cursor:first.nextCursor})
  assert.equal(next.nextCursor,null)
  assert.ok(next.matches.every(item=>!first.matches.some(prior=>prior.citation.messageId===item.citation.messageId)))
  assert.match(f.calls[0].init.headers.Prefer,/IdType="ImmutableId"/)
  await assert.rejects(f.index.read('mail_search',{limit:50},f.context),{code:'invalid_input'})
  f.storage.close()
})

test('Graph folder paging preserves skip or opaque skiptoken and binds continuation to the exact folder route',async()=>{
  const f=fixture('outlook',url=>{
    assert.equal(url.pathname,'/v1.0/me/mailFolders')
    assert.equal(url.searchParams.get('includeHiddenFolders'),'true')
    assert.equal(url.searchParams.get('$top'),'2')
    if(url.searchParams.has('$skiptoken')) {
      assert.equal(url.searchParams.get('$skiptoken'),'opaque+/=token')
      assert.equal(url.searchParams.has('$skip'),false)
      return Response.json({value:[]})
    }
    if(url.searchParams.has('$skip')) {
      assert.equal(url.searchParams.get('$skip'),'2')
      return Response.json({value:[{id:'archive',displayName:'Archive'}],
        '@odata.nextLink':'https://graph.microsoft.com/v1.0/me/mailFolders?%24skiptoken=opaque%2B%2F%3Dtoken'})
    }
    return Response.json({value:[{id:'inbox',displayName:'Inbox'},{id:'sent',displayName:'Sent'}],
      '@odata.nextLink':'https://graph.microsoft.com/v1.0/me/mailFolders?$skip=2'})
  })
  const first=await f.ui.folders({mailboxId:'box',limit:2})
  assert.equal(first.nextCursor,'$skip=2')
  const second=await f.ui.folders({mailboxId:'box',limit:2,cursor:first.nextCursor})
  assert.equal(second.nextCursor,'$skiptoken=opaque+/=token')
  assert.equal((await f.ui.folders({mailboxId:'box',limit:2,cursor:second.nextCursor})).nextCursor,null)
  const count=f.calls.length
  for(const cursor of ['$skip=-1','$skip=1.2','$skip=1234567890123456','$skiptoken=','https://evil.example/next']) {
    await assert.rejects(f.ui.folders({mailboxId:'box',cursor}),{code:'invalid_cursor'})
  }
  assert.equal(f.calls.length,count)
  f.storage.close()

  const nested=fixture('outlook',url=>{
    assert.equal(url.pathname,'/v1.0/me/mailFolders/parent%3D1/childFolders')
    return Response.json({value:[], '@odata.nextLink':'https://graph.microsoft.com/v1.0/me/mailFolders/parent%3D1/childFolders?$skip=5'})
  })
  assert.equal((await nested.ui.folders({mailboxId:'box',parentId:'parent=1'})).nextCursor,'$skip=5')
  nested.storage.close()
})

test('Graph folder pagination rejects untrusted, malformed and ambiguous provider URLs before following them',async()=>{
  const invalid=[
    'https://evil.example/v1.0/me/mailFolders?$skip=2',
    'https://user@graph.microsoft.com/v1.0/me/mailFolders?$skip=2',
    'https://graph.microsoft.com/v1.0/me/messages?$skip=2',
    'https://graph.microsoft.com/v1.0/me/mailFolders/other/childFolders?$skip=2',
    'https://graph.microsoft.com/v1.0/me/mailFolders?$skip=2#fragment',
    'https://graph.microsoft.com/v1.0/me/mailFolders?$skip=2&$skip=3',
    'https://graph.microsoft.com/v1.0/me/mailFolders?$skip=2&$skiptoken=opaque',
    'https://graph.microsoft.com/v1.0/me/mailFolders?$skip=-2',
    'https://graph.microsoft.com/v1.0/me/mailFolders?$skiptoken=',
    'https://graph.microsoft.com/v1.0/me/mailFolders?$skiptoken=%0A',
    'https://graph.microsoft.com/v1.0/me/%ZZ?$skip=2',
    'not-a-url','',
  ]
  for(const link of invalid) {
    const f=fixture('outlook',()=>Response.json({value:[], '@odata.nextLink':link}))
    await assert.rejects(f.ui.folders({mailboxId:'box'}),{code:'invalid_provider_response',status:502})
    assert.equal(f.calls.length,1)
    f.storage.close()
  }
})

test('Gmail folder listing pages bounded provider labels and rejects impossible nesting',async()=>{
  const f=fixture('gmail',url=>{
    assert.equal(url.pathname,'/gmail/v1/users/me/labels')
    return Response.json({labels:[{id:'INBOX',name:'Inbox',type:'system'},{id:'Label_1',name:'Invoices',type:'user'},{id:'Label_2',name:'Family',type:'user'}]})
  })
  const first=await f.ui.folders({mailboxId:'box',limit:2})
  assert.equal(first.nextCursor,'labels:2')
  assert.deepEqual((await f.ui.folders({mailboxId:'box',limit:2,cursor:first.nextCursor})).folders.map(item=>item.id),['Label_2'])
  await assert.rejects(f.ui.folders({mailboxId:'box',parentId:'INBOX'}),{code:'folders_not_nested'})
  await assert.rejects(f.ui.folders({mailboxId:'box',cursor:'labels:-1'}),{code:'invalid_cursor'})
  await assert.rejects(f.ui.folders({mailboxId:'box',limit:101}),{code:'invalid_limit'})
  f.storage.close()
})

test('raw Gmail and Graph MIME reads preserve binary bytes and stable IDs without indexing full contents',async()=>{
  const mime=new Uint8Array([...encode('From: sender@example.com\r\nContent-Type: application/octet-stream\r\n\r\n'),0,255,128,13,10])
  for(const provider of ['gmail','outlook']) {
    const f=fixture(provider,url=>{
      assert.equal(url.pathname,provider==='gmail' ? '/gmail/v1/users/me/messages/raw-id' : '/v1.0/me/messages/raw-id/$value')
      if(provider==='gmail') {
        assert.equal(url.searchParams.get('format'),'raw')
        return Response.json({id:'raw-id',raw:Buffer.from(mime).toString('base64url')})
      }
      return new Response(mime,{headers:{'Content-Type':'message/rfc822'}})
    })
    const remembered=f.index.index.remember('box',provider,view('raw-id'))
    const raw=await f.ui.raw({mailboxId:'box',messageId:remembered.mailMessageId})
    assert.equal(raw.messageId,remembered.mailMessageId)
    assert.equal(raw.mimeType,'message/rfc822')
    assert.deepEqual(raw.bytes,mime)
    assert.ok(!JSON.stringify(f.store.rows('SELECT data FROM mail_index')).includes('application/octet-stream'))
    await assert.rejects(f.ui.raw({mailboxId:'other',messageId:remembered.mailMessageId}),{code:'message_not_found'})
    f.index.index.tombstone('box','raw-id')
    await assert.rejects(f.ui.raw({mailboxId:'box',messageId:remembered.mailMessageId}),{code:'message_deleted'})
    assert.equal(f.calls.length,1)
    f.storage.close()
  }
})

test('raw MIME download rejects wrong Gmail identity, invalid content and oversized Graph streams',async()=>{
  for(const data of [{id:'wrong',raw:'YWJj'},{id:'raw-id',raw:'not base64!'}]) {
    const f=fixture('gmail',()=>Response.json(data))
    await assert.rejects(f.ui.raw({mailboxId:'box',messageId:'raw-id'}),{code:'invalid_provider_response'})
    f.storage.close()
  }
  let cancelled=false,chunks=0
  const f=fixture('outlook',()=>new Response(new ReadableStream({
    pull(controller){chunks++;controller.enqueue(new Uint8Array(1024*1024))},cancel(){cancelled=true},
  })))
  await assert.rejects(f.ui.raw({mailboxId:'box',messageId:'raw-id'}),{code:'content_too_large'})
  assert.equal(cancelled,true)
  assert.ok(chunks<=12)
  const before=f.calls.length
  for(const messageId of ['../escape','%2Fescape','bad#id','bad\nid']) {
    await assert.rejects(f.ui.raw({mailboxId:'box',messageId}),{code:'invalid_input'})
  }
  assert.equal(f.calls.length,before)
  f.storage.close()
})

test('native read completion rejects session revocation and account-generation changes across provider I/O',async()=>{
  const inputs=[['list',{}],['folders',{}],['raw',{messageId:'raw-id'}],['aliases',{}]]
  for(const [method,args] of inputs) {
    let active=true
    const f=fixture('gmail',url=>{
      active=false
      if(url.pathname.endsWith('/messages'))return Response.json({messages:[]})
      if(url.pathname.endsWith('/labels'))return Response.json({labels:[]})
      if(url.pathname.endsWith('/sendAs'))return Response.json({sendAs:[]})
      return Response.json({id:'raw-id',raw:'YWJj'})
    })
    const assertAuthorized=()=>{if(!active)throw error('session_revoked',401)}
    await assert.rejects(f.ui[method]({mailboxId:'box',...args},assertAuthorized),{code:'session_revoked'})
    assert.equal(f.calls.length,1)
    await assert.rejects(f.ui[method]({mailboxId:'box',...args},assertAuthorized),{code:'session_revoked'})
    assert.equal(f.calls.length,1)
    f.storage.close()
  }
  let f
  f=fixture('outlook',()=>{f.setGeneration();return Response.json({value:[]})})
  await assert.rejects(f.ui.folders({mailboxId:'box'}),{code:'account_generation_changed'})
  f.storage.close()
})

test('mail UI deltas carry stable metadata updates and tombstones with per-mailbox cursors',()=>{
  const f=fixture()
  const first=f.index.index.remember('box','gmail',view('first',{body:'FULL PRIVATE BODY',bodyType:'text'}),{now:100})
  const second=f.index.index.remember('box','gmail',view('second'),{now:100})
  const page=f.ui.delta({mailboxId:'box',limit:1})
  assert.equal(page.hasMore,true)
  assert.equal(page.changes[0].messageId,first.mailMessageId)
  assert.equal(page.changes[0].metadata.contentCoverage,'snippet')
  assert.ok(!('body' in page.changes[0].metadata))
  const rest=f.ui.delta({mailboxId:'box',after:page.cursor})
  assert.equal(rest.changes[0].messageId,second.mailMessageId)
  assert.equal(rest.hasMore,false)
  f.index.index.remember('box','gmail',view('first'),{now:200})
  assert.deepEqual(f.ui.delta({mailboxId:'box',after:rest.cursor}).changes,[],'indexedAt-only changes must not produce new device deltas')
  f.index.index.remember('box','gmail',view('first',{isRead:true,version:'v2'}),{now:300})
  f.index.index.tombstone('box','second')
  const updates=f.ui.delta({mailboxId:'box',after:rest.cursor})
  assert.equal(updates.changes.length,2)
  assert.equal(updates.changes[0].messageId,first.mailMessageId)
  assert.equal(updates.changes[0].metadata.isRead,true)
  assert.deepEqual(updates.changes[1],{seq:updates.changes[1].seq,messageId:second.mailMessageId,deleted:true})
  f.index.index.tombstone('box','second')
  assert.equal(f.ui.delta({mailboxId:'box',after:updates.cursor}).changes.length,0)
  assert.deepEqual(f.ui.delta({mailboxId:'other'}).changes,[])
  assert.throws(()=>f.ui.delta({mailboxId:'box',after:999}),{code:'index_cursor_changed'})
  assert.throws(()=>f.ui.delta({mailboxId:'box',limit:0}),{code:'invalid_cursor'})
  assert.ok(!JSON.stringify(f.store.rows('SELECT data FROM mail_index_changes')).includes('FULL PRIVATE BODY'))
  f.credential.scopes=[]
  assert.throws(()=>f.ui.delta({mailboxId:'box'}),{code:'scope_required'})
  f.storage.close()
})
