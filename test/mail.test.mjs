import test from 'node:test';
import assert from 'node:assert/strict';
import {executeMailCommand,mailCapabilities,mailToolsFor,prepareMailCommand,readMailTool} from '../src/mail/index.mjs';

const gmailModify='https://www.googleapis.com/auth/gmail.modify';
const makeContext=(provider,scopes,fetchImpl=async()=>{throw Error('unexpected network call');})=>({mailboxId:'mailbox-a',credential:{provider,scopes,actions:mailCapabilities({provider,scopes}).filter(cap=>cap.supported).map(cap=>cap.action),accessToken:'test-token'},fetchImpl});
const json=data=>Response.json(data);

test('provider capabilities, grants and actual scopes intersect at planning and dispatch',async()=>{
  const g=makeContext('gmail',[gmailModify]);
  const outlook=makeContext('outlook',['https://graph.microsoft.com/Mail.ReadWrite']);
  const actions=cred=>mailCapabilities(cred).filter(c=>c.authorized).map(c=>c.action);
  assert.ok(actions(g.credential).includes('add_label'));
  assert.ok(!actions(outlook.credential).includes('add_label'));
  assert.ok(actions(outlook.credential).includes('set_categories'));
  assert.ok(!actions(outlook.credential).includes('send'));
  for(const credential of [g.credential,outlook.credential]){
    assert.ok(mailCapabilities(credential).filter(c=>c.action.includes('delete')).every(c=>['delete_draft','delete_label'].includes(c.action)));
    await assert.rejects(prepareMailCommand({action:'permanent_delete',messageId:'a'},{...g,credential}),{code:'unsupported_action'});
  }
  await assert.rejects(prepareMailCommand({action:'send',to:['a@b.test']},outlook),{code:'scope_required'});
  const readOnly={...g.credential,actions:[]};
  const missingGrant={...g.credential,actions:undefined};
  assert.ok(!mailToolsFor(missingGrant).some(t=>t.name==='mail_write'));
  assert.ok(!mailToolsFor(readOnly).some(t=>t.name==='mail_write'));
  const frozen=await prepareMailCommand({action:'mark_read',messageId:'m'},g);
  assert.equal((await executeMailCommand(frozen,{...g,credential:readOnly})).code,'action_forbidden');
  assert.equal((await executeMailCommand(frozen,{...g,mailboxId:'mailbox-b'})).code,'mailbox_mismatch');
});

test('legacy read state and trash mappings retain provider identifiers and dispositions',async()=>{
  for (const [provider,action,method,path,body] of [
    ['gmail','mark_read','POST','/messages/m/modify',{addLabelIds:[],removeLabelIds:['UNREAD']}],
    ['gmail','trash','POST','/messages/m/trash',undefined],
    ['gmail','restore','POST','/messages/m/untrash',undefined],
    ['outlook','star','PATCH','/messages/m',{flag:{flagStatus:'flagged'}}],
    ['outlook','trash','POST','/messages/m/move',{destinationId:'deleteditems'}],
    ['outlook','restore','POST','/messages/m/move',{destinationId:'inbox'}],
  ]) {
    const seen=[];
    const ctx=makeContext(provider,[gmailModify,'Mail.ReadWrite'],async(url,init)=>{
      seen.push(new URL(url).pathname);
      assert.ok(seen[0].endsWith(path));assert.equal(init.method,method);
      assert.deepEqual(init.body ? JSON.parse(init.body) : undefined,body);
      assert.equal(init.redirect,'manual');
      return json({id:'immutable-new'});
    });
    const prepared=await prepareMailCommand({action,messageId:'m'},ctx);
    const result=await executeMailCommand(prepared,ctx);
    assert.equal(result.status,'succeeded');assert.equal(result.providerId,'immutable-new');assert.equal(seen.length,1);
  }
});

