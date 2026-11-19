import { identifier, requireThat } from './protocol.mjs'
import { mailToolsFor } from './mail/index.mjs'

export const activeTaskStates = ['queued','running','waiting_mail','waiting_external','waiting_connector','waiting_user','needs_review']

export function taskMailboxes(task) {
  return task.mailboxIds || (task.mailboxId ? [task.mailboxId] : [])
}

export function historyScope(task, beforeN) {
  return {callerTaskId:task.id,allowedMailboxes:taskMailboxes(task),allowedConnectors:task.connectorIds || [],beforeN}
}

function ids(value, field, max) {
  requireThat(Array.isArray(value) && value.length <= max,'invalid_'+field)
  const result = value.map(id => identifier(id,field))
  requireThat(new Set(result).size === result.length,'duplicate_'+field)
  return result
}

export function bindResources(input, mail, extensions, {retained=false}={}) {
  const mailboxIds = ids(input.mailboxIds ?? (input.mailboxId ? [input.mailboxId] : []),'mailbox_id',20)
  if (input.mailboxId) requireThat(mailboxIds.includes(input.mailboxId),'mailbox_scope_mismatch')
  const mailEpochs = Object.fromEntries(mailboxIds.map(id => [id,mail.metadata(id).epoch]))
  const connectorIds = ids(input.connectorIds || [],'connector_id',20)
  const assetIds = ids(input.assetIds || [],'asset_id',retained ? 64 : 4)
  const additional = extensions?.bind?.({connectorIds,assetIds,mailboxIds,retained}) || {}
  requireThat(!connectorIds.length || additional.connectorEpochs,'connector_not_available',503)
  requireThat(!assetIds.length || additional.assetsBound,'assets_not_available',503)
  return {mailboxIds,mailEpochs,mailboxId:input.mailboxId || mailboxIds[0] || null,
    mailEpoch:mailboxIds.length ? mailEpochs[input.mailboxId || mailboxIds[0]] : null,
    connectorIds,connectorEpochs:additional.connectorEpochs || {},assetIds}
}

export function assertResources(task, connections, extensions) {
  for (const id of taskMailboxes(task)) connections.assertEpoch(id,task.mailEpochs?.[id] ?? task.mailEpoch)
  extensions?.assert?.(task)
}

export function selectMailbox(task, input = {}) {
  const allowed = taskMailboxes(task)
  const mailboxId = input.mailboxId || (allowed.length === 1 ? allowed[0] : null)
  requireThat(mailboxId && allowed.includes(mailboxId),'mailbox_not_in_task',403)
  const {mailboxId:ignored,...argumentsWithoutScope} = input
  return {mailboxId,epoch:task.mailEpochs?.[mailboxId] ?? task.mailEpoch,input:argumentsWithoutScope}
}

export function scopedMailTools(task, mail) {
  const mailboxes = taskMailboxes(task)
  const tools = new Map()
  for (const id of mailboxes) for (const tool of mailToolsFor(mail.metadata(id,task.mailEpochs?.[id] ?? task.mailEpoch))) {
    if (task.readOnly && tool.name==='mail_write') continue
    if (!tools.has(tool.name)) tools.set(tool.name,structuredClone(tool))
    else if (tool.name === 'mail_write') {
      const action = tools.get(tool.name).inputSchema.properties.action
      action.enum = [...new Set([...action.enum,...tool.inputSchema.properties.action.enum])]
    }
  }
  // A caller-supplied mailbox is always checked against the frozen task scope;
  // union tools do not grant an action unsupported by the selected connection.
  for (const tool of tools.values()) {
    tool.inputSchema.properties.mailboxId = {type:'string',enum:mailboxes}
    if (mailboxes.length > 1) tool.inputSchema.required = [...new Set([...(tool.inputSchema.required || []),'mailboxId'])]
    tool.description += ' Authorized mailbox IDs: '+mailboxes.join(', ')+'.'
  }
  return [...tools.values()]
}
