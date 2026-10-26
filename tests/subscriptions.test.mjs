import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { Store } from '../server/store.mjs';
import { createStudio } from '../server/studio.mjs';
import { studioSettings, StudioError } from '../server/studio-domain.mjs';
import { billingConfig, plans, verifyStripeSignature, STRIPE_VERSION } from '../server/subscriptions.mjs';

const env={STUDIO_SUBSCRIPTIONS_ENABLED:'true',STRIPE_SECRET_KEY:'sk_test_fixture',STRIPE_WEBHOOK_SECRET:'whsec_fixture'};
const files=[{path:'README.md',content:'# Fixture'},{path:'fxmanifest.lua',content:"fx_version 'cerulean'\ngame 'gta5'\n"}];
function fixture(t){
  const store=new Store(':memory:');t.after(()=>store.close());
  const user=store.login({id:'123456789012345678',username:'Owner',displayName:'Owner',avatar:null});
  const other=store.login({id:'223456789012345678',username:'Other',displayName:'Other',avatar:null});
  const config={origin:'https://ai.nightz.dev',ownerIds:[user.discord_id],workerToken:'a'.repeat(64),billing:billingConfig(env)};
  const calls=[],objects=new Map();let currentSession=null,authorized=true,afterFetch=null;
  const fetcher=async(url,options)=>{
    assert.equal(new URL(url).origin,'https://api.stripe.com');assert.equal(options.headers['Stripe-Version'],STRIPE_VERSION);
    const path=new URL(url).pathname.replace('/v1/',''),body=new URLSearchParams(options.body);
    calls.push({path,options,body});let value;
    if(path==='customers')value={id:'cus_fixture'};
    else if(path==='checkout/sessions')value=currentSession={id:'cs_test_fixture',url:'https://checkout.stripe.com/c/pay/fixture',status:'open',mode:'subscription'};
    else if(path==='checkout/sessions/cs_test_fixture')value=currentSession;
    else if(path==='billing_portal/configurations')value={id:'bpc_fixture'};
    else if(path==='billing_portal/configurations/bpc_fixture')value={id:'bpc_fixture',features:{subscription_update:{enabled:false},subscription_cancel:{mode:'at_period_end'}}};
    else if(path==='billing_portal/sessions')value={url:'https://billing.stripe.com/p/session/fixture'};
    else if(options.method==='POST' && path==='subscriptions/sub_fixture'){value=objects.get(path);value.cancel_at_period_end=body.get('cancel_at_period_end')==='true';}
    else value=objects.get(path);
    if(afterFetch)await afterFetch(path);
    assert.ok(value,`Unexpected Stripe call: ${path}`);
    return {ok:true,json:async()=>structuredClone(value)};
  };
  const required=req=>{if(!req.user || !authorized)throw new StudioError(401,'Sign in.');return {user_id:req.user.id,hash:req.user.id};};
  const mutation=req=>{if(req.headers['x-csrf-token']!=='fixture')throw new StudioError(403,'Security check failed.');return required(req);};
  const app=createStudio({store,config,fetcher,catalog:{tools:[{id:'ai-script-generator',category:'create',engine:'coding'}]},required,mutation,readJson:async req=>req.body,json:(res,status,data)=>Object.assign(res,{status,data:structuredClone(data)})});
  const settings=studioSettings(store);settings.model='fixture-model';settings.inputUsdPerMillion=1;settings.outputUsdPerMillion=2;settings.maxBudgetMicros=100000;settings.maxOutputTokens=1024;settings.tools['ai-script-generator']='members';delete settings.version;
  store.db.prepare('UPDATE studio_settings SET value=? WHERE id=1').run(JSON.stringify(settings));store.db.prepare('INSERT INTO studio_worker VALUES(1,?,1)').run(Date.now());
  const request=async(path,method='GET',body=null,member=user,headers={})=>{
    const res={};await app.route({user:member,method,body,headers:{'x-csrf-token':'fixture',...headers}},res,new URL(path,config.origin));return res;
  };
  const view=async()=>(await request('/api/studio/billing')).data;
  const checkout=async(planId='starter')=>request('/api/studio/billing/checkout','POST',{planId,acceptedTerms:true,pricingVersion:(await view()).version});
  async function event(type,object,eventId=`evt_${randomUUID().replaceAll('-','')}`,patch={}){
    const raw=Buffer.from(JSON.stringify({id:eventId,type,api_version:STRIPE_VERSION,data:{object},...patch}));
    const timestamp=Math.floor(Date.now()/1000),sig=createHmac('sha256',env.STRIPE_WEBHOOK_SECRET).update(`${timestamp}.`).update(raw).digest('hex');
    const req=Readable.from([raw]);req.method='POST';req.headers={'content-type':'application/json','stripe-signature':`t=${timestamp},v1=${sig}`};
    const res={};await app.route(req,res,new URL('/api/studio/billing/webhook',config.origin));return res;
  }
  async function preparePayment(){
    assert.equal((await checkout()).status,200);
    const receipt=store.db.prepare('SELECT * FROM studio_billing_checkouts').get(),terms=JSON.parse(receipt.terms);
    const now=Math.floor(Date.now()/1000),price={currency:'usd',unit_amount:terms.priceCents,recurring:{interval:'month',interval_count:1}};
    objects.set('subscriptions/sub_fixture',{id:'sub_fixture',customer:'cus_fixture',status:'active',cancel_at_period_end:false,metadata:{nd_checkout:receipt.id},items:{data:[{quantity:1,price}]},latest_invoice:'in_fixture'});
    objects.set('invoices/in_fixture',{id:'in_fixture',subscription:'sub_fixture',customer:'cus_fixture',status:'paid',billing_reason:'subscription_create',currency:'usd',amount_paid:terms.priceCents,subtotal:terms.priceCents,charge:'ch_fixture',paid_out_of_band:false,discounts:[],lines:{has_more:false,data:[{price,quantity:1,proration:false,period:{start:now-60,end:now+28*86400}}]}});
    objects.set('charges/ch_fixture',{id:'ch_fixture',invoice:'in_fixture',refunded:false,disputed:false,amount_refunded:0});
    currentSession.status='complete';currentSession.subscription='sub_fixture';return terms;
  }
  async function pay(){const terms=await preparePayment();assert.equal((await event('invoice.paid',{id:'in_fixture'})).status,200);return terms;}
  async function queue(){
    const project=(await request('/api/projects','POST',{name:'ND_Subscription',toolId:'ai-script-generator',target:'Standalone',requirements:'Subscription fixture'})).data.project;
    const catalog=(await request('/api/studio/models')).data;
    return request(`/api/projects/${project.id}/jobs`,'POST',{version:1,prompt:'Create a resource',requestId:randomUUID(),modelId:'fixture-model',pricingVersion:catalog.pricingVersion,quotedCredits:catalog.models[0].creditsPerBuild});
  }
  const worker=(path,body)=>request(`/api/worker/${path}`,'POST',body,null,{authorization:`Bearer ${config.workerToken}`});
  const claim=async()=>(await worker('claim',{})).data.job;
  const complete=async(job,cost=12345,result={files,summary:'Fixture delivered',checks:['Syntax fixture']})=>worker('complete',{id:job.id,lease:job.lease,costMicros:cost,result});
  return {store,user,other,config,calls,objects,request,view,checkout,event,preparePayment,pay,queue,claim,complete,worker,setAuthorized:value=>{authorized=value;},setAfterFetch:fn=>{afterFetch=fn;}};
}

