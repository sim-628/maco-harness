import { fingerprint, requireThat } from './protocol.mjs'
import { validateArguments } from './connectors/schema.mjs'
import { ASK_USER_TOOL } from './interactions.mjs'
import { assertResources } from './task-scope.mjs'

const object = (properties,required=[]) => ({type:'object',additionalProperties:false,properties,required})
const string = maxLength => ({type:'string',minLength:1,maxLength})
const assetId = string(80)
const tool = (name,description,properties,required,barrier=false) => ({name,description,inputSchema:object(properties,required),binding:{kind:'asset',barrier}})
const assetTools = [
  tool('asset_list','List the files explicitly attached to this task, including generated artifacts.',{},[]),
  tool('asset_read','Read a bounded text page from an attached file. Inspect coverage; non-empty text is not proof that scans, images or all pages were understood. If pending, use asset_parse to wait.',
    {assetId,page:{type:'integer',minimum:1,maximum:1000},offset:{type:'integer',minimum:0,maximum:8000000}},['assetId']),
  tool('asset_search','Search parsed text in one attached file. Coverage and truncation remain relevant to every match.',
    {assetId,query:string(500)},['assetId','query']),
  tool('asset_parse','Parse an attached file and wait durably. Auto uses configured local/Cloudflare conversion; explicit DeepSeek OCR requires an operator API key. A failed or unknown job is not retried automatically.',
    {assetId,parser:{type:'string',enum:['auto','local','cloudflare','deepseek']}},['assetId'],true),
  tool('asset_import_mail','Import one attachment from an authorized mailbox into private file storage. Use the exact reference returned by mail_list_attachments.',
    {mailboxId:string(128),messageId:string(2048),attachmentId:string(2048)},['mailboxId','messageId','attachmentId'],true)
]
const delegateTool = {
  name:'delegate_task',description:'Delegate a bounded file-analysis or computation task to the separately enabled hosted executor. It has no mail/MCP tools or account credentials. Return only the needed input, never keys or tokens. It uses a separate operator-billed model. Results and generated files return to this task; only local mail_write may send them.',
  binding:{kind:'hosted',barrier:true},inputSchema:object({instructions:string(12000),input:{type:'string',maxLength:24000},
    attachmentIds:{type:'array',maxItems:4,items:assetId}},['instructions'])
}
const terminalConnector = new Set(['succeeded','failed','cancelled','rejected'])
const terminalExecution = new Set(['completed','failed','cancelled','unknown'])

/** Adapts independent capabilities to the harness. It owns no scheduler or
 * credential storage; all external work uses the account's existing ledgers. */
