import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync,readFileSync,writeFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generate,providerPayload,price,reserveFor,configuredProviders } from '../worker/provider.mjs';
import { runJob } from '../worker/start.mjs';

const settings={provider:'openai',model:'fixture-model',maxCalls:2,maxOutputTokens:1024,maxBudgetMicros:1000000,inputUsdPerMillion:2,cachedInputUsdPerMillion:.5,outputUsdPerMillion:10,cacheWritePolicy:'provider-default',cacheWrite30mUsdPerMillion:2.5,cacheWrite12hUsdPerMillion:5,longContextThreshold:null,longContextInputMultiplier:1,longContextOutputMultiplier:1};
const job={id:'provider-fixture',lease:'lease-fixture',prompt:'Build source',settings,project:{name:'Test',tool_id:'ai-script-generator',target:'Standalone',requirements:'Test source',files:[]}};
const files=[{path:'README.md',content:'# Fixture'},{path:'fxmanifest.lua',content:"fx_version 'cerulean'\ngame 'gta5'"}];
const result=(extra={})=>({status:'completed',usage:{input_tokens:100,output_tokens:20,input_tokens_details:{cached_tokens:10}},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({summary:'Finished source',changes:files})}]}],...extra});
const response=extra=>new Response(JSON.stringify(result(extra)));

test('OpenAI and DeepSeek use separate fixed Responses contracts and never accept arbitrary endpoints',async()=>{
  for(const provider of ['openai','deepseek']){
    const current={...job,settings:{...settings,provider,endpoint:'https://unexpected.invalid/steal',cacheWritePolicy:'disabled'}};
    let calls=0;
    const output=await generate(current,[],{key:provider+'-fixture-private-key',fetcher:async(address,options)=>{
      calls++;assert.equal(address,provider==='openai'?'https://api.openai.com/v1/responses':'https://api.deepseek.com/responses');
      assert.equal(options.headers.authorization,'Bearer '+provider+'-fixture-private-key');assert.equal(options.redirect,'error');
      const body=JSON.parse(options.body);
      assert.equal(body.store,false);assert.equal(body.text.format.type,'json_schema');
      assert.equal(JSON.stringify(body).includes('fixture-private-key'),false);
      assert.equal(body.max_output_tokens,1024);
      if(provider==='openai'){
        assert.equal(body.text.format.strict,true);assert.deepEqual(body.prompt_cache_options,{mode:'explicit'});
        assert.equal(body.reasoning,undefined);
      }else{
        assert.equal(body.text.format.strict,undefined);assert.equal(body.prompt_cache_options,undefined);
        assert.deepEqual(body.reasoning,{effort:'none'});
      }
      return response();
    }});
    assert.equal(calls,1);assert.equal(output.files.length,2);assert.equal(output.cost,385);
  }
  let requests=0;
  await assert.rejects(generate({...job,settings:{...settings,provider:'https://unexpected.invalid'}},[],{key:'fixture-private-key',fetcher:async()=>{requests++;return response();}}),/Unsupported coding provider/);
  assert.equal(requests,0);
});

test('legacy OpenAI payloads retain provider defaults unless an explicit cache policy was captured',()=>{
  const payload=providerPayload({...job,settings:{...settings,provider:undefined,cacheWritePolicy:undefined}},[]);
  assert.equal(payload.prompt_cache_options,undefined);assert.equal(payload.text.format.strict,true);
  assert.equal(payload.reasoning,undefined);
});

test('provider credentials are independent and optional with at least one configured provider',()=>{
  assert.deepEqual(configuredProviders({OPENAI_API_KEY:'openai-fixture-key'}),['openai']);
  assert.deepEqual(configuredProviders({DEEPSEEK_API_KEY:'deepseek-fixture-key'}),['deepseek']);
  assert.deepEqual(configuredProviders({OPENAI_API_KEY:'openai-fixture-key',DEEPSEEK_API_KEY:'deepseek-fixture-key'}),['openai','deepseek']);
  assert.throws(()=>configuredProviders({}),/at least one/);
  assert.throws(()=>configuredProviders({DEEPSEEK_API_KEY:'invalid\nprivate-key'}),/privately/);
});

