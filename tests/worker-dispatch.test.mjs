import test from 'node:test';
import assert from 'node:assert/strict';
import { runJob } from '../worker/start.mjs';
import { generate } from '../worker/provider.mjs';

const files=[{path:'README.md',content:'# Test source'}];
const job={id:'dispatch-test',lease:'dispatch-lease',prompt:'Create source',settings:{model:'fixture-model',maxCalls:2,maxOutputTokens:1024,maxBudgetMicros:1000000,inputUsdPerMillion:1,outputUsdPerMillion:2},project:{name:'Test',tool_id:'ai-script-generator',target:'Standalone',requirements:'Test source',files:[]}};
function setup(extra={}) {
  return {preflight:async()=>{},generator:async()=>({files,summary:'Test source',cost:123}),validator:async()=>({ok:true,checks:['Syntax passed.']}),...extra};
}

test('cancellation during generation progress prevents dispatch and reports known zero cost',async()=>{
  const stop=new AbortController(),completions=[];let dispatched=0;
  await runJob(job,setup({signal:stop.signal,
    api:async(path,body)=>{
      if(path==='/api/worker/progress' && body.stage==='generating')stop.abort();
      if(path==='/api/worker/complete')completions.push(body);
      return {};
    },
    generator:async(_,__,{signal})=>{dispatched++;signal.throwIfAborted();}
  }));
  assert.equal(dispatched,0);assert.equal(completions.length,1);
  assert.equal(completions[0].costMicros,0);assert.match(completions[0].result.error,/interrupted/);
});

test('cancellation during preflight progress does not begin validator work',async()=>{
  const stop=new AbortController(),completions=[];let preflights=0,dispatched=0;
  await runJob(job,setup({signal:stop.signal,
    preflight:async()=>{preflights++;},
    generator:async()=>{dispatched++;return {files,summary:'Unexpected output',cost:123};},
    api:async(path,body)=>{
      if(path==='/api/worker/progress' && body.stage==='checking')stop.abort();
      if(path==='/api/worker/complete')completions.push(body);
      return {};
    }
  }));
  assert.equal(preflights,0);assert.equal(dispatched,0);assert.equal(completions[0].costMicros,0);
});

test('cancellation during post-generation progress does not start another validator',async()=>{
  const stop=new AbortController(),completions=[];let checked=0,checkingEvents=0;
  await runJob(job,setup({signal:stop.signal,
    validator:async()=>{checked++;return {ok:true,checks:[]};},
    api:async(path,body)=>{
      if(path==='/api/worker/progress' && body.stage==='checking' && ++checkingEvents===2)stop.abort();
      if(path==='/api/worker/complete')completions.push(body);
      return {};
    }
  }));
  assert.equal(checked,0);assert.equal(completions[0].costMicros,123);assert.equal(completions[0].result.files,undefined);
});

test('cancellation during repair progress preserves prior usage without starting or charging another request',async()=>{
  const stop=new AbortController(),completions=[];let dispatched=0;
  await runJob(job,setup({signal:stop.signal,
    api:async(path,body)=>{
      if(path==='/api/worker/progress' && body.stage==='repairing')stop.abort();
      if(path==='/api/worker/complete')completions.push(body);
      return {};
    },
    generator:async(_,__,{signal})=>{dispatched++;signal.throwIfAborted();return {files,summary:'Needs repair',cost:123};},
    validator:async()=>({ok:false,kind:'source',checks:['Invalid Lua syntax.']})
  }));
  assert.equal(dispatched,1);assert.equal(completions.length,1);
  assert.equal(completions[0].costMicros,123);assert.equal(completions[0].result.files,undefined);
});

test('missing credentials fail before transport and do not claim uncertain provider spend',async()=>{
  const completions=[];let requested=0;
  await runJob(job,setup({
    generator:async(current,files,options)=>generate(current,files,{...options,fetcher:async()=>{requested++;throw new Error('Must not call transport');}}),
    api:async(path,body)=>{if(path==='/api/worker/complete')completions.push(body);return {};}
  }));
  assert.equal(requested,0);assert.equal(completions.length,1);
  assert.equal(completions[0].costMicros,0);assert.match(completions[0].result.error,/credentials/);
});

test('already aborted provider generation reports zero usage without invoking transport',async()=>{
  const stop=new AbortController();stop.abort();let requested=0;
  await assert.rejects(generate(job,[],{key:'fixture-private-provider-key',signal:stop.signal,fetcher:async()=>{requested++;throw new Error('Transport was invoked');}}),error=>error.name==='AbortError' && error.providerCostMicros===0);
  assert.equal(requested,0);
});

test('unknown failures after transport dispatch still retain the full conservative hold',async()=>{
  const completions=[];let requested=0;
  await runJob(job,setup({key:'fixture-private-provider-key',
    generator:async(current,files,options)=>generate(current,files,{...options,fetcher:async()=>{requested++;throw new TypeError('Connection lost after sending request');}}),
    api:async(path,body)=>{if(path==='/api/worker/complete')completions.push(body);return {};}
  }));
  assert.equal(requested,1);assert.equal(completions.length,1);
  assert.equal(completions[0].costMicros,job.settings.maxBudgetMicros);assert.equal(completions[0].result.files,undefined);
});

test('only explicitly classified source errors authorize another paid repair request',async()=>{
  for(const kind of [undefined,'unexpected','infrastructure']){
    const completions=[];let dispatched=0;
    await runJob(job,setup({
      generator:async()=>{dispatched++;return {files,summary:'Source',cost:123};},
      validator:async()=>({ok:false,kind,checks:['Unclassified validator failure.']}),
      api:async(path,body)=>{if(path==='/api/worker/complete')completions.push(body);return {};}
    }));
    assert.equal(dispatched,1);assert.equal(completions.length,1);assert.equal(completions[0].costMicros,123);
    assert.match(completions[0].result.error,/infrastructure/);assert.equal(completions[0].result.files,undefined);
  }
});
