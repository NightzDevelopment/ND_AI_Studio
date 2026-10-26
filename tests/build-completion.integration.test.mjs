import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { createApp, hash } from '../server/app.mjs';
import { readConfig } from '../server/config.mjs';
import { runJob } from '../worker/start.mjs';
import { generate } from '../worker/provider.mjs';

const ownerId='100000000000000001';
const generatedFiles=[{path:'README.md',content:'# Completed resource'}, {path:'client.lua',content:'print("generated")'}].sort((a,b)=>a.path.localeCompare(b.path));
const catalog={tools:[{id:'ai-script-generator',engine:'coding',category:'create'}]};
async function fixture(t,provider='openai',modelOverrides={}) {
  const directory=await mkdtemp(join(tmpdir(),'studio-completion-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const database=join(directory,'studio.sqlite');
  const config=readConfig({NODE_ENV:'development',APP_ORIGIN:'http://127.0.0.1',OWNER_DISCORD_IDS:ownerId,STUDIO_WORKER_TOKEN:'f'.repeat(64)});
  const session=randomBytes(32).toString('base64url'),csrf=randomBytes(32).toString('base64url');
  let store,server,base,user;
  async function start(first=false) {
    store=new Store(database);
    if(first){
      user=store.login({id:ownerId,username:'Fixture',displayName:'Fixture',avatar:null});
      store.newSession(hash(session),user.id,csrf,3600);
    }
    server=createApp({store,config,catalog});
    server.listen(0,'127.0.0.1');await once(server,'listening');
    base=`http://127.0.0.1:${server.address().port}`;
  }
  async function stop(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();}
  await start(true);t.after(stop);
  async function request(path,{method='GET',body,worker=false,binary=false}={}) {
    const headers=worker?{authorization:`Bearer ${config.workerToken}`}:{cookie:`${config.sessionCookie}=${session}`,origin:config.origin,'x-csrf-token':csrf};
    if(body!==undefined)headers['content-type']='application/json';
    const response=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
    const data=binary?Buffer.from(await response.arrayBuffer()):await response.json();
    if(!response.ok)throw Object.assign(new Error(data.error||`HTTP ${response.status}`),{status:response.status});
    return data;
  }
  const worker=(path,body)=>request(path,{method:'POST',body,worker:true});
  const current=(await request('/api/admin/settings')).settings;
  await request('/api/admin/settings',{method:'PATCH',body:{...current,tools:{'ai-script-generator':'owner','discord-bot-generator':'disabled'}}});
  const settings=await request('/api/admin/models');
  await request('/api/admin/models',{method:'PATCH',body:{version:settings.version,creditsEnabled:true,defaultModelId:'fixture-model',models:[{
    id:'fixture-model',label:'Fixture',provider,tier:'budget',enabled:true,compatible:true,inputUsdPerMillion:1,cachedInputUsdPerMillion:.25,outputUsdPerMillion:2,
    maxOutputTokens:1024,maxCalls:2,maxBudgetMicros:100000,timeoutSeconds:180,creditsPerBuild:5,...modelOverrides
  }]}});
  await request('/api/admin/credits',{method:'POST',body:{discordId:ownerId,amount:25,reason:'Integration fixture',requestId:randomUUID(),version:0}});
  await worker('/api/worker/heartbeat',{ready:true,providers:[provider]});
  const {project}=await request('/api/projects',{method:'POST',body:{name:'ND_Fixture',toolId:'ai-script-generator',target:'Standalone',requirements:'Fixture-only build'}});
  const models=await request('/api/studio/models');
  const queued=await request(`/api/projects/${project.id}/jobs`,{method:'POST',body:{version:1,prompt:'Build source',requestId:randomUUID(),modelId:'fixture-model',pricingVersion:models.pricingVersion,quotedCredits:5}});
  const {job}=await worker('/api/worker/claim',{});assert.equal(job.id,queued.job.id);
  return {request,worker,project,job,get store(){return store;},restart:async()=>{await stop();await start();}};
}

test('worker acknowledgement loss, API restart and legacy apply retain one revision and one credit debit',async t=>{
  const f=await fixture(t);let generationCalls=0,validationCalls=0,deliveries=0;
  const reply=await runJob(f.job,{
    preflight:async()=>{},wait:async()=>{},
    generator:async()=>{generationCalls++;return {files:generatedFiles,summary:'Fixture result',cost:100};},
    validator:async()=>{validationCalls++;return {ok:true,checks:['Fixture validation passed; no live container was run.']};},
    api:async(path,body)=>{
      const result=await f.worker(path,body);
      if(path==='/api/worker/complete'&&++deliveries===1){await f.restart();throw new TypeError('Response lost after durable commit');}
      return result;
    }
  });
  assert.equal(generationCalls,1);assert.equal(validationCalls,1);assert.equal(deliveries,2);
  assert.equal(reply.status,'applied');assert.equal(reply.appliedVersion,2);
  const saved=(await f.request(`/api/projects/${f.project.id}`)).project;
  assert.equal(saved.version,2);assert.deepEqual(saved.files,generatedFiles);
  const job=(await f.request(`/api/jobs/${f.job.id}`)).job;
  assert.equal(job.status,'applied');assert.equal(job.appliedVersion,2);assert.equal(job.credits.state,'charged');
  const zip=await f.request(`/api/jobs/${f.job.id}/export`,{binary:true});assert.equal(zip.readUInt32LE(0),0x04034b50);
  await f.request(`/api/jobs/${f.job.id}/apply`,{method:'POST',body:{version:1}});
  assert.equal((await f.request(`/api/studio/credits`)).wallet.balance,20);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM studio_revisions WHERE project_id=?').get(f.project.id).n,2);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM studio_credit_ledger WHERE kind='charged'").get().n,1);
});

test('worker preserves a finished downloadable result when an edit wins the revision race',async t=>{
  const f=await fixture(t);
  const reply=await runJob(f.job,{
    preflight:async()=>{},wait:async()=>{},
    generator:async()=>{
      await f.request(`/api/projects/${f.project.id}/files`,{method:'PUT',body:{version:1,path:'manual.lua',content:'print("manual")'}});
      return {files:generatedFiles,summary:'Fixture conflict result',cost:100};
    },
    validator:async()=>({ok:true,checks:['Fixture validation passed; no live container was run.']}),
    api:f.worker
  });
  assert.equal(reply.status,'review');assert.equal(reply.appliedVersion,null);assert.ok(reply.applicationError);
  const saved=(await f.request(`/api/projects/${f.project.id}`)).project;
  assert.equal(saved.version,2);assert.deepEqual(saved.files,[{path:'manual.lua',content:'print("manual")'}]);
  const job=(await f.request(`/api/jobs/${f.job.id}`)).job;
  assert.deepEqual(job.result.files,generatedFiles);assert.equal(job.credits.state,'charged');
  const zip=await f.request(`/api/jobs/${f.job.id}/export`,{binary:true});assert.ok(zip.includes(Buffer.from('client.lua')));
  await f.restart();assert.equal((await f.request(`/api/jobs/${f.job.id}`)).job.applicationError,job.applicationError);
  assert.equal((await f.request('/api/studio/credits')).wallet.balance,20);
});

test('DeepSeek provider snapshot reaches its adapter and atomically saves the validated result and credit settlement',async t=>{
  const f=await fixture(t,'deepseek');let providerCalls=0,validations=0;
  assert.equal(f.job.settings.provider,'deepseek');
  const reply=await runJob(f.job,{
    key:'deepseek-integration-fixture-key',preflight:async()=>{},wait:async()=>{},api:f.worker,
    generator:async(job,files,options)=>generate(job,files,{...options,fetcher:async(address,request)=>{
      providerCalls++;assert.equal(address,'https://api.deepseek.com/responses');
      assert.equal(request.headers.authorization,'Bearer deepseek-integration-fixture-key');
      const payload=JSON.parse(request.body);assert.deepEqual(payload.reasoning,{effort:'none'});
      assert.equal(payload.text.format.strict,undefined);assert.equal(payload.prompt_cache_options,undefined);
      return new Response(JSON.stringify({status:'completed',usage:{input_tokens:1000,output_tokens:200,input_tokens_details:{cached_tokens:400}},
        output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({summary:'Provider fixture result',changes:generatedFiles})}]}]}));
    }}),
    validator:async files=>{validations++;assert.deepEqual(files,generatedFiles);return {ok:true,checks:['Fixture validation passed; no live container was run.']};}
  });
  assert.equal(providerCalls,1);assert.equal(validations,1);assert.equal(reply.status,'applied');
  const job=(await f.request(`/api/jobs/${f.job.id}`)).job;
  assert.equal(job.provider,'deepseek');assert.equal(job.costMicros,1100);assert.equal(job.credits.state,'charged');
  assert.deepEqual((await f.request(`/api/projects/${f.project.id}`)).project.files,generatedFiles);
  assert.equal((await f.request('/api/studio/credits')).wallet.balance,20);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM studio_credit_ledger WHERE kind='charged'").get().n,1);
});