test('OpenAI cache writes are disjoint input tokens and TTL prices do not double-count reasoning or writes',()=>{
  const usage={input_tokens:12000,output_tokens:100,input_tokens_details:{cached_tokens:4000,cache_write_tokens:7000,cache_write_tokens_details:{ttl_30m_tokens:3000,ttl_12h_tokens:4000}},output_tokens_details:{reasoning_tokens:80}};
  assert.equal(price(usage,settings),32500);
  assert.equal(price({...usage,input_tokens_details:{cached_tokens:4000,cache_write_tokens:0}},settings),19000);
});

test('missing or invalid cache write meters and unknown TTL prices cannot silently undercharge',()=>{
  const base={input_tokens:100,output_tokens:1,input_tokens_details:{cached_tokens:20,cache_write_tokens:50,cache_write_tokens_details:{ttl_30m_tokens:30,ttl_12h_tokens:20}}};
  for(const details of [
    {...base.input_tokens_details,cache_write_tokens:-1},
    {...base.input_tokens_details,cached_tokens:51},
    {...base.input_tokens_details,cache_write_tokens_details:undefined},
    {...base.input_tokens_details,cache_write_tokens_details:{ttl_30m_tokens:50}},
    {...base.input_tokens_details,cache_write_tokens_details:{ttl_30m_tokens:40,ttl_12h_tokens:20}},
    {...base.input_tokens_details,cache_write_tokens_details:{ttl_30m_tokens:30,ttl_12h_tokens:'20'}},
  ])assert.throws(()=>price({...base,input_tokens_details:details},settings));
  assert.throws(()=>price(base,{...settings,cacheWrite30mUsdPerMillion:null}),/30-minute/);
  assert.throws(()=>price(base,{...settings,cacheWrite12hUsdPerMillion:null}),/12-hour/);
  assert.throws(()=>price(base,{...settings,provider:'deepseek',cacheWrite30mUsdPerMillion:0,cacheWrite12hUsdPerMillion:0}),/unverified cache write/);
});

test('long context multipliers apply to the entire request only above the captured threshold',()=>{
  const current={...settings,longContextThreshold:272000,longContextInputMultiplier:2,longContextOutputMultiplier:1.5};
  const usage={input_tokens:272000,output_tokens:100,input_tokens_details:{cached_tokens:4000,cache_write_tokens:7000,cache_write_tokens_details:{ttl_30m_tokens:3000,ttl_12h_tokens:4000}}};
  assert.equal(price(usage,current),price(usage,settings));
  const extended={...usage,input_tokens:272001};
  assert.equal(price(extended,current),((272001-4000-7000)*2+4000*.5+3000*2.5+4000*5)*2+100*10*1.5);
});

test('reservation covers the most expensive permitted cache write policy and possible long context tier',()=>{
  const payload={input:'x'.repeat(272001)},input=Buffer.byteLength(JSON.stringify(payload))+4096;
  const current={...settings,longContextThreshold:272000,longContextInputMultiplier:2,longContextOutputMultiplier:1.5};
  assert.equal(reserveFor(payload,current),Math.ceil(input*5*2+1024*10*1.5));
  assert.equal(reserveFor(payload,{...current,cacheWritePolicy:'disabled'}),Math.ceil(input*2*2+1024*10*1.5));
  assert.equal(reserveFor(payload,{...current,longContextThreshold:null}),Math.ceil(input*5+1024*10));
});

