import {approvalActions, checkAction, fault} from './policy.mjs';
import {base64url, b64, keys, request, segment, string, validId} from './common.mjs';
import {compose, freezeAttachment, graphFile, graphMessage, mailboxSender, mime} from './compose.mjs';

const delivery = ['send','reply','forward'];
const draft = ['create_draft','update_draft'];
const composition = ['to','cc','bcc','subject','body','bodyType','attachments'];
const safeDestinations = new Set(['inbox','archive','sentitems','drafts']);
const prohibitedFolders = new Set(['deleteditems','junkemail','recoverableitemsdeletions','recoverableitemsroot']);
async function safeFolder(ctx,destination) {
  validId(destination,'folderId');
  if (safeDestinations.has(destination)) return;
  if (prohibitedFolders.has(destination.toLowerCase())) throw fault('unsafe_folder');
  const folder = async id => (await request(ctx,'mailFolders/'+segment(id),{query:{$select:'id,parentFolderId,isHidden'}})).data;
  const [trash,junk,root] = await Promise.all([folder('deleteditems'),folder('junkemail'),folder('msgfolderroot')]);
  if (!trash?.id || !junk?.id || !root?.id) throw fault('unverified_folder');
  let id=destination;
  for (let depth=0;depth<16;depth++) {
    const info=await folder(id);
    if (!info?.id || !info.parentFolderId || info.id===trash.id || info.id===junk.id || info.isHidden!==false) throw fault('unsafe_folder');
    if (info.parentFolderId===root.id) return;
    id=info.parentFolderId;
  }
  throw fault('unverified_folder');
}

async function userLabel(ctx,labelId) {
  const {data} = await request(ctx,'labels/'+segment(labelId));
  if (data?.type!=='user' || data?.id!==labelId) throw fault('invalid_user_label');
  return data;
}

async function draftVersion(ctx,draftId) {
  if (ctx.credential.provider==='gmail') {
    // A Gmail draft's ID is stable but replacing its MIME changes the contained message ID.
    const {data}=await request(ctx,'drafts/'+segment(draftId),{query:{format:'minimal',fields:'id,message(id,labelIds)'}});
    if (data?.id!==draftId || !Array.isArray(data.message?.labelIds) || !data.message.labelIds.includes('DRAFT')) throw fault('not_a_draft');
    if (typeof data.message.id!=='string' || !data.message.id) throw fault('draft_version_unavailable');
    return data.message.id;
  }
  const {data} = await request(ctx,'messages/'+segment(draftId),{query:{$select:'id,isDraft,changeKey'}});
  if (data?.isDraft!==true || data.id!==draftId) throw fault('not_a_draft');
  if (typeof data['@odata.etag']!=='string' || !data['@odata.etag']) throw fault('draft_version_unavailable');
  return data['@odata.etag'];
}

// Only read metadata under the already verified draft. No attachment bytes or
// provider URLs from a model are needed to remove an existing attachment.
async function draftAttachment(ctx,draftId,attachmentId) {
  const {data}=await request(ctx,'messages/'+segment(draftId)+'/attachments/'+segment(attachmentId),{
    query:{$select:'id,name,size,contentType,isInline,lastModifiedDateTime'},
  });
  if (data?.id!==attachmentId) throw fault('attachment_mismatch');
  if (!Number.isSafeInteger(data.size) || data.size<0 || typeof data.isInline!=='boolean') throw fault('invalid_provider_response');
  return {
    attachmentId, name:string(data.name,'attachmentName',2048), size:data.size,
    mimeType:string(data.contentType ?? '', 'attachmentContentType',256), isInline:data.isInline,
    lastModifiedDateTime:string(data.lastModifiedDateTime,'attachmentModifiedAt',128,true),
  };
}

const command = (method,path,body) => ({method,path,...(body===undefined?{}:{body})});
function requiredName(name) {
  const clean = string(name,'name',200,true);
  if (!clean.trim()) throw fault('invalid_input');
  return clean;
}