const unreconciled=reason=>({status:'unreconciled',reason});
const providerResult=usage=>({status:'completed',usage,output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({summary:'Generated source with unreconciled cache writes',changes:generatedFiles})}]}]});

for(const variant of ['lifetimes-unavailable','price-unconfigured'])test(`${variant} cache writes still validate and save, with a durable full-reservation accounting receipt`,async t=>{
  const knownRates=variant==='lifetimes-unavailable'?{cacheWrite30mUsdPerMillion:1.25,cacheWrite12hUsdPerMillion:2.5}:{};
  const f=await fixture(t,'openai',knownRates),expected=unreconciled(`cache-write-${variant}`);
  const details={cached_tokens:20,cache_write_tokens:50};
  if(variant==='price-unconfigured')details.cache_write_tokens_details={ttl_30m_tokens:30,ttl_12h_tokens:20};
  const usage={input_tokens:100,output_tokens:20,input_tokens_details:details};
  let calls=0,validations=0,deliveries=0;const receipts=[];
  const reply=await runJob(f.job,{
    key:'openai-accounting-fixture-key',preflight:async()=>{},wait:async()=>{},
    generator:async(job,files,options)=>generate(job,files,{...options,fetcher:async(address,request)=>{
      calls++;assert.equal(address,'https://api.openai.com/v1/responses');assert.equal(request.headers.authorization,'Bearer openai-accounting-fixture-key');
      return new Response(JSON.stringify(providerResult(usage)),{headers:{'content-type':'application/json'}});
    }}),
    validator:async files=>{validations++;assert.deepEqual(files,generatedFiles);return {ok:true,checks:['Fixture syntax and packaging validation passed.']};},
    api:async(path,body)=>{
      const result=await f.worker(path,body);
      if(path==='/api/worker/complete'){
        receipts.push(JSON.stringify(body));deliveries++;
        if(deliveries===1){await f.restart();throw new TypeError('Accounting completion acknowledgement lost after commit');}
      }
      return result;
    }
  });
  assert.equal(calls,1);assert.equal(validations,1);assert.equal(deliveries,2);assert.equal(receipts[0],receipts[1]);
  assert.equal(reply.status,'applied');assert.equal(reply.appliedVersion,2);
  const job=(await f.request(`/api/jobs/${f.job.id}`)).job;
  assert.equal(job.status,'applied');assert.equal(job.costMicros,f.job.settings.maxBudgetMicros);assert.deepEqual(job.result.accounting,expected);
  assert.deepEqual(job.result.files,generatedFiles);assert.equal(job.credits.state,'charged');
  const project=(await f.request(`/api/projects/${f.project.id}`)).project;
  assert.equal(project.version,2);assert.deepEqual(project.files,generatedFiles);
  assert.equal((await f.request('/api/studio/credits')).wallet.balance,20);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM studio_revisions WHERE project_id=?').get(f.project.id).n,2);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM studio_credit_ledger WHERE kind='charged'").get().n,1);
  const receipt=JSON.parse(receipts[0]),other=variant==='lifetimes-unavailable'?'cache-write-price-unconfigured':'cache-write-lifetimes-unavailable';
  await assert.rejects(f.worker('/api/worker/complete',{...receipt,result:{...receipt.result,accounting:unreconciled(other)}}),error=>error.status===409);
  const {accounting,...withoutAccounting}=receipt.result;
  await assert.rejects(f.worker('/api/worker/complete',{...receipt,result:withoutAccounting}),error=>error.status===409);
  const reordered=await f.worker('/api/worker/complete',{...receipt,result:{...receipt.result,accounting:{reason:accounting.reason,status:accounting.status}}});
  assert.equal(reordered.appliedVersion,2);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM studio_credit_ledger WHERE kind='charged'").get().n,1);
});

