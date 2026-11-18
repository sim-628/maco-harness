import {checkRead, fault} from './policy.mjs';
import {attachmentLimit, bodyLimit, decoder, digest, keys, request, segment, string, unbase64, validId} from './common.mjs';

export const listingFields = 'id,conversationId,subject,from,toRecipients,ccRecipients,replyTo,receivedDateTime,sentDateTime,bodyPreview,isRead,flag,parentFolderId,changeKey,internetMessageId,hasAttachments,isDraft,categories';
const metadataFields = 'id,name,size,contentType,isInline,lastModifiedDateTime';
const maxResults = 8;
const trunc = (value,max=512) => String(value || '').slice(0,max);
const graphAddress = item => trunc(item?.emailAddress?.address,320);
const messagePath = id => 'messages/' + segment(id);
const citation = (ctx,messageId) => ({mailboxId:ctx.mailboxId,messageId});

function walk(payload) {
  const parts = [];
  const stack = [payload];
  while (stack.length) {
    if (parts.length + stack.length > 500) throw fault('message_too_complex');
    const part = stack.pop();
    if (!part) continue;
    parts.push(part);
    if (part.parts?.length) {
      if (parts.length + stack.length + part.parts.length > 500) throw fault('message_too_complex');
      stack.push(...part.parts.slice().reverse());
    }
  }
  return parts;
}

export function gmailView(ctx, msg, includeBody) {
  const headers = msg.payload?.headers || [];
  const header = key => trunc(headers.find(x=>x.name.toLowerCase() === key)?.value, 2048);
  const result = {citation:citation(ctx,msg.id),threadId:msg.threadId,version:msg.historyId,subject:header('subject'),from:header('from'),replyTo:header('reply-to'),internetMessageId:header('message-id'),references:header('references'),date:msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : header('date'),to:header('to'),cc:header('cc'),preview:trunc(msg.snippet),labels:msg.labelIds || [],isRead:!(msg.labelIds || []).includes('UNREAD'),isStarred:(msg.labelIds || []).includes('STARRED'),isDraft:(msg.labelIds || []).includes('DRAFT')};
  if (includeBody) {
    const parts = walk(msg.payload).filter(p=>!p.filename && (p.body?.data || p.body?.attachmentId));
    const plain = parts.filter(p=>p.mimeType === 'text/plain');
    const chosen = plain.length ? plain : parts.filter(p=>p.mimeType === 'text/html');
    let body = '';
    for (const part of chosen) {
      if (body.length > bodyLimit) break;
      if (!part.body.data) continue;
      // Read a bounded base64 prefix on a quartet boundary.
      const prefix = part.body.data.slice(0,4*Math.ceil((bodyLimit+3)/3));
      body += decoder.decode(unbase64(prefix,bodyLimit+6)) + '\n';
    }
    result.body = body.slice(0,bodyLimit).trimEnd();
    result.bodyType = plain.length ? 'text' : chosen.length ? 'html' : 'text';
    result.truncated = body.length > bodyLimit || chosen.some(p=>p.body?.size > bodyLimit || (p.body?.attachmentId && !p.body?.data));
  }
  return result;
}

export function graphView(ctx, msg) {
  const result = {citation:citation(ctx,msg.id),threadId:msg.conversationId,version:msg.changeKey,subject:trunc(msg.subject,2048),from:graphAddress(msg.from),replyTo:(msg.replyTo || []).map(graphAddress).join(', '),internetMessageId:trunc(msg.internetMessageId,1024),date:msg.receivedDateTime,to:(msg.toRecipients || []).map(graphAddress).join(', '),cc:(msg.ccRecipients || []).map(graphAddress).join(', '),preview:trunc(msg.bodyPreview),isRead:msg.isRead,isStarred:msg.flag?.flagStatus === 'flagged',isDraft:msg.isDraft,hasAttachments:msg.hasAttachments,categories:msg.categories || [],folderId:msg.parentFolderId};
  if (msg.body) {
    result.body = trunc(msg.body.content,bodyLimit);
    result.bodyType = msg.body.contentType === 'html' ? 'html' : 'text';
    result.truncated = (msg.body.content || '').length > bodyLimit;
  }
  return result;
}