async function composeCommand(ctx,input) {
  const {action}=input;
  const isDraft=draft.includes(action), isUpdate=action==='update_draft';
  const gmail=ctx.credential.provider==='gmail';
  const extras=isUpdate?['draftId']:['reply','forward'].includes(action)?['messageId']:[];
  keys(input,['action',...composition,...extras]);
  const draftId=isUpdate?validId(input.draftId):null;
  if (isUpdate && !gmail && input.attachments!==undefined) throw fault('use_add_draft_attachment');
  const {message,summary}=await compose(ctx,input);
  if (gmail || action==='reply') {
    message.from=await mailboxSender(ctx);
    summary.from=message.from;
  }
  let call, condition;
  if (isDraft) {
    if (isUpdate) condition={draftId,version:await draftVersion(ctx,draftId)};
    if (gmail) {
      call=command(isUpdate?'PUT':'POST',isUpdate?'drafts/'+segment(draftId):'drafts',{message:{raw:base64url(mime(message))}});
    } else {
      call=command(isUpdate?'PATCH':'POST',isUpdate?'messages/'+segment(draftId):'messages',graphMessage(message));
    }
  } else if (gmail) {
    call=command('POST','messages/send',{raw:base64url(mime(message)),...(message.threadId ? {threadId:message.threadId}:{})});
  } else if (action==='reply') {
    // Graph sendMail accepts RFC message headers through the MIME variant, including In-Reply-To.
    call={...command('POST','sendMail',b64(mime(message))),contentType:'text/plain'};
  } else {
    call=command('POST','sendMail',{message:graphMessage(message),saveToSentItems:true});
  }
  const resource = draftId ? (gmail?'draft:':'message:')+draftId : action==='reply' || action==='forward' ? 'message:'+input.messageId : action+':'+crypto.randomUUID();
  return {resource,summary:{...(draftId?{draftId}:{}),...summary},payload:{call,condition}};
}

