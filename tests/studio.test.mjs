import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { createApp, hash } from '../server/app.mjs';
import { readConfig } from '../server/config.mjs';
import { validateFiles,changedFiles,zipFiles,studioSettings,migrateStudio } from '../server/studio-domain.mjs';
import { memberRoles } from '../server/studio-discord.mjs';
const OWNER='100000000000000001',OTHER='100000000000000002';
const catalog={tools:[{id:'ai-script-generator',engine:'coding',category:'create'},{id:'discord-bot-generator',engine:'coding',category:'create'},{id:'community-gallery',engine:'utility-content',category:'browse'}]};
async function fixture(t,owner=true,database=':memory:') {
  const store=new Store(database);
  const config=readConfig({APP_ORIGIN:'http://127.0.0.1',NODE_ENV:'development',OWNER_DISCORD_IDS:owner ? OWNER : '',STUDIO_WORKER_TOKEN:'a'.repeat(64)});
  const credentials={};
  for (const id of [OWNER,OTHER]) { const user=store.login({id,username:id,displayName:id,avatar:null}),session=randomBytes(32).toString('base64url'),csrf=randomBytes(32).toString('base64url');store.newSession(hash(session),user.id,csrf,3600);credentials[id]={user,session,csrf}; }
  const errors=[];const app=createApp({store,config,catalog,logger:{error:message=>errors.push(message)}});app.listen(0,'127.0.0.1');await once(app,'listening');
  let closed=false;
  const close=async()=>{if(closed)return;closed=true;app.closeAllConnections();await new Promise(resolve=>app.close(resolve));store.close();};
  t.after(close);
  const origin=`http://127.0.0.1:${app.address().port}`;
  const call=async(path,{method='GET',body,user=OWNER,csrf=true,worker=false}={})=>{
    const headers={};
    if (user) {headers.cookie=`${config.sessionCookie}=${credentials[user].session}`;headers.origin=config.origin;if(csrf) headers['x-csrf-token']=credentials[user].csrf;}
    if(worker)headers.authorization=`Bearer ${config.workerToken}`;
    if(body!==undefined) headers['content-type']='application/json';
    const response=await fetch(origin+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
    const raw=await response.arrayBuffer();let data;try{data=JSON.parse(Buffer.from(raw));}catch{data=Buffer.from(raw);}
    return {status:response.status,data,headers:response.headers};
  };
  const create=async()=>{const r=await call('/api/projects',{method:'POST',body:{name:'ND_Test',toolId:'ai-script-generator',target:'Standalone',requirements:'A simple resource.'}});assert.equal(r.status,201,JSON.stringify(r.data));return r.data.project;};
  const enabled=async()=>{
    const s=studioSettings(store);const r=await call('/api/admin/settings',{method:'PATCH',body:{...s,model:'test-model',inputUsdPerMillion:1,outputUsdPerMillion:1,maxBudgetMicros:250000,tools:{'ai-script-generator':'owner','discord-bot-generator':'owner'}}});assert.equal(r.status,200,JSON.stringify(r.data));
    assert.equal((await call('/api/worker/heartbeat',{method:'POST',body:{ready:true},worker:true,user:null})).status,200);
  };
  const queue=async(p,extra={})=>call(`/api/projects/${p.id}/jobs`,{method:'POST',body:{version:p.version,prompt:'Build a simple resource',requestId:randomUUID(),...extra}});
  const claim=async()=>{const r=await call('/api/worker/claim',{method:'POST',body:{},user:null,worker:true});assert.equal(r.status,200,JSON.stringify(r.data));return r.data.job;};
  const complete=async(job,result={files:[{path:'client.lua',content:'print(1)'}],summary:'Generated resource',checks:['Syntax passed.']},costMicros=100)=>call('/api/worker/complete',{method:'POST',body:{id:job.id,lease:job.lease,result,costMicros},worker:true,user:null});
  return {store,config,credentials,call,create,enabled,errors,close,queue,claim,complete};
}
test('owner access is explicit, never awarded to the first account',async t=>{const f=await fixture(t,false);assert.equal((await f.call('/api/admin/settings')).status,403);assert.equal((await f.call('/api/studio/session')).data.owner,false);});
test('anonymous and cross-account operations fail closed',async t=>{const f=await fixture(t);assert.equal((await f.call('/api/projects',{user:null})).status,401);const p=await f.create();assert.equal((await f.call(`/api/projects/${p.id}`,{user:OTHER})).status,404);assert.equal((await f.call('/api/admin/settings',{user:OTHER})).status,403);});
test('project creation checks CSRF, fields, framework and browse tools',async t=>{const f=await fixture(t);const body={name:'x',toolId:'ai-script-generator',target:'Standalone',requirements:'x'};assert.equal((await f.call('/api/projects',{method:'POST',body,csrf:false})).status,403);for(const change of [{target:'invalid'},{toolId:'community-gallery'},{admin:true}])assert.equal((await f.call('/api/projects',{method:'POST',body:{...body,...change}})).status,400);});
test('editing, conflict protection, rename, deletion and restore preserve history',async t=>{
  const f=await fixture(t);let p=await f.create();const url=`/api/projects/${p.id}`;
  let r=await f.call(`${url}/files`,{method:'PUT',body:{version:1,path:'client/main.lua',content:'print("one")'}});assert.equal(r.status,200,JSON.stringify(r.data));p=r.data.project;assert.equal(p.version,2);
  assert.equal((await f.call(`${url}/files`,{method:'PUT',body:{version:1,path:'client/main.lua',content:'overwrite'}})).status,409);
  r=await f.call(`${url}/files`,{method:'PUT',body:{version:2,path:'client/main.lua',renameTo:'client/app.lua'}});assert.equal(r.status,200);assert.equal(r.data.project.files[0].path,'client/app.lua');
  r=await f.call(`${url}/files`,{method:'PUT',body:{version:3,path:'client/app.lua',remove:true}});assert.equal(r.data.project.files.length,0);
  r=await f.call(`${url}/restore`,{method:'POST',body:{version:4,revision:2}});assert.equal(r.status,200);assert.equal(r.data.project.version,5);assert.equal(r.data.project.files[0].content,'print("one")');
  assert.equal((await f.call(`${url}/revisions`)).data.revisions.length,5);
  assert.equal((await f.call(`${url}/export?version=2`)).data.readUInt32LE(0),0x04034b50);
});
test('source limits reject traversal, case collisions, secrets, oversized and binary contents',()=>{
  for(const path of ['../x.lua','/x.lua','a\\x.lua','.git/config.json','.env','.env.production','a/../x.lua','node_modules/x.js','a./x.js','x.pem','a%2f.js'])assert.throws(()=>validateFiles([{path,content:'x'}]),path);
  assert.throws(()=>validateFiles([{path:'a.js',content:'x'},{path:'A.js',content:'x'}]));
  assert.throws(()=>validateFiles([{path:'a.js',content:'x'},{path:'a.js/b.js',content:'x'}]));
  assert.throws(()=>validateFiles([{path:'a.js',content:'x'.repeat(65537)}]));assert.throws(()=>validateFiles([{path:'a.js',content:'\0'}]));
  assert.equal(validateFiles([{path:'.env.example',content:'TOKEN='}]).length,1);
  assert.throws(()=>changedFiles([],[{path:'a.js',content:'x'},{path:'a.js',content:null}]));
});
test('owner controls revoke sessions and prevent owner suspension',async t=>{
  const f=await fixture(t);const user=f.credentials[OTHER].user;
  let r=await f.call(`/api/admin/users/${user.id}`,{method:'PATCH',body:{version:0,status:'suspended',dailyLimit:1,dailyBudgetMicros:10000,revokeSessions:true,reason:'Test suspension'}});assert.equal(r.status,200,JSON.stringify(r.data));
  assert.equal((await f.call('/api/projects',{user:OTHER})).status,401);
  r=await f.call(`/api/admin/users/${f.credentials[OWNER].user.id}`,{method:'PATCH',body:{version:0,status:'suspended',dailyLimit:1,dailyBudgetMicros:10000,revokeSessions:true,reason:'Attempt'}});assert.equal(r.status,400);
  assert.equal((await f.call('/api/admin/audit')).data.items.length,1);
});
test('settings conflicts and secrets are not exposed',async t=>{const f=await fixture(t);const s=studioSettings(f.store);await f.enabled();assert.equal((await f.call('/api/admin/settings',{method:'PATCH',body:s})).status,409);const raw=JSON.stringify((await f.call('/api/admin/settings')).data);assert.ok(!raw.includes(f.config.workerToken));assert.ok(!raw.includes('clientSecret'));});
test('generator stays unavailable without isolated worker and configured provider',async t=>{const f=await fixture(t);const p=await f.create();const body={version:1,prompt:'build',requestId:randomUUID()};assert.equal((await f.call(`/api/projects/${p.id}/jobs`,{method:'POST',body})).status,403);await f.enabled();f.store.db.prepare('DELETE FROM studio_worker').run();assert.equal((await f.call(`/api/projects/${p.id}/jobs`,{method:'POST',body})).status,503);});
test('validated builds save automatically with idempotent completion and application',async t=>{
  const f=await fixture(t);await f.enabled();const p=await f.create(),request={version:1,prompt:'Build the resource',requestId:randomUUID()};
  let r=await f.call(`/api/projects/${p.id}/jobs`,{method:'POST',body:request});assert.equal(r.status,202,JSON.stringify(r.data));const id=r.data.job.id;
  assert.equal((await f.call(`/api/projects/${p.id}/jobs`,{method:'POST',body:request})).data.job.id,id);
  assert.equal((await f.call(`/api/projects/${p.id}/jobs`,{method:'POST',body:{...request,requestId:randomUUID()}})).status,409);
  assert.equal((await f.call('/api/worker/claim',{method:'POST',body:{},user:null})).status,401);
  r=await f.call('/api/worker/claim',{method:'POST',body:{},worker:true,user:null});assert.equal(r.status,200);const job=r.data.job;assert.equal(job.id,id);
  assert.equal(job.applicationMode,'automatic');
  const completion={id,lease:job.lease,costMicros:100,result:{files:[{path:'client.lua',content:'print(1)'}],summary:'Created resource',checks:['Syntax passed.']}};
  r=await f.call('/api/worker/complete',{method:'POST',user:null,worker:true,body:completion});assert.equal(r.status,200,JSON.stringify(r.data));
  assert.deepEqual(r.data,{ok:true,status:'applied',appliedVersion:2,applicationError:null});
  assert.equal((await f.call(`/api/projects/${p.id}`)).data.project.files[0].path,'client.lua');
  const replay=await f.call('/api/worker/complete',{method:'POST',user:null,worker:true,body:completion});assert.deepEqual(replay.data,r.data);
  for(const patch of [{lease:'wrong-lease'},{costMicros:101},{result:{...completion.result,summary:'Changed response'}}])assert.equal((await f.call('/api/worker/complete',{method:'POST',user:null,worker:true,body:{...completion,...patch}})).status,409);
  assert.equal((await f.call(`/api/jobs/${id}`,{user:OTHER})).status,404);
  r=await f.call(`/api/jobs/${id}/apply`,{method:'POST',body:{version:1}});assert.equal(r.status,200);assert.equal(r.data.project.version,2);
  assert.equal((await f.call(`/api/jobs/${id}/apply`,{method:'POST',body:{version:2}})).status,200);
  assert.equal((await f.call(`/api/projects/${p.id}/revisions`)).data.revisions.length,2);
  assert.equal((await f.call(`/api/jobs/${id}/export`)).data.readUInt32LE(0),0x04034b50);
  const view=(await f.call(`/api/jobs/${id}`)).data.job;assert.equal(view.appliedVersion,2);assert.equal(view.applicationMode,'automatic');assert.equal(view.applicationError,null);
  assert.equal('completion_lease' in view,false);assert.equal('completion_hash' in view,false);
});
test('cancelled leases cannot submit results and preserve potential spend',async t=>{
  const f=await fixture(t);await f.enabled();const p=await f.create();const created=await f.call(`/api/projects/${p.id}/jobs`,{method:'POST',body:{version:1,prompt:'build',requestId:randomUUID()}});
  const id=created.data.job.id,{job}= (await f.call('/api/worker/claim',{method:'POST',worker:true,user:null,body:{}})).data;
  assert.equal((await f.call(`/api/jobs/${id}/cancel`,{method:'POST',body:{}})).status,200);
  assert.equal((await f.call('/api/worker/progress',{method:'POST',worker:true,user:null,body:{id,lease:job.lease}})).status,409);
  assert.equal((await f.call('/api/worker/complete',{method:'POST',worker:true,user:null,body:{id,lease:job.lease,costMicros:100,result:{files:[{path:'client.lua',content:'print(1)'}],summary:'Late output',checks:[]}}})).status,409);
  assert.equal((await f.call(`/api/jobs/${id}`)).data.job.costMicros,250000);
});
test('stale generated result does not overwrite manual changes',async t=>{
  const f=await fixture(t);await f.enabled();const p=await f.create();const created=await f.call(`/api/projects/${p.id}/jobs`,{method:'POST',body:{version:1,prompt:'build',requestId:randomUUID()}});const id=created.data.job.id;
  const {job}=(await f.call('/api/worker/claim',{method:'POST',worker:true,user:null,body:{}})).data;
  await f.call(`/api/projects/${p.id}/files`,{method:'PUT',body:{version:1,path:'manual.lua',content:'print(2)'}});
  const completion=await f.call('/api/worker/complete',{method:'POST',worker:true,user:null,body:{id,lease:job.lease,costMicros:50,result:{files:[{path:'generated.lua',content:'print(1)'}],summary:'Test',checks:[]}}});
  assert.equal(completion.status,200);assert.equal(completion.data.status,'review');assert.match(completion.data.applicationError,/Project changed/);
  const preserved=(await f.call(`/api/jobs/${id}`)).data.job;assert.equal(preserved.appliedVersion,null);assert.equal(preserved.result.files[0].path,'generated.lua');
  assert.equal((await f.call(`/api/jobs/${id}/export`)).data.readUInt32LE(0),0x04034b50);
  assert.equal((await f.call(`/api/jobs/${id}/apply`,{method:'POST',body:{version:2}})).status,409);assert.equal((await f.call(`/api/projects/${p.id}`)).data.project.files[0].path,'manual.lua');
});
test('stale jobs fail rather than replaying potentially billed calls',async t=>{
  const f=await fixture(t);await f.enabled();const p=await f.create();const result=await f.call(`/api/projects/${p.id}/jobs`,{method:'POST',body:{version:1,prompt:'build',requestId:randomUUID()}});
  await f.call('/api/worker/claim',{method:'POST',worker:true,user:null,body:{}});f.store.db.prepare('UPDATE studio_jobs SET lease_until=0').run();
  const r=await f.call(`/api/jobs/${result.data.job.id}`);assert.equal(r.data.job.status,'failed');assert.equal(r.data.job.costMicros,250000);
  assert.equal((await f.call('/api/worker/claim',{method:'POST',worker:true,user:null,body:{}})).data.job,null);
});
test('daily spend reserves prevent starting over-budget jobs',async t=>{const f=await fixture(t);await f.enabled();const p=await f.create();f.store.db.prepare('INSERT INTO studio_controls VALUES(?,?,?,?,?)').run(f.credentials[OWNER].user.id,'active',5,10000,1);assert.equal((await f.call(`/api/projects/${p.id}/jobs`,{method:'POST',body:{version:1,prompt:'build',requestId:randomUUID()}})).status,429);});
test('Discord role checks fail closed when refreshed provider calls fail',async()=>{
  const store=new Store(':memory:');migrateStudio(store);const user=store.login({id:OTHER,username:'member',displayName:'member',avatar:null});const s=studioSettings(store);delete s.version;s.guildId=OWNER;store.db.prepare('UPDATE studio_settings SET value=?').run(JSON.stringify(s));
  const config={botToken:'test'};let roles=await memberRoles(store,config,user,{fetcher:async()=>new Response(JSON.stringify({roles:[OWNER]}))});assert.deepEqual(roles,[OWNER]);
  roles=await memberRoles(store,config,user,{refresh:true,fetcher:async()=>new Response('',{status:403})});assert.deepEqual(roles,[]);assert.equal(store.db.prepare('SELECT ok FROM studio_roles').get().ok,0);store.close();
});
test('additive schema preserves the previous account schema version and data',()=>{const store=new Store(':memory:');const user=store.login({id:OWNER,username:'owner',displayName:'owner',avatar:null});migrateStudio(store);migrateStudio(store);assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,1);assert.equal(store.user(user.id).username,'owner');store.close();});
test('ZIP includes only validated source entries',()=>{const zip=zipFiles([{path:'client.lua',content:'print(1)'}]);assert.equal(zip.readUInt32LE(0),0x04034b50);assert.equal(zip.readUInt32LE(zip.length-22),0x06054b50);assert.ok(zip.includes(Buffer.from('client.lua')));assert.throws(()=>zipFiles([{path:'../secret.txt',content:'x'}]));});

