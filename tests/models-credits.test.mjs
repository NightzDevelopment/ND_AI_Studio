import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.mjs';
import { createStudio } from '../server/studio.mjs';
import { studioSettings, StudioError } from '../server/studio-domain.mjs';
import { validateModel } from '../server/studio-models.mjs';

const model=(id='test-budget',cost=5)=>({id,label:id,tier:cost>5?'premium':'budget',enabled:true,compatible:true,inputUsdPerMillion:1,cachedInputUsdPerMillion:.25,outputUsdPerMillion:2,maxOutputTokens:1024,maxCalls:2,maxBudgetMicros:100000,timeoutSeconds:180,creditsPerBuild:cost});
const files=[{path:'fxmanifest.lua',content:"fx_version 'cerulean'\ngame 'gta5'\n"},{path:'README.md',content:'# Test'}];
function fixture(t){
  const store=new Store(':memory:');t.after(()=>store.close());
  const user=(id,name)=>store.login({id,username:name,displayName:name,avatar:null});
  const owner=user('123456789012345678','Owner'),member=user('223456789012345678','Member'),other=user('323456789012345678','Other');
  const config={ownerIds:[owner.discord_id],workerToken:'a'.repeat(64),botToken:''};
  const required=req=>{if(!req.user)throw new StudioError(401,'Sign in.');return {user_id:req.user.id};};
  const mutation=req=>{const s=required(req);if(req.headers['x-csrf-token']!=='test-csrf'||req.headers.origin!=='https://ai.nightz.dev')throw new StudioError(403,'CSRF denied.');return s;};
  const app=createStudio({store,config,catalog:{tools:[{id:'ai-script-generator',category:'create',engine:'coding'}]},required,mutation,readJson:async req=>req.body,json:(res,status,data)=>Object.assign(res,{status,data:JSON.parse(JSON.stringify(data))})});
  const s=studioSettings(store);s.model='test-legacy';s.inputUsdPerMillion=1;s.outputUsdPerMillion=2;s.maxBudgetMicros=100000;s.maxOutputTokens=1024;s.tools['ai-script-generator']='members';delete s.version;
  store.db.prepare('UPDATE studio_settings SET value=? WHERE id=1').run(JSON.stringify(s));
  store.db.prepare('INSERT INTO studio_worker VALUES(1,?,1)').run(Date.now());
  async function request(path,method='GET',body,user=owner,headers={}){
    const req={user,method,body,headers:{origin:'https://ai.nightz.dev','x-csrf-token':'test-csrf',...headers}},res={setHeader(){},writeHead(status){this.status=status;},end(content){this.content=content;}};
    const handled=await app.route(req,res,new URL(path,'https://ai.nightz.dev'));assert.equal(handled,true);return res;
  }
  const worker=(path,body)=>request(`/api/worker/${path}`,'POST',body,null,{authorization:`Bearer ${config.workerToken}`});
  const catalog=async(models=[model(),model('test-premium',20)],creditsEnabled=true)=>{
    const current=await request('/api/admin/models');
    const r=await request('/api/admin/models','PATCH',{version:current.data.version,models,defaultModelId:models.find(m=>m.enabled)?.id || '',creditsEnabled});assert.equal(r.status,200,JSON.stringify(r.data));return r.data;
  };
  const grant=async(user=member,amount=50)=>{
    const w=await request(`/api/admin/credits?discordId=${user.discord_id}`);
    const body={discordId:user.discord_id,amount,reason:'Test allocation',requestId:randomUUID(),version:w.data.wallet.version};
    return {body,response:await request('/api/admin/credits','POST',body)};
  };
  const create=async(user=member)=>{const r=await request('/api/projects','POST',{name:'ND_Test',toolId:'ai-script-generator',target:'Standalone',requirements:'Test project'},user);assert.equal(r.status,201);return r.data.project;};
  const queue=async(project,user=member,id='test-budget',extra={})=>{
    const c=(await request('/api/studio/models','GET',null,user)).data;
    const body={version:project.version,prompt:'Build a simple resource',requestId:randomUUID(),modelId:id,pricingVersion:c.pricingVersion,quotedCredits:c.creditsEnabled?c.models.find(m=>m.id===id)?.creditsPerBuild:0,...extra};
    return {body,response:await request(`/api/projects/${project.id}/jobs`,'POST',body,user)};
  };
  const complete=async(job,result={files,summary:'Generated',checks:['Syntax passed.']},costMicros=100)=>worker('complete',{id:job.id,lease:job.lease,result,costMicros});
  const wallet=async(user=member)=>(await request('/api/studio/credits','GET',null,user)).data.wallet;
  return {store,owner,member,other,config,request,worker,catalog,grant,create,queue,complete,wallet};
}

