import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp,readdir,readFile,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join,sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { Miniflare } from 'miniflare'

const issuer='https://backend-login.example/auth/v1'
const source=fileURLToPath(new URL('../src/',import.meta.url))
const worker='maco-backend-integration'
const scope='openid https://www.googleapis.com/auth/gmail.modify'
const encode=value=>new TextEncoder().encode(value)
const digest=async value=>Buffer.from(await crypto.subtle.digest('SHA-256',encode(value))).toString('hex')
const command=(type,fields={})=>({protocolVersion:1,commandId:crypto.randomUUID(),type,...fields})

async function logins() {
  const keys=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify'])
  const publicKey=await crypto.subtle.exportKey('jwk',keys.publicKey)
  async function issue(sub,session_id) {
    const base64=value=>Buffer.from(JSON.stringify(value)).toString('base64url')
    const now=Math.floor(Date.now()/1000)
    const payload=base64({alg:'ES256',kid:'backend-integration'})+'.'+
      base64({sub,session_id,iat:now,iss:issuer,aud:'authenticated',role:'authenticated',exp:now+300})
    const sig=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},keys.privateKey,encode(payload))
    return payload+'.'+Buffer.from(sig).toString('base64url')
  }
  return {jwks:{keys:[{...publicKey,alg:'ES256',kid:'backend-integration'}]},
    alice:await issue('alice','alice-desktop'),phone:await issue('alice','alice-phone'),bob:await issue('bob','bob-device')}
}

function stream(delta,reason='stop') {
  return new Response('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:reason}],
    usage:{prompt_tokens:12,completion_tokens:5}})+'\n\ndata: [DONE]\n\n',
  {headers:{'Content-Type':'text/event-stream'}})
}
const call=(id,name,args)=>stream({tool_calls:[{index:0,id,type:'function',function:{name,arguments:JSON.stringify(args)}}]},'tool_calls')

function outgoing(login,counts) {
  return async req=>{
    const url=new URL(req.url)
    if (url.href===issuer+'/.well-known/jwks.json') return Response.json(login.jwks)
    if (url.href==='https://api.openai.com/v1/chat/completions') {
      assert.equal(req.headers.get('Authorization'),'Bearer fixture-model-key')
      const {messages,tools}=await req.json()
      counts.models++
      assert.ok(!tools.some(tool=>tool.function.name.startsWith('mail_')),'standalone tasks must not inherit mail authority')
      const message=messages.filter(item=>item.role==='user').at(-1).content
      if (message.startsWith('Parse the attached fixture')) {
        const read=messages.find(item=>item.tool_call_id==='read-file')
        if (read) {
          const value=JSON.parse(read.content)
          assert.equal(value.coverage,'complete')
          assert.match(value.text,/Reusable attachment text/)
          return stream({content:'The attached text was read in the cloud.'})
        }
        const parsed=messages.find(item=>item.tool_call_id==='parse-file')
        if (parsed) {
          assert.equal(JSON.parse(parsed.content).state,'succeeded',parsed.content)
          return call('read-file','asset_read',{assetId:counts.assetId})
        }
        return call('parse-file','asset_parse',{assetId:counts.assetId})
      }
      if (message.startsWith('Ask for a tone')) {
        const answer=messages.find(item=>item.tool_call_id==='ask-tone')
        if (answer) {
          assert.deepEqual(JSON.parse(answer.content).answer,{tone:'brief'})
          return stream({content:'The preference was supplied from the other device.'})
        }
        return call('ask-tone','ask_user',{question:'Which tone should I use?',fields:[
          {id:'tone',label:'Tone',type:'choice',required:true,options:['brief','detailed']},
        ]})
      }
      return stream({content:'Standalone completed.'})
    }
    if (url.href==='https://oauth2.googleapis.com/token') {
      const body=new URLSearchParams(await req.text())
      assert.equal(body.get('code'),'fixture-code')
      assert.ok(body.get('code_verifier'))
      return Response.json({access_token:'fixture-mail',refresh_token:'fixture-refresh',token_type:'Bearer',scope,expires_in:3600})
    }
    if (url.href==='https://openidconnect.googleapis.com/v1/userinfo') return Response.json({sub:'google-alice'})
    if (url.origin==='https://gmail.googleapis.com') {
      assert.equal(req.headers.get('Authorization'),'Bearer fixture-mail')
      assert.equal(req.method,'GET','analysis integration performs no provider mutation')
      counts.mailReads++
      const version=String(counts.providerVersion)
      if (url.pathname==='/gmail/v1/users/me/profile') return Response.json({emailAddress:'alice@example.com',historyId:version})
      if (url.pathname==='/gmail/v1/users/me/history') return Response.json({historyId:version,history:[]})
      if (url.pathname==='/gmail/v1/users/me/messages') return Response.json({messages:[{id:'message-1',threadId:'thread-1'}]})
      if (url.pathname==='/gmail/v1/users/me/messages/message-1') return Response.json({
        id:'message-1',threadId:'thread-1',historyId:version,internalDate:String(Date.now()-1000),labelIds:['INBOX'],snippet:'Invoice fixture',
        payload:{headers:[{name:'Subject',value:'Invoice fixture'},{name:'From',value:'sender@example.com'}],
          ...(url.searchParams.get('format')==='full' ? {parts:[{mimeType:'text/plain',body:{size:12,data:Buffer.from('Invoice body').toString('base64url')}}]} : {})},
      })
    }
    throw Error('Unexpected outgoing request: '+url.origin+url.pathname)
  }
}

