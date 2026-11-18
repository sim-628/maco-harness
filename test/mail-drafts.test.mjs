import test from 'node:test';
import assert from 'node:assert/strict';
import {readMailTool,mailToolsFor} from '../src/mail/index.mjs';
import {MailIndexService} from '../src/mail-index/index.mjs';
import {Store} from '../src/store.mjs';
import {createStorage} from './support/storage.mjs';

const json=data=>Response.json(data);
const ctx=(provider,fetchImpl)=>({mailboxId:'mailbox-a',credential:{provider,accessToken:'test-token',
  scopes:provider==='gmail'?['https://www.googleapis.com/auth/gmail.readonly']:['Mail.Read'],actions:[]},fetchImpl});
const gmailDraft=(draftId,messageId)=>({id:draftId,message:{id:messageId,threadId:'thread',historyId:'v1',
  labelIds:['DRAFT'],snippet:'A short preview',internalDate:'1770000000000',
  payload:{headers:[{name:'Subject',value:'Draft subject'},{name:'To',value:'recipient@example.test'}],body:{data:btoa('private full body')}}}});
const graphDraft=id=>({id,isDraft:true,changeKey:'v1',subject:'Draft subject',bodyPreview:'A short preview',
  body:{content:'private full body',contentType:'text'},toRecipients:[{emailAddress:{address:'recipient@example.test'}}]});

test('Gmail draft listing returns independently verified draft and message IDs with metadata only',async()=>{
  const calls=[];
  const context=ctx('gmail',async(url,init)=>{
    const u=new URL(url);calls.push(u);assert.equal(init.method,'GET');assert.equal(init.redirect,'manual');
    if (u.pathname.endsWith('/drafts')) {
      assert.equal(u.searchParams.get('maxResults'),'2');assert.equal(u.searchParams.get('pageToken'),'opaque-token');
      return json({drafts:[{id:'draft-stable',message:{id:'old-message-id'}}],nextPageToken:'next-token'});
    }
    assert.ok(u.pathname.endsWith('/drafts/draft-stable'));assert.equal(u.searchParams.get('format'),'metadata');
    assert.ok(!u.searchParams.get('fields').includes('body'));
    // Replacing a Gmail draft changes its message ID while draft ID stays stable.
    return json(gmailDraft('draft-stable','new-message-id'));
  });
  const result=await readMailTool('mail_list_drafts',{limit:2,cursor:'gmail-drafts:opaque-token'},context);
  assert.equal(calls.length,2);assert.equal(result.matches.length,1);
  assert.equal(result.matches[0].draftId,'draft-stable');assert.equal(result.matches[0].citation.messageId,'new-message-id');
  assert.notEqual(result.matches[0].draftId,result.matches[0].citation.messageId);
  assert.equal(result.matches[0].subject,'Draft subject');assert.equal(result.matches[0].isDraft,true);
  assert.ok(!JSON.stringify(result).includes('private full body'));assert.ok(!('body' in result.matches[0]));
  assert.equal(result.nextCursor,'gmail-drafts:next-token');assert.equal(result.unavailable,0);
});

test('Gmail draft listing enforces eight-item page bounds and reports drafts removed during the read',async()=>{
  let detailCalls=0;
  const context=ctx('gmail',async url=>{
    const u=new URL(url);
    if (u.pathname.endsWith('/drafts')) {
      assert.equal(u.searchParams.get('maxResults'),'8');
      return json({drafts:Array.from({length:8},(_,i)=>({id:'d'+i})),nextPageToken:'more'});
    }
    detailCalls++;const id=u.pathname.split('/').at(-1);
    return id==='d0'?new Response(null,{status:404}):json(gmailDraft(id,'m'+id));
  });
  const result=await readMailTool('mail_list_drafts',{},context);
  assert.equal(detailCalls,8);assert.equal(result.matches.length,7);assert.equal(result.unavailable,1);
  assert.equal(result.nextCursor,'gmail-drafts:more');
  for(const input of [{limit:9},{limit:0},{query:'body search'},{cursor:'https://evil.test/drafts'}, {cursor:'graph-drafts:$skip=2'}]) {
    await assert.rejects(readMailTool('mail_list_drafts',input,ctx('gmail',()=>{assert.fail('invalid input reached provider');})));
  }
  const oversized=ctx('gmail',async()=>json({drafts:Array.from({length:9},(_,i)=>({id:'d'+i}))}));
  await assert.rejects(readMailTool('mail_list_drafts',{},oversized),{code:'invalid_provider_response'});
});

test('Gmail listing refuses mismatched or non-draft resources and malformed page tokens',async()=>{
  for (const draft of [gmailDraft('wrong','m'),{id:'d',message:{id:'m',labelIds:['SENT']}}]) {
    const context=ctx('gmail',async url=>new URL(url).pathname.endsWith('/drafts')?json({drafts:[{id:'d'}]}):json(draft));
    await assert.rejects(readMailTool('mail_list_drafts',{},context),{code:'invalid_provider_response'});
  }
  for (const token of [42,'bad\nvalue','x'.repeat(4096)]) {
    const context=ctx('gmail',async()=>json({drafts:[],nextPageToken:token}));
    await assert.rejects(readMailTool('mail_list_drafts',{},context),{code:'invalid_provider_response'});
  }
});

