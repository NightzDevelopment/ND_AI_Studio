import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { createStudio } from '../server/studio.mjs';
import { StudioError, studioSettings } from '../server/studio-domain.mjs';

const OWNER='100000000000000001',STAFF='100000000000000002',TARGET='100000000000000003',ROLE='100000000000000004',GUILD='100000000000000005';
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
function fixture(t){
  const store=new Store(':memory:');t.after(()=>store.close());
  const user=id=>store.login({id,username:id,displayName:id,avatar:null});
  const owner=user(OWNER),staff=user(STAFF),target=user(TARGET),sessionHash='staff-session-hash';
  store.newSession(sessionHash,staff.id,'csrf',3600);
  const config={ownerIds:[OWNER],workerToken:'a'.repeat(64),botToken:'fixture-bot'};
  const required=req=>{const session=store.session(req.sessionHash);if(!session)throw new StudioError(401,'Session ended.');return session;};
  const mutation=(req,expected=null)=>{
    const session=required(req);
    if(expected&&(session.hash!==expected.hash||session.user_id!==expected.user_id))throw new StudioError(401,'Session changed.');
    if(req.headers.origin!=='https://ai.nightz.dev'||req.headers['x-csrf-token']!==session.csrf)throw new StudioError(403,'CSRF failed.');
    return session;
  };
  let roleGate=null,bodyGate=null,roles=[ROLE];
  const app=createStudio({store,config,catalog:{tools:[]},required,mutation,
    readJson:async req=>{if(bodyGate){const gate=bodyGate;bodyGate=null;gate.entered.resolve();await gate.release.promise;}return req.body;},
    fetcher:async()=>{if(roleGate){const gate=roleGate;roleGate=null;gate.entered.resolve();await gate.release.promise;}return new Response(JSON.stringify({roles}));},
    json:(res,status,data)=>Object.assign(res,{status,data})});
  const settings=studioSettings(store);delete settings.version;settings.guildId=GUILD;settings.roleMappings={[ROLE]:['users:read','users:manage']};
  store.db.prepare('UPDATE studio_settings SET value=?').run(JSON.stringify(settings));
  const request=async(path,{method='GET',body}={})=>{
    const req={method,body,sessionHash,headers:{origin:'https://ai.nightz.dev','x-csrf-token':'csrf'}},res={setHeader(){}};
    await app.route(req,res,new URL(path,'https://ai.nightz.dev'));return res;
  };
  const pause=kind=>{const gate={entered:deferred(),release:deferred()};if(kind==='roles')roleGate=gate;else bodyGate=gate;return {entered:gate.entered.promise,release:()=>gate.release.resolve()};};
  const update=()=>request(`/api/admin/users/${target.id}`,{method:'PATCH',body:{version:0,status:'suspended',dailyLimit:5,dailyBudgetMicros:1000000,revokeSessions:true,reason:'Staff review'}});
  return {store,owner,staff,target,sessionHash,request,pause,update,setRoles:value=>{roles=value;},changeSettings:change=>{const current=studioSettings(store);delete current.version;change(current);store.db.prepare('UPDATE studio_settings SET value=?,version=version+1').run(JSON.stringify(current));}};
}

test('staff session revocation during a Discord role lookup prevents private administration reads',async t=>{
  const f=fixture(t),gate=f.pause('roles'),pending=f.request('/api/admin/users');await gate.entered;
  f.store.db.prepare('DELETE FROM sessions WHERE hash=?').run(f.sessionHash);gate.release();
  const denied=await pending;assert.equal(denied.status,401);assert.equal(denied.data.users,undefined);
});

test('staff suspension during a Discord role lookup prevents administration writes',async t=>{
  const f=fixture(t),gate=f.pause('roles'),pending=f.update();await gate.entered;
  f.store.db.prepare('INSERT INTO studio_controls VALUES(?,?,?,?,?)').run(f.staff.id,'suspended',5,1000000,1);gate.release();
  assert.equal((await pending).status,403);assert.equal(f.store.db.prepare('SELECT count(*) n FROM studio_controls WHERE user_id=?').get(f.target.id).n,0);
});

test('role mapping changes during a Discord lookup cannot authorize stale permissions',async t=>{
  const f=fixture(t),gate=f.pause('roles'),pending=f.update();await gate.entered;f.changeSettings(settings=>{settings.roleMappings={};});gate.release();
  assert.equal((await pending).status,403);assert.equal(f.store.db.prepare('SELECT count(*) n FROM studio_audit').get().n,0);
});

test('a guild change during a Discord role lookup fails closed instead of using old-guild roles',async t=>{
  const f=fixture(t),gate=f.pause('roles'),pending=f.update();await gate.entered;f.changeSettings(settings=>{settings.guildId='100000000000000006';});gate.release();
  assert.equal((await pending).status,409);assert.equal(f.store.db.prepare('SELECT count(*) n FROM studio_audit').get().n,0);
});

test('staff membership is refreshed after a partial request body before an administrative mutation',async t=>{
  const f=fixture(t),gate=f.pause('body'),pending=f.update();await gate.entered;f.setRoles([]);gate.release();
  assert.equal((await pending).status,403);assert.equal(f.store.db.prepare('SELECT count(*) n FROM studio_controls WHERE user_id=?').get(f.target.id).n,0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM studio_audit').get().n,0);
});

test('an unchanged staff session and refreshed permission can complete the administrative mutation',async t=>{
  const f=fixture(t),gate=f.pause('body'),pending=f.update();await gate.entered;gate.release();
  assert.equal((await pending).status,200);assert.equal(f.store.db.prepare('SELECT status FROM studio_controls WHERE user_id=?').get(f.target.id).status,'suspended');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM studio_audit').get().n,1);
});