test('review mode is captured per build and remains available for intentional manual application',async t=>{
  const f=await fixture(t);await f.enabled();const p=await f.create();
  const queued=await f.queue(p,{applicationMode:'review'});assert.equal(queued.status,202);assert.equal(queued.data.job.applicationMode,'review');
  const job=await f.claim();assert.equal(job.applicationMode,'review');
  const done=await f.complete(job);assert.deepEqual(done.data,{ok:true,status:'review',appliedVersion:null,applicationError:null});
  assert.equal((await f.call(`/api/projects/${p.id}`)).data.project.version,1);
  const applied=await f.call(`/api/jobs/${job.id}/apply`,{method:'POST',body:{version:1}});assert.equal(applied.status,200);assert.equal(applied.data.project.version,2);
  assert.equal((await f.complete(job)).data.appliedVersion,2);
  await f.call(`/api/projects/${p.id}/files`,{method:'PUT',body:{version:2,path:'manual.lua',content:'print(2)'}});
  const duplicate=await f.call(`/api/jobs/${job.id}/apply`,{method:'POST',body:{version:1}});assert.equal(duplicate.status,200);assert.equal(duplicate.data.project.version,3);assert.equal(duplicate.data.project.revision,3);assert.equal(duplicate.data.project.files.some(file=>file.path==='manual.lua'),true);
  assert.equal((await f.call(`/api/projects/${p.id}`)).data.project.version,3);
});

