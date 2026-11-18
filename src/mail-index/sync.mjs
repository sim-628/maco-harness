import {request,segment,validId} from '../mail/common.mjs';
import {fault,checkRead} from '../mail/policy.mjs';
import {gmailView,graphView,listingFields} from '../mail/read.mjs';

const PAGE=8, INTERVAL=5*60_000;
const gmailFields='id,threadId,historyId,labelIds,snippet,internalDate,payload(headers)';
const guard=ctx=>ctx.assertCurrent?.();

export async function preview(ctx,id) {
  const gmail=ctx.credential.provider==='gmail';
  const {data}=await request(ctx,'messages/'+segment(id),{query:gmail?{format:'metadata',fields:gmailFields}:{$select:listingFields}});
  if(data?.id!==id)throw fault('invalid_provider_response');
  return gmail?gmailView(ctx,data,false):graphView(ctx,data);
}
function graphLink(link,path) {
  let url;
  try{if(typeof link!=='string'||link.length>8192)throw Error();url=new URL(link);}catch{throw fault('invalid_provider_response');}
  // Continuations are provider data, never arbitrary credential-bearing URLs.
  if(url.origin!=='https://graph.microsoft.com' || url.username || url.password || url.hash ||
    decodeURIComponent(url.pathname)!==decodeURIComponent('/v1.0/me/'+path))throw fault('invalid_provider_response');
  return {path,query:Object.fromEntries(url.searchParams)};
}
async function pool(items,fn,width=3) {
  const results=Array(items.length); let position=0;
  await Promise.all(Array.from({length:Math.min(width,items.length)},async()=>{
    while(position<items.length){const index=position++;results[index]=await fn(items[index]);}
  }));
  return results;
}