test('DeepSeek refusal, incomplete output and unsafe schema retain known usage without paid retry or fallback',async()=>{
  const current={...job,settings:{...settings,provider:'deepseek'}};
  for(const extra of [
    {status:'incomplete'},
    {output:[{type:'message',content:[{type:'refusal',refusal:'Declined'}]}]},
    {output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({summary:'Unsafe',changes:[{path:'../escape.lua',content:'x'}]})}]}]},
    {output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({summary:'Unknown fields',changes:files,extra:true})}]}]},
  ]){
    let calls=0;
    await assert.rejects(generate(current,[],{key:'deepseek-fixture-private-key',fetcher:async address=>{calls++;assert.equal(address,'https://api.deepseek.com/responses');return response(extra);}}),error=>error.providerCostMicros===385);
    assert.equal(calls,1);
  }
  let calls=0;
  await assert.rejects(generate(current,[],{key:'deepseek-fixture-private-key',fetcher:async()=>{calls++;return new Response('{}',{status:503});}}));
  assert.equal(calls,1);
});

test('DeepSeek cancellation and budget checks preserve abort signals and prevent unapproved paid requests',async()=>{
  const current={...job,settings:{...settings,provider:'deepseek'}},controller=new AbortController();
  let called=0;
  await assert.rejects(generate({...current,settings:{...current.settings,maxBudgetMicros:1}},[],{key:'deepseek-fixture-private-key',fetcher:async()=>{called++;return response();}}),/estimate exceeds/);
  assert.equal(called,0);
  const pending=generate(current,[],{key:'deepseek-fixture-private-key',signal:controller.signal,fetcher:async(_,options)=>new Promise((_,reject)=>{
    called++;options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});
  })});
  controller.abort();await assert.rejects(pending);assert.equal(called,1);
});

test('unknown cache write billing retains a conservative reservation instead of claiming known zero usage',async()=>{
  const current={...job,settings:{...settings,cacheWrite30mUsdPerMillion:null,cacheWrite12hUsdPerMillion:null}},receipts=[];let generated=0;
  await runJob(current,{key:'fixture-private-key',preflight:async()=>{},generator:async(current,files,options)=>{
    generated++;return generate(current,files,{...options,fetcher:async()=>response({usage:{input_tokens:100,output_tokens:20,input_tokens_details:{cache_write_tokens:30,cache_write_tokens_details:{ttl_30m_tokens:30,ttl_12h_tokens:0}}}})});
  },api:async(path,body)=>{if(path==='/api/worker/complete')receipts.push(body);return {};}});
  assert.equal(generated,1);assert.equal(receipts.length,1);assert.equal(receipts[0].costMicros,current.settings.maxBudgetMicros);
  assert.equal(receipts[0].result.files,undefined);assert.ok(receipts[0].result.error);
});

test('worker installer preserves DeepSeek-only and unrelated private settings without prompting',t=>{
  const directory=mkdtempSync(join(tmpdir(),'nd-provider-env-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const script=readFileSync(new URL('../deploy/setup-worker.sh',import.meta.url),'utf8');
  const block=/^python3[^\n]* <<'PY'\n([\s\S]*?)^PY$/m.exec(script)[1];
  const envPath=join(directory,'worker.env'),original="STUDIO_ORIGIN=https://ai.nightz.dev\nSTUDIO_WORKER_TOKEN="+'a'.repeat(64)+"\nDEEPSEEK_API_KEY=deepseek-fixture-private-key\n# Existing private binding\nCUSTOM_PROVIDER_SETTING='preserve this value'\n";
  writeFileSync(envPath,original,{mode:0o600});
  const source=block.replace("Path.home() / '.config/nd-ai-worker.env'",'Path('+JSON.stringify(envPath)+')');
  const output=spawnSync('python3',['-'],{input:source,env:{PATH:process.env.PATH,ND_AI_VALIDATOR_IMAGE:'sha256:'+'a'.repeat(64),DOCKER_HOST:'unix:///fixture/docker.sock'},encoding:'utf8',timeout:3000});
  assert.equal(output.status,0,output.stdout+output.stderr);assert.equal(output.stdout,'');assert.equal(output.stderr,'');
  const saved=readFileSync(envPath,'utf8');
  assert.ok(saved.includes('DEEPSEEK_API_KEY=deepseek-fixture-private-key\n'));assert.ok(saved.includes("# Existing private binding\nCUSTOM_PROVIDER_SETTING='preserve this value'\n"));
  assert.equal(saved.includes('OPENAI_API_KEY='),false);
});