export class RuntimeTools {
  constructor(service) { this.service=service }
  bind({connectorIds,assetIds,mailboxIds,retained}) {
    const {connectors,assets}=this.service
    const connectorEpochs=Object.fromEntries(connectorIds.map(id=>{
      const connection=connectors.get(id)
      connectors.assertEpoch(id,connection.epoch)
      return [id,connection.epoch]
    }))
    if (retained) assetIds.forEach(id=>assets.get(id))
    else assets.validateRefs(assetIds)
    for (const id of assetIds) this.checkAssetSource(assets.get(id),mailboxIds)
    return {connectorEpochs,assetsBound:true}
  }
  checkAssetSource(asset,mailboxIds) {
    if (asset.source?.kind==='mail') requireThat(mailboxIds.includes(asset.source.mailboxId),'asset_mailbox_not_in_task',403)
  }
  assert(task) {
    this.service.assertAvailable()
    this.service.sessions.assertActive(task.authorizationSession)
    const {connectors,assets}=this.service
    for (const id of task.connectorIds || []) connectors.assertEpoch(id,task.connectorEpochs[id])
    for (const id of task.assetIds || []) {
      const asset=assets.get(id)
      this.checkAssetSource(asset,task.mailboxIds || (task.mailboxId ? [task.mailboxId] : []))
    }
  }
  current(task) {
    const latest=this.service.store.getTask(task.id)
    requireThat(latest.runId===task.runId && latest.version===task.version && latest.state==='running','run_superseded',409)
    this.service.connections.assertEpoch(task.profile.connectionId,task.modelEpoch)
    assertResources(task,this.service.connections,this)
    return latest
  }
  async tools(task) {
    const {connectors,assets,hosted}=this.service
    const result=[ASK_USER_TOOL]
    if (assets.env.ASSETS) result.push(...assetTools.filter(tool=>tool.name!=='asset_import_mail' || task.mailboxIds?.length))
    if (task.allowHosted && hosted.capabilities().enabled) result.push(delegateTool)
    for (const id of task.connectorIds || []) for (const definition of connectors.tools(id)) {
      if (task.readOnly && (definition.access!=='read' || definition.requiresApproval)) continue
      requireThat(result.length<48,'tool_capacity_exceeded',422)
      const digest=await fingerprint([id,definition.name,definition.schemaDigest])
      result.push({name:'mcp_'+digest.slice(0,32),description:definition.description || definition.name,
        inputSchema:definition.inputSchema,validate:validateArguments,
        binding:{kind:'connector',connectionId:id,epoch:task.connectorEpochs[id],tool:definition.name,
          schemaDigest:definition.schemaDigest,barrier:definition.access!=='read' || definition.requiresApproval}})
    }
    return result
  }
  asset(task,id) {
    requireThat(task.assetIds?.includes(id),'asset_not_in_task',403)
    return this.service.assets.get(id)
  }
  connector(call,task) {
    const binding=call.binding
    requireThat(task.connectorIds?.includes(binding.connectionId) && task.connectorEpochs[binding.connectionId]===binding.epoch,'connector_not_in_task',403)
    const current=this.service.connectors.tools(binding.connectionId).find(tool=>tool.name===binding.tool)
    requireThat(current && current.schemaDigest===binding.schemaDigest,'connector_tool_changed',409)
    validateArguments(current.inputSchema,call.arguments)
    return {connectionId:binding.connectionId,expectedEpoch:binding.epoch,tool:binding.tool,arguments:call.arguments,taskId:task.id,runId:task.runId}
  }
  async read(call,task,signal) {
    const {assets,connectors}=this.service
    this.current(task)
    if (call.binding.kind==='connector') return connectors.read({...this.connector(call,task),signal})
    if (call.name==='asset_list') return {assets:(task.assetIds || []).map(id=>assets.get(id))}
    this.asset(task,call.arguments.assetId)
    if (call.name==='asset_read') return assets.read(call.arguments.assetId,{page:call.arguments.page,offset:call.arguments.offset})
    if (call.name==='asset_search') return assets.search(call.arguments.assetId,{query:call.arguments.query})
    requireThat(false,'tool_not_allowed',403)
  }
  accepted(call,task,id) {
    if (call.binding?.kind==='connector') return Boolean(this.service.connectors.operation(id))
    if (call.binding?.kind==='hosted') return Boolean(this.service.hosted.find({parentTaskId:task.id,runId:task.runId,runVersion:task.version,requestId:id}))
    return false
  }
  async execute(call,task,signal,id) {
    const {store,assets,connectors,hosted,interactions,memory}=this.service
    this.current(task)
    if (call.binding.kind==='interaction') {
      const interaction=interactions.start(task,id,call.arguments)
      return interaction.state==='waiting' ? {wait:{kind:'interaction',state:'waiting_user',interactionId:id}} : {result:interaction}
    }
    if (call.binding.kind==='connector') {
      let operation=connectors.operation(id)
      if (!operation) {
        const plan=await connectors.plan({...this.connector(call,task),signal})
        this.current(task)
        requireThat(task.pending.memoryEpoch===memory.state().epoch,'memory_context_changed',409)
        operation=store.tx(()=>connectors.accept(plan,{id,commandId:id,taskId:task.id,runId:task.runId}))
      }
      if (terminalConnector.has(operation.state)) return {result:operation}
      return {wait:{kind:'connector',state:operation.state==='unknown' ? 'needs_review' : 'waiting_connector',operationId:id}}
    }
    if (call.binding.kind==='hosted') {
      let execution=hosted.find({parentTaskId:task.id,runId:task.runId,runVersion:task.version,requestId:id})
      if (!execution) {
        requireThat(task.allowHosted,'hosted_not_allowed_for_task',403)
        requireThat((task.assetIds || []).length<=60,'task_asset_capacity_reached',409)
        for (const assetId of call.arguments.attachmentIds || []) this.asset(task,assetId)
        execution=hosted.start({parentTaskId:task.id,runId:task.runId,runVersion:task.version,requestId:id,
          instructions:call.arguments.instructions,input:call.arguments.input || '',attachmentIds:call.arguments.attachmentIds || [],
          authority:{memoryEpoch:memory.state().epoch,modelEpoch:task.modelEpoch,
            mailEpochs:task.mailEpochs || {},connectorEpochs:task.connectorEpochs || {}}})
      }
      if (terminalExecution.has(execution.state) && execution.delivered) {
        const artifacts=execution.result?.artifacts || []
        requireThat(new Set([...(task.assetIds || []),...artifacts.map(asset=>asset.id)]).size<=64,'task_asset_capacity_reached',409)
        for (const asset of artifacts) assets.get(asset.id)
        task.assetIds=[...new Set([...(task.assetIds || []),...artifacts.map(asset=>asset.id)])]
        return {result:execution}
      }
      return {wait:{kind:'hosted',state:'waiting_external',delegationId:execution.executionId}}
    }
    if (call.name==='asset_import_mail') {
      requireThat(task.mailboxIds?.includes(call.arguments.mailboxId),'mailbox_not_in_task',403)
      requireThat((task.assetIds || []).length<64,'too_many_task_assets',409)
      const selected=this.service.index.resolveInput(call.arguments.mailboxId,{messageId:call.arguments.messageId})
      const asset=await assets.importMail({...call.arguments,messageId:selected.messageId,expectedEpoch:task.mailEpochs[call.arguments.mailboxId],taskId:task.id})
      this.current(task)
      task.assetIds=[...(task.assetIds || []),asset.id]
      return {result:{asset}}
    }
    if (call.name==='asset_parse') {
      this.asset(task,call.arguments.assetId)
      const job=assets.parse(call.arguments.assetId,{parser:call.arguments.parser || 'auto'})
      if (['succeeded','failed','unknown','cancelled'].includes(job.state)) return {result:job}
      return {wait:{kind:'asset',state:'waiting_external',delegationId:job.id,assetId:call.arguments.assetId}}
    }
    requireThat(false,'tool_not_allowed',403)
  }
  cancel(task) {
    this.service.interactions.cancelForTask(task.id)
    this.service.hosted.cancelForTask(task.id,'parent_cancelled')
    for (const [index,call] of (task.pending?.calls || []).entries()) {
      if (index<(task.pending?.index || 0) || call.binding?.kind!=='connector') continue
      const id='tool:'+task.runId+':'+task.step+':'+index
      const op=this.service.connectors.operation(id)
      if (op && ['waiting_approval','queued'].includes(op.state)) this.service.connectors.cancel({operationId:id,approvalVersion:op.approvalVersion})
    }
  }
}