test('application mode validation and duplicate enqueue cannot change the captured mode',async t=>{
  const f=await fixture(t);await f.enabled();const p=await f.create();
  for(const applicationMode of ['overwrite',null,false])assert.equal((await f.queue(p,{applicationMode})).status,400);
  const requestId=randomUUID();const first=await f.queue(p,{requestId,applicationMode:'review'});assert.equal(first.status,202);
  assert.equal((await f.queue(p,{requestId,applicationMode:'automatic'})).status,409);
  assert.equal((await f.queue(p,{requestId})).data.job.applicationMode,'review');
});

test('existing project generation keeps prior source revisions and supports rollback',async t=>{
  const f=await fixture(t);await f.enabled();let p=await f.create();
  p=(await f.call(`/api/projects/${p.id}/files`,{method:'PUT',body:{version:1,path:'client.lua',content:'print("original")'}})).data.project;
  assert.equal((await f.queue(p)).status,202);const job=await f.claim();assert.equal((await f.complete(job)).data.appliedVersion,3);
  const old=(await f.call(`/api/projects/${p.id}/revisions?version=2`)).data.project;assert.equal(old.files[0].content,'print("original")');
  const restored=await f.call(`/api/projects/${p.id}/restore`,{method:'POST',body:{version:3,revision:2}});assert.equal(restored.status,200);assert.equal(restored.data.project.version,4);assert.deepEqual(restored.data.project.files,old.files);
  assert.equal((await f.complete(job)).data.appliedVersion,3);assert.equal((await f.call(`/api/projects/${p.id}`)).data.project.version,4);
});

