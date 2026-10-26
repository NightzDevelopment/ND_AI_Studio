import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { randomBytes,randomUUID } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { createApp,hash } from '../server/app.mjs';
import { readConfig } from '../server/config.mjs';
import { migrateStudio,validatePreviewChanges } from '../server/studio-domain.mjs';

const OWNER='100000000000000001',MEMBER='100000000000000002';
const catalog={tools:[{id:'ai-script-generator',engine:'coding',category:'create'}]};
const change=(content='print("partial")',complete=false,path='client/main.lua')=>({path,content,complete});
async function fixture(t,{creator=OWNER,maxCalls=2,persistent=false}={}) {
  const directory=persistent?mkdtempSync(join(tmpdir(),'nd-live-preview-')):null;
  const config=readConfig({NODE_ENV:'development',APP_ORIGIN:'http://127.0.0.1',OWNER_DISCORD_IDS:OWNER,STUDIO_WORKER_TOKEN:'a'.repeat(64)});
  const database=directory?join(directory,'studio.sqlite'):':memory:';
  let store=new Store(database),app,base,closed=false;
  const credentials={};
  for(const id of [OWNER,MEMBER]) {
    const user=store.login({id,username:id,displayName:id,avatar:null}),session=randomBytes(32).toString('base64url'),csrf=randomBytes(32).toString('base64url');
    store.newSession(hash(session),user.id,csrf,3600);credentials[id]={user,session,csrf};
  }
  async function start() {
    closed=false;app=createApp({store,config,catalog,logger:{error(){}}});
    app.listen(0,'127.0.0.1');await once(app,'listening');base=`http://127.0.0.1:${app.address().port}`;
  }
  async function close(){if(closed)return;closed=true;app.closeAllConnections();await new Promise(resolve=>app.close(resolve));store.close();}
  await start();t.after(async()=>{await close();if(directory)rmSync(directory,{recursive:true,force:true});});
  async function call(path,{method='GET',body,user=creator,worker=false,token=config.workerToken}={}) {
    const headers={};
    if(user){headers.cookie=`${config.sessionCookie}=${credentials[user].session}`;headers.origin=config.origin;headers['x-csrf-token']=credentials[user].csrf;}
    if(worker)headers.authorization=`Bearer ${token}`;
    if(body!==undefined)headers['content-type']='application/json';
    const response=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
    const raw=Buffer.from(await response.arrayBuffer());let data;try{data=JSON.parse(raw.toString());}catch{data=raw;}
    return {status:response.status,data,headers:response.headers};
  }
  const worker=(path,body)=>call(`/api/worker/${path}`,{method:'POST',body,user:null,worker:true});
  const settings=(await call('/api/admin/settings',{user:OWNER})).data.settings;
  assert.equal((await call('/api/admin/settings',{user:OWNER,method:'PATCH',body:{...settings,tools:{'ai-script-generator':'members','discord-bot-generator':'disabled'}}})).status,200);
  const models=(await call('/api/admin/models',{user:OWNER})).data;
  assert.equal((await call('/api/admin/models',{user:OWNER,method:'PATCH',body:{version:models.version,defaultModelId:'preview-fixture',creditsEnabled:true,models:[{
    id:'preview-fixture',label:'Preview fixture',provider:'openai',tier:'budget',enabled:true,compatible:true,inputUsdPerMillion:1,cachedInputUsdPerMillion:.25,outputUsdPerMillion:2,
    maxCalls,maxOutputTokens:1024,maxBudgetMicros:100000,timeoutSeconds:180,creditsPerBuild:5,
  }]}})).status,200);
  assert.equal((await call('/api/admin/credits',{user:OWNER,method:'POST',body:{discordId:creator,amount:50,reason:'Preview fixture',requestId:randomUUID(),version:0}})).status,200);
  assert.equal((await worker('heartbeat',{ready:true,providers:['openai']})).status,200);
  const created=await call('/api/projects',{method:'POST',body:{name:'Preview_Test',toolId:'ai-script-generator',target:'Standalone',requirements:'Fixture source'}});
  assert.equal(created.status,201);const project=created.data.project;
  const quote=(await call('/api/studio/models')).data;
  const queued=await call(`/api/projects/${project.id}/jobs`,{method:'POST',body:{version:1,prompt:'Generate source',requestId:randomUUID(),modelId:'preview-fixture',pricingVersion:quote.pricingVersion,quotedCredits:5}});
  assert.equal(queued.status,202);const claimed=await worker('claim',{});assert.equal(claimed.status,200);const job=claimed.data.job;
  const preview=(changes=[change()],extra={})=>worker('preview',{id:job.id,lease:job.lease,sequence:1,attempt:1,changes,...extra});
  const complete=(result={files:[{path:'client/main.lua',content:'print("saved")'}],summary:'Validated fixture',checks:['Fixture check passed.']},costMicros=10)=>worker('complete',{id:job.id,lease:job.lease,costMicros,result});
  return {call,worker,project,job,preview,complete,creator,credentials,config,get store(){return store;},get app(){return app;},get base(){return base;},restart:async()=>{await close();store=new Store(database);await start();}};
}

