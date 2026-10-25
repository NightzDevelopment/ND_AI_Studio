import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { Store } from '../server/store.mjs';
import { createApp, hash } from '../server/app.mjs';
import { readConfig } from '../server/config.mjs';
import { validateFiles,changedFiles,zipFiles,studioSettings,migrateStudio } from '../server/studio-domain.mjs';
import { memberRoles } from '../server/studio-discord.mjs';
const OWNER='100000000000000001',OTHER='100000000000000002';
const catalog={tools:[{id:'ai-script-generator',engine:'coding',category:'create'},{id:'discord-bot-generator',engine:'coding',category:'create'},{id:'community-gallery',engine:'utility-content',category:'browse'}]};
async function fixture(t,owner=true) {
  const store=new Store(':memory:');
  const config=readConfig({APP_ORIGIN:'http://127.0.0.1',NODE_ENV:'development',OWNER_DISCORD_IDS:owner ? OWNER : '',STUDIO_WORKER_TOKEN:'a'.repeat(64)});
  const credentials={};
  for (const id of [OWNER,OTHER]) { const user=store.login({id,username:id,displayName:id,avatar:null}),session=randomBytes(32).toString('base64url'),csrf=randomBytes(32).toString('base64url');store.newSession(hash(session),user.id,csrf,3600);credentials[id]={user,session,csrf}; }
  const errors=[];const app=createApp({store,config,catalog,logger:{error:message=>errors.push(message)}});app.listen(0,'127.0.0.1');await once(app,'listening');
  t.after(async()=>{app.closeAllConnections();await new Promise(resolve=>app.close(resolve));store.close();});
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
  return {store,config,credentials,call,create,enabled,errors};
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
test('build lifecycle is idempotent, review-only and revision-safe',async t=>{
  const f=await fixture(t);await f.enabled();const p=await f.create(),request={version:1,prompt:'Build the resource',requestId:randomUUID()};
  let r=await f.call(`/api/projects/${p.id}/jobs`,{method:'POST',body:request});assert.equal(r.status,202,JSON.stringify(r.data));const id=r.data.job.id;
  assert.equal((await f.call(`/api/projects/${p.id}/jobs`,{method:'POST',body:request})).data.job.id,id);
  assert.equal((await f.call(`/api/projects/${p.id}/jobs`,{method:'POST',body:{...request,requestId:randomUUID()}})).status,409);
  assert.equal((await f.call('/api/worker/claim',{method:'POST',body:{},user:null})).status,401);
  r=await f.call('/api/worker/claim',{method:'POST',body:{},worker:true,user:null});assert.equal(r.status,200);const job=r.data.job;assert.equal(job.id,id);
  r=await f.call('/api/worker/complete',{method:'POST',user:null,worker:true,body:{id,lease:job.lease,costMicros:100,result:{files:[{path:'client.lua',content:'print(1)'}],summary:'Created resource',checks:['Syntax passed.']}}});assert.equal(r.status,200,JSON.stringify(r.data));
  assert.equal((await f.call(`/api/projects/${p.id}`)).data.project.files.length,0);
  assert.equal((await f.call(`/api/jobs/${id}`,{user:OTHER})).status,404);
  r=await f.call(`/api/jobs/${id}/apply`,{method:'POST',body:{version:1}});assert.equal(r.status,200);assert.equal(r.data.project.version,2);
  assert.equal((await f.call(`/api/jobs/${id}/apply`,{method:'POST',body:{version:2}})).status,409);
});
test('cancelled leases cannot submit results and preserve potential spend',async t=>{
  const f=await fixture(t);await f.enabled();const p=await f.create();const created=await f.call(`/api/projects/${p.id}/jobs`,{method:'POST',body:{version:1,prompt:'build',requestId:randomUUID()}});
  const id=created.data.job.id,{job}= (await f.call('/api/worker/claim',{method:'POST',worker:true,user:null,body:{}})).data;
  assert.equal((await f.call(`/api/jobs/${id}/cancel`,{method:'POST',body:{}})).status,200);
  assert.equal((await f.call('/api/worker/progress',{method:'POST',worker:true,user:null,body:{id,lease:job.lease}})).status,409);
  assert.equal((await f.call(`/api/jobs/${id}`)).data.job.costMicros,250000);
});
test('stale generated result does not overwrite manual changes',async t=>{
  const f=await fixture(t);await f.enabled();const p=await f.create();const created=await f.call(`/api/projects/${p.id}/jobs`,{method:'POST',body:{version:1,prompt:'build',requestId:randomUUID()}});const id=created.data.job.id;
  const {job}=(await f.call('/api/worker/claim',{method:'POST',worker:true,user:null,body:{}})).data;
  await f.call(`/api/projects/${p.id}/files`,{method:'PUT',body:{version:1,path:'manual.lua',content:'print(2)'}});
  await f.call('/api/worker/complete',{method:'POST',worker:true,user:null,body:{id,lease:job.lease,costMicros:50,result:{files:[{path:'generated.lua',content:'print(1)'}],summary:'Test',checks:[]}}});
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