test('completion receipts and applied files survive a database and API restart without a browser',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'nd-completion-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));const database=join(directory,'studio.sqlite');
  const first=await fixture(t,true,database);await first.enabled();const p=await first.create();await first.queue(p);const job=await first.claim();
  const completed=await first.complete(job);assert.equal(completed.data.status,'applied');await first.close();
  const next=await fixture(t,true,database);const replay=await next.complete(job);assert.equal(replay.status,200);assert.deepEqual(replay.data,completed.data);
  assert.equal((await next.call(`/api/projects/${p.id}`)).data.project.version,2);
  assert.equal(next.store.db.prepare('SELECT count(*) n FROM studio_revisions WHERE project_id=?').get(p.id).n,2);
  assert.equal((await next.call(`/api/jobs/${job.id}`)).data.job.appliedVersion,2);
});

test('failed completion receipts are idempotent and do not create a source revision',async t=>{
  const f=await fixture(t);await f.enabled();const p=await f.create();await f.queue(p);const job=await f.claim();const failure={error:'Source checks did not pass.'};
  const first=await f.complete(job,failure);assert.equal(first.data.status,'failed');assert.deepEqual((await f.complete(job,failure)).data,first.data);
  assert.equal((await f.complete(job,{error:'Another result'})).status,409);
  assert.equal((await f.call(`/api/projects/${p.id}`)).data.project.version,1);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM studio_events WHERE job_id=? AND stage='failed'").get(job.id).n,1);
});