test('unreconciled accounting completion metadata is strict and cannot lower its captured reservation',async t=>{
  const f=await fixture(t),result={files:generatedFiles,summary:'Validated fixture',checks:['Fixture validation passed.']};
  const complete=(accounting,costMicros=f.job.settings.maxBudgetMicros)=>f.worker('/api/worker/complete',{id:f.job.id,lease:f.job.lease,costMicros,result:{...result,accounting}});
  for(const accounting of [null,[],{},'unreconciled',{status:'unreconciled'},{reason:'cache-write-lifetimes-unavailable'},
    {status:'estimated',reason:'cache-write-lifetimes-unavailable'},unreconciled('unknown-reason'),{...unreconciled('cache-write-price-unconfigured'),extra:true}]) {
    await assert.rejects(complete(accounting),error=>error.status===400);
  }
  const accounting=unreconciled('cache-write-lifetimes-unavailable');
  for(const cost of [0,f.job.settings.maxBudgetMicros-1])await assert.rejects(complete(accounting,cost),error=>error.status===400);
  const current=f.store.db.prepare('SELECT status,result,cost,completion_hash FROM studio_jobs WHERE id=?').get(f.job.id);
  assert.equal(current.status,'running');assert.equal(current.result,null);assert.equal(current.cost,0);assert.equal(current.completion_hash,null);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM studio_revisions WHERE project_id=?').get(f.project.id).n,1);
  const wallet=(await f.request('/api/studio/credits')).wallet;assert.equal(wallet.balance,25);assert.equal(wallet.reserved,5);
  const accepted=await complete(accounting);assert.equal(accepted.status,'applied');
  assert.deepEqual((await f.request(`/api/jobs/${f.job.id}`)).job.result.accounting,accounting);
});

