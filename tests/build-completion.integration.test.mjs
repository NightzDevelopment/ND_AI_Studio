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

const ownerId='100000000000000001';
const generatedFiles=[{path:'README.md',content:'# Completed resource'}, {path:'client.lua',content:'print("generated")'}].sort((a,b)=>a.path.localeCompare(b.path));
const catalog={tools:[{id:'ai-script-generator',engine:'coding',category:'create'}]};
async function fixture(t) {
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
    id:'fixture-model',label:'Fixture',tier:'budget',enabled:true,compatible:true,inputUsdPerMillion:1,cachedInputUsdPerMillion:.25,outputUsdPerMillion:2,
    maxOutputTokens:1024,maxCalls:2,maxBudgetMicros:100000,timeoutSeconds:180,creditsPerBuild:5
  }]}});
  await request('/api/admin/credits',{method:'POST',body:{discordId:ownerId,amount:25,reason:'Integration fixture',requestId:randomUUID(),version:0}});
  await worker('/api/worker/heartbeat',{ready:true});
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
