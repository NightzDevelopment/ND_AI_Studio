import test from 'node:test';
import assert from 'node:assert/strict';
import { runJob } from '../worker/start.mjs';

const files=[{path:'README.md',content:'# Finished source'},{path:'main.js',content:'const ready = true;'}];
const job={id:'completion-test',lease:'original-lease',prompt:'Build source',settings:{model:'fixture-model',maxCalls:2,maxOutputTokens:1024,maxBudgetMicros:1000000,inputUsdPerMillion:1,outputUsdPerMillion:2},project:{name:'Source',tool_id:'discord-bot-generator',target:'Standalone',requirements:'Build source',files:[]}};
const httpError=status=>Object.assign(new Error('Worker API status '+status+'.'),{status});
function preparation(extra={}) {
  return {preflight:async()=>{},generator:async()=>({files,summary:'Validated output',cost:123}),validator:async()=>({ok:true,checks:['Syntax passed.','Not tested: runtime behavior.']}),wait:async()=>{},...extra};
}

test('lost successful acknowledgement replays one completion without repeating paid generation or validation',async()=>{
  let generated=0,validated=0;const receipts=[],pauses=[];
  const reply=await runJob(job,preparation({
    generator:async()=>{generated++;return {files,summary:'Validated output',cost:123};},
    validator:async()=>{validated++;return {ok:true,checks:['Syntax passed.']};},
    wait:async milliseconds=>pauses.push(milliseconds),
    api:async(path,body)=>{
      if(path!=='/api/worker/complete')return {};
      receipts.push(JSON.stringify(body));
      if(receipts.length===1)throw new TypeError('Acknowledgement lost after commit');
      return {ok:true,status:'applied',appliedVersion:2};
    }
  }));
  assert.equal(generated,1);assert.equal(validated,1);
  assert.equal(receipts.length,2);assert.equal(receipts[0],receipts[1]);
  assert.deepEqual(pauses,[250]);assert.equal(reply.appliedVersion,2);
  assert.deepEqual(JSON.parse(receipts[0]).result.files,files);
});

test('temporary completion failures have bounded backoff and identical original receipt data',async()=>{
  const receipts=[],pauses=[];let generated=0;
  const reply=await runJob(job,preparation({
    generator:async()=>{generated++;return {files,summary:'Validated output',cost:123};},
    wait:async milliseconds=>pauses.push(milliseconds),
    api:async(path,body)=>{
      if(path!=='/api/worker/complete')return {};
      receipts.push(JSON.stringify(body));
      if(receipts.length<3){body.result.files[0].content='Mutated adapter input';throw httpError(receipts.length===1 ? 503 : 429);}
      return {ok:true,status:'review',applicationError:'A newer revision exists.'};
    }
  }));
  assert.equal(generated,1);assert.equal(receipts.length,3);
  assert.ok(receipts.every(receipt=>receipt===receipts[0]));assert.deepEqual(pauses,[250,1000]);
  assert.equal(reply.status,'review');assert.deepEqual(JSON.parse(receipts[0]).result.files,files);
});

test('exhausted acknowledgement retries never replace validated files with an error completion',async()=>{
  const receipts=[];let generated=0;
  await assert.rejects(runJob(job,preparation({
    generator:async()=>{generated++;return {files,summary:'Validated output',cost:123};},
    api:async(path,body)=>{
      if(path!=='/api/worker/complete')return {};
      receipts.push(JSON.stringify(body));throw new TypeError('Network unavailable');
    }
  })),/Network unavailable/);
  assert.equal(generated,1);assert.equal(receipts.length,3);
  assert.ok(receipts.every(receipt=>receipt===receipts[0]));
  assert.equal(JSON.parse(receipts[0]).result.error,undefined);
});

test('cancelled leases, invalid payloads and authentication rejection are not retried',async()=>{
  for(const status of [400,401,403,409]){
    let completions=0;const pauses=[];
    await assert.rejects(runJob(job,preparation({
      wait:async milliseconds=>pauses.push(milliseconds),
      api:async(path,body)=>{
        if(path!=='/api/worker/complete')return {};
        completions++;assert.deepEqual(body.result.files,files);throw httpError(status);
      }
    })),error=>error.status===status);
    assert.equal(completions,1);assert.deepEqual(pauses,[]);
  }
});

test('legacy server acknowledgement remains compatible without requiring the new response fields',async()=>{
  let completions=0;
  const reply=await runJob(job,preparation({api:async path=>{
    if(path==='/api/worker/complete')completions++;
    return {ok:true};
  }}));
  assert.equal(completions,1);assert.deepEqual(reply,{ok:true});
});

test('interruption after provider completion retains known cost and cannot submit unchecked files',async()=>{
  const stop=new AbortController(),receipts=[];let checked=0;
  await runJob(job,preparation({signal:stop.signal,
    generator:async()=>{stop.abort();return {files,summary:'Unchecked output',cost:123};},
    validator:async()=>{checked++;return {ok:true,checks:[]};},
    api:async(path,body)=>{if(path==='/api/worker/complete')receipts.push(body);return {};}
  }));
  assert.equal(checked,0);assert.equal(receipts.length,1);
  assert.equal(receipts[0].costMicros,123);assert.equal(receipts[0].result.files,undefined);
  assert.match(receipts[0].result.error,/interrupted/);
});

test('failed validation only delivers an error and never repeats generation during acknowledgement retry',async()=>{
  const receipts=[];let generated=0,checked=0;
  await runJob(job,preparation({
    generator:async()=>{generated++;return {files,summary:'Invalid output',cost:123};},
    validator:async()=>{checked++;return {ok:false,kind:'source',checks:['main.js: syntax failed.']};},
    api:async(path,body)=>{
      if(path!=='/api/worker/complete')return {};
      receipts.push(JSON.stringify(body));if(receipts.length===1)throw httpError(502);return {};
    }
  }));
  assert.equal(generated,2);assert.equal(checked,2);assert.equal(receipts.length,2);
  assert.equal(receipts[0],receipts[1]);assert.equal(JSON.parse(receipts[0]).costMicros,246);
  assert.match(JSON.parse(receipts[0]).result.error,/Validation did not pass/);
  assert.equal(JSON.parse(receipts[0]).result.files,undefined);
});

test('an in-flight heartbeat rejection after terminal commit cannot invalidate completion delivery',async t=>{
  t.mock.timers.enable({apis:['setInterval']});
  let rejectHeartbeat,heartbeats=0,completions=0;
  await runJob(job,preparation({
    generator:async()=>{
      t.mock.timers.tick(10000);
      return {files,summary:'Validated output',cost:123};
    },
    wait:async()=>{
      rejectHeartbeat(httpError(409));
      await Promise.resolve();
      t.mock.timers.tick(20000);
    },
    api:async(path,body)=>{
      if(path==='/api/worker/progress'&&!body.stage){heartbeats++;return new Promise((_,reject)=>{rejectHeartbeat=reject;});}
      if(path==='/api/worker/complete'){
        completions++;assert.deepEqual(body.result.files,files);
        if(completions===1)throw new TypeError('Lost acknowledgement');
      }
      return {ok:true};
    }
  }));
  assert.equal(heartbeats,1);assert.equal(completions,2);
});