test('validated unreconciled output preserves a newer project and remains downloadable without another credit debit',async t=>{
  const f=await fixture(t);let calls=0,validations=0;
  const accounting=unreconciled('cache-write-lifetimes-unavailable');
  const reply=await runJob(f.job,{
    key:'openai-accounting-fixture-key',preflight:async()=>{},wait:async()=>{},api:f.worker,
    generator:async(job,files,options)=>{
      const generated=await generate(job,files,{...options,fetcher:async()=>{
        calls++;return new Response(JSON.stringify(providerResult({input_tokens:100,output_tokens:20,input_tokens_details:{cache_write_tokens:50}})));
      }});
      await f.request(`/api/projects/${f.project.id}/files`,{method:'PUT',body:{version:1,path:'manual.lua',content:'print("newer manual source")'}});
      return generated;
    },
    validator:async()=>{validations++;return {ok:true,checks:['Fixture source validation passed.']};}
  });
  assert.equal(calls,1);assert.equal(validations,1);assert.equal(reply.status,'review');assert.ok(reply.applicationError);
  const saved=(await f.request(`/api/projects/${f.project.id}`)).project;
  assert.equal(saved.version,2);assert.deepEqual(saved.files,[{path:'manual.lua',content:'print("newer manual source")'}]);
  const job=(await f.request(`/api/jobs/${f.job.id}`)).job;
  assert.deepEqual(job.result.accounting,accounting);assert.deepEqual(job.result.files,generatedFiles);assert.equal(job.costMicros,f.job.settings.maxBudgetMicros);
  assert.equal(job.credits.state,'charged');assert.equal((await f.request('/api/studio/credits')).wallet.balance,20);
  assert.ok((await f.request(`/api/jobs/${f.job.id}/export`,{binary:true})).includes(Buffer.from('client.lua')));
});