function authoritativeState(f) {
  const {preview,preview_sequence,...job}=f.store.db.prepare('SELECT * FROM studio_jobs WHERE id=?').get(f.job.id);
  return {job,projects:f.store.db.prepare('SELECT * FROM studio_projects').all(),revisions:f.store.db.prepare('SELECT * FROM studio_revisions').all(),
    credits:f.store.db.prepare('SELECT * FROM studio_job_credits').all(),wallets:f.store.db.prepare('SELECT * FROM studio_credit_wallets').all(),
    ledger:f.store.db.prepare('SELECT * FROM studio_credit_ledger').all(),events:f.store.db.prepare('SELECT * FROM studio_events').all()};
}

test('live preview snapshots are private unvalidated text and never mutate source, credits, events or the lease',async t=>{
  const f=await fixture(t),text='<img src=x onerror="globalThis.previewExecuted=true">\n<script>alert(1)</script>';
  f.store.db.prepare('UPDATE studio_jobs SET lease_until=? WHERE id=?').run(Date.now()+80000,f.job.id);
  const before=authoritativeState(f);
  const sent=await f.preview([change(text,false,'web/index.html')]);
  assert.equal(sent.status,200);assert.deepEqual(sent.data,{ok:true,accepted:true,previewVersion:1});
  assert.deepEqual(authoritativeState(f),before);
  const detail=await f.call(`/api/jobs/${f.job.id}`);
  assert.match(detail.headers.get('content-type'),/^application\/json/);
  assert.equal(detail.data.job.previewVersion,1);
  assert.deepEqual(detail.data.job.preview,{sequence:1,attempt:1,changes:[change(text,false,'web/index.html')]});
  const summaries=(await f.call(`/api/projects/${f.project.id}/jobs`)).data;
  assert.equal(summaries.jobs[0].previewVersion,1);assert.equal('preview' in summaries.jobs[0],false);
  assert.equal(JSON.stringify(summaries).includes(text),false);
  assert.equal(summaries.projectVersion,1);assert.equal(summaries.projectUpdatedAt,f.project.updated_at);
  assert.equal((await f.call(`/api/jobs/${f.job.id}/export`)).status,409);
  assert.deepEqual((await f.call(`/api/projects/${f.project.id}`)).data.project.files,[]);
});