test('a full progress log cannot prevent atomic successful completion',async t=>{
  const f=await fixture(t);await f.enabled();const p=await f.create();await f.queue(p);const job=await f.claim();
  const insert=f.store.db.prepare('INSERT INTO studio_events(job_id,stage,message,created_at) VALUES(?,?,?,?)');
  for(let i=2;i<100;i++)insert.run(job.id,'checking','Progress check',new Date().toISOString());
  assert.equal((await f.complete(job)).data.status,'applied');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM studio_events WHERE job_id=?').get(job.id).n,100);
  assert.equal(f.store.db.prepare('SELECT stage FROM studio_events WHERE job_id=? ORDER BY id DESC LIMIT 1').get(job.id).stage,'applied');
});

test('revision quota preserves validated output and ZIP without a partial source save',async t=>{
  const f=await fixture(t);await f.enabled();const p=await f.create();
  for(let version=2;version<=100;version++)f.store.db.prepare('INSERT INTO studio_revisions VALUES(?,?,?,?,?,?)').run(p.id,version,'[]','Saved revision',p.user_id,new Date().toISOString());
  f.store.db.prepare('UPDATE studio_projects SET version=100 WHERE id=?').run(p.id);p.version=100;
  await f.queue(p);const job=await f.claim();const done=await f.complete(job);assert.equal(done.status,200);assert.equal(done.data.status,'review');assert.match(done.data.applicationError,/100 revisions/);
  assert.equal((await f.call(`/api/projects/${p.id}`)).data.project.version,100);
  assert.equal((await f.call(`/api/jobs/${job.id}/export`)).data.readUInt32LE(0),0x04034b50);
  assert.deepEqual((await f.complete(job)).data,done.data);
});