export async function readMessage(ctx,id) {
  checkRead(ctx.credential);
  const gmail = ctx.credential.provider === 'gmail';
  const query = gmail ? {format:'full'} : {$select:listingFields+',body'};
  const {data} = await request(ctx,messagePath(id),{query});
  if (data?.id !== id) throw fault('invalid_provider_response');
  if (!gmail) return graphView(ctx,data);
  // Gmail can store an ordinary textual body part in the attachments endpoint.
  // Fetch at most the bounded text budget, and keep partial coverage visible.
  let remaining=bodyLimit, reads=0;
  const parts=walk(data.payload).filter(p=>!p.filename && /^text\/(plain|html)$/.test(p.mimeType));
  const plain=parts.filter(p=>p.mimeType==='text/plain');
  for (const part of (plain.length ? plain : parts)) {
    if (part.body?.data || !part.body?.attachmentId) continue;
    const size=part.body.size;
    if (!Number.isSafeInteger(size) || size<0 || size>remaining || reads>=4) continue;
    reads++;
    remaining-=size;
    const {data:result}=await request(ctx,messagePath(id)+'/attachments/'+segment(part.body.attachmentId),{max:4*Math.ceil(size/3)+16384});
    unbase64(result?.data,size);
    part.body.data=result.data;
  }
  return gmailView(ctx,data,true);
}

function graphCursor(link, expectedPath) {
  if (!link) return null;
  let url;
  try {
    if (typeof link!=='string' || link.length>8192) throw Error();
    url=new URL(link);
    if (url.origin!=='https://graph.microsoft.com' || url.username || url.password || url.hash ||
      (expectedPath && decodeURIComponent(url.pathname)!==decodeURIComponent('/v1.0/me/'+expectedPath))) throw Error();
  } catch {throw fault('invalid_provider_response');}
  const continuationKeys=['$skiptoken','$skip'].filter(key=>url.searchParams.has(key));
  if (continuationKeys.length!==1) throw fault('invalid_provider_response');
  for (const key of ['$skiptoken','$skip']) {
    const value=url.searchParams.get(key);
    if (url.searchParams.getAll(key).length>1) throw fault('invalid_provider_response');
    if (value) {
      const cursor=key+'='+value;
      try {applyGraphCursor({},cursor);} catch {throw fault('invalid_provider_response');}
      return cursor;
    }
  }
  throw fault('invalid_provider_response');
}

function applyGraphCursor(query, value) {
  if (!value) return;
  const match = /^(\$skiptoken|\$skip)=(.+)$/.exec(value);
  if (!match || value.length>4096 || /[\x00-\x1f\x7f]/.test(value) ||
    (match[1]==='$skip' && !/^\d{1,15}$/.test(match[2]))) throw fault('invalid_cursor');
  query[match[1]]=match[2];
}