test('Outlook listing uses the drafts folder, immutable IDs, fixed metadata and encoded continuation only',async()=>{
  const context=ctx('outlook',async(url,init)=>{
    const u=new URL(url);assert.equal(u.origin,'https://graph.microsoft.com');
    assert.equal(u.pathname,'/v1.0/me/mailFolders/drafts/messages');
    assert.equal(u.searchParams.get('$top'),'3');assert.equal(u.searchParams.get('$filter'),'isDraft eq true');
    assert.equal(u.searchParams.get('$skiptoken'),'opaque&$select=body');
    assert.ok(!u.searchParams.get('$select').split(',').includes('body'));
    assert.ok(init.headers.Prefer.includes('ImmutableId'));
    return json({value:[graphDraft('native-draft-message')],
      '@odata.nextLink':'https://graph.microsoft.com/v1.0/me/mailFolders/drafts/messages?$top=3&$skip=4'});
  });
  const result=await readMailTool('mail_list_drafts',{limit:3,cursor:'graph-drafts:$skiptoken=opaque&$select=body'},context);
  assert.equal(result.matches[0].draftId,'native-draft-message');
  assert.equal(result.matches[0].citation.messageId,'native-draft-message');
  assert.ok(!('body' in result.matches[0]));assert.equal(result.nextCursor,'graph-drafts:$skip=4');
});

test('Outlook rejects untrusted continuation origins, different resources and malformed tokens',async()=>{
  const path='https://graph.microsoft.com/v1.0/me/mailFolders/drafts/messages';
  for (const nextLink of [
    'https://evil.test/v1.0/me/mailFolders/drafts/messages?$skip=8',
    'https://graph.microsoft.com/v1.0/me/messages?$skip=8',
    'https://user:pass@graph.microsoft.com/v1.0/me/mailFolders/drafts/messages?$skip=8',
    path+'?$skip=8#fragment',path+'?$skip=8&$skip=9',path+'?$skip=8&$skiptoken=9',
    path+'?$skip=-1',path+'?$skiptoken=',path+'?$skiptoken=bad%0Avalue',
  ]) {
    let calls=0;
    const context=ctx('outlook',async()=>{calls++;return json({value:[], '@odata.nextLink':nextLink});});
    await assert.rejects(readMailTool('mail_list_drafts',{},context),{code:'invalid_provider_response'});
    assert.equal(calls,1);
  }
  await assert.rejects(readMailTool('mail_list_drafts',{cursor:'graph-drafts:$skip=bad'},ctx('outlook',()=>assert.fail('no request expected'))),{code:'invalid_cursor'});
  await assert.rejects(readMailTool('mail_list_drafts',{},ctx('outlook',async()=>json({value:[{...graphDraft('m'),isDraft:false}]}))),{code:'invalid_provider_response'});
});

test('the index normalizes message citations while preserving provider draft IDs and mailbox isolation',async()=>{
  const storage=createStorage(),index=new MailIndexService(new Store(storage));
  try {
    const context=ctx('gmail',async url=>new URL(url).pathname.endsWith('/drafts')?json({drafts:[{id:'draft-1'}]}):json(gmailDraft('draft-1','message-9')));
    const result=await index.read('mail_list_drafts',{},context);
    const item=result.matches[0];
    assert.match(item.citation.messageId,/^mail_/);assert.equal(item.draftId,'draft-1');
    assert.equal(index.resolveInput('mailbox-a',{draftId:item.draftId}).draftId,'draft-1');
    assert.equal(index.resolveInput('mailbox-a',{messageId:item.citation.messageId}).messageId,'message-9');
    assert.throws(()=>index.resolveInput('another-mailbox',{messageId:item.citation.messageId}),{code:'message_not_found'});
    assert.ok(!JSON.stringify(index.store.rows('SELECT data FROM mail_index')).includes('private full body'));
  } finally {storage.close();}
});

test('draft listing remains a read capability and schema exposes the attachment removal identifier',async()=>{
  for(const provider of ['gmail','outlook']) {
    const context=ctx(provider);
    assert.ok(mailToolsFor(context.credential).some(t=>t.name==='mail_list_drafts'));
    const unscoped={...context,credential:{...context.credential,scopes:[]}};
    assert.ok(!mailToolsFor(unscoped.credential).some(t=>t.name==='mail_list_drafts'));
    await assert.rejects(readMailTool('mail_list_drafts',{},unscoped),{code:'scope_required'});
  }
  const writer=mailToolsFor({provider:'outlook',scopes:['Mail.ReadWrite'],actions:['remove_draft_attachment']}).find(t=>t.name==='mail_write');
  assert.equal(writer.inputSchema.properties.attachmentId.type,'string');
});