async function organize(ctx,input) {
  const {action}=input;
  const gmail=ctx.credential.provider==='gmail';
  if (action==='delete_draft') {
    keys(input,['action','draftId']);
    const id=validId(input.draftId);
    const condition={draftId:id,version:await draftVersion(ctx,id)};
    const call=command('DELETE',(gmail?'drafts/':'messages/')+segment(id));
    return {resource:(gmail?'draft:':'message:')+id,
      summary:{draftId:id,providerVersion:condition.version,disposition:gmail?'permanent_draft_delete':'provider_draft_delete'},
      payload:{call,condition}};
  }
  if (action==='delete_label') {
    keys(input,['action','labelId']);
    const id=validId(input.labelId);
    const label=await userLabel(ctx,id);
    const name=string(label.name,'labelName',2048);
    const condition={label:id,labelName:name};
    return {resource:'labels:'+id,summary:{labelId:id,name,disposition:'delete_label_and_remove_from_messages'},
      payload:{call:command('DELETE','labels/'+segment(id)),condition}};
  }
  if (['create_label','rename_label','create_folder','rename_folder'].includes(action)) {
    const create=action.startsWith('create');
    const key=gmail?'labelId':'folderId';
    keys(input,['action','name',...(create ? (!gmail?['parentId']:[]) : [key])]);
    const name=requiredName(input.name);
    const id=create ? null : validId(input[key]);
    const target=gmail ? 'labels' : 'mailFolders';
    let path=create ? target : target+'/'+segment(id), condition;
    if (input.parentId) {condition={folder:validId(input.parentId)}; path='mailFolders/'+segment(input.parentId)+'/childFolders';}
    if (gmail && id) condition={label:id};
    if (!gmail && id) condition={folder:id};
    await checkCondition(ctx,condition);
    const call=command(create?'POST':'PATCH',path,gmail?{name}:{displayName:name});
    return {resource:target+':'+(id || (input.parentId || '')+'/'+name),summary:{...input},payload:{call,condition}};
  }
  if (action==='add_draft_attachment') {
    keys(input,['action','draftId','ref']);
    const id=validId(input.draftId);
    const condition={draftId:id,version:await draftVersion(ctx,id)};
    const file=await freezeAttachment(ctx,input.ref);
    const call=command('POST','messages/'+segment(id)+'/attachments',graphFile(file));
    return {resource:'message:'+id,summary:{draftId:id,attachment:file.meta},payload:{call,condition}};
  }
  if (action==='remove_draft_attachment') {
    keys(input,['action','draftId','attachmentId']);
    const id=validId(input.draftId),attachmentId=validId(input.attachmentId,'attachmentId');
    const condition={draftId:id,version:await draftVersion(ctx,id)};
    condition.attachment=await draftAttachment(ctx,id,attachmentId);
    const call=command('DELETE','messages/'+segment(id)+'/attachments/'+segment(attachmentId));
    return {resource:'message:'+id,summary:{draftId:id,providerVersion:condition.version,attachment:{...condition.attachment}},payload:{call,condition}};
  }
  const extras={add_label:['labelId'],remove_label:['labelId'],move:['folderId'],restore:gmail?[]:['folderId'],set_categories:['categories']};
  keys(input,['action','messageId',...(extras[action] || [])]);
  const id=validId(input.messageId),path='messages/'+segment(id);
  let call,condition;
  if (gmail) {
    if (action==='trash' || action==='restore') call=command('POST',path+'/'+(action==='trash'?'trash':'untrash'));
    else {
      // Mirrors GmailMailService.mutate's standard folder and flag mappings.
      const labels={mark_read:[[],['UNREAD']],mark_unread:[['UNREAD'],[]],star:[['STARRED'],[]],unstar:[[],['STARRED']],archive:[[],['INBOX','SPAM']],move_to_inbox:[['INBOX'],['SPAM']],
        mark_spam:[['SPAM'],['INBOX']],mark_not_spam:[['INBOX'],['SPAM']],mark_important:[['IMPORTANT'],[]],mark_unimportant:[[],['IMPORTANT']]};
      if (action==='add_label' || action==='remove_label') {
        const label=validId(input.labelId);
        condition={label};
        await checkCondition(ctx,condition);
        labels[action]=action==='add_label'?[[label],[]]:[[],[label]];
      }
      const pair=labels[action];
      if (!pair) throw fault('unsupported_action');
      call=command('POST',path+'/modify',{addLabelIds:pair[0],removeLabelIds:pair[1]});
    }
  } else {
    const patches={mark_read:{isRead:true},mark_unread:{isRead:false},star:{flag:{flagStatus:'flagged'}},unstar:{flag:{flagStatus:'notFlagged'}},
      mark_important:{importance:'high'},mark_unimportant:{importance:'normal'}};
    if (action==='set_categories') {
      if (!Array.isArray(input.categories) || input.categories.length>24) throw fault('invalid_categories');
      patches[action]={categories:input.categories.map(requiredName)};
    }
    if (patches[action]) call=command('PATCH',path,patches[action]);
    else {
      // These are mailbox moves, not junk-reporting or sender-blocking APIs.
      const destinations={archive:'archive',trash:'deleteditems',restore:input.folderId??'inbox',move_to_inbox:'inbox',move:input.folderId,
        mark_spam:'junkemail',mark_not_spam:'inbox'};
      const folder=validId(destinations[action],'folderId');
      if (action==='move' || action==='restore') {condition={folder}; await checkCondition(ctx,condition);}
      call=command('POST',path+'/move',{destinationId:folder});
    }
  }
  return {resource:'message:'+id,summary:{...input},payload:{call,condition}};
}

const versionedActions = new Set([
  'mark_read','mark_unread','star','unstar','archive','trash','restore','move_to_inbox',
  'add_label','remove_label','move','set_categories','reply','forward',
  'mark_spam','mark_not_spam','mark_important','mark_unimportant',
]);