async function listDrafts(ctx,input) {
  keys(input,['limit','cursor']);
  const limit=input.limit ?? maxResults;
  if (!Number.isInteger(limit) || limit<1 || limit>maxResults) throw fault('invalid_input');
  const cursor=string(input.cursor ?? '', 'cursor',4096,true);
  const gmail=ctx.credential.provider==='gmail';
  const prefix=gmail?'gmail-drafts:':'graph-drafts:';
  if (cursor && (!cursor.startsWith(prefix) || cursor.length===prefix.length)) throw fault('invalid_cursor');
  const continuation=cursor.slice(prefix.length);
  if (gmail) {
    const {data}=await request(ctx,'drafts',{query:{maxResults:limit,pageToken:continuation || undefined}});
    if (!data || (data.drafts!==undefined && !Array.isArray(data.drafts)) || (data.drafts?.length || 0)>limit) throw fault('invalid_provider_response');
    let nextCursor=null;
    if (data.nextPageToken!==undefined) {
      if (typeof data.nextPageToken!=='string' || !data.nextPageToken || data.nextPageToken.length>4096-prefix.length || /[\x00-\x1f\x7f]/.test(data.nextPageToken)) throw fault('invalid_provider_response');
      nextCursor=prefix+data.nextPageToken;
    }
    const matches=await Promise.all((data.drafts || []).map(async item=>{
      const draftId=validId(item?.id,'draftId');
      let draft;
      try {
        ({data:draft}=await request(ctx,'drafts/'+segment(draftId),{
          query:{format:'metadata',fields:'id,message(id,threadId,historyId,labelIds,snippet,internalDate,payload(headers))'},
        }));
      } catch(error) {
        // A draft may have been sent/deleted since the listing. Preserve page
        // continuation and report the missing item instead of inventing an ID.
        if (error.code==='not_found') return null;
        throw error;
      }
      if (draft?.id!==draftId || !Array.isArray(draft.message?.labelIds) || !draft.message.labelIds.includes('DRAFT')) throw fault('invalid_provider_response');
      validId(draft.message.id,'messageId');
      return {...gmailView(ctx,draft.message,false),draftId};
    }));
    return {matches:matches.filter(Boolean),nextCursor,unavailable:matches.filter(item=>item===null).length};
  }
  const path='mailFolders/drafts/messages';
  const query={$select:listingFields,$top:limit,$filter:'isDraft eq true'};
  applyGraphCursor(query,continuation);
  const {data}=await request(ctx,path,{query});
  if (!Array.isArray(data?.value) || data.value.length>limit) throw fault('invalid_provider_response');
  const matches=data.value.map(message=>{
    const draftId=validId(message?.id,'draftId');
    if (message.isDraft!==true) throw fault('invalid_provider_response');
    // Never expose a full body from a listing even if a provider ignores $select.
    return {...graphView(ctx,{...message,body:undefined}),draftId};
  });
  const token=graphCursor(data['@odata.nextLink'],path);
  if (token && token.length>4096-prefix.length) throw fault('invalid_provider_response');
  return {matches,nextCursor:token?prefix+token:null,unavailable:0};
}

