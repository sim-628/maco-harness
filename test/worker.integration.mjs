import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { Miniflare } from 'miniflare';

const issuer = 'https://test-login.example/auth/v1';
const inbox = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';
const source = fileURLToPath(new URL('../src/', import.meta.url));
const scopes = 'openid https://www.googleapis.com/auth/gmail.modify';

async function logins() {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign','verify']);
  const publicKey = await crypto.subtle.exportKey('jwk', keys.publicKey);
  async function issue(sub) {
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const header = encode({ alg: 'ES256', kid: 'integration' });
    const claims = encode({ sub, iss: issuer, aud: 'authenticated', role: 'authenticated', exp: Math.floor(Date.now()/1000) + 300 });
    const payload = header + '.' + claims;
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, new TextEncoder().encode(payload));
    return payload + '.' + Buffer.from(sig).toString('base64url');
  }
  return { jwks: { keys: [{ ...publicKey, alg: 'ES256', kid: 'integration' }] }, alice: await issue('alice'), bob: await issue('bob') };
}

function stream(delta, finish) {
  const frame = { choices:[{ index:0, delta, finish_reason:finish }], usage:{prompt_tokens:12,completion_tokens:5} };
  return new Response('data: ' + JSON.stringify(frame) + '\n\ndata: [DONE]\n\n', {headers:{'Content-Type':'text/event-stream'}});
}

function fakeProviders(login, counts) {
  return async req => {
    const url = new URL(req.url);
    if (url.href === issuer + '/.well-known/jwks.json') return Response.json(login.jwks);
    if (url.href === 'https://oauth2.googleapis.com/token') {
      const params = new URLSearchParams(await req.text());
      assert.equal(params.get('code'), 'test-code');
      assert.ok(params.get('code_verifier'));
      return Response.json({access_token:'fixture-mail',refresh_token:'fixture-refresh',token_type:'Bearer',scope:scopes,expires_in:3600});
    }
    if (url.href === 'https://openidconnect.googleapis.com/v1/userinfo') {
      assert.equal(req.headers.get('Authorization'), 'Bearer fixture-mail');
      return Response.json({sub:'google-alice'});
    }
    if (url.origin === 'https://gmail.googleapis.com' && url.pathname === '/gmail/v1/users/me/profile') {
      assert.equal(req.headers.get('Authorization'), 'Bearer fixture-mail');
      return Response.json({emailAddress:'alice@example.com',historyId:counts.marked?'8':'7'});
    }
    if (url.origin === 'https://gmail.googleapis.com' && url.pathname === '/gmail/v1/users/me/history') {
      assert.equal(req.headers.get('Authorization'), 'Bearer fixture-mail');
      counts.histories=(counts.histories || 0)+1;
      return Response.json({historyId:counts.marked?'8':'7',history:counts.marked?[{messages:[{id:'message-1'}]}]:[]});
    }
    if (url.href.startsWith(inbox)) {
      assert.equal(req.headers.get('Authorization'), 'Bearer fixture-mail');
      if (url.pathname.endsWith('/send') && req.method === 'POST') {
        assert.ok(Date.now() >= counts.due, 'scheduled send reached provider before due time');
        const {raw} = await req.json();
        assert.match(Buffer.from(raw, 'base64url').toString(), /recipient@example.com/);
        counts.sends++;
        return Response.json({id:'sent-1', threadId:'sent-thread'});
      }
      if (url.pathname.endsWith('/message-1/modify') && req.method === 'POST') {
        const body=await req.json();
        assert.deepEqual(body.removeLabelIds,['UNREAD']);
        counts.modifies=(counts.modifies || 0)+1;
        counts.marked=true;
        return Response.json({id:'message-1',historyId:'8',labelIds:['INBOX']});
      }
      assert.equal(req.method, 'GET');
      counts.reads++;
      if (url.pathname.endsWith('/messages')) return Response.json({messages:[{id:'message-1',threadId:'thread-1'}]});
      if (url.pathname.endsWith('/message-1')) return Response.json({id:'message-1',threadId:'thread-1',historyId:counts.marked?'8':'7',internalDate:String(Date.now()-1000),labelIds:counts.marked?['INBOX']:['INBOX','UNREAD'],snippet:'Invoice reminder 报销发票',payload:{headers:[{name:'Subject',value:'Integration fixture'},{name:'From',value:'sender@example.com'}],
        ...(url.searchParams.get('format')==='full'?{parts:[{mimeType:'text/plain',body:{size:21,data:Buffer.from('Complete invoice text').toString('base64url')}}]}:{})}});
    }
    if (url.href === 'https://api.openai.com/v1/chat/completions') {
      assert.equal(req.headers.get('Authorization'), 'Bearer fixture-model-key');
      const {messages,tools} = await req.json();
      assert.ok(tools.some(tool => tool.function.name === 'mail_search'));
      counts.model++;
      if (counts.historyMode) {
        assert.ok(tools.some(tool => tool.function.name === 'history_search'));
        assert.ok(tools.some(tool => tool.function.name === 'history_read'));
        const read = messages.find(message => message.tool_call_id === 'history-read');
        if (read) {
          const value = JSON.parse(read.content);
          assert.equal(value.taskId,counts.historyTarget);
          assert.match(value.content,/报销发票/);
          counts.historyReads = (counts.historyReads || 0)+1;
          return stream({content:'Read the original AlphaLaunch decision.'},'stop');
        }
        const searched = messages.find(message => message.tool_call_id === 'history-search');
        if (searched) {
          const hit = JSON.parse(searched.content).results.find(item => item.taskId === counts.historyTarget);
          assert.ok(hit,'historical task was not found');
          counts.historySource = hit.messageId;
          return stream({tool_calls:[{index:0,id:'history-read',type:'function',function:{name:'history_read',
            arguments:JSON.stringify({taskId:hit.taskId,messageId:hit.messageId,neighbors:1})}}]},'tool_calls');
        }
        return stream({tool_calls:[{index:0,id:'history-search',type:'function',function:{name:'history_search',
          arguments:JSON.stringify({query:'报销发票'})}}]},'tool_calls');
      }
      if(counts.simpleReplies)return stream({content:'Understood. AlphaLaunch context retained.'},'stop');
      const result = messages.find(message => message.role === 'tool');
      if (result) {
        assert.match(result.content, /Integration fixture/);
        return stream({content:'Found the invoice.'}, 'stop');
      }
      return stream({tool_calls:[{index:0,id:'call-1',type:'function',function:{name:'mail_search',arguments:'{"query":"invoice","limit":1}'}}]}, 'tool_calls');
    }
    throw Error('Unexpected outgoing request to ' + url.origin + url.pathname);
  };
}