async function messageVersion(ctx,id) {
  const gmail=ctx.credential.provider==='gmail';
  const query=gmail ? {format:'minimal',fields:'id,historyId'} : {$select:'id,changeKey'};
  const {data}=await request(ctx,'messages/'+segment(id),{query});
  const version=gmail ? data?.historyId : data?.changeKey;
  if (data?.id!==id || typeof version!=='string' || !version) throw fault('provider_version_unavailable');
  return {version,etag:data['@odata.etag']};
}

async function checkCondition(ctx,condition) {
  if (condition?.label) {
    const label=await userLabel(ctx,condition.label);
    if (condition.labelName!==undefined && label.name!==condition.labelName) throw fault('version_conflict');
  }
  if (condition?.folder) await safeFolder(ctx,condition.folder);
  if (condition?.message && (await messageVersion(ctx,condition.message.id)).version!==condition.message.version) throw fault('version_conflict');
  if (condition?.attachment) {
    const current=await draftAttachment(ctx,condition.draftId,condition.attachment.attachmentId);
    if (JSON.stringify(current)!==JSON.stringify(condition.attachment)) throw fault('version_conflict');
  }
  if (condition?.draftId && await draftVersion(ctx,condition.draftId)!==condition.version) throw fault('version_conflict');
}

export async function prepareMailCommand(input,ctx) {
  const action=input?.action;
  checkAction(ctx.credential,action);
  validId(ctx.mailboxId,'mailboxId');
  let condition;
  if (ctx.expectedProviderVersion!==undefined) {
    if (!versionedActions.has(action)) throw fault('unsupported_version_condition');
    const expected=string(ctx.expectedProviderVersion,'expectedProviderVersion',2048,true);
    const id=validId(input.messageId);
    condition=await messageVersion(ctx,id);
    if (!expected || condition.version!==expected) throw fault('version_conflict');
    condition.id=id;
  }
  const prepared = await (delivery.includes(action) || draft.includes(action) ? composeCommand(ctx,input) : organize(ctx,input));
  if (condition) {
    const source=prepared.summary.source;
    if (source && source.version!==condition.version) throw fault('version_conflict');
    prepared.payload.condition={...prepared.payload.condition,message:condition};
    prepared.summary.providerVersion=condition.version;
  }
  return {action,mailboxId:ctx.mailboxId,provider:ctx.credential.provider,requiresApproval:approvalActions.has(action),...prepared};
}

export async function executeMailCommand(prepared,ctx) {
  try {
    if (prepared.mailboxId!==ctx.mailboxId || prepared.provider!==ctx.credential.provider) throw fault('mailbox_mismatch');
    checkAction(ctx.credential,prepared.action);
    const {call,condition}=prepared.payload;
    await checkCondition(ctx,condition);
    const options={...call};
    // An attachment is a separate Graph resource: its parent's ETag is not the
    // attachment ETag. For removal we recheck metadata and then the draft version
    // immediately before DELETE; Graph's attachment API promises no parent CAS.
    if (condition?.draftId && !condition.attachment && ctx.credential.provider==='outlook') options.headers={'If-Match':condition.version};
    if (condition?.message?.etag && call.method==='PATCH' && ctx.credential.provider==='outlook') {
      options.headers={'If-Match':condition.message.etag};
    }
    const {status,data}=await request(ctx,call.path,options);
    const providerId = data?.id;
    // If move/create succeeded but the new identity is unavailable it must be reconciled before reuse.
    if ((call.path.endsWith('/move') || ['create_draft','create_label','create_folder'].includes(prepared.action)) && !providerId) throw fault('submission_unknown');
    return {status:'succeeded',httpStatus:status,...(typeof providerId==='string'?{providerId}:{}),...((data?.changeKey || data?.historyId)?{providerVersion:data.changeKey || data.historyId}:{}),...(delivery.includes(prepared.action)?{accepted:true}:{})};
  } catch(error) {
    return {status:error.code==='submission_unknown'?'unknown':'failed',code:error.code || 'provider_error',...(error.httpStatus?{httpStatus:error.httpStatus}:{}),...(error.retryAfterMs?{retryAfterMs:error.retryAfterMs}:{})};
  }
}