async function search(ctx,input) {
  keys(input,['query','limit','cursor','filters']);
  const q = string(input.query ?? '','query',2048,true);
  const limit = input.limit ?? maxResults;
  if (!Number.isInteger(limit) || limit<1 || limit>maxResults) throw fault('invalid_input');
  const cursor = string(input.cursor ?? '','cursor',4096,true);
  const filters = input.filters || {};
  keys(filters,['from','after','before','unread','folderId']);
  if (filters.from != null) string(filters.from,'from',320,true);
  for (const key of ['after','before']) if (filters[key] != null && !Number.isFinite(Date.parse(filters[key]))) throw fault('invalid_input');
  if (filters.unread != null && typeof filters.unread !== 'boolean') throw fault('invalid_input');
  if (filters.folderId != null) validId(filters.folderId);
  if (ctx.credential.provider === 'gmail') {
    const terms = q ? ['('+q+')'] : [];
    if (filters.from) terms.push('from:'+JSON.stringify(filters.from));
    if (filters.after) terms.push('after:'+Math.floor(Date.parse(filters.after)/1000));
    if (filters.before) terms.push('before:'+Math.ceil(Date.parse(filters.before)/1000));
    if (filters.unread != null) terms.push(filters.unread ? 'is:unread' : 'is:read');
    const {data} = await request(ctx,'messages',{query:{q:terms.join(' '),maxResults:limit,pageToken:cursor || undefined,labelIds:filters.folderId,includeSpamTrash:true}});
    const matches = [];
    for (const item of (data?.messages || []).slice(0,limit)) {
      const response = await request(ctx,messagePath(item.id),{query:{format:'metadata',fields:'id,threadId,historyId,labelIds,snippet,internalDate,payload(headers)'}});
      matches.push(gmailView(ctx,response.data,false));
    }
    return {matches,nextCursor:data?.nextPageToken || null};
  }
  const query = {$select:listingFields,$top:limit};
  const clauses=[];
  if (filters.after) clauses.push('receivedDateTime ge '+new Date(filters.after).toISOString());
  if (filters.before) clauses.push('receivedDateTime lt '+new Date(filters.before).toISOString());
  if (filters.from) clauses.push("from/emailAddress/address eq '"+filters.from.replace(/'/g,"''")+"'");
  if (filters.unread != null) clauses.push('isRead eq '+String(!filters.unread));
  if (q) query.$search = JSON.stringify(q);
  else if (clauses.length) query.$filter=clauses.join(' and ');
  applyGraphCursor(query,cursor);
  const path=filters.folderId ? 'mailFolders/'+segment(filters.folderId)+'/messages' : 'messages';
  const {data} = await request(ctx,path,{query});
  // Graph search and filter support differs. When using $search, apply structured
  // constraints to this page and expose pagination rather than silently dropping it.
  const matches=(data?.value || []).slice(0,limit).filter(m=>!q || (
    (!filters.from || graphAddress(m.from).toLowerCase()===filters.from.toLowerCase()) &&
    (!filters.after || Date.parse(m.receivedDateTime)>=Date.parse(filters.after)) &&
    (!filters.before || Date.parse(m.receivedDateTime)<Date.parse(filters.before)) &&
    (filters.unread == null || m.isRead===!filters.unread)
  )).map(m=>graphView(ctx,m));
  return {matches,nextCursor:graphCursor(data?.['@odata.nextLink'],path)};
}

async function thread(ctx,{threadId}) {
  validId(threadId);
  if (ctx.credential.provider === 'gmail') {
    const {data} = await request(ctx,'threads/'+segment(threadId),{query:{format:'full'}});
    const list = data.messages || [];
    return {messages:list.slice(-maxResults).map(m=>gmailView(ctx,m,true)),truncated:list.length>maxResults};
  }
  const {data} = await request(ctx,'messages',{query:{$filter:"conversationId eq '"+threadId.replace(/'/g,"''")+"'",$select:listingFields+',body',$top:maxResults}});
  return {messages:(data.value || []).slice(0,maxResults).map(m=>graphView(ctx,m)),truncated:!!data['@odata.nextLink']};
}

function attachmentRef(ctx,messageId,id,name,type,size,version) {
  const ref={mailboxId:ctx.mailboxId,messageId,attachmentId:id,name:trunc(name || 'attachment',255),mimeType:trunc(type || 'application/octet-stream',127),size:Number(size || 0)};
  if (version) ref.version=String(version);
  return ref;
}

async function listAttachments(ctx,messageId) {
  if (ctx.credential.provider === 'gmail') {
    const {data} = await request(ctx,messagePath(messageId),{query:{format:'full'}});
    const found = walk(data.payload).filter(p=>p.body?.attachmentId || (p.filename && p.body?.data != null));
    return {attachments:found.slice(0,60).map(p=>attachmentRef(ctx,messageId,p.body.attachmentId || 'part:'+p.partId,p.filename,p.mimeType,p.body.size,data.historyId)),truncated:found.length>60};
  }
  const {data} = await request(ctx,messagePath(messageId)+'/attachments',{query:{$select:metadataFields,$top:60}});
  return {attachments:(data.value || []).slice(0,60).map(p=>attachmentRef(ctx,messageId,p.id,p.name,p.contentType,p.size,p.lastModifiedDateTime)),truncated:!!data['@odata.nextLink']};
}

export async function downloadAttachment(ctx,inputRef,max=attachmentLimit,onlyText=false) {
  checkRead(ctx.credential);
  keys(inputRef,['mailboxId','messageId','attachmentId','name','mimeType','size','version']);
  if (inputRef.mailboxId !== ctx.mailboxId) throw fault('mailbox_mismatch');
  const messageId=validId(inputRef.messageId), id=validId(inputRef.attachmentId);
  let ref, bytes;
  const checkRef = () => {
    if (inputRef.version && inputRef.version !== ref.version) throw fault('version_conflict');
    if (!Number.isSafeInteger(ref.size) || ref.size < 0 || ref.size>max) throw fault('content_too_large');
    if (onlyText && !['text/plain','text/csv','text/markdown','application/json'].includes(ref.mimeType.toLowerCase())) throw fault('unsupported_attachment_type');
  };
  if (ctx.credential.provider === 'gmail') {
    const {data} = await request(ctx,messagePath(messageId),{query:{format:'full'}});
    const p = walk(data.payload).find(p=>p.body?.attachmentId === id || (!p.body?.attachmentId && p.filename && 'part:'+p.partId === id));
    if (!p) throw fault('attachment_not_found');
    ref=attachmentRef(ctx,messageId,id,p.filename,p.mimeType,p.body.size,data.historyId);
    checkRef();
    const encoded=p.body.attachmentId ? (await request(ctx,messagePath(messageId)+'/attachments/'+segment(id),{max:4*Math.ceil(max/3)+16384})).data.data : p.body.data;
    bytes=unbase64(encoded,max);
  } else {
    const path=messagePath(messageId)+'/attachments/'+segment(id);
    const {data:meta}=await request(ctx,path,{query:{$select:metadataFields}});
    if (meta?.['@odata.type'] !== '#microsoft.graph.fileAttachment') throw fault('unsupported_attachment_type');
    ref=attachmentRef(ctx,messageId,id,meta.name,meta.contentType,meta.size,meta.lastModifiedDateTime);
    checkRef();
    const {data:file}=await request(ctx,path,{max:4*Math.ceil(max/3)+16384});
    if (file.id!==id || file.lastModifiedDateTime!==meta.lastModifiedDateTime || file.name!==meta.name || file.contentType!==meta.contentType) throw fault('version_conflict');
    bytes=unbase64(file.contentBytes,max);
  }
  return {ref:{...ref,size:bytes.length},bytes};
}

export async function readMailTool(name,input,ctx) {
  checkRead(ctx.credential);
  if (name === 'mail_search') return search(ctx,input);
  if (name === 'mail_list_drafts') return listDrafts(ctx,input);
  if (name === 'mail_thread') { keys(input,['threadId']); return thread(ctx,input); }
  if (name === 'mail_read') { keys(input,['messageId']); return readMessage(ctx,input.messageId); }
  if (name === 'mail_list_attachments') { keys(input,['messageId']); return listAttachments(ctx,validId(input.messageId)); }
  if (name === 'mail_read_attachment') {
    keys(input,['ref']);
    const {ref,bytes}=await downloadAttachment(ctx,input.ref,bodyLimit,true);
    let text;
    try {text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);} catch {throw fault('unsupported_attachment_encoding');}
    if (text.includes('\u0000')) throw fault('unsupported_attachment_encoding');
    return {ref,text,sha256:await digest(bytes)};
  }
  if (name === 'mail_list_organization') {
    keys(input,['parentId']);
    if (ctx.credential.provider === 'gmail') {
      if (input.parentId) throw fault('unsupported_action');
      const {data}=await request(ctx,'labels');
      return {labels:(data.labels || []).slice(0,100).map(l=>({id:l.id,name:l.name,type:l.type})),truncated:(data.labels || []).length>100};
    }
    const path=input.parentId ? 'mailFolders/'+segment(input.parentId)+'/childFolders' : 'mailFolders';
    const {data}=await request(ctx,path,{query:{$select:'id,displayName,parentFolderId,childFolderCount',$top:100}});
    return {folders:(data.value || []).slice(0,100),truncated:!!data['@odata.nextLink']};
  }
  throw fault('unsupported_tool');
}
