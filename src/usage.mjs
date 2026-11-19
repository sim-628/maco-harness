import { requireThat } from './protocol.mjs'

const number=value=>Number.isSafeInteger(value) && value>=0 ? value : null
const starts=new Set(['attempt.started','context.compaction_started','memory.extraction_started'])
const ends=new Set(['attempt.finished','attempt.abandoned','context.compaction_finished','context.compaction_failed',
  'memory.extraction_finished','memory.extraction_interrupted'])

export class UsageService {
  constructor(store) {
    this.store=store
    store.rows('CREATE TABLE IF NOT EXISTS model_usage (id TEXT PRIMARY KEY,at INTEGER NOT NULL,data TEXT NOT NULL)')
  }
  record(type,fields) {
    let key,kind,provider,model,payer,usage=fields.usage
    if (starts.has(type) || ends.has(type)) {
      key=fields.messageId || fields.compactionId || fields.jobId
      kind=fields.messageId ? 'task' : fields.compactionId ? 'context_compaction' : 'preference_extraction'
      let profile=fields.modelProfile
      if (kind==='preference_extraction') {
        const job=this.store.one('SELECT attempts,data FROM memory_jobs WHERE id=?',fields.jobId)
        profile ??= job && JSON.parse(job.data).profile
        key=fields.jobId+':attempt:'+(fields.attempt ?? job?.attempts ?? 1)
      } else if (!profile) {
        const task=this.store.one('SELECT data FROM tasks WHERE id=?',fields.taskId)
        profile=task && JSON.parse(task.data).profile
      }
      provider=profile?.provider;model=profile?.model;payer='user_connection'
    } else if (type==='execution.updated' || type==='execution.usage') {
      key=fields.executionId;kind='hosted';provider='openai-agents';payer='operator'
      model=fields.model
      if (!model) {
        const execution=this.store.one('SELECT data FROM delegations WHERE id=?',fields.executionId)
        model=execution && JSON.parse(execution.data).profile.model
      }
    } else return
    if (!key) return
    const old=this.store.one('SELECT data FROM model_usage WHERE id=?',key)
    const prior=old && JSON.parse(old.data)
    const raw=starts.has(type) ? null : Object.hasOwn(fields,'usage') ? usage : prior?.usage || null
    if (raw) usage={inputTokens:number(raw.inputTokens),outputTokens:number(raw.outputTokens),
      cacheReadTokens:number(raw.cacheReadTokens ?? raw.cachedInputTokens),cacheWriteTokens:number(raw.cacheWriteTokens),
      reasoningTokens:number(raw.reasoningTokens),totalTokens:number(raw.totalTokens)}
    else usage=null
    const value={id:key,taskId:fields.taskId || fields.parentTaskId || prior?.taskId || null,
      kind,provider:prior?.provider || provider || null,model:prior?.model || model || null,payer,
      state:starts.has(type) ? 'started' : type.endsWith('updated') ? fields.state : type==='execution.usage' ? prior?.state || 'running' : type.split('.').at(-1),
      usage,at:prior?.at || Date.now(),updatedAt:Date.now(),costUSD:null,billingComplete:false}
    this.store.rows('INSERT INTO model_usage VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',key,value.at,JSON.stringify(value))
  }
  page({before=Number.MAX_SAFE_INTEGER,limit=100}={}) {
    requireThat(Number.isSafeInteger(before) && before>=0 && Number.isInteger(limit) && limit>=1 && limit<=100,'invalid_usage_page')
    const rows=this.store.rows('SELECT rowid AS n,data FROM model_usage WHERE rowid<? ORDER BY rowid DESC LIMIT ?',before,limit+1)
    return {usage:rows.slice(0,limit).map(row=>JSON.parse(row.data)),nextBefore:rows.length>limit ? rows[limit-1].n : null,
      costUSD:null,billingComplete:false,note:'Provider-reported tokens only. Unknown usage, hosted compute, parsing, storage and notification fees are not zero-cost entries.'}
  }
}
