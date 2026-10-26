import test from 'node:test';
import assert from 'node:assert/strict';
import { runJob } from '../worker/start.mjs';
import { generate } from '../worker/provider.mjs';

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
  assert.equal('accounting' in JSON.parse(receipts[0]).result,false);
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

const unreconciled={status:'unreconciled',reason:'cache-write-lifetimes-unavailable'};
function meteredResponse(usage,extra={}){
  return new Response(JSON.stringify({status:'completed',usage,output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({summary:'Generated source',changes:files})}]}],...extra}));
}

test('a known first call followed by an unpriced repair retains exactly one full job reservation',async()=>{
  const receipts=[],spent=[];let requested=0,checked=0;
  await runJob(job,preparation({key:'fixture-provider-key',
    generator:async(current,source,options)=>{spent.push(options.spent);return generate(current,source,{...options,fetcher:async()=>{
      requested++;return meteredResponse(requested===1?{input_tokens:100,output_tokens:20}:{input_tokens:100,output_tokens:20,input_tokens_details:{cache_write_tokens:30}});
    }});},
    validator:async()=>({ok:++checked===2,kind:checked===2?'ok':'source',checks:checked===1?['main.js: syntax failed.']:['Syntax passed.']}),
    api:async(path,body)=>{if(path==='/api/worker/complete')receipts.push(body);return {};}
  }));
  assert.equal(requested,2);assert.equal(checked,2);assert.deepEqual(spent,[0,140]);
  assert.equal(receipts.length,1);assert.equal(receipts[0].costMicros,job.settings.maxBudgetMicros);
  assert.equal(receipts[0].result.error,undefined);assert.deepEqual(receipts[0].result.accounting,unreconciled);
});

test('unpriced first-call validation failure cannot dispatch another paid repair',async()=>{
  const receipts=[];let requested=0,checked=0;
  await runJob(job,preparation({key:'fixture-provider-key',
    generator:async(current,source,options)=>generate(current,source,{...options,fetcher:async()=>{requested++;return meteredResponse({input_tokens:100,output_tokens:20,input_tokens_details:{cache_write_tokens:30}});}}),
    validator:async()=>{checked++;return {ok:false,kind:'source',checks:['main.js: syntax failed.']};},
    api:async(path,body)=>{if(path==='/api/worker/complete')receipts.push(body);return {};}
  }));
  assert.equal(requested,1);assert.equal(checked,1);assert.equal(receipts.length,1);
  assert.equal(receipts[0].costMicros,job.settings.maxBudgetMicros);assert.equal(receipts[0].result.files,undefined);
  assert.match(receipts[0].result.error,/no further provider request was sent/i);assert.deepEqual(receipts[0].result.accounting,unreconciled);
});

test('unpriced successful completion preserves immutable accounting metadata across acknowledgement retries',async()=>{
  const receipts=[];let generated=0,checked=0;
  await runJob(job,preparation({
    generator:async()=>{generated++;return {files,summary:'Validated source',cost:job.settings.maxBudgetMicros,accounting:{...unreconciled}};},
    validator:async()=>{checked++;return {ok:true,checks:['Syntax passed.']};},
    api:async(path,body)=>{
      if(path!=='/api/worker/complete')return {};
      receipts.push(JSON.stringify(body));
      if(receipts.length===1){body.result.accounting.reason='cache-write-price-unconfigured';throw new TypeError('Acknowledgement lost after commit');}
      return {ok:true,status:'applied'};
    }
  }));
  assert.equal(generated,1);assert.equal(checked,1);assert.equal(receipts.length,2);assert.equal(receipts[0],receipts[1]);
  const saved=JSON.parse(receipts[0]);assert.equal(saved.costMicros,job.settings.maxBudgetMicros);assert.deepEqual(saved.result.accounting,unreconciled);assert.deepEqual(saved.result.files,files);
});

test('cancellation after unpriced provider output preserves the reservation but never submits unchecked files',async()=>{
  const stop=new AbortController(),receipts=[];let checked=0;
  await runJob(job,preparation({signal:stop.signal,
    generator:async()=>{stop.abort();return {files,summary:'Unchecked source',cost:job.settings.maxBudgetMicros,accounting:{...unreconciled}};},
    validator:async()=>{checked++;return {ok:true,checks:[]};},
    api:async(path,body)=>{if(path==='/api/worker/complete')receipts.push(body);return {};}
  }));
  assert.equal(checked,0);assert.equal(receipts.length,1);assert.equal(receipts[0].costMicros,job.settings.maxBudgetMicros);
  assert.equal(receipts[0].result.files,undefined);assert.match(receipts[0].result.error,/interrupted/);assert.deepEqual(receipts[0].result.accounting,unreconciled);
});

test('validator infrastructure failure after unpriced output preserves its accounting without a paid repair',async()=>{
  const receipts=[];let generated=0,checked=0;
  await runJob(job,preparation({
    generator:async()=>{generated++;return {files,summary:'Unchecked source',cost:job.settings.maxBudgetMicros,accounting:{...unreconciled}};},
    validator:async()=>{checked++;throw Object.assign(new Error('Validator infrastructure unavailable.'),{status:503});},
    api:async(path,body)=>{if(path==='/api/worker/complete')receipts.push(body);return {};}
  }));
  assert.equal(generated,1);assert.equal(checked,1);assert.equal(receipts.length,1);assert.equal(receipts[0].costMicros,job.settings.maxBudgetMicros);
  assert.equal(receipts[0].result.files,undefined);assert.match(receipts[0].result.error,/infrastructure/);assert.deepEqual(receipts[0].result.accounting,unreconciled);
});

test('invalid structured output with unpriced usage propagates its full reservation and accounting to failure delivery',async()=>{
  const receipts=[];let requested=0,checked=0;
  await runJob(job,preparation({key:'fixture-provider-key',
    generator:async(current,source,options)=>generate(current,source,{...options,fetcher:async()=>{
      requested++;return meteredResponse({input_tokens:100,output_tokens:20,input_tokens_details:{cache_write_tokens:30}},
        {output:[{type:'message',content:[{type:'output_text',text:'{malformed JSON'}]}]});
    }}),
    validator:async()=>{checked++;return {ok:true,checks:[]};},
    api:async(path,body)=>{if(path==='/api/worker/complete')receipts.push(body);return {};}
  }));
  assert.equal(requested,1);assert.equal(checked,0);assert.equal(receipts.length,1);assert.equal(receipts[0].costMicros,job.settings.maxBudgetMicros);
  assert.equal(receipts[0].result.files,undefined);assert.ok(receipts[0].result.error);assert.deepEqual(receipts[0].result.accounting,unreconciled);
});