test('account storage quota preserves completed output without exceeding source limits',async t=>{
  const f=await fixture(t);await f.enabled();
  const files=[{path:'a.txt',content:'a'.repeat(65536)},{path:'b.txt',content:'b'.repeat(65536)}],raw=JSON.stringify(files);
  let stored=0,version=100,p;
  const insert=f.store.db.prepare('INSERT INTO studio_revisions VALUES(?,?,?,?,?,?)');
  while(stored+Buffer.byteLength(raw)<33554432){
    if(version===100){p=await f.create();stored+=2;version=1;}
    insert.run(p.id,++version,raw,'Stored source',p.user_id,new Date().toISOString());stored+=Buffer.byteLength(raw);
    f.store.db.prepare('UPDATE studio_projects SET version=? WHERE id=?').run(version,p.id);
  }
  const target=await f.create();await f.queue(target);const job=await f.claim();const done=await f.complete(job,{files,summary:'Completed large source',checks:['Syntax passed.']});
  assert.equal(done.status,200);assert.equal(done.data.status,'review');assert.match(done.data.applicationError,/32 MiB/);
  assert.equal((await f.call(`/api/projects/${target.id}`)).data.project.version,1);
  assert.equal((await f.call(`/api/jobs/${job.id}`)).data.job.result.files.length,2);
});

for(const restriction of ['archived','suspended','disabled'])test(`${restriction} builds cannot apply a late worker result`,async t=>{
  const f=await fixture(t);await f.enabled();const p=await f.create();await f.queue(p);const job=await f.claim();
  if(restriction==='archived')f.store.db.prepare('UPDATE studio_projects SET archived=1 WHERE id=?').run(p.id);
  if(restriction==='suspended')f.store.db.prepare('INSERT INTO studio_controls VALUES(?,?,?,?,?)').run(p.user_id,'suspended',5,1000000,1);
  if(restriction==='disabled'){const s=studioSettings(f.store);delete s.version;s.tools['ai-script-generator']='disabled';f.store.db.prepare('UPDATE studio_settings SET value=?').run(JSON.stringify(s));}
  assert.equal((await f.complete(job)).status,409);assert.equal(f.store.db.prepare('SELECT version FROM studio_projects WHERE id=?').get(p.id).version,1);
  assert.equal(f.store.db.prepare('SELECT completion_hash FROM studio_jobs WHERE id=?').get(job.id).completion_hash,null);
});

test('legacy queued builds migrate to review mode without changing their captured source',async t=>{
  const f=await fixture(t);await f.enabled();const p=await f.create();const queued=await f.queue(p);
  for(const name of ['application_mode','applied_version','application_error','completion_lease','completion_hash'])f.store.db.exec(`ALTER TABLE studio_jobs DROP COLUMN ${name}`);
  migrateStudio(f.store);migrateStudio(f.store);
  assert.equal(f.store.db.prepare('SELECT application_mode FROM studio_jobs WHERE id=?').get(queued.data.job.id).application_mode,'review');
  const job=await f.claim();assert.equal((await f.complete(job)).data.status,'review');assert.equal((await f.call(`/api/projects/${p.id}`)).data.project.version,1);
});

test('concurrent completion callbacks create one revision and terminal event',async t=>{
  const f=await fixture(t);await f.enabled();const p=await f.create();await f.queue(p);const job=await f.claim();
  const replies=await Promise.all([f.complete(job),f.complete(job),f.complete(job)]);
  for(const reply of replies){assert.equal(reply.status,200);assert.deepEqual(reply.data,replies[0].data);}
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM studio_revisions WHERE project_id=?').get(p.id).n,2);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM studio_events WHERE job_id=? AND stage='applied'").get(job.id).n,1);
});

