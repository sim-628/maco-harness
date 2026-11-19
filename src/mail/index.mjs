import {ACTIONS, hasScope, mailCapabilities, readOAuthScopes} from './policy.mjs';
export {mailCapabilities,readOAuthScopes};
export {readMailTool} from './read.mjs';
export {prepareMailCommand,executeMailCommand} from './commands.mjs';

const id = {type:'string',minLength:1,maxLength:2048};
const text = {type:'string'};
const ref = {
  type:'object',additionalProperties:false,required:['mailboxId','messageId','attachmentId'],
  properties:{mailboxId:id,messageId:id,attachmentId:id,name:text,mimeType:text,size:{type:'integer',minimum:0},version:text},
};
const assetRef = {type:'object',additionalProperties:false,required:['assetId'],properties:{assetId:{type:'string',minLength:1,maxLength:128}}};
const outboundRef = {oneOf:[ref,assetRef]};
const addressList = {type:'array',items:{type:'string'},maxItems:50};
function tool(name,description,properties,required=[]) {
  return {name,description,inputSchema:{type:'object',additionalProperties:false,properties,required}};
}

const reads=[
  tool('mail_search','Search the bound mailbox. Use scope metadata for sender/date/subject/preview queries that may use the cloud index; use fulltext (default) for facts anywhere in a message. Gmail takes Gmail syntax, Outlook takes search text. Coverage and pagination are explicit. Continue with the same query, scope, filters and nextCursor.',{query:text,scope:{type:'string',enum:['metadata','fulltext']},filters:{type:'object',additionalProperties:false,properties:{from:text,after:text,before:text,unread:{type:'boolean'},folderId:id}},limit:{type:'integer',minimum:1,maximum:8},cursor:text}),
  tool('mail_list_drafts','List up to 8 existing drafts with metadata/snippet and an explicit provider draftId for update_draft or delete_draft. draftId is separate from the message citation; never infer it from messageId. For Outlook, remove_draft_attachment also uses this draftId and an attachmentId from mail_list_attachments. Continue with the returned nextCursor; unavailable counts Gmail drafts sent/deleted while listing.',{limit:{type:'integer',minimum:1,maximum:8},cursor:text}),
  tool('mail_read','Read one message and return its mailbox/message citation, body, and truncation status.',{messageId:id},['messageId']),
  tool('mail_thread','Read a bounded conversation by the threadId returned from search or read.',{threadId:id},['threadId']),
  tool('mail_list_attachments','List original attachment references for one message. Truncation is explicit.',{messageId:id},['messageId']),
  tool('mail_read_attachment','Read UTF-8 text/plain, Markdown, CSV or JSON, up to 48 KiB, with its source reference and SHA-256.',{ref},['ref']),
  tool('mail_list_organization','List Gmail labels or Outlook folders. For Outlook, parentId lists child folders.',{parentId:id}),
];
function writer(actions) {
  return tool('mail_write',
    'Submit one mailbox command. Message organization uses messageId. mark_spam/mark_not_spam move to/from spam; they do not block senders or report abuse. Label actions use labelId or name, folder actions use folderId or name and optional parentId. delete_label removes a Gmail user label from all messages, not the messages themselves. set_categories replaces categories. Draft and outbound messages use explicit to/cc/bcc, subject and body; update_draft replaces the composition and requires draftId. Obtain existing draftId from mail_list_drafts, never infer it from messageId. delete_draft requires draftId and permanently deletes a Gmail draft. add_draft_attachment uses draftId and ref; remove_draft_attachment uses an existing Outlook draftId and attachmentId. Reply/forward take the source messageId. Attachments are original references from this mailbox or an authorized Maco asset reference {assetId}; never mix the two shapes. All attached bytes share a 512 KiB total limit. Forward quotes the source. Outbound messages, draft/label deletion and attachment removal await approval. Set scheduledAt to the Unix epoch time in milliseconds for a scheduled delivery. expectedRevision checks the Maco resource revision; expectedProviderVersion checks the message version returned from read.',
    {action:{type:'string',enum:actions},messageId:id,draftId:id,attachmentId:id,labelId:id,folderId:id,parentId:id,name:text,categories:{type:'array',items:text},to:addressList,cc:addressList,bcc:addressList,subject:text,body:text,bodyType:{enum:['text','html'],type:'string'},attachments:{type:'array',items:outboundRef,maxItems:12},ref:outboundRef,scheduledAt:{type:'integer',minimum:0},expectedRevision:{type:'integer',minimum:0},expectedProviderVersion:{type:'string',minLength:1,maxLength:2048}},['action']);
}

export const MAIL_TOOLS=[...reads,writer(ACTIONS)];
export function mailToolsFor(credential) {
  const tools=hasScope(credential,readOAuthScopes(credential.provider)) ? [...reads] : [];
  const actions=mailCapabilities(credential).filter(cap=>cap.authorized && (Array.isArray(credential.actions) && credential.actions.includes(cap.action))).map(cap=>cap.action);
  if (actions.length) tools.push(writer(actions));
  return tools;
}
