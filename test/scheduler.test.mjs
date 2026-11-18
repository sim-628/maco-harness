import test from 'node:test'
import assert from 'node:assert/strict'
import {ExecutionHost} from '../src/scheduler.mjs'

test('work arriving during pump finalization gets an immediate pass instead of waiting for an alarm',async()=>{
  for (const offset of [1,2,3,4]) {
    let ready=false,processed=false
    const host={pump:null,rerun:false,ctx:{waitUntil(){}},
      async dispatch(){if(ready)processed=true},kick:ExecutionHost.prototype.kick}
    host.kick()
    for(let i=0;i<offset;i++)await Promise.resolve()
    ready=true
    host.kick()
    for(let i=0;i<12;i++)await Promise.resolve()
    assert.equal(processed,true,'lost wake at microtask '+offset)
    assert.equal(host.pump,null)
  }
})
