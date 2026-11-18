import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareMailCommand,executeMailCommand} from '../src/mail/commands.mjs';
import {mailCapabilities} from '../src/mail/policy.mjs';
import {authorization,validateActions} from '../src/connections/oauth.mjs';
import {MailCommandExecutor} from '../src/mail-executor.mjs';
import {Store} from '../src/store.mjs';
import {createStorage} from './support/storage.mjs';

const google=scope=>'https://www.googleapis.com/auth/gmail.'+scope;
const json=data=>Response.json(data);
function context(provider,fetchImpl,scopes=provider==='gmail'?[google('modify')]:['Mail.ReadWrite']) {
  return {mailboxId:'mailbox-a',credential:{provider,scopes,accessToken:'test-token',
    actions:mailCapabilities({provider,scopes}).filter(c=>c.supported).map(c=>c.action)},
    fetchImpl:fetchImpl || (async()=>{throw Error('Unexpected request');})};
}
const flags=['mark_spam','mark_not_spam','mark_important','mark_unimportant'];

test('new actions keep provider, product grants, OAuth scopes and explicit deletion permission separate',async()=>{
  for (const provider of ['gmail','outlook']) {
    const modify=validateActions(provider,['modify']);
    for (const action of flags) assert.ok(modify.includes(action));
    assert.ok(!modify.includes('delete_draft'));assert.ok(!modify.includes('delete_label'));
    assert.deepEqual(validateActions(provider,['move_to_trash']),['trash']);
    assert.ok(!validateActions(provider,['write']).includes('delete_draft'));
    assert.deepEqual(validateActions(provider,['delete_draft']),['delete_draft']);
    for (const action of ['permanent_delete','delete_folder','spam']) {
      assert.throws(()=>validateActions(provider,[action]),{code:'unsupported_mail_action'});
    }
    const readOnly=context(provider,undefined,provider==='gmail'?[google('readonly')]:['Mail.Read']);
    for (const action of [...flags,'delete_draft']) {
      await assert.rejects(prepareMailCommand({action,messageId:'m',draftId:'d'},readOnly),{code:'scope_required'});
    }
    const trashOnly=context(provider);trashOnly.credential.actions=['trash'];
    await assert.rejects(prepareMailCommand({action:'delete_draft',draftId:'d'},trashOnly),{code:'action_forbidden'});
  }
  assert.deepEqual(validateActions('gmail',['delete_label']),['delete_label']);
  assert.throws(()=>validateActions('outlook',['delete_label']),{code:'unsupported_mail_action'});
  assert.ok(validateActions('outlook',['write']).includes('remove_draft_attachment'));
  assert.ok(!validateActions('gmail',['write']).includes('remove_draft_attachment'));
  const authorized=(provider,scopes,action)=>mailCapabilities({provider,scopes}).find(c=>c.action===action).authorized;
  assert.equal(authorized('gmail',[google('compose')],'delete_draft'),true);
  assert.equal(authorized('gmail',[google('labels')],'delete_label'),true);
  assert.equal(authorized('gmail',[google('compose')],'delete_label'),false);
  assert.equal(authorized('outlook',['https://graph.microsoft.com/Mail.ReadWrite'],'remove_draft_attachment'),true);
  assert.equal(authorized('outlook',['Mail.Send'],'remove_draft_attachment'),false);
  const env={GOOGLE_CLIENT_ID:'g',GOOGLE_CLIENT_SECRET:'secret',OAUTH_REDIRECT_URI:'https://app.example.test/oauth/callback'};
  const scopes=authorization('gmail',env,{actions:['delete_draft'],state:'state',codeChallenge:'challenge'}).scopes;
  assert.ok(scopes.includes(google('compose')));assert.ok(!scopes.includes('https://mail.google.com/'));
});

test('spam and importance map to bounded provider-native message operations',async()=>{
  const cases=[
    ['gmail','mark_spam','POST','/messages/m/modify',{addLabelIds:['SPAM'],removeLabelIds:['INBOX']}],
    ['gmail','mark_not_spam','POST','/messages/m/modify',{addLabelIds:['INBOX'],removeLabelIds:['SPAM']}],
    ['gmail','mark_important','POST','/messages/m/modify',{addLabelIds:['IMPORTANT'],removeLabelIds:[]}],
    ['gmail','mark_unimportant','POST','/messages/m/modify',{addLabelIds:[],removeLabelIds:['IMPORTANT']}],
    ['outlook','mark_spam','POST','/messages/m/move',{destinationId:'junkemail'}],
    ['outlook','mark_not_spam','POST','/messages/m/move',{destinationId:'inbox'}],
    ['outlook','mark_important','PATCH','/messages/m',{importance:'high'}],
    ['outlook','mark_unimportant','PATCH','/messages/m',{importance:'normal'}],
  ];
  for (const [provider,action,method,path,body] of cases) {
    let calls=0;
    const ctx=context(provider,async(url,init)=>{
      calls++;assert.ok(new URL(url).pathname.endsWith(path));assert.equal(init.method,method);
      assert.deepEqual(JSON.parse(init.body),body);assert.equal(init.redirect,'manual');
      return json({id:'m'});
    });
    const prepared=await prepareMailCommand({action,messageId:'m'},ctx);
    assert.equal(prepared.requiresApproval,false);
    assert.equal((await executeMailCommand(prepared,ctx)).status,'succeeded');assert.equal(calls,1);
  }
});

