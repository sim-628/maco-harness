import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareMailCommand, executeMailCommand, MAIL_TOOLS } from '../src/mail/index.mjs'
import { assertFrozenAssetReferences, freezeAttachment } from '../src/mail/compose.mjs'
import { attachmentLimit, digest } from '../src/mail/common.mjs'
import { validateTool } from '../src/tool-policy.mjs'

const encode = value => new TextEncoder().encode(value)
const id = 'asset_12345678-1234-1234-1234-123456789abc'
const context = (provider,extra = {}) => ({mailboxId:'mailbox-one',credential:{provider,accessToken:'fixture-token',
  scopes:provider === 'gmail' ? ['https://www.googleapis.com/auth/gmail.modify'] : ['Mail.ReadWrite','Mail.Send'],
  actions:['send','reply','forward','create_draft','update_draft','add_draft_attachment']},...extra})
async function assetFixture(text = 'Approved generated report') {
  const bytes = typeof text === 'string' ? encode(text) : text
  const asset = {id,name:'report.txt',mimeType:'text/plain',size:bytes.length,sha256:await digest(bytes),source:{kind:'executor',taskId:'task-one'}}
  return {asset,bytes}
}

test('generated R2 asset enters Gmail frozen approval and sends precisely the approved bytes',async () => {
  const saved = await assetFixture()
  let reads = 0,checks = 0
  const writes = []
  const ctx = context('gmail',{
    readAsset:async (assetId,options) => {reads++;assert.equal(assetId,id);assert.equal(options.maxBytes,attachmentLimit);return structuredClone(saved)},
    assertAsset:assetId => {checks++;assert.equal(assetId,id);return saved.asset},
    fetchImpl:async (url,init) => {
      if (init.method === 'GET') {assert.ok(url.endsWith('/profile'));return Response.json({emailAddress:'owner@example.test'})}
      writes.push(JSON.parse(init.body));return Response.json({id:'provider-sent'})
    },
  })
  const input = {action:'send',to:['recipient@example.test'],subject:'Report',body:'See attachment',attachments:[{assetId:id}]}
  const prepared = await prepareMailCommand(input,ctx)
  assert.equal(prepared.requiresApproval,true)
  assert.equal(prepared.summary.attachments[0].assetId,id)
  assert.equal(prepared.summary.attachments[0].sha256,saved.asset.sha256)
  assert.equal(prepared.summary.attachments[0].name,'report.txt')
  assert.ok(!JSON.stringify(prepared.summary).includes(btoa('Approved generated report')))
  const receipt = await executeMailCommand(prepared,{...ctx,beforeWrite:() => assertFrozenAssetReferences(ctx,prepared)})
  assert.equal(receipt.status,'succeeded')
  assert.equal(receipt.accepted,true)
  assert.equal(reads,1)
  assert.equal(checks,1)
  const mime = Buffer.from(writes[0].raw,'base64url').toString()
  assert.ok(mime.includes(btoa('Approved generated report')))
  assert.ok(mime.includes("filename*=UTF-8''report.txt"))
})

test('Outlook send and draft attachment paths use approved R2 content without provider attachment fetching',async () => {
  for (const action of ['send','create_draft','add_draft_attachment']) {
    const saved = await assetFixture()
    const writes = []
    const ctx = context('outlook',{
      readAsset:async () => structuredClone(saved),assertAsset:() => saved.asset,
      fetchImpl:async (url,init) => {
        if (init.method === 'GET') {assert.ok(url.includes('/messages/draft-one'));return Response.json({id:'draft-one',isDraft:true,'@odata.etag':'W/"v1"'})}
        writes.push({url,body:JSON.parse(init.body)});return Response.json({id:'created'})
      },
    })
    const input = action === 'add_draft_attachment' ? {action,draftId:'draft-one',ref:{assetId:id}} :
      {action,to:['recipient@example.test'],body:'Report',attachments:[{assetId:id}]}
    const prepared = await prepareMailCommand(input,ctx)
    const receipt = await executeMailCommand(prepared,{...ctx,beforeWrite:() => assertFrozenAssetReferences(ctx,prepared)})
    assert.equal(receipt.status,'succeeded')
    assert.equal(writes.length,1)
    const file = action === 'add_draft_attachment' ? writes[0].body :
      action === 'send' ? writes[0].body.message.attachments[0] : writes[0].body.attachments[0]
    assert.equal(file.name,'report.txt')
    assert.equal(file.contentBytes,btoa('Approved generated report'))
    assert.equal(file['@odata.type'],'#microsoft.graph.fileAttachment')
  }
})

test('mixed asset/provider reference shapes are rejected before either adapter is called',async () => {
  const ctx = context('gmail',{readAsset:async () => assert.fail('unvalidated asset read'),fetchImpl:async () => assert.fail('unexpected provider')})
  await assert.rejects(freezeAttachment(ctx,{assetId:id,mailboxId:'mailbox-one',messageId:'m',attachmentId:'f'}),{code:'invalid_input'})
  await assert.rejects(freezeAttachment(ctx,{assetId:id,name:'overridden.txt'}),{code:'invalid_input'})
  await assert.rejects(freezeAttachment(ctx,{assetId:'https://private.example/file'}),{code:'invalid_asset_reference'})
  await assert.rejects(freezeAttachment(context('gmail'),{assetId:id}),{code:'asset_reader_unavailable'})
})