async function until(get,ready) {
  const end=Date.now()+12000
  let value
  do {
    value=await get()
    if (ready(value)) return value
    await sleep(25)
  } while (Date.now()<end)
  assert.fail('Timed out waiting for state: '+JSON.stringify(value))
}

async function fixture(t) {
  const login=await logins(),counts={models:0,mailReads:0,providerVersion:9}
  const dir=await mkdtemp(join(process.env.MACO_TEST_TMPDIR || tmpdir(),'maco-backend-'))
  const files=(await readdir(source,{recursive:true})).filter(file=>file.endsWith('.mjs'))
  const modules=Object.fromEntries(await Promise.all(files.map(async path=>[
    path.split(sep).join('/'),{type:'esm',contents:await readFile(join(source,path),'utf8')},
  ])))
  const bindings={SUPABASE_URL:'https://backend-login.example',CONNECTION_ENCRYPTION_KEY:Buffer.alloc(32,8).toString('base64'),
    GOOGLE_CLIENT_ID:'fixture-client',GOOGLE_CLIENT_SECRET:'fixture-secret',OAUTH_REDIRECT_URI:'https://client.example/callback',
    ALLOWED_ORIGINS:'https://client.example'}
  const options={cf:false,resourcePersistencePath:dir,workers:[{
    config:{name:worker,compatibilityDate:'2026-11-18',manifest:{mainModule:'worker.mjs',modules},
      env:{...Object.fromEntries(Object.entries(bindings).map(([name,value])=>[name,{type:'text',value}])),
        AGENTS:{type:'durable-object',worker,exportName:'MacoAgent'},ASSETS:{type:'r2',name:'private-backend-assets'}},
      exports:{MacoAgent:{type:'durable-object',storage:'sqlite'}}},
    dev:{outboundService:{type:'fetcher',handler:outgoing(login,counts)}},
  }]}
  let mf=new Miniflare(options)
  t.after(async()=>{try{await mf?.dispose()}finally{await rm(dir,{recursive:true,force:true})}})
  const dispatch=(token,path,init={})=>mf.dispatchFetch('https://agent.example/v1/'+path,{
    ...init,headers:{...(token ? {Authorization:'Bearer '+token} : {}),...init.headers},
  })
  async function request(token,path,body,status=200) {
    const response=await dispatch(token,path,body ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)} : {})
    const value=await response.json()
    assert.equal(response.status,status,JSON.stringify(value))
    return value
  }
  async function upload(token,text,{name='fixture.txt',key='fixture-upload',status=201,headers={}}={}) {
    const response=await dispatch(token,'assets?name='+encodeURIComponent(name),{method:'PUT',body:encode(text),
      headers:{'Content-Type':'text/plain','Idempotency-Key':key,'X-Content-SHA256':await digest(text),...headers}})
    const value=await response.json()
    assert.equal(response.status,status,JSON.stringify(value))
    return value
  }
  return {login,counts,dispatch,request,upload,
    bucket:()=>mf.getR2Bucket('ASSETS',worker),
    restart:async()=>{await mf.dispose();mf=new Miniflare(options)},
    complete:async taskId=>{
      const task=await until(()=>request(login.alice,'tasks/'+taskId),item=>['completed','failed','needs_review'].includes(item.state))
      assert.equal(task.state,'completed',JSON.stringify(task));return task
    }}
}