test('new message flags accept expected provider versions and reject stale dispatch',async()=>{
  for (const provider of ['gmail','outlook']) for (const action of flags) {
    let version='v1',writes=0;
    const ctx=context(provider,async(url,init)=>{
      if (init.method==='GET') return json({id:'m',historyId:version,changeKey:version,'@odata.etag':'W/"'+version+'"'});
      writes++;return json({id:'m'});
    });
    ctx.expectedProviderVersion='v1';
    const prepared=await prepareMailCommand({action,messageId:'m'},ctx);
    version='v2';
    assert.deepEqual(await executeMailCommand(prepared,ctx),{status:'failed',code:'version_conflict'});
    assert.equal(writes,0);
  }
});

test('draft deletion binds verified draft identity and version, and uses only draft-safe DELETE targets',async()=>{
  for (const provider of ['gmail','outlook']) {
    let version='v1',isDraft=true,writes=0;
    const ctx=context(provider,async(url,init)=>{
      const path=new URL(url).pathname;
      assert.ok(path.endsWith(provider==='gmail'?'/drafts/d':'/messages/d'));
      if (init.method==='GET') return json(provider==='gmail'
        ? {id:'d',message:{id:version,labelIds:isDraft?['DRAFT']:['SENT']}}
        : {id:'d',isDraft,'@odata.etag':'W/"'+version+'"'});
      writes++;assert.equal(init.method,'DELETE');assert.equal(init.body,undefined);
      if (provider==='outlook') assert.equal(init.headers['If-Match'],'W/"v1"');
      return new Response(null,{status:204});
    });
    const input={action:'delete_draft',draftId:'d'};
    const prepared=await prepareMailCommand(input,ctx);
    assert.equal(prepared.requiresApproval,true);
    assert.equal(prepared.summary.draftId,'d');assert.ok(prepared.summary.providerVersion);
    if (provider==='gmail') assert.equal(prepared.summary.disposition,'permanent_draft_delete');
    version='v2';assert.equal((await executeMailCommand(prepared,ctx)).code,'version_conflict');assert.equal(writes,0);
    version='v1';isDraft=false;
    assert.equal((await executeMailCommand(prepared,ctx)).code,'not_a_draft');assert.equal(writes,0);
    await assert.rejects(prepareMailCommand(input,ctx),{code:'not_a_draft'});
    isDraft=true;
    assert.equal((await executeMailCommand(prepared,ctx)).status,'succeeded');assert.equal(writes,1);
    await assert.rejects(prepareMailCommand({action:'delete_draft',messageId:'m'},ctx),{code:'invalid_input'});
  }
});

test('deleting a Gmail label requires a user label, exact identity and confirmed name',async()=>{
  let label={id:'Label_4',type:'user',name:'Project'},writes=0;
  const ctx=context('gmail',async(url,init)=>{
    assert.ok(new URL(url).pathname.endsWith('/labels/Label_4'));
    if (init.method==='GET') return json(label);
    writes++;assert.equal(init.method,'DELETE');return new Response(null,{status:204});
  },[google('labels')]);
  const input={action:'delete_label',labelId:'Label_4'};
  const prepared=await prepareMailCommand(input,ctx);
  assert.equal(prepared.requiresApproval,true);assert.equal(prepared.summary.name,'Project');
  label={...label,type:'system'};
  await assert.rejects(prepareMailCommand(input,ctx),{code:'invalid_user_label'});
  assert.equal((await executeMailCommand(prepared,ctx)).code,'invalid_user_label');assert.equal(writes,0);
  label={...label,type:'user',id:'another'};
  await assert.rejects(prepareMailCommand(input,ctx),{code:'invalid_user_label'});
  label={...label,id:'Label_4',name:'Changed'};
  assert.equal((await executeMailCommand(prepared,ctx)).code,'version_conflict');assert.equal(writes,0);
  label={...label,name:'Project'};
  assert.equal((await executeMailCommand(prepared,ctx)).status,'succeeded');assert.equal(writes,1);
  await assert.rejects(prepareMailCommand(input,context('outlook')),{code:'unsupported_action'});
});