test('preview detail is restricted to the project account and authenticated worker publication',async t=>{
  const f=await fixture(t,{creator:MEMBER});assert.equal((await f.preview()).status,200);
  assert.equal((await f.call(`/api/jobs/${f.job.id}`,{user:OWNER})).status,404);
  assert.equal((await f.call(`/api/projects/${f.project.id}/jobs`,{user:OWNER})).status,404);
  assert.equal((await f.call(`/api/jobs/${f.job.id}`,{user:null})).status,401);
  const body={id:f.job.id,lease:f.job.lease,sequence:2,attempt:1,changes:[change('unauthorized')]};
  assert.equal((await f.call('/api/worker/preview',{method:'POST',body})).status,401);
  assert.equal((await f.call('/api/worker/preview',{method:'POST',body,user:null,worker:true,token:'wrong-token'})).status,401);
  assert.equal((await f.preview([change('wrong lease')],{sequence:2,lease:'wrong-lease'})).status,409);
  assert.equal((await f.call(`/api/jobs/${f.job.id}`)).data.job.preview.changes[0].content,'print("partial")');
});

test('preview snapshots replace earlier snapshots while stale sequences and attempts are harmless no-ops',async t=>{
  const f=await fixture(t);assert.equal((await f.preview([change('first')],{sequence:2})).status,200);
  for(const sequence of [1,2]) {
    const stale=await f.preview([change('must not replace')],{sequence});
    assert.equal(stale.status,200);assert.deepEqual(stale.data,{ok:true,accepted:false,previewVersion:2});
  }
  const repaired=[change('second attempt',false,'server/main.lua'),change(null,true,'client/main.lua')];
  const next=await f.preview(repaired,{sequence:3,attempt:2});assert.equal(next.data.accepted,true);
  const oldAttempt=await f.preview([change('late first attempt')],{sequence:4,attempt:1});
  assert.deepEqual(oldAttempt.data,{ok:true,accepted:false,previewVersion:3});
  const view=(await f.call(`/api/jobs/${f.job.id}`)).data.job;
  assert.equal(view.preview.attempt,2);assert.equal(view.preview.sequence,3);assert.equal(view.preview.changes.length,2);
  assert.equal(view.preview.changes[0].content,null);assert.equal(view.preview.changes[1].path,'server/main.lua');
});

test('empty preview snapshots are supported and completion is explicit for deletions',async t=>{
  const f=await fixture(t);assert.equal((await f.preview([change()])).status,200);
  assert.equal((await f.preview([],{sequence:2})).status,200);
  assert.deepEqual((await f.call(`/api/jobs/${f.job.id}`)).data.job.preview.changes,[]);
  assert.equal((await f.preview([change(null,false)],{sequence:3})).status,400);
  assert.equal((await f.preview([change(null,true)],{sequence:3})).status,200);
  assert.deepEqual((await f.call(`/api/jobs/${f.job.id}`)).data.job.preview.changes,[change(null,true)]);
});

test('preview schema, call attempts and sequences cannot bypass the bounded worker contract',async t=>{
  const f=await fixture(t,{maxCalls:1});
  for(const extra of [{sequence:0},{sequence:-1},{sequence:1.5},{sequence:Number.MAX_SAFE_INTEGER+1},{sequence:'1'},{attempt:0},{attempt:3},{attempt:'1'},{attempt:2},{extra:true},{id:42},{lease:42}]) {
    const result=await f.preview([change()],extra);assert.equal(result.status,400,JSON.stringify(extra));
  }
  for(const changes of [null,{},[{}],[{...change(),complete:undefined}],[{...change(),complete:'true'}],[{...change(),extra:true}],[change(123)]]) {
    assert.equal((await f.preview(changes)).status,400,JSON.stringify(changes));
  }
  assert.equal(f.store.db.prepare('SELECT preview_sequence FROM studio_jobs WHERE id=?').get(f.job.id).preview_sequence,0);
});