test('organization grant cannot trash via system labels or alternate Outlook folder IDs',async()=>{
  const gmail=makeContext('gmail',[gmailModify],async()=>json({id:'TRASH',type:'system'}));
  await assert.rejects(prepareMailCommand({action:'add_label',messageId:'m',labelId:'TRASH'},gmail),{code:'invalid_user_label'});
  let movedToTrash=false;
  const fixtures={msgfolderroot:{id:'root'},deleteditems:{id:'trash'},junkemail:{id:'junk'},project:{id:'project',isHidden:false,parentFolderId:'root'},trash:{id:'trash',parentFolderId:'root',isHidden:false}};
  const outlook=makeContext('outlook',['Mail.ReadWrite'],async(url,init)=>{
    assert.equal(init.method,'GET');
    const id=new URL(url).pathname.split('/').pop();
    if (id==='project' && movedToTrash) return json({...fixtures.project,parentFolderId:'trash'});
    return json(fixtures[id]);
  });
  await assert.rejects(prepareMailCommand({action:'move',messageId:'m',folderId:'deleteditems'},outlook),{code:'unsafe_folder'});
  await assert.rejects(prepareMailCommand({action:'restore',messageId:'m',folderId:'trash'},outlook),{code:'unsafe_folder'});
  const prepared=await prepareMailCommand({action:'move',messageId:'m',folderId:'project'},outlook);
  movedToTrash=true;
  assert.deepEqual(await executeMailCommand(prepared,outlook),{status:'failed',code:'unsafe_folder'});
});

const gmailMessage = () => ({id:'src',historyId:'v1',threadId:'t',snippet:'Hello',payload:{headers:[
  {name:'From',value:'Sender <sender@example.com>'},{name:'Subject',value:'Hello'},{name:'Message-ID',value:'<original@example.com>'}],
  parts:[{mimeType:'text/plain',body:{size:5,data:btoa('hello')}},{mimeType:'text/plain',filename:'report.txt',partId:'1',body:{size:5,attachmentId:'f'}}]}});
test('original attachment reads verify metadata and send uses only approved frozen bytes',async()=>{
  let bytes='first';
  const reads=[],writes=[];
  const ctx=makeContext('gmail',[gmailModify],async(url,init)=>{
    const path=new URL(url).pathname;
    if(init.method==='POST'){writes.push(JSON.parse(init.body));return json({id:'accepted'});}
    reads.push(path);
    if (path.endsWith('/profile')) return json({emailAddress:'owner@example.com'});
    return path.endsWith('/attachments/f') ? json({data:btoa(bytes)}) : json(gmailMessage());
  });
  const {attachments:[ref]}=await readMailTool('mail_list_attachments',{messageId:'src'},ctx);
  const view=await readMailTool('mail_read_attachment',{ref},ctx);
  assert.equal(view.text,'first');assert.equal(view.sha256.length,64);
  await assert.rejects(readMailTool('mail_read_attachment',{ref:{...ref,mailboxId:'another'}},ctx),{code:'mailbox_mismatch'});
  await assert.rejects(readMailTool('mail_read_attachment',{ref:{...ref,version:'old'}},ctx),{code:'version_conflict'});
  const input={action:'reply',messageId:'src',cc:['cc@example.com'],bcc:['bcc@example.com'],subject:'Re: Hello',body:'Approved reply',attachments:[ref]};
  const prepared=await prepareMailCommand(input,ctx);
  assert.equal(prepared.requiresApproval,true);assert.equal(prepared.summary.attachments[0].sha256,view.sha256);
  assert.deepEqual(prepared.summary.to,['sender@example.com']);assert.deepEqual(prepared.summary.bcc,input.bcc);
  assert.equal(prepared.summary.body,'Approved reply');assert.ok(!JSON.stringify(prepared.summary).includes(btoa(bytes)));
  const before=reads.length; bytes='later';input.cc.push('extra@example.com');
  assert.equal((await executeMailCommand(JSON.parse(JSON.stringify(prepared)),ctx)).accepted,true);
  assert.equal(reads.length,before);assert.equal(writes.length,1);
  const mime=Buffer.from(writes[0].raw,'base64url').toString();
  assert.match(mime,/From: owner@example.com/);assert.match(mime,/In-Reply-To: <original@example.com>/);assert.ok(mime.includes(btoa('first')));assert.ok(!mime.includes(btoa('later')));
  assert.ok(!mime.includes('extra@example.com'));assert.equal(writes[0].threadId,'t');
});