test('workerd R2 assets, no-mail tasks and a cross-device conversation survive reconstruction',{timeout:60000},async t=>{
  const f=await fixture(t),{login,request,upload,dispatch,counts}=f
  await upload(null,'private input',{status:401})
  const status=await request(login.alice,'status')
  assert.deepEqual(status.features.assets.parsers,{local:true,cloudflare:false,deepseek:false})
  assert.equal(status.features.assets.enabled,true)
  assert.equal(status.features.assets.limits.maxBytes,10*1024*1024)
  assert.equal(status.features.assets.limits.maxRefs,4)
  assert.equal(status.features.hosted.enabled,false)
  const preflight=await dispatch(null,'assets',{method:'OPTIONS',headers:{Origin:'https://client.example',
    'Access-Control-Request-Method':'PUT','Access-Control-Request-Headers':'authorization, content-type, idempotency-key, x-content-sha256'}})
  assert.equal(preflight.status,204)
  const text='Reusable attachment text.\n金额 123.00; no provider calls are needed.'
  const {asset}=await upload(login.alice,text,{name:'说明.txt'})
  assert.equal(asset.parseStatus,'not_requested')
  assert.equal(asset.source.kind,'upload')
  assert.equal(asset.sha256,await digest(text))
  assert.ok(!JSON.stringify(asset).includes('accounts/'))
  assert.equal((await upload(login.phone,text,{name:'说明.txt'})).asset.id,asset.id)
  await upload(login.alice,'changed',{name:'说明.txt',status:409})
  await upload(login.alice,'digest mismatch',{key:'mismatch',status:400,headers:{'X-Content-SHA256':'0'.repeat(64)}})
  const {asset:bobs}=await upload(login.bob,'Bob private input')
  assert.notEqual(bobs.id,asset.id)
  await request(login.bob,'assets/'+asset.id,null,404)
  const leaked=await dispatch(login.bob,'assets/'+asset.id+'/download',{headers:{'X-Owner':'alice','X-Maco-Session':'alice-desktop'}})
  assert.equal(leaked.status,404)
  await leaked.arrayBuffer()
  assert.deepEqual((await request(login.bob,'assets')).assets.map(item=>item.id),[bobs.id])
  const downloaded=await dispatch(login.phone,'assets/'+asset.id+'/download')
  assert.equal(downloaded.status,200)
  assert.equal(downloaded.headers.get('X-Content-Type-Options'),'nosniff')
  assert.match(downloaded.headers.get('Content-Disposition'),/^attachment;/)
  assert.equal(await downloaded.text(),text)

  const model=await request(login.alice,'connections/model',{provider:'openai',apiKey:'fixture-model-key'})
  const profile={provider:'openai',model:'gpt-4.1',effort:'provider-default',connectionId:model.id}
  const create=command('task.create',{message:'Standalone model task.',modelProfile:profile,conversationId:'main'})
  const first=await request(login.alice,'commands',create,202)
  assert.deepEqual(first.mailboxIds,[])
  assert.equal(first.mailboxId,null)
  assert.equal((await f.complete(first.taskId)).messages.at(-1).content,'Standalone completed.')
  assert.equal(counts.mailReads,0)
  await request(login.alice,'commands',command('task.create',{message:'Wrong owner asset',modelProfile:profile,assetIds:[bobs.id]}),404)

  counts.assetId=asset.id
  const second=await request(login.phone,'commands',command('task.create',{
    message:'Parse the attached fixture in the cloud.',modelProfile:profile,conversationId:'main',assetIds:[asset.id],
  }),202)
  const parsed=await f.complete(second.taskId)
  assert.equal(parsed.messages.at(-1).content,'The attached text was read in the cloud.')
  const metadata=await request(login.phone,'assets/'+asset.id)
  assert.equal(metadata.asset.parseStatus,'succeeded')
  assert.equal(metadata.asset.coverage,'complete')
  assert.equal((await request(login.phone,'asset-parses/'+metadata.asset.parse.id)).job.state,'succeeded')
  const read=await request(login.phone,'assets/'+asset.id+'/text')
  assert.equal(read.text,text)
  const search=await request(login.phone,'assets/'+asset.id+'/search?query='+encodeURIComponent('金额'))
  assert.equal(search.matches.length,1)
  assert.equal(search.coverage,'complete')
  await request(login.bob,'asset-parses/'+metadata.asset.parse.id,null,404)
  const bucket=await f.bucket(),objects=await bucket.list()
  assert.equal(objects.objects.length,3,'two original files and one parsed result must be stored in real R2')
  assert.equal(new Set(objects.objects.map(item=>item.key.split('/')[1])).size,2)
  assert.ok(objects.objects.every(item=>item.key.startsWith('accounts/') && item.key.includes('/assets/')))

  const question=await request(login.alice,'commands',command('task.create',{
    message:'Ask for a tone before proceeding.',modelProfile:profile,conversationId:'main',
  }),202)
  await until(()=>request(login.phone,'tasks/'+question.taskId),task=>task.state==='waiting_user')
  const {interactions:[waiting]}=await request(login.phone,'interactions?waiting=1')
  assert.equal(waiting.taskId,question.taskId)
  assert.equal(waiting.version,1)
  await request(login.bob,'commands',command('interaction.respond',{interactionId:waiting.interactionId,expectedVersion:1,answer:{tone:'brief'}}),404)
  await request(login.phone,'commands',command('interaction.respond',{interactionId:waiting.interactionId,expectedVersion:2,answer:{tone:'brief'}}),409)
  await request(login.phone,'commands',command('interaction.respond',{interactionId:waiting.interactionId,expectedVersion:1,answer:{tone:'unlisted'}}),400)

  await f.restart()
  assert.equal((await request(login.phone,'assets/'+asset.id+'/text')).text,text)
  assert.equal((await request(login.phone,'assets/'+asset.id)).asset.parse.id,metadata.asset.parse.id)
  assert.equal((await request(login.phone,'interactions?waiting=1')).interactions[0].interactionId,waiting.interactionId)
  assert.equal((await request(login.alice,'commands',create,202)).taskId,first.taskId)
  const answer=command('interaction.respond',{interactionId:waiting.interactionId,expectedVersion:1,answer:{tone:'brief'}})
  const answered=await request(login.phone,'commands',answer,202)
  assert.equal(answered.interaction.version,2)
  assert.equal((await request(login.phone,'commands',answer,202)).interaction.version,2)
  assert.equal((await f.complete(question.taskId)).messages.at(-1).content,'The preference was supplied from the other device.')
  await request(login.alice,'commands',command('interaction.respond',{interactionId:waiting.interactionId,expectedVersion:1,answer:{tone:'detailed'}}),409)
  const timeline=await request(login.phone,'conversations/main/messages')
  assert.deepEqual(new Set(timeline.messages.map(item=>item.taskId)),new Set([first.taskId,second.taskId,question.taskId]))
  assert.ok(timeline.messages.every(item=>!item.toolCalls?.some(call=>'binding' in call)))
  assert.deepEqual((await request(login.bob,'conversations/main/messages')).messages,[])
  const conversations=await request(login.phone,'conversations')
  assert.deepEqual(conversations.conversations.map(item=>[item.id,item.taskCount]),[['main',3]])
  assert.equal(counts.mailReads,0)
  const events=await request(login.phone,'events?after=0')
  assert.ok(events.events.some(item=>item.type==='asset.updated'))
  assert.ok(events.events.some(item=>item.type==='interaction.updated'))
})