test('Graph attachment removal requires the existing draft and its exact attachment, with frozen metadata',async()=>{
  let isDraft=true,version='v1',writes=0;
  let attachment={id:'a',name:'Report.pdf',size:100,contentType:'application/pdf',isInline:false,lastModifiedDateTime:'2026-01-01T00:00:00Z'};
  const reads=[];
  const ctx=context('outlook',async(url,init)=>{
    const parsed=new URL(url);
    if (init.method==='GET') {
      reads.push(parsed.pathname);
      if (parsed.pathname.endsWith('/attachments/a')) {
        assert.ok(!parsed.search.includes('contentBytes'));return json(attachment);
      }
      assert.ok(parsed.pathname.endsWith('/messages/d'));return json({id:'d',isDraft,'@odata.etag':'W/"'+version+'"'});
    }
    writes++;assert.equal(init.method,'DELETE');assert.ok(parsed.pathname.endsWith('/messages/d/attachments/a'));
    assert.equal(init.headers['If-Match'],undefined);assert.equal(init.body,undefined);
    // Parent ETag is not a valid attachment ETag. Both resources were rechecked.
    assert.ok(reads.at(-1).endsWith('/messages/d'));
    return new Response(null,{status:204});
  });
  const input={action:'remove_draft_attachment',draftId:'d',attachmentId:'a'};
  const prepared=await prepareMailCommand(input,ctx);
  assert.equal(prepared.requiresApproval,true);assert.equal(prepared.summary.attachment.name,'Report.pdf');
  attachment={...attachment,name:'Changed.pdf'};
  assert.equal((await executeMailCommand(prepared,ctx)).code,'version_conflict');assert.equal(writes,0);
  attachment={...attachment,name:'Report.pdf'};version='v2';
  assert.equal((await executeMailCommand(prepared,ctx)).code,'version_conflict');assert.equal(writes,0);
  version='v1';isDraft=false;
  assert.equal((await executeMailCommand(prepared,ctx)).code,'not_a_draft');assert.equal(writes,0);
  const before=reads.length;
  await assert.rejects(prepareMailCommand(input,ctx),{code:'not_a_draft'});
  assert.equal(reads.length,before+1);
  isDraft=true;attachment={...attachment,id:'other'};
  await assert.rejects(prepareMailCommand(input,ctx),{code:'attachment_mismatch'});
  attachment={...attachment,id:'a'};
  assert.equal((await executeMailCommand(prepared,ctx)).status,'succeeded');assert.equal(writes,1);
  await assert.rejects(prepareMailCommand(input,context('gmail')),{code:'unsupported_action'});
});

test('destructive draft actions recheck grants and never retry an ambiguous deletion',async()=>{
  let writes=0;
  const ctx=context('outlook',async(url,init)=>{
    if (init.method==='GET') return json({id:'d',isDraft:true,'@odata.etag':'W/"v1"'});
    writes++;return new Response(null,{status:500});
  });
  const prepared=await prepareMailCommand({action:'delete_draft',draftId:'d'},ctx);
  const revoked={...ctx,credential:{...ctx.credential,actions:['trash']}};
  assert.equal((await executeMailCommand(prepared,revoked)).code,'action_forbidden');assert.equal(writes,0);
  assert.deepEqual(await executeMailCommand(prepared,ctx),{status:'unknown',code:'submission_unknown',httpStatus:500});
  assert.equal(writes,1);
});

test('the operation ledger freezes destructive targets, requires approval and serializes draft revisions',async()=>{
  const storage=createStorage(),store=new Store(storage);
  try {
    let writes=0;
    const ctx=context('outlook',async(url,init)=>{
      assert.ok(new URL(url).pathname.endsWith('/messages/d'));
      if (init.method==='GET') return json({id:'d',isDraft:true,'@odata.etag':'W/"v1"'});
      writes++;return new Response(null,{status:204});
    });
    const record={id:'mailbox-a',kind:'mail',status:'active',epoch:1,...ctx.credential};
    const connections={get:id=>id===record.id?record:null,assertEpoch(id,epoch){assert.equal(id,record.id);assert.equal(epoch,record.epoch);},
      async credential(){return 'test-token';}};
    const executor=new MailCommandExecutor(store,connections,{
      prepare:(input,credentials)=>prepareMailCommand(input,{...credentials,fetchImpl:ctx.fetchImpl}),
      execute:(prepared,credentials)=>executeMailCommand(prepared,{...credentials,fetchImpl:ctx.fetchImpl}),
    });
    const input={action:'delete_draft',draftId:'d'};
    const plan=await executor.plan(input,{mailboxId:'mailbox-a',expectedRevision:0});
    const second=await executor.plan(input,{mailboxId:'mailbox-a',expectedRevision:0});
    input.draftId='a-different-message';
    executor.accept(plan,{id:'first',commandId:'one'});
    executor.accept(second,{id:'second',commandId:'two'});
    assert.equal(store.getOp('first').prepared.summary.draftId,'d');
    await executor.run('first');assert.equal(writes,0);
    executor.decide('first',1,true);executor.decide('second',1,true);
    await Promise.all([executor.run('first'),executor.run('first')]);
    assert.equal(writes,1);assert.equal(store.getOp('first').revision,1);
    assert.equal(store.getOp('first').prepared.payload,undefined);
    await executor.run('second');
    assert.equal(store.getOp('second').receipt.code,'stale_mail_revision');assert.equal(writes,1);
    assert.throws(()=>executor.decide('first',1,true),{code:'stale_version'});
  } finally {storage.close();}
});