test('preview paths, collisions and text limits reuse the saved-source safety rules',async t=>{
  const f=await fixture(t);
  for(const path of ['../private.js','/absolute.js','.env','.git/config.json','node_modules/main.js','folder\\main.js','bad.pem','folder/../main.lua']) {
    assert.equal((await f.preview([change('x',false,path)])).status,400,path);
  }
  for(const changes of [
    [change('a',false,'Main.lua'),change('b',false,'main.lua')],
    [change('a',false,'main.lua'),change('b',false,'main.lua/child.js')],
    [change('a',false,'main.lua'),change('b',true,'main.lua')],
    Array.from({length:65},(_,i)=>change('',false,`file${i}.js`)),
    [change('x'.repeat(65537))],[change('é'.repeat(32769))],[change('nul\0byte')],
  ]) assert.equal((await f.preview(changes)).status,400);
  const oversized=[change('x'.repeat(65536),false,'a.js'),change('x'.repeat(65536),false,'b.js'),change('x',false,'c.js')];
  assert.equal((await f.preview(oversized)).status,413);
  const boundary=await f.preview(oversized.slice(0,2));assert.equal(boundary.status,200);
  assert.equal((await f.call(`/api/jobs/${f.job.id}`)).data.job.preview.changes.length,2);
  assert.equal((await f.preview([change('',false,'.env.example')],{sequence:2})).status,200);
});

for(const outcome of ['applied','failed','cancelled','expired'])test(`${outcome} jobs clear their unvalidated preview and reject delayed snapshots`,async t=>{
  const f=await fixture(t);await f.preview();
  if(outcome==='applied')assert.equal((await f.complete()).status,200);
  if(outcome==='failed')assert.equal((await f.complete({error:'Fixture failure'},0)).status,200);
  if(outcome==='cancelled')assert.equal((await f.call(`/api/jobs/${f.job.id}/cancel`,{method:'POST',body:{}})).status,200);
  if(outcome==='expired')f.store.db.prepare('UPDATE studio_jobs SET lease_until=0 WHERE id=?').run(f.job.id);
  const view=(await f.call(`/api/jobs/${f.job.id}`)).data.job;
  assert.equal(view.status,outcome==='expired'?'failed':outcome);assert.equal(view.preview,null);assert.equal(view.previewVersion,0);
  assert.equal(f.store.db.prepare('SELECT preview FROM studio_jobs WHERE id=?').get(f.job.id).preview,null);
  const late=await f.preview([change('late')],{sequence:1});assert.equal(late.status,409);
});

for(const restriction of ['archived','disabled'])test(`${restriction} active jobs hide preview text before their lease expires`,async t=>{
  const f=await fixture(t);await f.preview();
  if(restriction==='archived') {
    assert.equal((await f.call(`/api/projects/${f.project.id}`,{method:'PATCH',body:{version:1,name:f.project.name,requirements:f.project.requirements,favorite:false,archived:true}})).status,200);
  } else {
    const current=(await f.call('/api/admin/tools')).data;
    assert.equal((await f.call('/api/admin/tools',{method:'PATCH',body:{toolId:'ai-script-generator',mode:'disabled',version:current.version}})).status,200);
  }
  const view=(await f.call(`/api/jobs/${f.job.id}`)).data.job;
  assert.equal(view.status,'running');assert.equal(view.preview,null);assert.equal(view.previewVersion,0);
  const summaries=(await f.call(`/api/projects/${f.project.id}/jobs`)).data;
  assert.equal(summaries.jobs[0].previewVersion,0);
  assert.equal((await f.preview([change('revoked')],{sequence:2})).status,409);
});

test('suspension clears a running member preview and revokes both reads and publication',async t=>{
  const f=await fixture(t,{creator:MEMBER});await f.preview();
  const member=f.credentials[MEMBER].user;
  const result=await f.call(`/api/admin/users/${member.id}`,{user:OWNER,method:'PATCH',body:{version:0,status:'suspended',dailyLimit:5,dailyBudgetMicros:1000000,revokeSessions:true,reason:'Fixture suspension'}});
  assert.equal(result.status,200);
  const row=f.store.db.prepare('SELECT status,preview FROM studio_jobs WHERE id=?').get(f.job.id);
  assert.equal(row.status,'cancelled');assert.equal(row.preview,null);
  assert.equal((await f.call(`/api/jobs/${f.job.id}`)).status,401);
  assert.equal((await f.preview([change('revoked')],{sequence:2})).status,409);
});

