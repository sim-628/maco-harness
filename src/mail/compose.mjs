import {attachmentLimit, b64, bodyLimit, digest, encoder, request, string} from './common.mjs';
import {fault} from './policy.mjs';
import {downloadAttachment, readMessage} from './read.mjs';

const address = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/;
function recipients(input) {
  if (input == null) return [];
  if (!Array.isArray(input) || input.length>50 || input.some(x=>typeof x !== 'string' || x.length>254 || !address.test(x))) throw fault('invalid_recipients');
  return [...input];
}
function sourceAddress(header) {
  const match = /<([^<>]+)>\s*$/.exec(header);
  return recipients([match ? match[1] : header]);
}
const escaped = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const isMessageId = s => typeof s === 'string' && /^<[^<>\s\x00-\x1f\x7f]+@[^<>\s\x00-\x1f\x7f]+>$/.test(s) && s.length <= 900;

export async function mailboxSender(ctx) {
  const gmail = ctx.credential.provider === 'gmail';
  const {data} = gmail
    ? await request(ctx,'profile')
    : await request(ctx,'',{query:{$select:'mail,userPrincipalName'}});
  const from = gmail ? data?.emailAddress : data?.mail || data?.userPrincipalName;
  if (typeof from !== 'string' || from.length > 254 || !address.test(from)) throw fault('sender_unavailable');
  return from;
}

export async function freezeAttachment(ctx,ref,max=attachmentLimit) {
  const {ref:source,bytes} = await downloadAttachment(ctx,ref,max);
  const name = string(source.name,'attachment name',255,true);
  const mimeType = /^[a-z\d!#$&^_.+-]+\/[a-z\d!#$&^_.+-]+$/i.test(source.mimeType) ? source.mimeType : 'application/octet-stream';
  return {meta:{source,name,mimeType,size:bytes.length,sha256:await digest(bytes)},data:b64(bytes)};
}

export async function compose(ctx,input) {
  const isReply = input.action === 'reply', isForward = input.action === 'forward';
  const isDraft = input.action === 'create_draft' || input.action === 'update_draft';
  let source = null;
  if (isReply || isForward) source = await readMessage(ctx,input.messageId);
  const to = isReply && input.to === undefined ? sourceAddress(source.replyTo || source.from) : recipients(input.to);
  const cc = recipients(input.cc), bcc = recipients(input.bcc);
  if (!isDraft && !to.length && !cc.length && !bcc.length) throw fault('invalid_recipients');
  let subject = input.subject;
  if (subject === undefined && source) {
    const prefix = isReply ? 'Re: ' : 'Fwd: ';
    subject = source.subject.toLowerCase().startsWith(prefix.toLowerCase()) ? source.subject : prefix+source.subject;
  }
  subject=string(subject ?? '', 'subject', 2048, true);
  const bodyType = input.bodyType ?? 'text';
  if (!['html','text'].includes(bodyType)) throw fault('invalid_input');
  let body = string(input.body ?? '', 'body', bodyLimit);
  if (isForward) {
    if (source.truncated) throw fault('source_too_large');
    const info = ['---------- Forwarded message ----------','From: '+source.from,'Date: '+source.date,'Subject: '+source.subject,'',source.body].join('\n');
    body += bodyType === 'html' ? '<hr><pre>'+escaped(info)+'</pre>' : '\n\n'+info;
    string(body,'forward body',bodyLimit);
  }
  const refs = input.attachments ?? [];
  if (!Array.isArray(refs) || refs.length>12) throw fault('invalid_attachments');
  const files = [];
  let remaining = attachmentLimit;
  for (const ref of refs) {
    const file = await freezeAttachment(ctx,ref,remaining);
    remaining -= file.meta.size;
    files.push(file);
  }
  const summary={to,cc,bcc,subject,body,bodyType,attachments:files.map(f=>f.meta)};
  if (source) summary.source={...source.citation,version:source.version};
  const message = {...summary,files};
  if (isReply) {
    if (!isMessageId(source.internetMessageId)) throw fault('reply_header_unavailable');
    message.replyMessageId=source.internetMessageId;
    message.references=[...new Set([...(source.references || '').split(/\s+/).filter(isMessageId),source.internetMessageId])].slice(-12);
    message.threadId=source.threadId;
  }
  return {message,summary};
}

// The frozen MIME carries both envelope-visible recipients and exact attachment bytes.
// Header encoding, byte-based splitting and 76-column base64 follow the legacy scheduled sender.
function encodedWords(value) {
  const words=[];
  let chunk='';
  for (const char of value) {
    if (encoder.encode(chunk+char).length>42) { words.push(chunk); chunk=''; }
    chunk+=char;
  }
  if (chunk) words.push(chunk);
  return words.map(word=>'=?UTF-8?B?'+b64(encoder.encode(word))+'?=').join('\r\n ');
}
const wrap = data => (data.match(/.{1,76}/g) || []).join('\r\n');
export function mime(message) {
  const boundary = 'maco-'+crypto.randomUUID();
  const lines=['From: '+message.from,'MIME-Version: 1.0','Date: '+new Date().toUTCString()];
  for (const [key,header] of [['to','To'],['cc','Cc'],['bcc','Bcc']]) if (message[key].length) lines.push(header+': '+message[key].join(',\r\n '));
  lines.push('Subject: '+encodedWords(message.subject));
  if (message.replyMessageId) lines.push('In-Reply-To: '+message.replyMessageId,'References: '+message.references.join('\r\n '));
  if (message.files.length) lines.push('Content-Type: multipart/mixed; boundary="'+boundary+'"','','--'+boundary);
  lines.push('Content-Type: '+(message.bodyType==='html'?'text/html':'text/plain')+'; charset=utf-8','Content-Transfer-Encoding: base64','',wrap(b64(encoder.encode(message.body.replace(/\r\n|\r|\n/g,'\r\n')))));
  for (const file of message.files) {
    const filename=encodeURIComponent(file.meta.name).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
    lines.push('--'+boundary,'Content-Type: '+file.meta.mimeType,"Content-Disposition: attachment; filename*=UTF-8''"+filename,'Content-Transfer-Encoding: base64','',wrap(file.data));
  }
  if (message.files.length) lines.push('--'+boundary+'--');
  return encoder.encode(lines.join('\r\n')+'\r\n');
}

export function graphFile(file) {
  return {'@odata.type':'#microsoft.graph.fileAttachment',name:file.meta.name,contentType:file.meta.mimeType,contentBytes:file.data};
}
export function graphMessage(message) {
  const addressList = list => list.map(address=>({emailAddress:{address}}));
  const data = {subject:message.subject,body:{contentType:message.bodyType==='html'?'HTML':'Text',content:message.body},toRecipients:addressList(message.to),ccRecipients:addressList(message.cc),bccRecipients:addressList(message.bcc)};
  if (message.files.length) data.attachments=message.files.map(graphFile);
  return data;
}