test('workerd syncs device-generated mail analysis with version checks and no model inference',{timeout:45000},async t=>{
  const f=await fixture(t),{login,counts,request}=f
  const authorization=await request(login.alice,'connections/oauth/start',{provider:'gmail',actions:['modify']})
  const mail=await request(login.alice,'connections/oauth/complete',{state:authorization.state,code:'fixture-code'})
  const after=new Date(Date.now()-7*86400000).toISOString()
  await request(login.alice,'commands',command('mail.sync',{mailboxId:mail.id,after}),202)
  await until(()=>request(login.phone,'mail/index?mailboxId='+mail.id),value=>value.index?.complete && value.index?.phase==='idle')
  const found=await request(login.phone,'mail/read',{mailboxId:mail.id,tool:'mail_search',input:{scope:'metadata',query:'invoice',filters:{after},limit:1}})
  const id=found.result.matches[0].citation.messageId
  assert.match(id,/^mail_[0-9a-f-]{36}$/)
  const full=await request(login.phone,'mail/read',{mailboxId:mail.id,tool:'mail_read',input:{messageId:id}})
  const missing=await request(login.phone,'mail/analysis',{mailboxId:mail.id,messageIds:[id]})
  assert.equal(missing.analyses[0].status,'not_analyzed')
  const item={messageId:id,providerVersion:full.result.providerVersion,expectedVersion:0,
    summary:'Device-only invoice summary',categories:['invoice','invoice'],analyzer:'on-device-fixture'}
  const sync=command('mail.analysis.sync',{mailboxId:mail.id,items:[item]})
  const result=await request(login.alice,'commands',sync,202)
  assert.equal(result.analyses[0].source,'on_device')
  assert.equal(result.analyses[0].version,1)
  assert.deepEqual(result.analyses[0].categories,['invoice'])
  assert.equal((await request(login.alice,'commands',sync,202)).analyses[0].version,1)
  await request(login.phone,'commands',command('mail.analysis.sync',{mailboxId:mail.id,items:[item]}),409)
  await request(login.bob,'mail/analysis',{mailboxId:mail.id,messageIds:[id]},404)
  const second=await request(login.phone,'commands',command('mail.analysis.sync',{
    mailboxId:mail.id,items:[{...item,expectedVersion:1,summary:'Reviewed on the phone'}],
  }),202)
  assert.equal(second.analyses[0].version,2)
  await f.restart()
  const restored=await request(login.alice,'mail/analysis',{mailboxId:mail.id,messageIds:[id]})
  assert.equal(restored.analyses[0].summary,'Reviewed on the phone')
  assert.equal(restored.analyses[0].status,'available')
  counts.providerVersion++
  await request(login.phone,'mail/read',{mailboxId:mail.id,tool:'mail_read',input:{messageId:id}})
  const stale=await request(login.phone,'mail/analysis',{mailboxId:mail.id,messageIds:[id]})
  assert.equal(stale.analyses[0].status,'stale')
  assert.equal(counts.models,0,'syncing client analysis must never invoke a cloud model')
})
