import assert from 'node:assert/strict';
import test from 'node:test';
import {Store} from '../src/store.mjs';
import {MailIndexService} from '../src/mail-index/index.mjs';
import {createStorage} from './support/storage.mjs';

const now=Date.parse('2026-11-18T12:00:00Z');
const after='2026-11-01T00:00:00Z';
const ctx=(provider='gmail',mailboxId='box',fetchImpl)=>({mailboxId,credential:{provider,accessToken:'test-only',scopes:provider==='gmail'?['https://www.googleapis.com/auth/gmail.modify']:['Mail.ReadWrite'],actions:[]},fetchImpl});
const view=(id,fields={})=>({citation:{mailboxId:'box',messageId:id},subject:'Receipt',from:'person@example.com',date:'2026-11-17T10:00:00Z',preview:'An invoice',version:'version',isRead:false,...fields});
const fixture=()=>{const storage=createStorage(),store=new Store(storage);let time=now;return {storage,store,index:new MailIndexService(store,{now:()=>time}),setTime:value=>{time=value;}};};
function ready(index,mailbox='box') {
  index.startSync(mailbox,'gmail',{after});
  const state=index.index.syncState(mailbox);
  Object.assign(state,{phase:'idle',complete:true,syncedAt:now,due:now+300000});
  index.index.saveSync(state);
}
const json=value=>Response.json(value);
const gmail=(id,fields={})=>({id,threadId:'thread',historyId:'9007199254740991001',internalDate:String(now-1000),labelIds:['INBOX','UNREAD'],snippet:'A preview',payload:{headers:[{name:'Subject',value:'Subject '+id},{name:'From',value:'sender@example.com'}]},...fields});

test('a rejected read commit rolls back its index row and FTS projection together',async()=>{
  const f=fixture();ready(f.index);
  const context={...ctx(),commitResult(){throw Object.assign(new Error(),{code:'stale_mail_revision'});}};
  await assert.rejects(f.index.read('mail_read',{messageId:'raw'},context,async()=>view('raw')),{code:'stale_mail_revision'});
  assert.equal(f.index.index.lookup('box','raw'),undefined);
  const result=await f.index.read('mail_search',{scope:'metadata',query:'invoice',filters:{after}},ctx(),()=>{throw Error('provider must not be called');});
  assert.deepEqual(result.matches,[]);
  f.storage.close();
});

async function drain(index,context,max=60) {
  for(let i=0;i<max;i++) {
    await index.syncNext(context);
    if(index.syncState(context.mailboxId).phase==='idle')return;
  }
  assert.fail('bounded sync did not reach idle');
}

test('stable IDs survive service reconstruction; provider ID case and mailbox identity remain distinct',async()=>{
  const f=fixture();
  const a=f.index.index.remember('box','outlook',view('CaseID',{body:'FULL PRIVATE BODY',bodyType:'text',truncated:false}),{now});
  const same=f.index.index.remember('box','outlook',view('CaseID'),{now});
  const lower=f.index.index.remember('box','outlook',view('caseid'),{now});
  const other=f.index.index.remember('other','outlook',view('CaseID'),{now});
  assert.equal(a.mailMessageId,same.mailMessageId);
  assert.notEqual(a.mailMessageId,lower.mailMessageId);
  assert.notEqual(a.mailMessageId,other.mailMessageId);
  const reloaded=new MailIndexService(f.store);
  assert.equal(reloaded.resolveInput('box',{messageId:a.mailMessageId}).messageId,'CaseID');
  assert.throws(()=>reloaded.resolveInput('other',{messageId:a.mailMessageId}),{code:'message_not_found'});
  assert.ok(!JSON.stringify(f.store.rows('SELECT * FROM mail_index')).includes('FULL PRIVATE BODY'));
  assert.equal(a.contentCoverage,'snippet');
  f.storage.close();
});

test('metadata can use the index; fulltext and uncovered historical queries still use provider search even with local hits',async()=>{
  const f=fixture();ready(f.index);
  f.index.index.remember('box','gmail',view('id'),{now});
  let calls=0;
  const read=async(name,input)=>{calls++;assert.equal(input.scope,undefined);return {matches:[view('id')],nextCursor:null};};
  const query={scope:'metadata',query:'invoice',filters:{after}};
  const local=await f.index.read('mail_search',query,ctx(),read);
  assert.equal(calls,0);assert.equal(local.matches.length,1);assert.equal(local.coverage.bodySearchCoverage,'snippet_only');
  const full=await f.index.read('mail_search',{...query,scope:'fulltext'},ctx(),read);
  assert.equal(calls,1);assert.equal(full.coverage.fullTextSearched,true);
  await f.index.read('mail_search',{...query,filters:{after:'2020-01-01'}},ctx(),read);
  assert.equal(calls,2);
  await f.index.read('mail_search',{...query,filters:{}},ctx(),read);
  assert.equal(calls,3);
  f.storage.close();
});