test('legacy applied jobs retain their saved revision and idempotent apply after migration',async t=>{
  const f=await fixture(t);await f.enabled();const p=await f.create();await f.queue(p,{applicationMode:'review'});const job=await f.claim();await f.complete(job);
  await f.call(`/api/jobs/${job.id}/apply`,{method:'POST',body:{version:1}});
  for(const name of ['application_mode','applied_version','application_error','completion_lease','completion_hash'])f.store.db.exec(`ALTER TABLE studio_jobs DROP COLUMN ${name}`);
  migrateStudio(f.store);const view=(await f.call(`/api/jobs/${job.id}`)).data.job;assert.equal(view.appliedVersion,2);assert.equal(view.applicationMode,'review');
  assert.equal((await f.call(`/api/jobs/${job.id}/apply`,{method:'POST',body:{version:1}})).status,200);
  assert.equal((await f.call(`/api/projects/${p.id}`)).data.project.version,2);
});

test('over-budget completion cannot auto-apply and safely replays its recorded failure',async t=>{
  const f=await fixture(t);await f.enabled();const p=await f.create();await f.queue(p);const job=await f.claim();
  const result={files:[{path:'client.lua',content:'print(1)'}],summary:'Generated',checks:['Syntax passed.']};
  const done=await f.complete(job,result,250001);assert.equal(done.data.status,'failed');assert.equal(done.data.appliedVersion,null);
  assert.deepEqual((await f.complete(job,result,250001)).data,done.data);assert.equal((await f.call(`/api/projects/${p.id}`)).data.project.version,1);
});

test('worker provider readiness defaults old heartbeats to OpenAI and rejects malformed advertisements',async t=>{
  const f=await fixture(t);await f.enabled();
  const status=()=>f.call('/api/worker/status',{method:'POST',body:{},user:null,worker:true});
  assert.deepEqual((await status()).data,{ready:true,providers:['openai']});
  assert.deepEqual((await f.call('/api/studio/session')).data.workerProviders,['openai']);
  for(const providers of [null,'openai',['openai','openai'],['qwen'],['openai','deepseek','other']]){
    const r=await f.call('/api/worker/heartbeat',{method:'POST',body:{ready:true,providers},user:null,worker:true});assert.equal(r.status,400);
  }
  assert.deepEqual((await status()).data.providers,['openai']);
  assert.equal((await f.call('/api/worker/heartbeat',{method:'POST',body:{ready:true,providers:['deepseek','openai']},user:null,worker:true})).status,200);
  assert.deepEqual((await status()).data.providers,['deepseek','openai']);
  assert.deepEqual((await f.call('/api/admin/settings')).data.workerProviders,['deepseek','openai']);
  await f.call('/api/worker/heartbeat',{method:'POST',body:{ready:true},user:null,worker:true});assert.deepEqual((await status()).data.providers,['openai']);
});

test('offline, stale and uncredentialed workers expose no ready providers',async t=>{
  const f=await fixture(t);const session=()=>f.call('/api/studio/session');
  assert.equal((await session()).data.workerReady,false);assert.deepEqual((await session()).data.workerProviders,[]);
  f.store.db.prepare('INSERT INTO studio_worker VALUES(1,?,1)').run(Date.now());
  assert.deepEqual((await session()).data.workerProviders,['openai']);
  f.store.db.prepare('UPDATE studio_worker SET checked_at=?').run(Date.now()-45001);assert.deepEqual((await session()).data.workerProviders,[]);
  await f.call('/api/worker/heartbeat',{method:'POST',body:{ready:false,providers:['deepseek']},worker:true,user:null});assert.deepEqual((await session()).data.workerProviders,[]);
  await f.call('/api/worker/heartbeat',{method:'POST',body:{ready:true,providers:['deepseek']},worker:true,user:null});assert.deepEqual((await session()).data.workerProviders,['deepseek']);
  f.config.workerToken='';assert.equal((await session()).data.workerReady,false);assert.deepEqual((await session()).data.workerProviders,[]);
});

function providerCatalog(f){
  const model=(id,provider)=>({id,provider,label:id,tier:'budget',enabled:true,compatible:true,inputUsdPerMillion:1,cachedInputUsdPerMillion:.25,outputUsdPerMillion:2,maxOutputTokens:1024,maxCalls:2,maxBudgetMicros:100000,timeoutSeconds:180,creditsPerBuild:5});
  f.store.db.prepare('UPDATE studio_model_settings SET value=? WHERE id=1').run(JSON.stringify({configured:true,models:[model('test-openai','openai'),model('deepseek-flash','deepseek')],defaultModelId:'test-openai',creditsEnabled:true}));
  for(const credential of Object.values(f.credentials))f.store.db.prepare('INSERT INTO studio_credit_wallets(user_id,balance) VALUES(?,50)').run(credential.user.id);
}
async function queueProvider(f,p,modelId,user=OWNER){
  const quote=(await f.call('/api/studio/models',{user})).data;
  return f.call(`/api/projects/${p.id}/jobs`,{method:'POST',user,body:{version:p.version,prompt:'Provider readiness fixture',requestId:randomUUID(),modelId,pricingVersion:quote.pricingVersion,quotedCredits:5}});
}

