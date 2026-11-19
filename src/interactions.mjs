import { checkedVersion, identifier, requireThat } from './protocol.mjs'

const text = (value,max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max
const view = record => { const {runVersion,...value} = record; return value }

export const ASK_USER_TOOL = {
  name:'ask_user',description:'Ask for missing information or a choice and pause this task until the user answers on any device. This never approves a mail or MCP operation.',
  binding:{kind:'interaction',barrier:true},
  inputSchema:{type:'object',additionalProperties:false,required:['question'],properties:{
    question:{type:'string',minLength:1,maxLength:2000},
    fields:{type:'array',maxItems:8,items:{type:'object',additionalProperties:false,required:['id','label','type'],properties:{
      id:{type:'string',minLength:1,maxLength:64},label:{type:'string',minLength:1,maxLength:300},
      type:{type:'string',enum:['text','choice','boolean']},required:{type:'boolean'},
      options:{type:'array',maxItems:12,items:{type:'string',minLength:1,maxLength:200}}
    }}}
  }}
}

export class InteractionService {
  constructor(store,{onSettled=()=>{}} = {}) {
    Object.assign(this,{store,onSettled})
    store.rows('CREATE TABLE IF NOT EXISTS interactions (id TEXT PRIMARY KEY,task TEXT NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL)')
    store.rows('CREATE INDEX IF NOT EXISTS interaction_task ON interactions(task,state)')
  }
  get(id) { const row=this.store.one('SELECT data FROM interactions WHERE id=?',id); return row && view(JSON.parse(row.data)) }
  save(record) {
    record.updatedAt=Date.now()
    this.store.rows('INSERT INTO interactions VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,data=excluded.data',record.interactionId,record.taskId,record.state,JSON.stringify(record))
    this.store.event('interaction.updated',{interaction:view(record)})
    return view(record)
  }
  start(task,id,{question,fields=[]}) {
    const existing=this.get(id)
    if (existing) return existing
    requireThat(text(question,2000) && Array.isArray(fields) && fields.length<=8,'invalid_interaction')
    const ids=new Set()
    for (const field of fields) {
      identifier(field.id,'field_id')
      requireThat(!ids.has(field.id) && text(field.label,300) && ['text','choice','boolean'].includes(field.type),'invalid_interaction_field')
      ids.add(field.id)
      if (field.type==='choice') requireThat(Array.isArray(field.options) && field.options.length>=2 && field.options.length<=12 &&
        field.options.every(option=>text(option,200)) && new Set(field.options).size===field.options.length,'invalid_interaction_options')
      else requireThat(!field.options,'invalid_interaction_options')
    }
    return this.store.tx(()=>this.save({interactionId:id,taskId:task.id,runId:task.runId,runVersion:task.version,
      question,fields:structuredClone(fields),state:'waiting',version:1,createdAt:Date.now(),answer:null}))
  }
  respond({interactionId,expectedVersion,answer}) {
    const row=this.store.one('SELECT data FROM interactions WHERE id=?',identifier(interactionId,'interaction_id'))
    requireThat(row,'interaction_not_found',404)
    const record=JSON.parse(row.data), task=this.store.getTask(record.taskId)
    checkedVersion(expectedVersion,record.version)
    requireThat(record.state==='waiting' && task.runId===record.runId && task.version===record.runVersion && task.state==='waiting_user','interaction_superseded',409)
    if (!record.fields.length) requireThat(text(answer,8000),'invalid_interaction_answer')
    else {
      requireThat(answer && typeof answer==='object' && !Array.isArray(answer),'invalid_interaction_answer')
      requireThat(Object.keys(answer).every(key=>record.fields.some(field=>field.id===key)),'invalid_interaction_answer')
      for (const field of record.fields) {
        const value=answer[field.id]
        if (value===undefined) {requireThat(!field.required,'interaction_answer_required');continue}
        requireThat(field.type==='boolean' ? typeof value==='boolean' : field.type==='choice' ? field.options.includes(value) : text(value,4000),'invalid_interaction_answer')
      }
    }
    return this.store.tx(()=>{
      record.answer=structuredClone(answer);record.state='answered';record.version++
      const result=this.save(record)
      this.onSettled(result)
      return {interaction:result}
    })
  }
  cancelForTask(taskId) {
    for (const row of this.store.rows("SELECT data FROM interactions WHERE task=? AND state='waiting'",taskId)) {
      const record=JSON.parse(row.data);record.state='cancelled';record.version++;this.save(record)
    }
  }
  list({before=Number.MAX_SAFE_INTEGER,waiting=false}={}) {
    const rows=this.store.rows(`SELECT rowid AS n,data FROM interactions WHERE rowid<? ${waiting ? "AND state='waiting'" : ''} ORDER BY rowid DESC LIMIT 51`,before)
    return {interactions:rows.slice(0,50).map(row=>view(JSON.parse(row.data))),nextBefore:rows.length>50 ? rows[49].n : null}
  }
}
