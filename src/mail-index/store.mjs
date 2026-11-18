import {fault} from '../mail/policy.mjs';
import {validId} from '../mail/common.mjs';

const stablePattern=/^mail_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const schema=[
  `CREATE TABLE IF NOT EXISTS mail_index (n INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,mailbox TEXT NOT NULL,providerId TEXT NOT NULL,received INTEGER NOT NULL,subject TEXT NOT NULL,sender TEXT NOT NULL,snippet TEXT NOT NULL,folder TEXT,unread INTEGER NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,syncSeen TEXT NOT NULL DEFAULT '',data TEXT NOT NULL,UNIQUE(mailbox,providerId))`,
  'CREATE INDEX IF NOT EXISTS mail_index_date ON mail_index(mailbox,deleted,received DESC,n DESC)',
  'CREATE INDEX IF NOT EXISTS mail_index_folder ON mail_index(mailbox,folder,deleted,received DESC)',
  'CREATE VIRTUAL TABLE IF NOT EXISTS mail_index_fts USING fts5(id UNINDEXED,mailbox UNINDEXED,subject,sender,snippet)',
  'CREATE TABLE IF NOT EXISTS mail_index_meta (mailbox TEXT PRIMARY KEY,provider TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 0,epoch INTEGER NOT NULL DEFAULT 0)',
  'CREATE TABLE IF NOT EXISTS mail_sync (mailbox TEXT PRIMARY KEY,due INTEGER NOT NULL,data TEXT NOT NULL)',
];
const clean=value=>String(value || '').slice(0,2048);