test('R2 attachment preflight checks the real hash, length, and safe headers',async () => {
  for (const change of [
    value => {value.asset.sha256='0'.repeat(64)},
    value => {value.asset.size++},
    value => {value.asset.name='x\r\nBcc: victim@example.test'},
    value => {value.asset.mimeType='text/plain\r\nInjected: x'},
    value => {value.asset.id='asset_aaaaaaaa-1234-1234-1234-123456789abc'},
  ]) {
    const saved = await assetFixture();change(saved)
    await assert.rejects(freezeAttachment(context('gmail',{readAsset:async () => saved}),{assetId:id}))
  }
  const saved = await assetFixture(new Uint8Array(attachmentLimit+1))
  await assert.rejects(freezeAttachment(context('gmail',{readAsset:async () => saved}),{assetId:id}),{code:'invalid_asset_attachment'})
})

test('R2 and provider files share the existing total 512 KiB composition bound',async () => {
  const saved = await assetFixture(new Uint8Array(300*1024))
  const limits = []
  const ctx = context('outlook',{readAsset:async (assetId,{maxBytes}) => {limits.push(maxBytes);return saved}})
  await assert.rejects(prepareMailCommand({action:'send',to:['recipient@example.test'],attachments:[{assetId:id},{assetId:id}]},ctx),{code:'invalid_asset_attachment'})
  assert.deepEqual(limits,[attachmentLimit,attachmentLimit-300*1024])
})

test('dispatch refuses deleted, revoked, changed or uncheckable R2 assets before provider writes',async () => {
  const saved = await assetFixture()
  let writes = 0
  const ctx = context('outlook',{readAsset:async () => structuredClone(saved),fetchImpl:async () => {writes++;return Response.json({id:'sent'})}})
  const prepared = await prepareMailCommand({action:'send',to:['recipient@example.test'],attachments:[{assetId:id}]},ctx)
  for (const assertAsset of [undefined,
    () => {throw Object.assign(Error(),{code:'asset_not_available',status:410})},
    () => {throw Object.assign(Error(),{code:'connection_changed',status:403})},
    () => ({...saved.asset,sha256:'0'.repeat(64)}),
    async () => saved.asset,
  ]) {
    const checked = {...ctx,assertAsset}
    const result = await executeMailCommand(prepared,{...checked,beforeWrite:() => assertFrozenAssetReferences(checked,prepared)})
    assert.equal(result.status,'failed')
  }
  assert.equal(writes,0)
})

test('source permission is checked again after an async Graph draft condition read',async () => {
  const saved = await assetFixture()
  let revoked = false,writes = 0
  const ctx = context('outlook',{readAsset:async () => saved,assertAsset:() => {
    if (revoked) throw Object.assign(Error(),{code:'connection_changed',status:403});return saved.asset
  },fetchImpl:async (url,init) => {
    if (init.method === 'GET') return Response.json({id:'draft-one',isDraft:true,'@odata.etag':'W/"v1"'})
    writes++;return Response.json({id:'new-attachment'})
  }})
  const prepared = await prepareMailCommand({action:'add_draft_attachment',draftId:'draft-one',ref:{assetId:id}},ctx)
  assertFrozenAssetReferences(ctx,prepared)
  const executing = {...ctx,fetchImpl:async (url,init) => {
    if (init.method === 'GET') {revoked=true;return Response.json({id:'draft-one',isDraft:true,'@odata.etag':'W/"v1"'})}
    writes++;return Response.json({id:'new-attachment'})
  },beforeWrite:() => assertFrozenAssetReferences(ctx,prepared)}
  assert.deepEqual(await executeMailCommand(prepared,executing),{status:'failed',code:'connection_changed'})
  assert.equal(writes,0)
})

test('model tool schema accepts either reference and rejects a mixed alternative',() => {
  const schema = MAIL_TOOLS.find(tool => tool.name === 'mail_write').inputSchema
  validateTool(schema,{action:'send',to:['recipient@example.test'],attachments:[{assetId:id}]})
  validateTool(schema,{action:'send',to:['recipient@example.test'],attachments:[{mailboxId:'mailbox-one',messageId:'m',attachmentId:'f'}]})
  validateTool(schema,{action:'add_draft_attachment',draftId:'draft-one',ref:{assetId:id}})
  assert.throws(() => validateTool(schema,{action:'send',to:['recipient@example.test'],attachments:[{assetId:id,mailboxId:'mailbox-one',messageId:'m',attachmentId:'f'}]}),{code:'invalid_tool_arguments'})
  const readSchema = MAIL_TOOLS.find(tool => tool.name === 'mail_read_attachment').inputSchema
  assert.throws(() => validateTool(readSchema,{ref:{assetId:id}}),{code:'invalid_tool_arguments'})
})