test('monthly plans retain a $10 target after configured cost reserves and full allowance consumption',()=>{
  const config=billingConfig(env),data=plans(config);
  assert.deepEqual(data.map(plan=>[plan.priceCents,plan.credits]),[[1999,369],[2999,1329],[4999,3249]]);
  for(const p of data)assert.equal(p.priceCents-p.credits-p.paymentReserveCents-p.overheadReserveCents-p.failureReserveCents,1000);
  assert.equal(billingConfig({}).enabled,false);
  for(const patch of [{STRIPE_SECRET_KEY:''},{STRIPE_WEBHOOK_SECRET:''},{STUDIO_PAYMENT_RESERVE_BPS:'-1'},{STUDIO_OVERHEAD_RESERVE_CENTS:'100000'}])assert.throws(()=>billingConfig({...env,...patch}));
});
test('webhook signatures reject tampering, duplicate timestamps and stale deliveries',()=>{
  const raw=Buffer.from('{"fixture":true}'),now=Date.now(),timestamp=Math.floor(now/1000),signature=createHmac('sha256','secret').update(`${timestamp}.`).update(raw).digest('hex');
  const header=`t=${timestamp},v1=${signature}`;
  assert.doesNotThrow(()=>verifyStripeSignature(raw,header,'secret',now));
  for(const [body,head,time] of [[Buffer.from('{}'),header,now],[raw,`${header},t=${timestamp}`,now],[raw,header,now+301000],[raw,header,'invalid']])assert.throws(()=>verifyStripeSignature(body,head,'secret',time));
});
test('checkout is server priced, requires acknowledgment and CSRF, and retries reuse one session',async t=>{
  const f=fixture(t),version=(await f.view()).version;
  assert.equal((await f.request('/api/studio/billing/checkout','POST',{planId:'starter',acceptedTerms:false,pricingVersion:version})).status,409);
  assert.equal((await f.request('/api/studio/billing/checkout','POST',{planId:'starter',acceptedTerms:true,pricingVersion:version,priceCents:1})).status,400);
  assert.equal((await f.request('/api/studio/billing/checkout','POST',{},f.user,{'x-csrf-token':'bad'})).status,403);
  assert.equal((await f.checkout()).status,200);assert.equal((await f.checkout()).status,200);
  assert.equal(f.calls.filter(call=>call.path==='checkout/sessions').length,1);
  const call=f.calls.find(call=>call.path==='checkout/sessions');assert.equal(call.body.get('line_items[0][price_data][unit_amount]'),'1999');assert.ok(call.options.headers['Idempotency-Key']);
  assert.equal((await f.view()).subscription,null);assert.equal((await f.queue()).status,402);
});
test('paid invoices grant once, refresh cannot duplicate allowance and other users cannot see it',async t=>{
  const f=fixture(t),terms=await f.pay();assert.equal((await f.view()).wallet.available,terms.credits);
  assert.equal((await f.event('invoice.paid',{id:'in_fixture'},'evt_duplicate')).status,200);
  assert.equal((await f.event('invoice.paid',{id:'in_fixture'},'evt_duplicate')).status,200);
  assert.equal((await f.request('/api/studio/billing/refresh','POST',{})).status,200);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM studio_subscription_periods').get().n,1);
  assert.equal((await f.request('/api/studio/billing','GET',null,f.other)).data.wallet.available,0);
  assert.equal((await f.checkout()).status,409);
});
test('metered completion charges actual micro-cost once and releases the unused reservation',async t=>{
  const f=fixture(t),terms=await f.pay();assert.equal((await f.queue()).status,202);
  assert.equal((await f.view()).wallet.available,terms.credits-10);
  const job=await f.claim();assert.equal(job.settings.subscriptionBilling,true);
  assert.equal((await f.complete(job)).status,200);assert.equal((await f.complete(job)).status,200);
  const p=f.store.db.prepare('SELECT * FROM studio_subscription_periods').get();assert.equal(p.spent,12345);assert.equal(p.provider_spent,12345);
  assert.equal((await f.view()).wallet.available,terms.credits-2);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM studio_credit_ledger').get().n,0);
});
test('billed failures, cancellation and expired leases restore the allowance but preserve provider exposure',async t=>{
  const f=fixture(t),terms=await f.pay();await f.queue();let job=await f.claim();
  await f.complete(job,20000,{error:'Provider failure'});assert.equal((await f.view()).wallet.available,terms.credits);
  assert.equal(f.store.db.prepare('SELECT provider_spent FROM studio_subscription_periods').get().provider_spent,20000);
  const queued=await f.queue();await f.request(`/api/jobs/${queued.data.job.id}/cancel`,'POST',{});
  assert.equal((await f.view()).wallet.available,terms.credits);
  await f.queue();job=await f.claim();f.store.db.prepare('UPDATE studio_jobs SET lease_until=0 WHERE id=?').run(job.id);
  assert.equal((await f.view()).wallet.available,terms.credits);
  assert.equal(f.store.db.prepare('SELECT provider_spent FROM studio_subscription_periods').get().provider_spent,120000);
  assert.equal((await f.complete(job)).status,409);
});
test('unpriced delivered output is preserved without an estimated customer allowance charge',async t=>{
  const f=fixture(t),terms=await f.pay();await f.queue();const job=await f.claim();
  const result={files,summary:'Delivered despite unknown token pricing',checks:[],accounting:{status:'unreconciled',reason:'cache-write-price-unconfigured'}};
  assert.equal((await f.complete(job,job.settings.maxBudgetMicros,result)).status,200);
  assert.equal((await f.view()).wallet.available,terms.credits);
  assert.equal(f.store.db.prepare('SELECT provider_spent FROM studio_subscription_periods').get().provider_spent,job.settings.maxBudgetMicros);
});
test('insufficient allowance and exhausted failure reserves block before a provider job is queued',async t=>{
  const f=fixture(t);await f.pay();
  f.store.db.prepare('UPDATE studio_subscription_periods SET spent=allowance-50000').run();assert.equal((await f.queue()).status,402);
  f.store.db.prepare('UPDATE studio_subscription_periods SET spent=0,provider_spent=allowance+failure_reserve-50000').run();assert.equal((await f.queue()).status,503);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM studio_jobs').get().n,0);
});
test('refund and dispute receipts received before a paid invoice cannot be undone by a late grant',async t=>{
  for(const type of ['charge.refunded','charge.dispute.created']){
    const f=fixture(t);await f.preparePayment();
    assert.equal((await f.event(type,type==='charge.refunded'?{id:'ch_fixture'}:{id:'dp_fixture',charge:'ch_fixture'})).status,200);
    assert.equal((await f.event('invoice.paid',{id:'in_fixture'})).status,200);
    assert.equal((await f.view()).subscription.revoked,true);assert.equal((await f.queue()).status,402);
  }
});
test('canceling renewal keeps the paid allowance available and can be reversed before expiry',async t=>{
  const f=fixture(t),terms=await f.pay();
  assert.equal((await f.request('/api/studio/billing/cancel','POST',{cancelAtEnd:true})).status,200);
  assert.equal((await f.view()).subscription.cancelAtEnd,true);assert.equal((await f.view()).wallet.available,terms.credits);
  assert.equal((await f.request('/api/studio/billing/cancel','POST',{cancelAtEnd:false})).status,200);
  assert.equal((await f.view()).subscription.cancelAtEnd,false);
});
test('discounted, foreign-currency and malformed invoices are not silently granted a full allowance',async t=>{
  for(const patch of [{amount_paid:1},{currency:'eur'},{billing_reason:'subscription_update'},{paid_out_of_band:true},{discounts:['coupon']},{lines:{has_more:true,data:[]}}]){
    const f=fixture(t);await f.preparePayment();Object.assign(f.objects.get('invoices/in_fixture'),patch);
    assert.equal((await f.event('invoice.paid',{id:'in_fixture'})).status,409);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM studio_subscription_periods').get().n,0);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM studio_billing_events').get().n,0);
  }
});
test('expired paid periods cannot authorize new usage and source access remains available',async t=>{
  const f=fixture(t);await f.pay();f.store.db.prepare('UPDATE studio_subscription_periods SET end_at=?').run(Date.now()-1000);
  assert.equal((await f.queue()).status,402);assert.equal((await f.request('/api/projects')).status,200);
});
test('session invalidation during checkout never returns a payment URL to an expired session',async t=>{
  const f=fixture(t);f.setAfterFetch(async path=>{if(path==='customers')f.setAuthorized(false);});
  assert.equal((await f.checkout()).status,401);assert.equal(f.calls.filter(call=>call.path==='checkout/sessions').length,0);
});
test('billing portal uses the owning customer and a dedicated configuration without plan changes',async t=>{
  const f=fixture(t);await f.pay();
  assert.equal((await f.request('/api/studio/billing/portal','POST',{})).status,200);
  assert.equal((await f.request('/api/studio/billing/portal','POST',{})).status,200);
  assert.equal(f.calls.filter(call=>call.path==='billing_portal/configurations').length,1);
  const configuration=f.calls.find(call=>call.path==='billing_portal/configurations');
  assert.equal(configuration.body.get('features[subscription_update][enabled]'),'false');
  assert.equal(configuration.body.get('features[subscription_cancel][mode]'),'at_period_end');
  assert.equal(f.calls.find(call=>call.path==='billing_portal/sessions').body.get('customer'),'cus_fixture');
  assert.equal((await f.request('/api/studio/billing/portal','POST',{},f.other)).status,409);
});
test('renewal grants a new allowance once and a late completion settles only its original period',async t=>{
  const f=fixture(t),terms=await f.pay();await f.queue();const job=await f.claim();
  f.store.db.prepare('UPDATE studio_subscription_periods SET end_at=?').run(Date.now()-1000);
  const invoice=structuredClone(f.objects.get('invoices/in_fixture'));invoice.id='in_renewal';invoice.billing_reason='subscription_cycle';
  const now=Math.floor(Date.now()/1000);invoice.lines.data[0].period={start:now,end:now+28*86400};
  f.objects.set('invoices/in_renewal',invoice);
  assert.equal((await f.event('invoice.paid',{id:'in_renewal'})).status,200);
  assert.equal((await f.view()).wallet.available,terms.credits);
  assert.equal((await f.complete(job)).status,200);
  assert.equal(f.store.db.prepare("SELECT spent FROM studio_subscription_periods WHERE invoice_id='in_fixture'").get().spent,12345);
  assert.equal(f.store.db.prepare("SELECT spent FROM studio_subscription_periods WHERE invoice_id='in_renewal'").get().spent,0);
  assert.equal((await f.event('invoice.paid',{id:'in_renewal'})).status,200);
  assert.equal((await f.event('invoice.paid',{id:'in_fixture'})).status,200);
  assert.equal((await f.view()).wallet.available,terms.credits);
});
test('a refunded queued build is canceled before claim without another provider request',async t=>{
  const f=fixture(t);await f.pay();const queued=await f.queue();
  await f.event('charge.refunded',{id:'ch_fixture'});
  assert.equal(await f.claim(),null);
  assert.equal(f.store.db.prepare('SELECT status FROM studio_jobs WHERE id=?').get(queued.data.job.id).status,'cancelled');
  assert.equal(f.store.db.prepare('SELECT provider_spent FROM studio_subscription_periods').get().provider_spent,0);
});
test('checkout refuses sales while the only configured generator is in owner testing',async t=>{
  const f=fixture(t),settings=studioSettings(f.store);settings.tools['ai-script-generator']='owner';delete settings.version;
  f.store.db.prepare('UPDATE studio_settings SET value=? WHERE id=1').run(JSON.stringify(settings));
  assert.equal((await f.view()).plans[0].available,false);assert.equal((await f.checkout()).status,503);
  assert.equal(f.calls.length,0);
});