test('project list metadata tracks saved edits independently of preview publications and build status',async t=>{
  const f=await fixture(t);await f.preview();
  const original=(await f.call(`/api/projects/${f.project.id}/jobs`)).data;
  const edit=await f.call(`/api/projects/${f.project.id}/files`,{method:'PUT',body:{version:1,path:'manual.lua',content:'print("manual")'}});
  assert.equal(edit.status,200);
  const updated=(await f.call(`/api/projects/${f.project.id}/jobs`)).data;
  assert.equal(original.projectVersion,1);assert.equal(updated.projectVersion,2);
  assert.equal(updated.projectUpdatedAt,edit.data.project.updated_at);
  assert.equal(updated.jobs[0].status,'running');assert.equal(updated.jobs[0].previewVersion,1);
  assert.equal((await f.preview([change('still partial')],{sequence:2})).status,200);
  assert.equal((await f.call(`/api/projects/${f.project.id}/jobs`)).data.projectVersion,2);
});

test('preview schema migration is additive and a running snapshot survives an API restart',async t=>{
  const f=await fixture(t,{persistent:true});await f.preview();await f.restart();
  const view=(await f.call(`/api/jobs/${f.job.id}`)).data.job;
  assert.equal(view.preview.sequence,1);assert.equal(view.previewVersion,1);
  assert.equal(f.store.db.prepare('PRAGMA user_version').get().user_version,1);
  f.store.db.exec('ALTER TABLE studio_jobs DROP COLUMN preview');f.store.db.exec('ALTER TABLE studio_jobs DROP COLUMN preview_sequence');
  migrateStudio(f.store);migrateStudio(f.store);
  const migrated=(await f.call(`/api/jobs/${f.job.id}`)).data.job;
  assert.equal(migrated.preview,null);assert.equal(migrated.previewVersion,0);assert.equal(migrated.baseVersion,1);assert.equal(migrated.status,'running');
  assert.equal((await f.preview()).status,200);
});

test('a delayed streaming preview cannot resurrect state after completion',async t=>{
  const f=await fixture(t);await f.preview();
  const payload=JSON.stringify({id:f.job.id,lease:f.job.lease,sequence:2,attempt:1,changes:[change('late partial')]});
  let signalBody;
  const bodyWaiting=new Promise(resolve=>{signalBody=resolve;});
  const observed=(incoming)=>{
    if(incoming.url!=='/api/worker/preview')return;
    f.app.off('request',observed);
    const waitForReader=()=>{if(incoming.listenerCount('data'))signalBody();else setImmediate(waitForReader);};
    setImmediate(waitForReader);
  };
  f.app.on('request',observed);
  let finish;
  const response=new Promise((resolve,reject)=>{
    const request=httpRequest(new URL('/api/worker/preview',f.base),{method:'POST',headers:{authorization:`Bearer ${f.config.workerToken}`,'content-type':'application/json','content-length':Buffer.byteLength(payload)}},result=>{
      let text='';result.on('data',chunk=>{text+=chunk;});result.on('end',()=>resolve({status:result.statusCode,data:JSON.parse(text)}));
    });
    request.on('error',reject);request.setTimeout(3000,()=>request.destroy(new Error('Delayed preview fixture timed out.')));
    request.flushHeaders();finish=()=>request.end(payload);
  });
  await bodyWaiting;assert.equal((await f.complete()).status,200);finish();
  assert.equal((await response).status,409);
  const row=f.store.db.prepare('SELECT status,preview,preview_sequence FROM studio_jobs WHERE id=?').get(f.job.id);
  assert.equal(row.status,'applied');assert.equal(row.preview,null);assert.equal(row.preview_sequence,1);
});

test('preview changes remain inert text and do not require JavaScript or HTML parsing',()=>{
  const content='</script><script>throw new Error("must not execute")</script>\nconst unfinished = "';
  assert.deepEqual(validatePreviewChanges([change(content,false,'preview.html')]),[change(content,false,'preview.html')]);
});