test('missing selected provider credentials reject enqueue before reserving credits or jobs',async t=>{
  const f=await fixture(t);await f.enabled();providerCatalog(f);const p=await f.create();
  const unsupported=await queueProvider(f,p,'deepseek-flash');assert.equal(unsupported.status,503);assert.match(unsupported.data.error,/selected provider/);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM studio_jobs').get().n,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM studio_credit_ledger').get().n,0);
  await f.call('/api/worker/heartbeat',{method:'POST',body:{ready:true,providers:['deepseek']},user:null,worker:true});
  assert.equal((await queueProvider(f,p,'test-openai')).status,503);
  assert.equal((await queueProvider(f,p,'deepseek-flash')).status,202);assert.equal((await f.claim()).settings.provider,'deepseek');
});

test('claim skips unavailable provider snapshots and can claim a supported job behind them',async t=>{
  const f=await fixture(t);await f.enabled();providerCatalog(f);
  const s=studioSettings(f.store);delete s.version;s.tools['ai-script-generator']='members';f.store.db.prepare('UPDATE studio_settings SET value=?').run(JSON.stringify(s));
  await f.call('/api/worker/heartbeat',{method:'POST',body:{ready:true,providers:['deepseek','openai']},user:null,worker:true});
  const first=await f.create();const queuedDeepseek=await queueProvider(f,first,'deepseek-flash');assert.equal(queuedDeepseek.status,202);
  const second=(await f.call('/api/projects',{method:'POST',user:OTHER,body:{name:'Other provider',toolId:'ai-script-generator',target:'Standalone',requirements:'Test'}})).data.project;
  const queuedOpenai=await queueProvider(f,second,'test-openai',OTHER);assert.equal(queuedOpenai.status,202);
  f.store.db.prepare('UPDATE studio_jobs SET created_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z',queuedDeepseek.data.job.id);
  await f.call('/api/worker/heartbeat',{method:'POST',body:{ready:true,providers:['openai']},user:null,worker:true});
  const claimed=await f.claim();assert.equal(claimed.id,queuedOpenai.data.job.id);assert.equal(claimed.settings.provider,'openai');
  assert.equal(f.store.db.prepare('SELECT status FROM studio_jobs WHERE id=?').get(queuedDeepseek.data.job.id).status,'queued');
  assert.equal(f.store.db.prepare('SELECT state FROM studio_job_credits WHERE job_id=?').get(queuedDeepseek.data.job.id).state,'reserved');
  assert.equal((await f.claim()),null);
  await f.call('/api/worker/heartbeat',{method:'POST',body:{ready:true,providers:['deepseek']},user:null,worker:true});assert.equal((await f.claim()).id,queuedDeepseek.data.job.id);
});

test('legacy queued provider snapshots remain OpenAI-only when provider was not captured',async t=>{
  const f=await fixture(t);await f.enabled();const p=await f.create();const queued=await f.queue(p);
  const row=f.store.db.prepare('SELECT settings FROM studio_jobs WHERE id=?').get(queued.data.job.id),settings=JSON.parse(row.settings);delete settings.provider;f.store.db.prepare('UPDATE studio_jobs SET settings=? WHERE id=?').run(JSON.stringify(settings),queued.data.job.id);
  await f.call('/api/worker/heartbeat',{method:'POST',body:{ready:true,providers:['deepseek']},user:null,worker:true});assert.equal((await f.claim()),null);
  await f.call('/api/worker/heartbeat',{method:'POST',body:{ready:true},user:null,worker:true});assert.equal((await f.claim()).id,queued.data.job.id);
});

test('provider advertisements persist through an API restart and do not revoke an active completion',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'nd-providers-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));const database=join(directory,'studio.sqlite');
  const first=await fixture(t,true,database);await first.enabled();providerCatalog(first);const p=await first.create();
  await first.call('/api/worker/heartbeat',{method:'POST',body:{ready:true,providers:['deepseek']},user:null,worker:true});
  await queueProvider(first,p,'deepseek-flash');const job=await first.claim();await first.close();
  const next=await fixture(t,true,database);assert.deepEqual((await next.call('/api/studio/session')).data.workerProviders,['deepseek']);
  await next.call('/api/worker/heartbeat',{method:'POST',body:{ready:true,providers:[]},user:null,worker:true});
  assert.equal((await next.complete(job)).data.status,'applied');
  const status=await next.call('/api/worker/status',{method:'POST',body:{},user:null,worker:true});assert.deepEqual(status.data,{ready:true,providers:[]});
});