test('model catalog preserves a configured legacy model without inventing credits',async t=>{
  const f=fixture(t),data=(await f.request('/api/studio/models','GET',null,f.member)).data;
  assert.equal(data.defaultModelId,'test-legacy');assert.equal(data.creditsEnabled,false);assert.equal(data.wallet.balance,0);
  const p=await f.create(),r=await f.request(`/api/projects/${p.id}/jobs`,'POST',{version:1,prompt:'Legacy request',requestId:randomUUID()},f.member);
  assert.equal(r.status,202);assert.equal(r.data.job.model,'test-legacy');assert.equal(r.data.job.credits.state,'not-used');
});
test('model validation rejects unsupported claims, unsafe prices and malformed configurations',()=>{
  for(const patch of [{id:'../model'},{label:''},{tier:'unknown'},{compatible:false},{inputUsdPerMillion:0},{outputUsdPerMillion:NaN},{cachedInputUsdPerMillion:2},{maxCalls:3},{timeoutSeconds:901},{creditsPerBuild:1.5},{maxOutputTokens:999999},{apiKey:'not-allowed'}])assert.throws(()=>validateModel({...model(),...patch}));
  assert.equal(validateModel({...model(),id:'ft:test-custom:model-v1'}).id,'ft:test-custom:model-v1');
});
test('verified presets require explicit owner import and cannot silently alter existing models or balances',async t=>{
  const f=fixture(t),before=(await f.request('/api/admin/models')).data;
  assert.equal(before.models.length,1);assert.equal(before.defaultModelId,'test-legacy');
  assert.equal(before.presets.length,5);
  for(const {verification,...preset} of before.presets){
    assert.equal(preset.enabled,false);assert.equal(preset.compatible,false);
    assert.ok(verification.sources.every(url=>url.startsWith('https://')));
    assert.equal(verification.checkedAt,'2026-10-25');
    assert.doesNotThrow(()=>validateModel(preset));
  }
  assert.equal((await f.wallet()).balance,0);
  assert.equal((await f.request('/api/studio/models','GET',null,f.member)).data.models.length,1);
  assert.equal((await f.request('/api/admin/models','GET',null,f.member)).status,403);
});
test('provider and cache fields reject arbitrary destinations and unsupported accounting configurations',()=>{
  assert.equal(validateModel(model()).provider,'openai');
  for(const patch of [{provider:'qwen'},{provider:'https://elsewhere.invalid'},{endpoint:'https://elsewhere.invalid'},
    {cacheWritePolicy:'free'},{cacheWrite30mUsdPerMillion:-1},{cacheWrite12hUsdPerMillion:NaN},
    {longContextThreshold:0},{longContextInputMultiplier:0},{longContextOutputMultiplier:Infinity},
    {longContextThreshold:null,longContextInputMultiplier:2},{provider:'deepseek',cacheWritePolicy:'disabled'}])assert.throws(()=>validateModel({...model(),...patch}));
});
test('selected provider, caching and long-context price bands stay frozen with the job',async t=>{
  const f=fixture(t),presets=(await f.request('/api/admin/models')).data.presets;
  const {verification,...definition}=presets.find(item=>item.id==='deepseek-flash');
  const selected={...definition,enabled:true,compatible:true};
  await f.catalog([selected]);await f.grant();
  await f.worker('heartbeat',{ready:true,providers:['deepseek']});
  const p=await f.create(),queued=await f.queue(p,f.member,selected.id);
  assert.equal(queued.response.status,202);assert.equal(queued.response.data.job.provider,'deepseek');
  assert.equal((await f.request('/api/studio/models','GET',null,f.member)).data.models[0].workerReady,true);
  await f.catalog([{...selected,inputUsdPerMillion:3,creditsPerBuild:40}]);
  const job=(await f.worker('claim',{})).data.job;
  assert.equal(job.settings.provider,'deepseek');assert.equal(job.settings.inputUsdPerMillion,.30);
  assert.equal(job.settings.cachedInputUsdPerMillion,.006);assert.equal(job.settings.creditsPerBuild,2);
  assert.equal(job.settings.cacheWritePolicy,'provider-default');assert.equal(job.settings.longContextThreshold,null);
  assert.equal((await f.complete(job)).status,200);assert.equal((await f.wallet()).balance,48);
  const {verification:source,...openai}=presets.find(item=>item.id==='gpt-6.1-sol');
  await f.catalog([{...openai,enabled:true,compatible:true}]);
  await f.worker('heartbeat',{ready:true,providers:['openai']});
  const project=await f.create(),next=await f.queue(project,f.member,openai.id);assert.equal(next.response.status,202);
  const captured=(await f.worker('claim',{})).data.job.settings;
  assert.equal(captured.cacheWritePolicy,'disabled');assert.equal(captured.cacheWrite30mUsdPerMillion,2.5);
  assert.equal(captured.cacheWrite12hUsdPerMillion,5);assert.equal(captured.longContextThreshold,272000);
  assert.equal(captured.longContextInputMultiplier,2);assert.equal(captured.longContextOutputMultiplier,1.5);
});
test('only the owner can change models, grants or credit settlements',async t=>{
  const f=fixture(t);for(const path of ['/api/admin/models','/api/admin/credits?discordId='+f.member.discord_id,'/api/admin/credits/pending'])assert.equal((await f.request(path,'GET',null,f.member)).status,403);
  assert.equal((await f.request('/api/studio/models','GET',null,null)).status,401);
  assert.equal((await f.request('/api/admin/models','PATCH',{},f.owner,{'x-csrf-token':'wrong'})).status,403);
});
test('catalog save rejects duplicates, stale revisions and disabled defaults',async t=>{
  const f=fixture(t),body={version:1,models:[model(),model()],defaultModelId:'test-budget',creditsEnabled:false};
  assert.equal((await f.request('/api/admin/models','PATCH',body)).status,400);
  body.models=[{...model(),enabled:false}];assert.equal((await f.request('/api/admin/models','PATCH',body)).status,400);
  await f.catalog();body.models=[model()];assert.equal((await f.request('/api/admin/models','PATCH',body)).status,409);
});
test('premium selection, prices and credit quote are captured per job',async t=>{
  const f=fixture(t);await f.catalog();await f.grant();const p=await f.create(),{response:r}=await f.queue(p,f.member,'test-premium');
  assert.equal(r.status,202);assert.equal(r.data.job.model,'test-premium');assert.deepEqual(r.data.job.credits,{amount:20,state:'reserved'});
  await f.catalog([{...model('test-budget',7),inputUsdPerMillion:9}]);
  const job=(await f.worker('claim',{})).data.job;assert.equal(job.settings.model,'test-premium');assert.equal(job.settings.inputUsdPerMillion,1);assert.equal(job.settings.creditsPerBuild,20);
});
test('stale quotes, client-supplied rates, disabled and unknown models cannot queue',async t=>{
  const f=fixture(t);await f.catalog();await f.grant();const p=await f.create();
  for(const extra of [{pricingVersion:'catalog:0'},{quotedCredits:0},{inputUsdPerMillion:.000001},{modelId:'unlisted'}])assert.notEqual((await f.queue(p,f.member,'test-budget',extra)).response.status,202);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM studio_jobs').get().n,0);assert.equal((await f.wallet()).reserved,0);
});
test('insufficient credits roll back both the job and reservation',async t=>{
  const f=fixture(t);await f.catalog();const p=await f.create(),r=(await f.queue(p)).response;
  assert.equal(r.status,409);assert.equal(f.store.db.prepare('SELECT count(*) n FROM studio_jobs').get().n,0);assert.equal((await f.wallet()).balance,0);
});
test('duplicate enqueue requests do not reserve twice or switch the captured model',async t=>{
  const f=fixture(t);await f.catalog();await f.grant();const p=await f.create(),{body,response}=await f.queue(p);
  const again=await f.request(`/api/projects/${p.id}/jobs`,'POST',body,f.member);assert.equal(again.status,200);assert.equal(again.data.job.id,response.data.job.id);assert.equal((await f.wallet()).reserved,5);
  assert.equal((await f.request(`/api/projects/${p.id}/jobs`,'POST',{...body,modelId:'test-premium'},f.member)).status,409);
});
test('automatic completion charges once; application and duplicate completion do not charge again',async t=>{
  const f=fixture(t);await f.catalog();await f.grant();const p=await f.create();await f.queue(p);
  const job=(await f.worker('claim',{})).data.job;assert.equal((await f.complete(job)).status,200);
  assert.equal((await f.wallet()).balance,45);assert.equal((await f.wallet()).reserved,0);
  assert.equal((await f.complete(job)).status,200);assert.equal((await f.request(`/api/jobs/${job.id}/apply`,'POST',{version:1},f.member)).status,200);
  assert.equal((await f.wallet()).balance,45);assert.equal(f.store.db.prepare("SELECT count(*) n FROM studio_credit_ledger WHERE kind='charged'").get().n,1);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM studio_revisions WHERE project_id=?').get(p.id).n,2);
});
test('validated conflict output is delivered and charged once while newer source stays intact',async t=>{
  const f=fixture(t);await f.catalog();await f.grant();const p=await f.create();await f.queue(p);const job=(await f.worker('claim',{})).data.job;
  const edited=await f.request(`/api/projects/${p.id}/files`,'PUT',{version:1,path:'manual.lua',content:'print("manual")'},f.member);assert.equal(edited.status,200);
  const done=await f.complete(job);assert.equal(done.data.status,'review');assert.match(done.data.applicationError,/Project changed/);
  assert.equal((await f.wallet()).balance,45);assert.equal((await f.wallet()).reserved,0);
  assert.equal((await f.complete(job)).status,200);assert.equal((await f.wallet()).balance,45);
  const current=await f.request(`/api/projects/${p.id}`,'GET',null,f.member);assert.deepEqual(current.data.project.files,[{path:'manual.lua',content:'print("manual")'}]);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM studio_credit_ledger WHERE kind='charged'").get().n,1);
});
test('settlement failure rolls back output, source revision and receipt before a safe retry',async t=>{
  const f=fixture(t);await f.catalog();await f.grant();const p=await f.create();await f.queue(p);const job=(await f.worker('claim',{})).data.job;
  f.store.db.exec("CREATE TRIGGER fail_charge BEFORE INSERT ON studio_credit_ledger WHEN NEW.kind='charged' BEGIN SELECT RAISE(ABORT,'fixture settlement failure'); END");
  await assert.rejects(()=>f.complete(job),/fixture settlement failure/);
  const interrupted=f.store.db.prepare('SELECT status,result,completion_hash FROM studio_jobs WHERE id=?').get(job.id);assert.equal(interrupted.status,'running');assert.equal(interrupted.result,null);assert.equal(interrupted.completion_hash,null);
  assert.equal(f.store.db.prepare('SELECT version FROM studio_projects WHERE id=?').get(p.id).version,1);assert.equal((await f.wallet()).balance,50);assert.equal((await f.wallet()).reserved,5);
  f.store.db.exec('DROP TRIGGER fail_charge');assert.equal((await f.complete(job)).data.status,'applied');assert.equal((await f.wallet()).balance,45);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM studio_revisions WHERE project_id=?').get(p.id).n,2);
});
test('queued cancellation releases credits without a debit',async t=>{
  const f=fixture(t);await f.catalog();await f.grant();const p=await f.create(),r=(await f.queue(p)).response;
  assert.equal((await f.request(`/api/jobs/${r.data.job.id}/cancel`,'POST',{},f.member)).status,200);
  assert.deepEqual(await f.wallet(),{balance:50,version:1,reserved:0,pending:0,available:50});
});
test('running cancellation holds credits for explicit owner review, not automatic charging',async t=>{
  const f=fixture(t);await f.catalog();await f.grant();const p=await f.create();await f.queue(p);const job=(await f.worker('claim',{})).data.job;
  await f.request(`/api/jobs/${job.id}/cancel`,'POST',{},f.member);let w=await f.wallet();assert.equal(w.pending,5);assert.equal(w.balance,50);assert.equal(w.available,45);
  assert.equal((await f.request('/api/admin/credits/resolve','POST',{jobId:job.id,action:'released',reason:'No completed proposal'})).status,200);
  w=await f.wallet();assert.equal(w.pending,0);assert.equal(w.balance,50);
  assert.equal((await f.request('/api/admin/credits/resolve','POST',{jobId:job.id,action:'charged',reason:'Duplicate'})).status,409);
});
test('known zero-usage failure releases hold; billed failure requires review',async t=>{
  const f=fixture(t);await f.catalog();await f.grant();const p=await f.create();await f.queue(p);let job=(await f.worker('claim',{})).data.job;
  await f.complete(job,{error:'Validator preflight unavailable.'},0);assert.equal((await f.wallet()).available,50);
  await f.queue(p);job=(await f.worker('claim',{})).data.job;await f.complete(job,{error:'Source validation failed.'},100);
  assert.equal((await f.wallet()).pending,5);assert.equal((await f.wallet()).balance,50);
  await f.request('/api/admin/credits/resolve','POST',{jobId:job.id,action:'charged',reason:'Owner test settlement'});
  assert.equal((await f.wallet()).balance,45);assert.equal((await f.wallet()).pending,0);
});
test('expired leases retain a pending hold and are never automatically replayed',async t=>{
  const f=fixture(t);await f.catalog();await f.grant();const p=await f.create();await f.queue(p);const job=(await f.worker('claim',{})).data.job;
  f.store.db.prepare('UPDATE studio_jobs SET lease_until=0 WHERE id=?').run(job.id);
  const w=await f.wallet();assert.equal(w.pending,5);assert.equal(w.available,45);
  assert.equal((await f.worker('claim',{})).data.job,null);assert.equal((await f.complete(job)).status,409);
});
test('disabling a tool before claim releases the queued credit reservation',async t=>{
  const f=fixture(t);await f.catalog();await f.grant();const p=await f.create();await f.queue(p);
  const s=studioSettings(f.store);s.tools['ai-script-generator']='disabled';delete s.version;f.store.db.prepare('UPDATE studio_settings SET value=? WHERE id=1').run(JSON.stringify(s));
  await f.worker('claim',{});assert.equal((await f.wallet()).available,50);
});
test('suspension cancels jobs and pending credits remain visible for reconciliation',async t=>{
  const f=fixture(t);await f.catalog();await f.grant();const p=await f.create();await f.queue(p);await f.worker('claim',{});
  assert.equal((await f.request(`/api/admin/users/${f.member.id}`,'PATCH',{status:'suspended',dailyLimit:5,dailyBudgetMicros:1000000,version:0,revokeSessions:true,reason:'Test suspension'})).status,200);
  const r=await f.request('/api/admin/credits/pending');assert.equal(r.data.items.length,1);
});
test('adjustments are idempotent and cannot withdraw reserved or pending credits',async t=>{
  const f=fixture(t);await f.catalog();const {body,response}=await f.grant();assert.equal(response.status,200);
  assert.equal((await f.request('/api/admin/credits','POST',body)).status,200);assert.equal((await f.wallet()).balance,50);
  assert.equal((await f.request('/api/admin/credits','POST',{...body,amount:100})).status,409);
  const p=await f.create();await f.queue(p);assert.equal((await f.grant(f.member,-46)).response.status,409);
  assert.equal((await f.grant(f.member,-40)).response.status,200);assert.equal((await f.wallet()).balance,10);assert.equal((await f.wallet()).available,5);
});
test('wallet reads never expose another account and only the owner can grant',async t=>{
  const f=fixture(t);await f.catalog();const {body}=await f.grant();assert.equal((await f.wallet(f.other)).balance,0);
  const read=await f.request(`/api/studio/credits?discordId=${f.member.discord_id}`,'GET',null,f.other);assert.equal(read.data.wallet.balance,0);
  assert.equal((await f.request('/api/admin/credits','POST',{...body,requestId:randomUUID()},f.member)).status,403);
});
test('credits can remain off while multiple models are available',async t=>{
  const f=fixture(t);await f.catalog(undefined,false);const p=await f.create(),r=(await f.queue(p,f.member,'test-premium')).response;
  assert.equal(r.status,202);assert.equal(r.data.job.credits.amount,0);assert.equal((await f.wallet()).balance,0);
});
test('additive model migration preserves accounts and the original user_version',async t=>{
  const f=fixture(t);assert.equal(f.store.db.prepare('PRAGMA user_version').get().user_version,1);assert.equal(f.store.user(f.owner.id).discord_id,f.owner.discord_id);
  const bad=await f.request('/api/admin/models','PATCH',{version:1,models:[model()],defaultModelId:'test-budget',creditsEnabled:true,botToken:'must-not-be-accepted'});assert.equal(bad.status,400);
});