test('unreconciled failed results retain pending credits, while ordinary over-budget completion stays failed',async t=>{
  const f=await fixture(t),accounting=unreconciled('cache-write-price-unconfigured');
  const receipt={id:f.job.id,lease:f.job.lease,costMicros:f.job.settings.maxBudgetMicros,result:{error:'Source failed validation with unreconciled provider usage.',accounting}};
  const done=await f.worker('/api/worker/complete',receipt);assert.equal(done.status,'failed');
  assert.equal((await f.worker('/api/worker/complete',receipt)).status,'failed');
  const job=(await f.request(`/api/jobs/${f.job.id}`)).job;
  assert.equal(job.credits.state,'pending');assert.deepEqual(job.result.accounting,accounting);
  assert.equal((await f.request(`/api/projects/${f.project.id}`)).project.version,1);
  const wallet=(await f.request('/api/studio/credits')).wallet;assert.equal(wallet.balance,25);assert.equal(wallet.pending,5);assert.equal(wallet.reserved,0);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM studio_credit_ledger WHERE kind='pending'").get().n,1);
  const over=await fixture(t),cost=over.job.settings.maxBudgetMicros+1;
  assert.equal((await over.worker('/api/worker/complete',{id:over.job.id,lease:over.job.lease,costMicros:cost,result:{files:generatedFiles,summary:'Over budget fixture',checks:[]}})).status,'failed');
  const overJob=(await over.request(`/api/jobs/${over.job.id}`)).job;
  assert.match(overJob.result.error,/exceeded/);assert.equal('accounting' in overJob.result,false);assert.equal(overJob.credits.state,'pending');
});

test('completion receipts without accounting metadata retain the original fingerprint and replay contract',async t=>{
  const f=await fixture(t),result={files:generatedFiles,summary:'Legacy normalized result',checks:['Fixture validation passed.']},costMicros=100;
  const receipt={id:f.job.id,lease:f.job.lease,costMicros,result};
  assert.equal((await f.worker('/api/worker/complete',receipt)).status,'applied');
  const stored=f.store.db.prepare('SELECT result,completion_hash FROM studio_jobs WHERE id=?').get(f.job.id);
  assert.equal(stored.completion_hash,hash(JSON.stringify({costMicros,result})));
  assert.equal('accounting' in JSON.parse(stored.result),false);
  await f.restart();assert.equal((await f.worker('/api/worker/complete',receipt)).appliedVersion,2);
});

test('known usage followed by an unreconciled repair retains the whole budget once, including earlier usage',async t=>{
  const f=await fixture(t);let calls=0,validations=0;
  const malformed=generatedFiles.map(file=>file.path==='client.lua'?{...file,content:'local = invalid fixture'}:file);
  const reply=await runJob(f.job,{
    key:'openai-accounting-fixture-key',preflight:async()=>{},wait:async()=>{},api:f.worker,
    generator:async(job,files,options)=>generate(job,files,{...options,fetcher:async()=>{
      calls++;
      const usage={input_tokens:100,output_tokens:20,input_tokens_details:{cached_tokens:20,...(calls===2?{cache_write_tokens:50}:{})}};
      const response=providerResult(usage);
      if(calls===1)response.output[0].content[0].text=JSON.stringify({summary:'First attempt',changes:malformed});
      return new Response(JSON.stringify(response));
    }}),
    validator:async files=>{
      validations++;
      if(validations===1)return {ok:false,kind:'source',checks:['client.lua: fixture syntax failed.']};
      assert.deepEqual(files,generatedFiles);return {ok:true,checks:['Fixture repair validation passed.']};
    }
  });
  assert.equal(calls,2);assert.equal(validations,2);assert.equal(reply.status,'applied');
  const job=(await f.request(`/api/jobs/${f.job.id}`)).job;
  assert.equal(job.costMicros,f.job.settings.maxBudgetMicros);
  assert.deepEqual(job.result.accounting,unreconciled('cache-write-lifetimes-unavailable'));
  assert.deepEqual((await f.request(`/api/projects/${f.project.id}`)).project.files,generatedFiles);
  assert.equal((await f.request('/api/studio/credits')).wallet.balance,20);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM studio_credit_ledger WHERE kind='charged'").get().n,1);
});