test('Chinese two-character searches and versioned paging work without treating snippets as full bodies',async()=>{
  const f=fixture();ready(f.index);
  for(let i=0;i<10;i++)f.index.index.remember('box','gmail',view('id'+i,{subject:'本月报销通知',preview:'附件是发票'}),{now});
  const query={scope:'metadata',query:'发票',filters:{after},limit:3};
  const first=await f.index.read('mail_search',query,ctx(),()=>{throw Error('must use index');});
  assert.equal(first.matches.length,3);assert.ok(first.nextCursor);
  const second=await f.index.read('mail_search',{...query,cursor:first.nextCursor},ctx());
  assert.ok(second.matches.every(item=>!first.matches.some(a=>a.mailMessageId===item.mailMessageId)));
  f.index.index.remember('box','gmail',view('new',{preview:'发票'}),{now});
  await assert.rejects(f.index.read('mail_search',{...query,cursor:first.nextCursor},ctx()),{code:'index_cursor_changed'});
  assert.ok(first.matches.every(item=>!('body' in item)&&item.contentCoverage==='snippet'));
  f.storage.close();
});

test('canonical IDs resolve for reads, writes and attachments, with mailbox checks and distinct draft IDs',async()=>{
  const f=fixture();
  const message=f.index.index.remember('box','gmail',view('raw'),{now});
  const read=await f.index.read('mail_read',{messageId:message.mailMessageId},ctx(),async(name,input)=>{
    assert.equal(input.messageId,'raw');return view('raw',{body:'Full text',truncated:false});
  });
  assert.equal(read.citation.messageId,message.mailMessageId);assert.equal(read.contentCoverage,'body');
  const command=f.index.resolveInput('box',{messageId:message.mailMessageId,attachments:[{mailboxId:'box',messageId:message.mailMessageId,attachmentId:'a'}]});
  assert.equal(command.messageId,'raw');assert.equal(command.attachments[0].messageId,'raw');
  assert.throws(()=>f.index.resolveInput('box',{ref:{mailboxId:'other',messageId:message.mailMessageId}}),{code:'mailbox_mismatch'});
  assert.throws(()=>f.index.resolveInput('box',{draftId:message.mailMessageId}),{code:'draft_id_required'});
  f.storage.close();
});

test('a late read does not overwrite the index after a mailbox mutation invalidates it',async()=>{
  const f=fixture();
  f.index.index.remember('box','gmail',view('raw',{subject:'Initial'}),{now});
  let release;
  const pending=f.index.read('mail_read',{messageId:'raw'},ctx(),()=>new Promise(resolve=>{release=resolve;}));
  f.index.invalidate('box');
  f.index.index.remember('box','gmail',view('raw',{subject:'Updated'}),{now});
  release(view('raw',{subject:'Old reply',body:'old'}));
  await pending;
  assert.equal(f.index.index.lookup('box','raw').subject,'Updated');
  f.storage.close();
});

test('Gmail bootstrap persists its cursor, catches up history and uses only metadata',async()=>{
  const f=fixture();f.index.startSync('box','gmail',{after});
  const calls=[];
  const context=ctx('gmail','box',async url=>{
    const u=new URL(url);calls.push(u);
    if(u.pathname.endsWith('/profile'))return json({historyId:'9007199254740991001'});
    if(u.pathname.endsWith('/history')) {
      assert.equal(u.searchParams.get('startHistoryId'),'9007199254740991001');
      return json({historyId:'9007199254740991009',history:[{messages:[{id:'new'}]}]});
    }
    if(u.pathname.endsWith('/messages'))return json({messages:[{id:'first'}]});
    assert.equal(u.searchParams.get('format'),'metadata');return json(gmail(u.pathname.split('/').at(-1)));
  });
  await f.index.syncNext(context);
  assert.equal(f.index.index.syncState('box').historyId,'9007199254740991001');
  const reconstructed=new MailIndexService(f.store,{now:()=>now});
  await drain(reconstructed,context);
  assert.equal(reconstructed.syncState('box').complete,true);
  assert.equal(reconstructed.index.syncState('box').historyId,'9007199254740991009');
  assert.equal(f.store.one('SELECT COUNT(*) AS n FROM mail_index').n,2);
  assert.ok(calls.every(u=>u.searchParams.get('format')!=='full'));
  f.storage.close();
});