test('attachment type and size checks precede download and header input cannot inject a recipient',async()=>{
  const source=gmailMessage();
  const ctx=makeContext('gmail',[gmailModify],async(url)=>{
    assert.ok(!url.includes('/attachments/'));return json(source);
  });
  const ref={mailboxId:'mailbox-a',messageId:'src',attachmentId:'f',mimeType:'text/plain',size:5};
  source.payload.parts[1].mimeType='application/octet-stream';
  await assert.rejects(readMailTool('mail_read_attachment',{ref},ctx),{code:'unsupported_attachment_type'});
  source.payload.parts[1].body.size=512*1024+1;
  await assert.rejects(prepareMailCommand({action:'send',to:['a@b.test'],body:'f',attachments:[ref]},ctx),{code:'content_too_large'});
  await assert.rejects(prepareMailCommand({action:'send',to:['a@b.test'],subject:'x\r\nBcc: b@b.test'},ctx),{code:'invalid_input'});
  await assert.rejects(prepareMailCommand({action:'mark_read',messageId:'..'},ctx),{code:'invalid_input'});
});

test('ambiguous writes are never retried and Graph 202 means provider acceptance',async()=>{
  for (const [code,expected] of [[500,'unknown'],[408,'unknown'],[0,'unknown'],[429,'failed'],[401,'failed'],[202,'succeeded']]){
    let calls=0;
    const ctx=makeContext('outlook',['Mail.Send'],async(url,init)=>{
      calls++;assert.ok(url.endsWith('/me/sendMail'));assert.equal(JSON.parse(init.body).message.body.content,'正文');
      if(!code) throw Error('connection dropped');
      return new Response(null,{status:code});
    });
    const prepared=await prepareMailCommand({action:'send',to:['a@b.test'],body:'正文',subject:'hello'},ctx);
    const receipt=await executeMailCommand(prepared,ctx);
    assert.equal(receipt.status,expected);assert.equal(calls,1);
    if(code===202) assert.deepEqual(receipt,{status:'succeeded',httpStatus:202,accepted:true});
  }
});

test('Graph draft update asserts immutable identity, draft state, and ETag at dispatch',async()=>{
  let etag='W/"v1"', isDraft=true, writes=0;
  const ctx=makeContext('outlook',['Mail.ReadWrite'],async(url,init)=>{
    if (init.method==='GET') return json({id:'m',isDraft,'@odata.etag':etag});
    writes++;assert.equal(init.headers['If-Match'],etag);return json({id:'m'});
  });
  const input={action:'update_draft',draftId:'m',subject:'Review',body:'Changed'};
  const prepared=await prepareMailCommand(input,ctx);
  etag='W/"v2"';
  assert.equal((await executeMailCommand(prepared,ctx)).code,'version_conflict');assert.equal(writes,0);
  isDraft=false;
  await assert.rejects(prepareMailCommand(input,ctx),{code:'not_a_draft'});
  isDraft=true;
  assert.equal((await executeMailCommand(await prepareMailCommand(input,ctx),ctx)).status,'succeeded');assert.equal(writes,1);
});

test('revocation during async provider preflight blocks the final write',async()=>{
  let revoked=false;
  const requests=[];
  const ctx=makeContext('gmail',[gmailModify],async(url,init)=>{
    requests.push(init.method);
    return json({id:'Label_4',type:'user'});
  });
  const prepared=await prepareMailCommand({action:'add_label',messageId:'m',labelId:'Label_4'},ctx);
  const guarded={...ctx,beforeWrite(){
    revoked=true;
    throw Object.assign(Error('changed'),{code:'connection_changed'});
  }};
  assert.deepEqual(await executeMailCommand(prepared,guarded),{status:'failed',code:'connection_changed'});
  assert.equal(revoked,true);assert.deepEqual(requests,['GET','GET']);
  const aborted={...ctx,signal:AbortSignal.abort()};
  assert.deepEqual(await executeMailCommand(prepared,aborted),{status:'failed',code:'request_cancelled'});
});