export class MessageIndexStore {
  constructor(store) {
    this.store=store;
    store.tx(()=>{for(const sql of schema)store.rows(sql);});
  }
  meta(mailbox,provider) {
    let meta=this.store.one('SELECT * FROM mail_index_meta WHERE mailbox=?',mailbox);
    if(!meta && provider) {
      this.store.rows('INSERT INTO mail_index_meta(mailbox,provider) VALUES (?,?)',mailbox,provider);
      meta=this.store.one('SELECT * FROM mail_index_meta WHERE mailbox=?',mailbox);
    }
    if(meta && provider && meta.provider!==provider) throw fault('mailbox_mismatch');
    return meta || {version:0,epoch:0};
  }
  lookup(mailbox,id) {
    if(typeof id!=='string') throw fault('invalid_input');
    if(stablePattern.test(id)) {
      const row=this.store.one('SELECT * FROM mail_index WHERE id=? AND mailbox=?',id,mailbox);
      if(!row) throw fault('message_not_found');
      if(row.deleted) throw fault('message_deleted');
      return row;
    }
    validId(id);
    return this.store.one('SELECT * FROM mail_index WHERE mailbox=? AND providerId=?',mailbox,id);
  }
  providerId(mailbox,id) { return this.lookup(mailbox,id)?.providerId || id; }
  public(row) {
    return {...JSON.parse(row.data),citation:{mailboxId:row.mailbox,messageId:row.id},mailMessageId:row.id,
      contentCoverage:'snippet',indexedAt:JSON.parse(row.data).indexedAt};
  }
  remember(mailbox,provider,view,{epoch,now=Date.now()}={}) {
    const providerId=validId(view?.citation?.messageId);
    return this.store.tx(()=>{
      const meta=this.meta(mailbox,provider);
      const prior=this.store.one('SELECT * FROM mail_index WHERE mailbox=? AND providerId=?',mailbox,providerId);
      // A mailbox mutation completed while this read was in flight. Its projection
      // is authoritative until the next current provider observation.
      if(epoch!==undefined && meta.epoch!==epoch) return prior ? this.public(prior) : null;
      const id=prior?.id || 'mail_'+crypto.randomUUID();
      const {body,bodyType,truncated,...fields}=view;
      const data={...fields,citation:{mailboxId:mailbox,messageId:providerId},preview:String(view.preview || '').slice(0,1024),indexedAt:now};
      const received=Number.isFinite(Date.parse(view.date)) ? Date.parse(view.date) : 0;
      const subject=clean(view.subject),sender=clean(view.from),snippet=data.preview;
      this.store.rows(`INSERT INTO mail_index(id,mailbox,providerId,received,subject,sender,snippet,folder,unread,deleted,data) VALUES (?,?,?,?,?,?,?,?,?,0,?)
        ON CONFLICT(mailbox,providerId) DO UPDATE SET received=excluded.received,subject=excluded.subject,sender=excluded.sender,snippet=excluded.snippet,folder=excluded.folder,unread=excluded.unread,deleted=0,data=excluded.data`,
        id,mailbox,providerId,received,subject,sender,snippet,view.folderId || null,view.isRead===false ? 1 : 0,JSON.stringify(data));
      if(!prior || prior.deleted || prior.subject!==subject || prior.sender!==sender || prior.snippet!==snippet) {
        this.store.rows('DELETE FROM mail_index_fts WHERE id=?',id);
        this.store.rows('INSERT INTO mail_index_fts(id,mailbox,subject,sender,snippet) VALUES (?,?,?,?,?)',id,mailbox,subject,sender,snippet);
      }
      this.store.rows('UPDATE mail_index_meta SET version=version+1 WHERE mailbox=?',mailbox);
      return this.public(this.store.one('SELECT * FROM mail_index WHERE id=?',id));
    });
  }
  tombstone(mailbox,providerId) {
    this.store.tx(()=>{
      const row=this.store.one('SELECT * FROM mail_index WHERE mailbox=? AND providerId=?',mailbox,providerId);
      if(!row)return;
      this.store.rows("UPDATE mail_index SET deleted=1,subject='',sender='',snippet='',data=? WHERE id=?",JSON.stringify({deleted:true}),row.id);
      this.store.rows('DELETE FROM mail_index_fts WHERE id=?',row.id);
      this.store.rows('UPDATE mail_index_meta SET version=version+1 WHERE mailbox=?',mailbox);
    });
  }
  invalidate(mailbox) {
    this.store.tx(()=>{
      this.store.rows('UPDATE mail_index_meta SET epoch=epoch+1,version=version+1 WHERE mailbox=?',mailbox);
      const job=this.syncState(mailbox);
      if(job){job.generation++;job.syncedAt=0;job.due=Date.now();this.saveSync(job);}
    });
  }
  clear(mailbox) {
    this.store.tx(()=>{
      this.store.rows('DELETE FROM mail_index_fts WHERE mailbox=?',mailbox);
      this.store.rows('DELETE FROM mail_index WHERE mailbox=?',mailbox);
      this.store.rows('DELETE FROM mail_index_meta WHERE mailbox=?',mailbox);
      this.store.rows('DELETE FROM mail_sync WHERE mailbox=?',mailbox);
    });
  }
  syncState(mailbox) {
    const row=this.store.one('SELECT data FROM mail_sync WHERE mailbox=?',mailbox);
    return row && JSON.parse(row.data);
  }
  saveSync(state) { this.store.rows('INSERT INTO mail_sync VALUES (?,?,?) ON CONFLICT(mailbox) DO UPDATE SET due=excluded.due,data=excluded.data',state.mailboxId,state.due,JSON.stringify(state)); }
  due(now=Date.now()) {return this.store.rows('SELECT mailbox FROM mail_sync WHERE due<=? ORDER BY due LIMIT 8',now).map(row=>row.mailbox);}
  nextDue() {return this.store.one('SELECT MIN(due) AS due FROM mail_sync').due;}
  coverage(mailbox) {
    const job=this.syncState(mailbox);
    return {source:'index',bodySearchCoverage:'snippet_only',historyComplete:!!job?.complete,
      after:job?.after || null,folders:job?.provider==='outlook' ? job.folders.map(f=>f.id) : null,
      syncedAt:job?.syncedAt || null,syncState:job?.phase || 'not_started',fullTextSearched:false};
  }
  query(mailbox,input,{now=Date.now(),maxAge=120_000}={}) {
    const filters=input.filters || {},coverage=this.coverage(mailbox),meta=this.meta(mailbox);
    const fresh=coverage.historyComplete && coverage.syncedAt && now-coverage.syncedAt<=maxAge;
    // The initial index deliberately covers a bounded time range. An unbounded
    // query must not silently become a recent-mail query.
    const covered=filters.after && coverage.after && Date.parse(filters.after)>=Date.parse(coverage.after);
    if(!fresh || !covered)return null;
    const limit=input.limit || 8;
    let offset=0;
    if(input.cursor) {
      const match=/^index:(\d+):(\d+)$/.exec(input.cursor);
      if(!match || Number(match[1])!==meta.version || Number(match[2])>10_000)throw fault('index_cursor_changed');
      offset=Number(match[2]);
    }
    const where=['mailbox=?','deleted=0','received>=?'],args=[mailbox,Date.parse(filters.after)];
    if(filters.before){where.push('received<?');args.push(Date.parse(filters.before));}
    if(filters.from){where.push('instr(lower(sender),lower(?))>0');args.push(filters.from);}
    if(filters.unread!=null){where.push('unread=?');args.push(filters.unread?1:0);}
    if(filters.folderId){where.push("(folder=? OR EXISTS(SELECT 1 FROM json_each(json_extract(mail_index.data,'$.labels')) WHERE value=?))");args.push(filters.folderId,filters.folderId);}
    const query=(input.query || '').trim();
    if(query && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(query)) {
      // Bound the fallback scan; SQLite's default tokenizer does not segment CJK.
      const candidate=this.store.rows('SELECT * FROM mail_index WHERE '+where.join(' AND ')+' ORDER BY received DESC,n DESC LIMIT 513',...args);
      if(candidate.length>512)return null;
      const terms=query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
      const matches=candidate.filter(row=>terms.every(term=>(row.subject+' '+row.sender+' '+row.snippet).toLocaleLowerCase().includes(term)));
      const page=matches.slice(offset,offset+limit);
      return {matches:page.map(row=>this.public(row)),nextCursor:matches.length>offset+limit?`index:${meta.version}:${offset+limit}`:null,coverage};
    }
    if(query) {
      const terms=query.match(/[\p{L}\p{N}]+/gu) || [];
      if(!terms.length || terms.length>64)return null;
      where.push('id IN (SELECT id FROM mail_index_fts WHERE mail_index_fts MATCH ? AND mailbox=?)');
      args.push(terms.map(term=>'"'+term.replaceAll('"','""')+'"').join(' AND '),mailbox);
    }
    const rows=this.store.rows('SELECT * FROM mail_index WHERE '+where.join(' AND ')+' ORDER BY received DESC,n DESC LIMIT ? OFFSET ?',...args,limit+1,offset);
    return {matches:rows.slice(0,limit).map(row=>this.public(row)),nextCursor:rows.length>limit?`index:${meta.version}:${offset+limit}`:null,coverage};
  }
}