test('expired Gmail history rebuilds coverage and sweeps deleted records without changing live canonical IDs',async()=>{
  const f=fixture();f.index.startSync('box','gmail',{after});
  let expired=false,rebuilt=false;
  const context=ctx('gmail','box',async url=>{
    const u=new URL(url),id=u.pathname.split('/').at(-1);
    if(id==='profile'){if(expired)rebuilt=true;return json({historyId:rebuilt?'h2':'h1'});}
    if(id==='history') {
      if(expired&&!rebuilt)return new Response(null,{status:404});
      return json({historyId:rebuilt?'h3':'h1'});
    }
    if(id==='messages')return json({messages:rebuilt?[{id:'live'}]:[{id:'live'},{id:'gone'}]});
    if(id==='gone'&&rebuilt)return new Response(null,{status:404});
    return json(gmail(id));
  });
  await drain(f.index,context);
  const live=f.index.index.lookup('box','live').id,gone=f.index.index.lookup('box','gone').id;
  expired=true;f.setTime(now+600000);
  await f.index.syncNext(context);
  assert.equal(f.index.syncState('box').complete,false);
  await drain(f.index,context);
  assert.equal(f.index.index.lookup('box','live').id,live);
  assert.throws(()=>f.index.resolveInput('box',{messageId:gone}),{code:'message_deleted'});
  f.storage.close();
});

test('Graph delta moves preserve canonical identity and removal from one folder is not permanent deletion',async()=>{
  const f=fixture();f.index.startSync('box','outlook',{after});
  let moved=false;
  const context=ctx('outlook','box',async(url,init)=>{
    const u=new URL(url),path=u.pathname;
    assert.match(init.headers.Prefer,/ImmutableId/);
    if(path.endsWith('/mailFolders'))return json({value:[{id:'inbox',childFolderCount:0},{id:'sent',childFolderCount:0}]});
    if(path.endsWith('/messages/delta')) {
      const folder=path.split('/').at(-3);
      assert.equal(u.searchParams.has('$filter'),false);
      const value=folder==='inbox'?[{id:'CaseID',...(moved?{'@removed':{reason:'deleted'}}:{})}]:(moved?[{id:'CaseID'}]:[]);
      return json({value,'@odata.deltaLink':'https://graph.microsoft.com'+path+'?$deltatoken='+ (moved?'two':'one')});
    }
    return json({id:'CaseID',subject:'Subject',from:{emailAddress:{address:'sender@example.com'}},receivedDateTime:new Date(now-1000).toISOString(),parentFolderId:moved?'sent':'inbox',changeKey:moved?'v2':'v1',bodyPreview:'Preview'});
  });
  await drain(f.index,context);
  const first=f.index.index.lookup('box','CaseID').id;
  moved=true;f.setTime(now+600000);
  await drain(f.index,context);
  const row=f.index.index.lookup('box',first);
  assert.equal(row.folder,'sent');assert.equal(row.deleted,0);
  assert.equal(f.store.one('SELECT COUNT(*) AS n FROM mail_index').n,1);
  f.storage.close();
});

test('provider continuation URLs are origin/path checked and sync credentials failures back off durably',async()=>{
  const f=fixture();f.index.startSync('box','outlook',{after});
  let calls=0;
  const context=ctx('outlook','box',async()=>{calls++;return json({value:[],'@odata.nextLink':'https://evil.example/collect?$skiptoken=private'});});
  await assert.rejects(f.index.syncNext(context),{code:'invalid_provider_response'});
  assert.equal(calls,1);assert.ok(f.index.nextDue()>now);
  const status=f.index.deferSync('box',{code:'connection_revoked'});
  assert.equal(status.nextSyncAt,Number.MAX_SAFE_INTEGER);
  f.index.startSync('box','outlook',{after});
  const paused=f.index.deferSync('box',{code:'connection_revoked'});
  assert.equal(paused.nextSyncAt,Number.MAX_SAFE_INTEGER);
  assert.equal(f.index.dueMailboxes(now).length,0);
  f.storage.close();
});


test('Graph continuations preserve encoded immutable folder IDs without accepting another mailbox path',async()=>{
  const f=fixture();f.index.startSync('box','outlook',{after});
  const folder='AA+id=';
  const context=ctx('outlook','box',async url=>{
    const u=new URL(url);
    if(u.pathname.endsWith('/mailFolders'))return json({value:[{id:folder,childFolderCount:0}]});
    assert.match(decodeURIComponent(u.pathname),/AA\+id=/);
    return json({value:[],'@odata.deltaLink':'https://graph.microsoft.com/v1.0/me/mailFolders/'+encodeURIComponent(folder)+'/messages/delta?$deltatoken=token'});
  });
  await drain(f.index,context);
  assert.equal(f.index.syncState('box').complete,true);
  f.storage.close();
});