export class MailSynchronizer {
  constructor(index,{now=()=>Date.now()}={}){this.index=index;this.store=index.store;this.now=now;}
  start(mailboxId,provider,{after}={}) {
    validId(mailboxId);
    if(!['gmail','outlook'].includes(provider))throw fault('unsupported_provider');
    const date=after===undefined?this.now()-90*86400000:Date.parse(after);
    if(!Number.isFinite(date) || date>this.now())throw fault('invalid_sync_range');
    return this.store.tx(()=>{
      this.index.meta(mailboxId,provider);
      const previous=this.index.syncState(mailboxId);
      const state={mailboxId,provider,after:new Date(date).toISOString(),generation:(previous?.generation || 0)+1,
        phase:provider==='gmail'?'gmail_bootstrap':'graph_discover',cursor:null,historyId:null,pending:null,
        token:crypto.randomUUID(),folders:[],discovery:[{path:'mailFolders'}],found:[],folderIndex:0,
        complete:false,syncedAt:0,due:this.now(),failures:0,error:null};
      this.index.saveSync(state);
      return this.status(mailboxId);
    });
  }
  status(mailboxId) {
    const state=this.index.syncState(mailboxId);
    return state?{mailboxId,provider:state.provider,phase:state.phase,after:state.after,complete:state.complete,
      syncedAt:state.syncedAt || null,nextSyncAt:state.due,generation:state.generation,error:state.error,
      folderCount:state.folders.length}:null;
  }
  check(state,ctx) {
    guard(ctx);
    if(this.index.syncState(state.mailboxId)?.generation!==state.generation)throw fault('sync_changed');
  }
  commit(state,ctx,apply=()=>{}) {
    this.check(state,ctx);
    this.store.tx(()=>{apply();this.index.saveSync(state);});
  }
  finish(state) {
    state.pending=null;state.cursor=null;state.phase='idle';state.complete=true;
    state.syncedAt=this.now();state.due=this.now()+INTERVAL;state.failures=0;state.error=null;
  }
  async drain(state,ctx) {
    const pending=state.pending,ids=pending.ids.slice(0,PAGE);
    const epoch=this.index.meta(state.mailboxId).epoch;
    const results=await pool(ids,async id=>{
      try{return {id,view:await preview(ctx,id)};}
      catch(error){if(error.code==='not_found')return {id,missing:true};throw error;}
    });
    pending.ids=pending.ids.slice(ids.length);
    if(!pending.ids.length)this.finalize(state,pending);
    state.due=state.phase==='idle'?state.due:this.now();
    this.commit(state,ctx,()=>{
      for(const item of results) {
        if(item.missing)this.index.tombstone(state.mailboxId,item.id);
        else if(Date.parse(item.view.date)>=Date.parse(state.after) || this.store.one('SELECT id FROM mail_index WHERE mailbox=? AND providerId=?',state.mailboxId,item.id))this.index.remember(state.mailboxId,state.provider,item.view,{epoch,now:this.now()});
        if(pending.token)this.store.rows('UPDATE mail_index SET syncSeen=? WHERE mailbox=? AND providerId=?',pending.token,state.mailboxId,item.id);
      }
    });
  }
  finalize(state,pending) {
    state.pending=null;
    if(pending.kind==='gmail_bootstrap') {
      state.cursor=pending.next || null;
      if(!state.cursor)state.phase='gmail_sweep';
    } else if(pending.kind==='gmail_history') {
      state.cursor=pending.next || null;
      if(!state.cursor){state.historyId=pending.historyId;this.finish(state);}
    } else if(pending.kind==='graph_delta') {
      const folder=state.folders[state.folderIndex];
      folder.next=pending.next || null;
      if(!folder.next) {
        folder.link=pending.delta;
        if(!folder.initialComplete)state.phase='graph_sweep';
        else state.folderIndex++;
      }
    }
  }
  async gmail(state,ctx) {
    if(state.phase==='gmail_bootstrap') {
      if(!state.historyId) {
        const {data}=await request(ctx,'profile');
        if(typeof data?.historyId!=='string')throw fault('invalid_provider_response');
        state.historyId=data.historyId;
        this.commit(state,ctx);return;
      }
      const {data}=await request(ctx,'messages',{query:{maxResults:PAGE,includeSpamTrash:true,q:'after:'+Math.floor(Date.parse(state.after)/1000),pageToken:state.cursor || undefined}});
      state.pending={kind:'gmail_bootstrap',ids:[...new Set((data?.messages || []).map(m=>validId(m.id)))],next:data?.nextPageToken || null,token:state.token};
    } else if(state.phase==='gmail_sweep') {
      const ids=this.store.rows('SELECT providerId FROM mail_index WHERE mailbox=? AND deleted=0 AND received>=? AND syncSeen<>? LIMIT ?',state.mailboxId,Date.parse(state.after),state.token,PAGE).map(r=>r.providerId);
      if(!ids.length){state.phase='gmail_history';state.cursor=null;this.commit(state,ctx);return;}
      state.pending={kind:'gmail_sweep',ids,token:state.token};
    } else {
      let data;
      try {({data}=await request(ctx,'history',{query:{startHistoryId:state.historyId,pageToken:state.cursor || undefined,maxResults:20}}));}
      catch(error){
        if(error.code!=='not_found')throw error;
        state.phase='gmail_bootstrap';state.historyId=null;state.cursor=null;state.token=crypto.randomUUID();state.complete=false;state.syncedAt=0;
        this.commit(state,ctx);return;
      }
      if(typeof data?.historyId!=='string')throw fault('invalid_provider_response');
      const ids=new Set();
      for(const change of data.history || []) {
        for(const message of change.messages || [])ids.add(validId(message.id));
        for(const type of ['messagesAdded','messagesDeleted','labelsAdded','labelsRemoved'])
          for(const item of change[type] || [])ids.add(validId(item.message.id));
      }
      if(ids.size>2000)throw fault('sync_page_too_large');
      state.pending={kind:'gmail_history',ids:[...ids],next:data.nextPageToken || null,historyId:data.historyId};
    }
    if(!state.pending.ids.length)this.finalize(state,state.pending);
    this.commit(state,ctx);
    if(state.pending)await this.drain(state,ctx);
  }
  async discover(state,ctx) {
    const item=state.discovery[0];
    if(!item) {
      const existing=new Map(state.folders.map(folder=>[folder.id,folder]));
      state.folders=state.found.map(id=>existing.get(id)||{id,link:null,next:null,initialComplete:false,token:crypto.randomUUID()});
      state.folderIndex=0;state.phase='graph_orphans';state.orphanToken=crypto.randomUUID();this.commit(state,ctx);return;
    }
    const query=item.link?graphLink(item.link,item.path).query:{$select:'id,childFolderCount',$top:50,includeHiddenFolders:true};
    const {data}=await request(ctx,item.path,{query});
    for(const folder of data?.value || []) {
      const id=validId(folder.id);
      if(!state.found.includes(id)) {
        if(state.found.length>=512)throw fault('too_many_folders');
        state.found.push(id);
        if(folder.childFolderCount>0)state.discovery.push({path:'mailFolders/'+segment(id)+'/childFolders'});
      }
    }
    const next=data?.['@odata.nextLink'];
    if(next){graphLink(next,item.path);item.link=next;}
    else state.discovery.shift();
    this.commit(state,ctx);
  }
  async graph(state,ctx) {
    if(state.phase==='graph_discover'){await this.discover(state,ctx);return;}
    if(state.phase==='graph_orphans') {
      // A removed folder is not proof that its messages were permanently deleted.
      // Resolve orphaned IDs against the mailbox, which also handles cross-folder moves.
      const ids=this.store.rows('SELECT providerId FROM mail_index WHERE mailbox=? AND deleted=0 AND syncSeen<>? AND folder IS NOT NULL AND NOT EXISTS (SELECT 1 FROM json_each(?) WHERE value=mail_index.folder) LIMIT ?',state.mailboxId,state.orphanToken,JSON.stringify(state.folders.map(f=>f.id)),PAGE).map(row=>row.providerId);
      if(ids.length){state.pending={kind:'graph_orphans',ids,token:state.orphanToken};this.commit(state,ctx);await this.drain(state,ctx);return;}
      state.phase='graph_delta';this.commit(state,ctx);return;
    }
    const folder=state.folders[state.folderIndex];
    if(!folder){this.finish(state);this.commit(state,ctx);return;}
    if(state.phase==='graph_sweep') {
      const ids=this.store.rows('SELECT providerId FROM mail_index WHERE mailbox=? AND folder=? AND deleted=0 AND received>=? AND syncSeen<>? LIMIT ?',state.mailboxId,folder.id,Date.parse(state.after),folder.token,PAGE).map(r=>r.providerId);
      if(!ids.length){folder.initialComplete=true;state.folderIndex++;state.phase='graph_delta';this.commit(state,ctx);return;}
      state.pending={kind:'graph_sweep',ids,token:folder.token};this.commit(state,ctx);await this.drain(state,ctx);return;
    }
    const path='mailFolders/'+segment(folder.id)+'/messages/delta';
    const link=folder.next || folder.link;
    const query=link?graphLink(link,path).query:{$select:listingFields,$top:PAGE};
    let data;
    try {({data}=await request(ctx,path,{query}));}
    catch(error) {
      if(error.httpStatus===410 || (error.code==='not_found' && link)) {
        folder.next=null;folder.link=null;folder.initialComplete=false;folder.token=crypto.randomUUID();state.complete=false;state.syncedAt=0;
        this.commit(state,ctx);return;
      }
      if(error.code==='not_found') {
        state.phase='graph_discover';state.discovery=[{path:'mailFolders'}];state.found=[];state.complete=false;state.syncedAt=0;
        this.commit(state,ctx);return;
      }
      throw error;
    }
    const next=data?.['@odata.nextLink'],delta=data?.['@odata.deltaLink'];
    if(next)graphLink(next,path);
    if(delta)graphLink(delta,path);
    if(!next&&!delta)throw fault('invalid_provider_response');
    state.pending={kind:'graph_delta',ids:[...new Set((data.value || []).map(m=>validId(m.id)))],next,delta,token:folder.token};
    if(!state.pending.ids.length)this.finalize(state,state.pending);
    this.commit(state,ctx);
    if(state.pending)await this.drain(state,ctx);
  }
  async run(ctx) {
    checkRead(ctx.credential);guard(ctx);
    const state=this.index.syncState(ctx.mailboxId);
    if(!state)return null;
    if(state.provider!==ctx.credential.provider)throw fault('mailbox_mismatch');
    if(state.due>this.now())return this.status(ctx.mailboxId);
    try {
      if(state.phase==='idle') {
        if(state.provider==='gmail')state.phase='gmail_history';
        else {state.phase='graph_discover';state.discovery=[{path:'mailFolders'}];state.found=[];}
      }
      state.due=this.now();
      if(state.pending)await this.drain(state,ctx);
      else if(state.provider==='gmail')await this.gmail(state,ctx);
      else await this.graph(state,ctx);
      return this.status(ctx.mailboxId);
    } catch(error) {
      if(error.code==='sync_changed')return this.status(ctx.mailboxId);
      try {
        this.check(state,ctx);
        state.failures++;state.error=error.code || 'sync_failed';
        state.due=this.now()+Math.min(3600_000,Math.max(error.retryAfterMs || 0,1000*2**Math.min(state.failures,12)));
        if(['connection_revoked','connection_changed','reauthorization_required','scope_required'].includes(state.error))state.due=Number.MAX_SAFE_INTEGER;
        this.commit(state,ctx);
      } catch {}
      throw error;
    }
  }
}