test('Gmail draft replacement checks the message version inside its stable draft ID',async()=>{
  let version='current',writes=0;
  const ctx=makeContext('gmail',[gmailModify],async(url,init)=>{
    if (url.endsWith('/profile')) return json({emailAddress:'sender@example.com'});
    if (init.method==='GET') return json({id:'d',message:{id:version,labelIds:['DRAFT']}});
    writes++;return json({id:'d'});
  });
  const prepared=await prepareMailCommand({action:'update_draft',draftId:'d',body:'Changed'},ctx);
  version='edited-on-another-device';
  assert.equal((await executeMailCommand(prepared,ctx)).code,'version_conflict');assert.equal(writes,0);
});

test('message version from a provider guards both planning and dispatch; Graph PATCH binds If-Match',async()=>{
  for (const provider of ['gmail','outlook']) {
    let version='v1',writes=0;
    const ctx=makeContext(provider,[gmailModify,'Mail.ReadWrite'],async(url,init)=>{
      if(init.method==='GET') return json({id:'m',historyId:version,changeKey:version,'@odata.etag':'W/"'+version+'"'});
      if(provider==='outlook') assert.equal(init.headers['If-Match'],'W/"v1"');
      writes++;return json({id:'m',...(provider==='gmail'?{historyId:'v2'}:{changeKey:'v2'})});
    });
    const input={action:'mark_read',messageId:'m'};
    await assert.rejects(prepareMailCommand(input,{...ctx,expectedProviderVersion:'v0'}),{code:'version_conflict'});
    const prepared=await prepareMailCommand(input,{...ctx,expectedProviderVersion:'v1'});
    version='external-edit';
    assert.equal((await executeMailCommand(prepared,ctx)).code,'version_conflict');assert.equal(writes,0);
    version='v1';
    assert.equal((await executeMailCommand(prepared,ctx)).providerVersion,'v2');assert.equal(writes,1);
    await assert.rejects(prepareMailCommand({action:'create_draft'},{...ctx,expectedProviderVersion:'v1'}),{code:'unsupported_version_condition'});
  }
});

test('Gmail detached text body is bounded, and forwarding an incomplete source is refused',async()=>{
  const message=gmailMessage();
  const part=message.payload.parts[0];
  part.body={attachmentId:'body-ref',size:5};
  let reads=0;
  const ctx=makeContext('gmail',[gmailModify],async url=>{
    if (url.endsWith('/attachments/body-ref')) {reads++;return json({data:btoa('hello')});}
    return json(message);
  });
  const complete=await readMailTool('mail_read',{messageId:'src'},ctx);
  assert.equal(complete.body,'hello');assert.equal(complete.truncated,false);assert.equal(reads,1);
  message.payload.parts[0].body.size=1024*1024;
  const partial=await readMailTool('mail_read',{messageId:'src'},ctx);
  assert.equal(partial.truncated,true);
  await assert.rejects(prepareMailCommand({action:'forward',messageId:'src',to:['r@example.com']},ctx),{code:'source_too_large'});
  assert.equal(reads,1);
});

test('a draft or send snapshot of binary originals enforces the aggregate 512 KiB ceiling',async()=>{
  const message=gmailMessage();
  const encoded=Buffer.alloc(300*1024,7).toString('base64');
  message.payload.parts[1]={filename:'photo.bin',mimeType:'application/octet-stream',body:{size:300*1024,attachmentId:'binary'}};
  let bytesFetched=0;
  const ctx=makeContext('gmail',[gmailModify],async url=>{
    if (url.endsWith('/attachments/binary')) {bytesFetched++;return json({data:encoded});}
    if (url.endsWith('/profile')) return json({emailAddress:'sender@example.com'});
    return json(message);
  });
  const {attachments:[ref]}=await readMailTool('mail_list_attachments',{messageId:'src'},ctx);
  const input={action:'send',to:['r@example.com'],attachments:[ref,ref]};
  await assert.rejects(prepareMailCommand(input,ctx),{code:'content_too_large'});
  assert.equal(bytesFetched,1);
  const good=await prepareMailCommand({...input,attachments:[ref]},ctx);
  assert.equal(good.summary.attachments[0].size,300*1024);
  assert.ok(good.summary.attachments[0].sha256.match(/^[a-f0-9]{64}$/));
  assert.ok(Buffer.byteLength(JSON.stringify(good))<2*1024*1024);
});
