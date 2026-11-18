import {MessageIndexStore} from './store.mjs';
import {MailSynchronizer} from './sync.mjs';
import {readMailTool} from '../mail/read.mjs';
import {fault,checkRead} from '../mail/policy.mjs';
import {keys,string} from '../mail/common.mjs';

const stablePattern=/^mail_[0-9a-f-]{36}$/;
const guard=ctx=>ctx.assertCurrent?.();
export class MailIndexService {
  constructor(store,options={}) {
    this.store=store;
    this.index=new MessageIndexStore(store);
    this.sync=new MailSynchronizer(this.index,options);
    this.now=options.now || (()=>Date.now());
  }
  resolveInput(mailboxId,input) {
    const value=structuredClone(input);
    if(value.messageId)value.messageId=this.index.providerId(mailboxId,value.messageId);
    const resolveRef=ref=>{
      if(ref.mailboxId!==mailboxId)throw fault('mailbox_mismatch');
      return {...ref,messageId:this.index.providerId(mailboxId,ref.messageId)};
    };
    if(value.ref)value.ref=resolveRef(value.ref);
    if(Array.isArray(value.attachments))value.attachments=value.attachments.map(resolveRef);
    // Gmail draft IDs are different resources from message IDs. Keep them explicit.
    if(value.draftId && stablePattern.test(value.draftId))throw fault('draft_id_required');
    return value;
  }
  invalidate(mailboxId) {this.index.invalidate(mailboxId);}
  clearMailbox(mailboxId) {this.index.clear(mailboxId);}
  startSync(mailboxId,provider,options={}) {return this.sync.start(mailboxId,provider,options);}
  syncState(mailboxId) {return this.sync.status(mailboxId);}
  nextDue() {return this.index.nextDue();}
  dueMailboxes(now=this.now()) {return this.index.due(now);}
  syncNext(ctx) {return this.sync.run(ctx);}
  deferSync(mailboxId,error) {
    const state=this.index.syncState(mailboxId);
    if(!state)return null;
    const code=/^[a-z_]{1,80}$/.test(error?.code || '')?error.code:'sync_failed';
    const blocked=['connection_not_found','connection_revoked','connection_changed','reauthorization_required','scope_required','mailbox_unavailable','not_a_mail_connection'].includes(code);
    if(!blocked && state.due>this.now() && state.error)return this.sync.status(mailboxId);
    state.failures++;state.error=code;
    state.due=blocked?Number.MAX_SAFE_INTEGER:this.now()+Math.min(3600_000,Math.max(error?.retryAfterMs || 0,1000*2**Math.min(state.failures,12)));
    this.store.tx(()=>this.index.saveSync(state));
    return this.sync.status(mailboxId);
  }
  validateSearch(input) {
    keys(input,['query','scope','filters','limit','cursor']);
    if(input.scope!==undefined && !['metadata','fulltext'].includes(input.scope))throw fault('invalid_input');
    string(input.query || '','query',2048,true);
    string(input.cursor || '','cursor',4096,true);
    if(input.limit!==undefined && (!Number.isInteger(input.limit)||input.limit<1||input.limit>8))throw fault('invalid_input');
    const filters=input.filters || {};
    keys(filters,['from','after','before','unread','folderId']);
    if(filters.from!=null)string(filters.from,'from',320,true);
    for(const key of ['after','before'])if(filters[key]!=null && (typeof filters[key]!=='string'||!Number.isFinite(Date.parse(filters[key]))))throw fault('invalid_input');
    if(filters.after&&filters.before&&Date.parse(filters.after)>=Date.parse(filters.before))throw fault('invalid_input');
    if(filters.unread!=null && typeof filters.unread!=='boolean')throw fault('invalid_input');
    if(filters.folderId!=null)string(filters.folderId,'folder',2048,true);
  }
  mapResult(result,ctx,epoch) {
    const mailbox=ctx.mailboxId,provider=ctx.credential.provider;
    const stableId=providerId=>{
      const known=this.index.lookup(mailbox,providerId);
      if(known)return known.id;
      const mapped=this.index.remember(mailbox,provider,{citation:{mailboxId:mailbox,messageId:providerId}},{epoch,now:this.now()});
      return mapped?.mailMessageId || providerId;
    };
    const mapView=view=>{
      if(!view?.citation?.messageId)return view;
      const mapped=this.index.remember(mailbox,provider,view,{epoch,now:this.now()});
      return {...view,...(mapped?{citation:mapped.citation,mailMessageId:mapped.mailMessageId}:{}),
        contentCoverage:typeof view.body==='string'?(view.truncated?'partial_body':'body'):'snippet'};
    };
    const mapRef=ref=>({...ref,messageId:stableId(ref.messageId)});
    if(!result || typeof result!=='object')return result;
    const output={...result};
    if(result.citation?.messageId)Object.assign(output,mapView(result));
    if(Array.isArray(result.matches))output.matches=result.matches.map(mapView);
    if(Array.isArray(result.messages))output.messages=result.messages.map(mapView);
    if(Array.isArray(result.attachments))output.attachments=result.attachments.map(mapRef);
    if(result.ref?.messageId)output.ref=mapRef(result.ref);
    return output;
  }
  async read(name,input,ctx,readImpl=readMailTool) {
    checkRead(ctx.credential);guard(ctx);
    this.index.meta(ctx.mailboxId,ctx.credential.provider);
    const epoch=this.index.meta(ctx.mailboxId).epoch;
    if(name==='mail_search') {
      this.validateSearch(input);
      const localCursor=String(input.cursor || '').startsWith('index:');
      if(input.scope==='metadata' && (!input.cursor || localCursor)) {
        const result=this.index.query(ctx.mailboxId,input,{now:this.now()});
        if(result){guard(ctx);return {...result,hasMore:!!result.nextCursor};}
        if(localCursor)throw fault('index_cursor_changed');
      } else if(localCursor)throw fault('invalid_cursor');
      const {scope,...query}=input;
      const remote=await readImpl(name,query,ctx);
      guard(ctx);
      return {...this.mapResult(remote,ctx,epoch),hasMore:!!remote.nextCursor,coverage:{source:'provider',
        bodySearchCoverage:'provider_search',fullTextSearched:true,historyComplete:false,
        providerScope:ctx.credential.provider,queryScope:scope || 'fulltext',hasMore:!!remote.nextCursor,
        note:'Provider query semantics and result limits apply; a page is not proof of exhaustive mailbox coverage.'}};
    }
    const normalized=this.resolveInput(ctx.mailboxId,input);
    const result=await readImpl(name,normalized,ctx);
    return this.store.tx(()=>{
      guard(ctx);
      const mapped=this.mapResult(result,ctx,epoch);
      return ctx.commitResult?ctx.commitResult(mapped):mapped;
    });
  }
}