test('an above-budget unreconciled completion stays failed and preserves its metadata for durable billing review',async t=>{
  const f=await fixture(t),accounting=unreconciled('cache-write-price-unconfigured');
  const receipt={id:f.job.id,lease:f.job.lease,costMicros:f.job.settings.maxBudgetMicros+1,result:{files:generatedFiles,summary:'Above-budget validated fixture',checks:['Fixture validation passed.'],accounting}};
  assert.equal((await f.worker('/api/worker/complete',receipt)).status,'failed');
  await f.restart();assert.equal((await f.worker('/api/worker/complete',receipt)).status,'failed');
  const job=(await f.request(`/api/jobs/${f.job.id}`)).job;
  assert.equal(job.costMicros,receipt.costMicros);assert.deepEqual(job.result.accounting,accounting);assert.match(job.result.error,/exceeded/);
  assert.equal(job.result.files,undefined);assert.equal(job.credits.state,'pending');
  assert.equal((await f.request(`/api/projects/${f.project.id}`)).project.version,1);
  const wallet=(await f.request('/api/studio/credits')).wallet;assert.equal(wallet.balance,25);assert.equal(wallet.pending,5);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM studio_credit_ledger WHERE kind='pending'").get().n,1);
});

test('unpriced cache writes cannot conceal an independently known provider cost above the budget',async t=>{
  const f=await fixture(t),accounting=unreconciled('cache-write-lifetimes-unavailable');
  const outputTokens=100000,knownOutputCost=outputTokens*f.job.settings.outputUsdPerMillion;
  assert.ok(knownOutputCost>f.job.settings.maxBudgetMicros);
  let providerCalls=0,validations=0,deliveries=0;const receipts=[];
  const reply=await runJob(f.job,{
    key:'openai-accounting-fixture-key',preflight:async()=>{},wait:async()=>{},
    generator:async(job,files,options)=>generate(job,files,{...options,fetcher:async()=>{
      providerCalls++;
      return new Response(JSON.stringify(providerResult({input_tokens:100,output_tokens:outputTokens,input_tokens_details:{cached_tokens:20,cache_write_tokens:50}})));
    }}),
    validator:async()=>{validations++;return {ok:true,checks:['This must not be reached for a known over-budget response.']};},
    api:async(path,body)=>{
      const result=await f.worker(path,body);
      if(path==='/api/worker/complete'){
        receipts.push(JSON.stringify(body));deliveries++;
        if(deliveries===1){await f.restart();throw new TypeError('Known-minimum failure acknowledgement lost after durable commit');}
      }
      return result;
    }
  });
  assert.equal(providerCalls,1);assert.equal(validations,0);assert.equal(deliveries,2);assert.equal(receipts[0],receipts[1]);
  assert.equal(reply.status,'failed');
  const job=(await f.request(`/api/jobs/${f.job.id}`)).job;
  assert.ok(job.costMicros>=knownOutputCost);assert.ok(job.costMicros>f.job.settings.maxBudgetMicros);
  assert.deepEqual(job.result.accounting,accounting);assert.match(job.result.error,/exceeded/);assert.equal(job.result.files,undefined);
  const project=(await f.request(`/api/projects/${f.project.id}`)).project;assert.equal(project.version,1);assert.deepEqual(project.files,[]);
  assert.equal(job.credits.state,'pending');
  const wallet=(await f.request('/api/studio/credits')).wallet;assert.equal(wallet.balance,25);assert.equal(wallet.pending,5);assert.equal(wallet.reserved,0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM studio_revisions WHERE project_id=?').get(f.project.id).n,1);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM studio_credit_ledger WHERE kind='pending'").get().n,1);
});
