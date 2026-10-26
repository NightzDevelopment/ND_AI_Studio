import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createFixture} from './fixtures/agent-http.mjs';
import {createSubscriptions} from '../server/subscriptions.mjs';
import {createModels} from '../server/studio-models.mjs';
import {project} from '../server/studio-domain.mjs';
async function fixture(t,{paid=true}={}){
  const f=await createFixture({billing:true});t.after(()=>f.close());
  if(paid){
    f.store.db.prepare('INSERT INTO studio_subscriptions VALUES(?,?,?,0)').run('sub_fixture',f.user.id,'active');
    f.store.db.prepare('INSERT INTO studio_subscription_periods(invoice_id,subscription_id,user_id,plan,price_cents,start_at,end_at,allowance,failure_reserve) VALUES(?,?,?,?,?,?,?,?,?)').run('in_fixture','sub_fixture',f.user.id,'starter',1999,Date.now()-60000,Date.now()+86400000,10000000,2000000);
  }
  const subscriptions=createSubscriptions({store:f.store,config:f.config,actor(){throw Error('No payment request permitted.');},readJson(){},json(){},fetcher(){throw Error('No payment request permitted.');}});
  const models=createModels({store:f.store,subscriptions,actor(){},readJson(){},json(){}});
  return {...f,subscriptions,models,period:()=>f.store.db.prepare('SELECT * FROM studio_subscription_periods WHERE invoice_id=?').get('in_fixture')};
}
async function task(f){
  const chat=(await f.call(`/api/agent/projects/${f.p.id}/chats`,{title:'Metered task',requestId:randomUUID()})).data.chat;
  await f.call(`/api/agent/projects/${f.p.id}/presence`,{tabId:randomUUID()});
  const catalog=(await f.call('/api/agent/bootstrap')).data.catalog,model=catalog.models[0];
  const body={requestId:randomUUID(),message:'Create the notification',mode:'build',modelId:model.id,pricingVersion:catalog.pricingVersion,quotedCredits:model.creditsPerBuild,maxSteps:16,continuation:'pause',projectVersion:2};
  return {chat,body,...await f.call(`/api/agent/chats/${chat.id}/tasks`,body)};
}
async function approve(f,id){const t=(await f.call(`/api/agent/tasks/${id}`)).data.task;const r=await f.call(`/api/agent/tasks/${id}/approve`,{version:t.version,planVersion:t.planVersion,planHash:t.planHash,requestId:randomUUID()});assert.equal(r.status,200,JSON.stringify(r.data));return r;}

test('agent quotes and reserves the existing subscription allowance, never a parallel free wallet',async t=>{
  const f=await fixture(t),r=await task(f);assert.equal(r.status,201,JSON.stringify(r.data));
  const settings=JSON.parse(f.store.db.prepare('SELECT settings FROM studio_jobs WHERE id=?').get(r.data.task.id).settings);
  assert.equal(settings.subscriptionBilling,true);assert.equal(r.data.task.billingMode,'metered');
  assert.equal(f.store.db.prepare('SELECT reserved FROM studio_subscription_jobs WHERE job_id=?').get(r.data.task.id).reserved,500000);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM studio_job_credits').get().n,0);
});
test('subscription enforcement cannot be bypassed by the owner agent endpoint',async t=>{
  const f=await fixture(t,{paid:false}),r=await task(f);assert.equal(r.status,402);assert.equal(f.store.db.prepare('SELECT count(*) n FROM studio_agent_tasks').get().n,0);assert.equal(f.counts().paid,0);
});
test('both ordinary recovery paths preserve agent reservations during plan approval and pause',async t=>{
  const f=await fixture(t),r=await task(f),id=r.data.task.id;await f.tick();
  f.models.recover();f.subscriptions.recover();
  assert.equal(f.store.db.prepare('SELECT state FROM studio_subscription_jobs WHERE job_id=?').get(id).state,'reserved');
  assert.equal(f.period().provider_spent,0);assert.equal(f.period().spent,0);
  const current=(await f.call(`/api/agent/tasks/${id}`)).data.task;
  await f.call(`/api/agent/tasks/${id}/control`,{action:'pause',version:current.version,requestId:randomUUID()});f.subscriptions.recover();
  assert.equal(f.store.db.prepare('SELECT state FROM studio_subscription_jobs WHERE job_id=?').get(id).state,'reserved');
});
test('successful metered agent delivery settles recorded usage once and retains subscription limits',async t=>{
  const f=await fixture(t),r=await task(f),id=r.data.task.id;await f.tick();await approve(f,id);await f.tick();
  const taskView=(await f.call(`/api/agent/tasks/${id}`)).data.task;assert.equal(taskView.state,'completed');assert.equal(taskView.appliedVersion,3);
  assert.equal(f.period().spent,taskView.spentMicros);assert.equal(f.period().provider_spent,taskView.spentMicros);assert.ok(taskView.spentMicros<500000);
  f.models.recover();f.subscriptions.recover();assert.equal(f.period().spent,taskView.spentMicros);assert.equal(project(f.store,f.user.id,f.p.id).version,3);
});
test('API failure releases the full customer allowance while preserving possible provider expense',async t=>{
  const f=await fixture(t),r=await task(f),id=r.data.task.id;f.behavior('api-failure');await f.tick();
  const taskView=(await f.call(`/api/agent/tasks/${id}`)).data.task;assert.equal(taskView.state,'failed');assert.equal(taskView.unreconciled,true);assert.equal(taskView.credits.state,'released');assert.equal(f.period().spent,0);assert.equal(f.period().provider_spent,500000);assert.equal(f.counts().paid,1);
  f.models.recover();f.subscriptions.recover();assert.equal(f.period().provider_spent,500000);
});
test('revoked paid periods prevent the next agent dispatch and plan approval',async t=>{
  const f=await fixture(t),r=await task(f),id=r.data.task.id;await f.tick();f.store.db.prepare('UPDATE studio_subscription_periods SET revoked=1').run();
  const current=(await f.call(`/api/agent/tasks/${id}`)).data.task;
  const approved=await f.call(`/api/agent/tasks/${id}/approve`,{version:current.version,planVersion:current.planVersion,planHash:current.planHash,requestId:randomUUID()});assert.equal(approved.status,409);await f.tick();assert.equal(f.counts().paid,3);assert.equal(project(f.store,f.user.id,f.p.id).version,2);
});
test('stopping metered planning returns customer allowance without erasing known provider usage',async t=>{
  const f=await fixture(t),r=await task(f),id=r.data.task.id;await f.tick();const current=(await f.call(`/api/agent/tasks/${id}`)).data.task;
  const stopped=await f.call(`/api/agent/tasks/${id}/control`,{action:'stop',version:current.version,requestId:randomUUID()});assert.equal(stopped.status,200);assert.equal(stopped.data.task.credits.state,'released');assert.equal(f.period().spent,0);assert.equal(f.period().provider_spent,current.spentMicros);
});