async function until(get, done) {
  const end = Date.now() + 12_000;
  let value;
  do {
    value = await get();
    if (done(value)) return value;
    await sleep(30);
  } while (Date.now() < end);
  assert.fail('Timed out waiting for transition: ' + JSON.stringify(value));
}

test('workerd persists a per-user mail task, broadcasts it, and delivers one approved send after restart', {timeout:45000}, async t => {
  const login = await logins(), counts = {model:0, reads:0, sends:0};
  const dir = await mkdtemp(join(process.env.MACO_TEST_TMPDIR || tmpdir(), 'maco-workerd-'));
  let mf;
  t.after(async () => { try { await mf?.dispose(); } finally { await rm(dir, {recursive:true,force:true}); } });
  const bindings = {
    SUPABASE_URL:'https://test-login.example', CONNECTION_ENCRYPTION_KEY:Buffer.alloc(32, 9).toString('base64'),
    GOOGLE_CLIENT_ID:'fixture-client', GOOGLE_CLIENT_SECRET:'fixture-secret', OAUTH_REDIRECT_URI:'https://client.example/callback',
  };
  const files = (await readdir(source,{recursive:true})).filter(file => file.endsWith('.mjs'));
  const modules = Object.fromEntries(await Promise.all(files.map(async path => [
    path.split(sep).join('/'), {type:'esm', contents:await readFile(join(source,path),'utf8')},
  ])));
  const options = {
    cf:false, resourcePersistencePath:dir, workers:[{
      config:{
        name:'maco-integration', compatibilityDate:'2026-09-01', manifest:{mainModule:'worker.mjs',modules},
        env:{...Object.fromEntries(Object.entries(bindings).map(([name,value]) => [name,{type:'text',value}])),
          AGENTS:{type:'durable-object', worker:'maco-integration', exportName:'MacoAgent'}},
        exports:{MacoAgent:{type:'durable-object',storage:'sqlite'}},
      },
      dev:{outboundService:{type:'fetcher',handler:fakeProviders(login,counts)}},
    }],
  };
  mf = new Miniflare(options);
  async function request(token, path, body, status = 200) {
    const headers = { 'X-Owner':'alice' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (body) headers['Content-Type'] = 'application/json';
    const res = await mf.dispatchFetch('https://agent.example/v1/' + path, { method:body ? 'POST' : 'GET',headers,...(body ? {body:JSON.stringify(body)} : {}) });
    const json = await res.json();
    assert.equal(res.status,status,JSON.stringify(json));
    return json;
  }
  const command = (type, fields) => ({protocolVersion:1, commandId:crypto.randomUUID(), type,...fields});
  await request(null, 'snapshot', null, 401);
  const model = await request(login.alice,'connections/model',{provider:'openai', apiKey:'fixture-model-key'});
  const baseline = await request(login.alice,'snapshot');

  // Browser login uses a WebSocket subprotocol. The Worker returns only the app protocol.
  const socketResponse = await mf.dispatchFetch('https://agent.example/v1/socket?after=' + baseline.snapshotCursor, {headers:{
    Upgrade:'websocket', 'Sec-WebSocket-Protocol':'maco.v1, bearer.' + login.alice,
  }});
  assert.equal(socketResponse.status,101);
  assert.equal(socketResponse.headers.get('Sec-WebSocket-Protocol'),'maco.v1');
  const socket = socketResponse.webSocket;
  const received = [];
  socket.addEventListener('message', e => {
    const event = JSON.parse(e.data);
    received.push(event);
    socket.send(JSON.stringify({type:'ack',seq:event.seq}));
  });
  socket.accept();
  await mf.unsafeEvictDurableObject('maco-integration','MacoAgent',{name:'alice',webSockets:'hibernate'});
  const auth = await request(login.alice,'connections/oauth/start',{provider:'gmail',actions:['modify','send']});
  await request(login.bob,'connections/oauth/complete',{state:auth.state,code:'test-code'},400);
  const mail = await request(login.alice,'connections/oauth/complete',{state:auth.state,code:'test-code'});
  const create = command('task.create',{message:'Search for one invoice.',modelProfile:{provider:'openai',model:'gpt-4.1',connectionId:model.id},mailboxId:mail.id});
  const task = await request(login.alice,'commands',create,202);
  const history = await until(() => request(login.alice,'tasks/' + task.taskId), result => ['completed','failed'].includes(result.state));
  assert.equal(history.state,'completed',JSON.stringify(history));
  assert.equal(history.messages.at(-1).content,'Found the invoice.');
  assert.equal(counts.model,2);
  assert.equal(counts.reads,2);
  const events = await request(login.alice,'events?after=' + baseline.snapshotCursor);
  await until(() => received, frames => frames.length >= events.events.length);
  assert.deepEqual(received.slice(0,events.events.length), events.events);
  assert.deepEqual((await request(login.bob,'connections')).connections,[]);
  await request(login.bob,'tasks/' + task.taskId,null,404);
  // Completed provider requests must release their timers so workerd can
  // hibernate the object and preserve the open WebSocket after a model turn.
  await mf.unsafeEvictDurableObject('maco-integration','MacoAgent',{name:'alice',webSockets:'hibernate'});
  counts.due = Date.now() + 2500;
  const submit = command('mail.submit',{mailboxId:mail.id,items:[{scheduledAt:counts.due,input:{action:'send',to:['recipient@example.com'],subject:'Workerd fixture',body:'Testing approval.'}}]});
  const {operations:[op]} = await request(login.alice,'commands',submit,202);
  assert.equal(op.state,'waiting_approval');
  assert.equal(counts.sends,0);
  await until(() => received, frames => frames.some(frame => frame.operationId === op.operationId && frame.seq > events.committedCursor));
  socket.close(1000,'test complete');
  await mf.dispose();
  mf = new Miniflare(options);
  const persisted = await request(login.alice,'operations/' + op.operationId);
  assert.equal(persisted.state,'waiting_approval');
  const approve = command('mail.approve',{operationId:op.operationId,approvalVersion:persisted.approvalVersion});
  await request(login.bob,'commands',approve,404);
  await request(login.alice,'commands',approve,202);
  await request(login.alice,'commands',approve,202);
  const sent = await until(() => request(login.alice,'operations/' + op.operationId), item => ['succeeded','unknown','failed'].includes(item.state));
  assert.equal(sent.state,'succeeded',JSON.stringify(sent));
  assert.equal(counts.sends,1);
  assert.equal((await request(login.alice,'commands',create,202)).taskId,task.taskId);
  assert.equal(counts.model,2);
});

test('workerd supports indexed mail IDs, CORS and editable isolated personal memory after reconstruction', {timeout:45000}, async t => {
  const login=await logins(),counts={model:0,reads:0,sends:0,modifies:0,histories:0,simpleReplies:true};
  const dir=await mkdtemp(join(process.env.MACO_TEST_TMPDIR || tmpdir(),'maco-extensions-'));
  let mf;
  t.after(async()=>{try{await mf?.dispose();}finally{await rm(dir,{recursive:true,force:true});}});
  const bindings={SUPABASE_URL:'https://test-login.example',CONNECTION_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64'),
    GOOGLE_CLIENT_ID:'fixture-client',GOOGLE_CLIENT_SECRET:'fixture-secret',OAUTH_REDIRECT_URI:'https://client.example/callback',
    ALLOWED_ORIGINS:'https://client.example'};
  const files=(await readdir(source,{recursive:true})).filter(file=>file.endsWith('.mjs'));
  const modules=Object.fromEntries(await Promise.all(files.map(async path=>[path.split(sep).join('/'),{type:'esm',contents:await readFile(join(source,path),'utf8')}])));
  const options={cf:false,resourcePersistencePath:dir,workers:[{
    config:{name:'maco-extensions',compatibilityDate:'2026-11-18',manifest:{mainModule:'worker.mjs',modules},
      env:{...Object.fromEntries(Object.entries(bindings).map(([name,value])=>[name,{type:'text',value}])),AGENTS:{type:'durable-object',worker:'maco-extensions',exportName:'MacoAgent'}},
      exports:{MacoAgent:{type:'durable-object',storage:'sqlite'}}},
    dev:{outboundService:{type:'fetcher',handler:fakeProviders(login,counts)}}
  }]};
  mf=new Miniflare(options);
  async function request(token,path,body,status=200) {
    const headers={Origin:'https://client.example','X-Owner':'alice'};
    if(token)headers.Authorization='Bearer '+token;
    if(body)headers['Content-Type']='application/json';
    const response=await mf.dispatchFetch('https://agent.example/v1/'+path,{method:body?'POST':'GET',headers,...(body?{body:JSON.stringify(body)}:{})});
    const value=await response.json();
    assert.equal(response.status,status,JSON.stringify(value));
    assert.equal(response.headers.get('Access-Control-Allow-Origin'),'https://client.example');
    return value;
  }
  const cmd=(type,fields)=>({protocolVersion:1,commandId:crypto.randomUUID(),type,...fields});
  const preflight=await mf.dispatchFetch('https://agent.example/v1/commands',{method:'OPTIONS',headers:{Origin:'https://client.example','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization, content-type'}});
  assert.equal(preflight.status,204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'),'https://client.example');
  await request(null,'memory',null,401);
  const forbidden=await mf.dispatchFetch('https://agent.example/v1/memory',{headers:{Origin:'https://evil.example',Authorization:'Bearer '+login.alice}});
  assert.equal(forbidden.status,403);assert.equal(forbidden.headers.get('Access-Control-Allow-Origin'),null);

  const fact=await request(login.alice,'commands',cmd('memory.upsert',{key:'account.time_zone',kind:'fact',value:'Asia/Shanghai'}),202);
  assert.equal(fact.memory.version,1);assert.equal(fact.memory.source.type,'user_edit');
  const revised=await request(login.alice,'commands',cmd('memory.upsert',{key:'account.time_zone',kind:'fact',value:'Asia/Tokyo',expectedVersion:1}),202);
  assert.equal(revised.memory.version,2);
  await request(login.alice,'commands',cmd('memory.upsert',{key:'account.time_zone',kind:'fact',value:'UTC',expectedVersion:1}),409);
  assert.deepEqual((await request(login.bob,'memory')).memories,[]);

  const model=await request(login.alice,'connections/model',{provider:'openai',apiKey:'fixture-model-key'});
  const auth=await request(login.alice,'connections/oauth/start',{provider:'gmail',actions:['modify']});
  const mail=await request(login.alice,'connections/oauth/complete',{state:auth.state,code:'test-code'});
  const profile={provider:'openai',model:'gpt-4.1',connectionId:model.id};
  async function task(message) {
    const result=await request(login.alice,'commands',cmd('task.create',{message,modelProfile:profile,mailboxId:mail.id}),202);
    const history=await until(()=>request(login.alice,'tasks/'+result.taskId),value=>['completed','failed'].includes(value.state));
    assert.equal(history.state,'completed',JSON.stringify(history));
    return history;
  }
  const prior=await task('以后用中文回复，回答尽量简洁。AlphaLaunch 报销发票记录。');
  const memories=await request(login.alice,'memory');
  const language=memories.memories.find(item=>item.key==='response.language');
  assert.equal(language.value,'中文');assert.equal(language.source.taskId,prior.taskId);
  const current=await task('检查 AlphaLaunch 报销事项。');
  const related=await request(login.alice,'memory/context?taskId='+current.taskId+'&query='+encodeURIComponent('报销'));
  assert.ok(related.relatedHistory.some(item=>item.taskId===prior.taskId&&item.content.includes('报销')));
  assert.ok(related.relatedHistory.every(item=>item.taskId!==current.taskId));
  assert.ok(related.facts.some(item=>item.key==='account.time_zone'&&item.value==='Asia/Tokyo'));
  assert.deepEqual((await request(login.bob,'memory/context?query='+encodeURIComponent('报销'))).relatedHistory,[]);

  counts.historyMode=true;counts.historyTarget=prior.taskId;
  const mailReadsBeforeHistory=counts.reads;
  const recalled=await task('Look up the earlier expense decision and read its exact source.');
  counts.historyMode=false;
  assert.equal(counts.historyReads,1);
  assert.equal(counts.reads,mailReadsBeforeHistory,'history-only tools must not read Gmail');
  assert.ok(recalled.messages.some(message=>message.toolName==='history_read'));
  const found=await request(login.alice,'history/search',{callerTaskId:recalled.taskId,query:'报销发票'});
  assert.ok(found.result.results.some(hit=>hit.messageId===counts.historySource));
  const exact=await request(login.alice,'history/read',{callerTaskId:recalled.taskId,taskId:prior.taskId,messageId:counts.historySource});
  assert.match(exact.result.content,/报销发票/);
  await request(login.bob,'history/read',{callerTaskId:recalled.taskId,taskId:prior.taskId,messageId:counts.historySource},404);

  const after=new Date(Date.now()-7*86400000).toISOString();
  const accepted=await request(login.alice,'commands',cmd('mail.sync',{mailboxId:mail.id,after}),202);
  assert.equal(accepted.index.mailboxId,mail.id);
  const index=await until(()=>request(login.alice,'mail/index?mailboxId='+mail.id),value=>value.index?.complete===true&&value.index?.phase==='idle');
  assert.equal(index.index.complete,true);
  assert.equal((await request(login.bob,'mail/index?mailboxId='+mail.id,null,404)).error,'connection_not_found');
  const before=counts.reads;
  const local=await request(login.alice,'mail/read',{mailboxId:mail.id,tool:'mail_search',input:{scope:'metadata',query:'invoice',filters:{after},limit:1}});
  assert.equal(local.result.coverage.source,'index');assert.equal(counts.reads,before);
  const id=local.result.matches[0].citation.messageId;
  assert.match(id,/^mail_[0-9a-f-]{36}$/);
  assert.equal(local.result.matches[0].contentCoverage,'snippet');
  const read=await request(login.alice,'mail/read',{mailboxId:mail.id,tool:'mail_read',input:{messageId:id}});
  assert.equal(read.result.citation.messageId,id);assert.equal(read.result.body,'Complete invoice text');
  assert.equal(read.result.contentCoverage,'body');
  const submit=await request(login.alice,'commands',cmd('mail.submit',{mailboxId:mail.id,items:[{expectedRevision:read.result.revision,expectedProviderVersion:read.result.providerVersion,input:{action:'mark_read',messageId:id}}]}),202);
  const op=await until(()=>request(login.alice,'operations/'+submit.operations[0].operationId),value=>['succeeded','failed','unknown'].includes(value.state));
  assert.equal(op.state,'succeeded',JSON.stringify(op));assert.equal(counts.modifies,1);
  await until(()=>request(login.alice,'mail/index?mailboxId='+mail.id),value=>value.index?.phase==='idle'&&value.index?.syncedAt>index.index.syncedAt);
  const updated=await request(login.alice,'mail/read',{mailboxId:mail.id,tool:'mail_search',input:{scope:'metadata',query:'invoice',filters:{after},limit:1}});
  assert.equal(updated.result.matches[0].citation.messageId,id);assert.equal(updated.result.matches[0].isRead,true);

  const deleted=await request(login.alice,'commands',cmd('memory.delete',{key:'response.language',expectedVersion:language.version}),202);
  assert.equal(deleted.memory.status,'deleted');
  await mf.dispose();mf=new Miniflare(options);
  const reloaded=await request(login.alice,'memory');
  assert.ok(reloaded.memories.some(item=>item.key==='account.time_zone'&&item.version===2));
  assert.ok(!reloaded.memories.some(item=>item.key==='response.language'));
  const reloadedHistory=await request(login.alice,'memory/context?query='+encodeURIComponent('报销'));
  assert.ok(reloadedHistory.relatedHistory.some(item=>item.taskId===current.taskId&&item.content.includes('报销')));
  assert.ok(!reloadedHistory.relatedHistory.some(item=>item.messageId===language.source.messageId));
  await request(login.alice,'history/read',{callerTaskId:recalled.taskId,taskId:prior.taskId,messageId:language.source.messageId},404);
  const currentSource=current.messages.find(message=>message.role==='user');
  const afterRestart=await request(login.alice,'history/read',{callerTaskId:recalled.taskId,taskId:current.taskId,messageId:currentSource.messageId});
  assert.match(afterRestart.result.content,/报销事项/);
  await task('以后用中文回复，回答尽量简洁。');
  assert.ok(!(await request(login.alice,'memory')).memories.some(item=>item.key==='response.language'));
  await request(login.alice,'commands',cmd('memory.upsert',{key:'response.language',value:'中文',expectedVersion:deleted.memory.version}),409);
  const restored=await request(login.alice,'commands',cmd('memory.upsert',{key:'response.language',value:'中文',expectedVersion:deleted.memory.version,restore:true}),202);
  assert.equal(restored.memory.status,'active');
  const reread=await request(login.alice,'mail/read',{mailboxId:mail.id,tool:'mail_read',input:{messageId:id}});
  assert.equal(reread.result.citation.messageId,id);
});

test('workerd compacts a large paired history with bounded SQL reads and reuses its checkpoint after reconstruction', {timeout:30000}, async t => {
  const dir=await mkdtemp(join(process.env.MACO_TEST_TMPDIR || tmpdir(),'maco-context-'));
  let mf;
  t.after(async()=>{try{await mf?.dispose();}finally{await rm(dir,{recursive:true,force:true});}});
  const files=(await readdir(source,{recursive:true})).filter(file=>file.endsWith('.mjs'));
  const modules=Object.fromEntries(await Promise.all(files.map(async path=>[path.split(sep).join('/'),{type:'esm',contents:await readFile(join(source,path),'utf8')}])));
  modules['context-fixture.mjs']={type:'esm',contents:`
    import {DurableObject} from 'cloudflare:workers';
    import {Store} from './store.mjs';
    import {CompactionService} from './model/compaction.mjs';
    import {groupMessages} from './model/context.mjs';
    export class ContextFixture extends DurableObject {
      constructor(ctx,env) {
        super(ctx,env);this.store=new Store(ctx.storage);
        const store=this.store;
        this.compaction=new CompactionService(store,{async *stream({tools}) {
          if(tools.length)throw Error('Summary tools must be empty');
          store.event('fixture.summary_called',{});
          yield {type:'text_delta',text:'Continue the mail task. Earlier messages are historical notes; consult exact source IDs for details. No email write has been approved or executed.'};
          yield {type:'usage',inputTokens:100,outputTokens:24};
          yield {type:'finish',reason:'stop'};
        }});
      }
      async rawState() {
        const text=JSON.stringify(this.store.messages('long-task',1000));
        const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
        return {count:this.store.one('SELECT COUNT(*) AS n FROM messages').n,
          digest:[...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('')};
      }
      async fetch(request) {
        const mode=new URL(request.url).pathname;
        if(mode==='/seed') {
          const task={id:'long-task',runId:'run-one',state:'running',version:1,profile:{provider:'openai',model:'fixture'},runStartedAt:Date.now()};
          this.store.tx(()=>{
            this.store.saveTask(task);
            this.store.appendMessage(task,{role:'user',content:'Review the historical mail decisions and continue.'});
            for(let i=0;i<310;i++)this.store.appendMessage(task,{role:i%2?'user':'assistant',content:'Historical entry '+i+': '+('relevant mail detail '.repeat(5))});
            this.store.appendMessage(task,{role:'assistant',content:'',toolCalls:[{id:'last-read',name:'mail_read',arguments:{messageId:'mail-source'}}]});
            this.store.appendMessage(task,{role:'tool',toolName:'mail_read',toolCallId:'last-read',content:JSON.stringify({subject:'Current observation',citation:{messageId:'mail-source'}})});
          });
          return Response.json(await this.rawState());
        }
        const task=this.store.getTask('long-task');
        const prepared=await this.compaction.prepare(task,{memoryEpoch:1,signal:new AbortController().signal});
        groupMessages(prepared.messages.filter(m=>m.role!=='system'));
        return Response.json({raw:await this.rawState(),compacted:prepared.compacted,truncated:prepared.truncated,
          checkpoint:this.compaction.view(task.id,1),calls:this.store.events(0,1000).filter(e=>e.type==='fixture.summary_called').length});
      }
    }
    export default {fetch(request,env){return env.CONTEXT.getByName('one').fetch(request)}};
  `};
  const options={cf:false,resourcePersistencePath:dir,workers:[{config:{name:'maco-context',compatibilityDate:'2026-11-18',
    manifest:{mainModule:'context-fixture.mjs',modules},env:{CONTEXT:{type:'durable-object',worker:'maco-context',exportName:'ContextFixture'}},
    exports:{ContextFixture:{type:'durable-object',storage:'sqlite'}}}}]};
  mf=new Miniflare(options);
  const get=async path=>{
    const response=await mf.dispatchFetch('https://context.test/'+path);
    assert.equal(response.status,200,await response.clone().text());
    return response.json();
  };
  const original=await get('seed');
  const first=await get('prepare');
  assert.ok(first.compacted>0);
  assert.ok(first.checkpoint.sourceCount>100,'fixture must exercise the SQL binding limit');
  assert.deepEqual(first.raw,original);
  await mf.dispose();mf=new Miniflare(options);
  const restored=await get('prepare');
  assert.equal(restored.compacted,0);
  assert.equal(restored.calls,first.calls,'unchanged source must not bill another summary after restart');
  assert.equal(restored.checkpoint.version,first.checkpoint.version);
  assert.deepEqual(restored.raw,original);
});
