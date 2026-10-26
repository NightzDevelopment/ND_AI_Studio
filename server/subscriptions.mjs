import { createHash, createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { insist, fields, integer, control } from './studio-domain.mjs';

export const BILLING_VERSION='2026-10-26';
export const STRIPE_VERSION='2024-06-20';
const DEFINITIONS=[['starter','Starter',1999],['pro','Pro',2999],['max','Max',4999]];
const id=(value,prefix)=>typeof value==='string' && new RegExp(`^${prefix}_[A-Za-z0-9_]+$`).test(value);
const objectId=value=>typeof value==='object' && value ? value.id : value;

export function billingConfig(env) {
  const enabled=env.STUDIO_SUBSCRIPTIONS_ENABLED==='true';
  const number=(name,fallback,max)=>integer(Number(env[name] ?? fallback),0,max,name);
  const result={enabled,secret:env.STRIPE_SECRET_KEY || '',webhookSecret:env.STRIPE_WEBHOOK_SECRET || '',
    feeBps:number('STUDIO_PAYMENT_RESERVE_BPS',400,10000),feeCents:number('STUDIO_PAYMENT_RESERVE_CENTS',50,10000),
    overheadCents:number('STUDIO_OVERHEAD_RESERVE_CENTS',300,100000),failureCents:number('STUDIO_FAILURE_RESERVE_CENTS',200,100000)};
  if(enabled && (!/^sk_(test|live)_[A-Za-z0-9]+$/.test(result.secret) || !/^whsec_[A-Za-z0-9]+$/.test(result.webhookSecret)))throw new Error('Subscriptions require private Stripe API and webhook secrets.');
  if(enabled && plans(result).some(plan=>plan.credits<1))throw new Error('Subscription cost reserves leave no AI allowance.');
  return result;
}
export function plans(config) {
  return DEFINITIONS.map(([id,name,priceCents])=>{
    const paymentReserveCents=Math.ceil(priceCents*config.feeBps/10000)+config.feeCents;
    const credits=Math.max(0,priceCents-1000-paymentReserveCents-config.overheadCents-config.failureCents);
    return {id,name,priceCents,credits,profitTargetCents:1000,paymentReserveCents,overheadReserveCents:config.overheadCents,failureReserveCents:config.failureCents};
  });
}
export function verifyStripeSignature(raw,header,secret,now=Date.now()) {
  insist(typeof header==='string' && header.length<4096,400,'Missing payment signature.');
  const parts=header.split(',').map(part=>part.split('='));
  const timestamps=parts.filter(([key])=>key==='t');
  insist(timestamps.length===1 && /^\d+$/.test(timestamps[0][1]),400,'Invalid payment signature.');
  const timestamp=Number(timestamps[0][1]);
  insist(Number.isSafeInteger(timestamp) && Math.abs(now/1000-timestamp)<=300,400,'Expired payment signature.');
  const expected=createHmac('sha256',secret).update(`${timestamp}.`).update(raw).digest();
  insist(parts.some(([key,value])=>key==='v1' && /^[a-f0-9]{64}$/.test(value || '') && timingSafeEqual(expected,Buffer.from(value,'hex'))),400,'Invalid payment signature.');
}
async function rawBody(req) {
  insist(!req.headers['content-encoding'] && (req.headers['content-type'] || '').startsWith('application/json'),415,'Send an uncompressed payment event.');
  const parts=[];let bytes=0;
  for await(const part of req){bytes+=part.length;insist(bytes<=1048576,413,'Payment event is too large.');parts.push(part);}
  return Buffer.concat(parts);
}

export function createSubscriptions({store,config,actor,readJson,json,fetcher=fetch,canSell=()=>true}) {
  const settings=config.billing || {enabled:false};
  const enabled=Boolean(settings.enabled), locks=new Map();
  store.transaction(()=>store.db.exec(`
    CREATE TABLE IF NOT EXISTS studio_billing_customers(user_id TEXT PRIMARY KEY REFERENCES users(id),customer_id TEXT NOT NULL UNIQUE) STRICT;
    CREATE TABLE IF NOT EXISTS studio_billing_checkouts(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),plan TEXT NOT NULL,terms TEXT NOT NULL,session_id TEXT UNIQUE,url TEXT,expires_at INTEGER NOT NULL,state TEXT NOT NULL) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS studio_billing_open_checkout ON studio_billing_checkouts(user_id) WHERE state IN ('creating','open');
    CREATE TABLE IF NOT EXISTS studio_subscriptions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),status TEXT NOT NULL,cancel_at_end INTEGER NOT NULL DEFAULT 0) STRICT;
    CREATE INDEX IF NOT EXISTS studio_subscriptions_user ON studio_subscriptions(user_id);
    CREATE TABLE IF NOT EXISTS studio_subscription_periods(invoice_id TEXT PRIMARY KEY,subscription_id TEXT NOT NULL REFERENCES studio_subscriptions(id),user_id TEXT NOT NULL REFERENCES users(id),plan TEXT NOT NULL,price_cents INTEGER NOT NULL,start_at INTEGER NOT NULL,end_at INTEGER NOT NULL,allowance INTEGER NOT NULL,spent INTEGER NOT NULL DEFAULT 0,provider_spent INTEGER NOT NULL DEFAULT 0,failure_reserve INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,UNIQUE(subscription_id,start_at)) STRICT;
    CREATE INDEX IF NOT EXISTS studio_subscription_current ON studio_subscription_periods(user_id,end_at);
    CREATE TABLE IF NOT EXISTS studio_subscription_jobs(job_id TEXT PRIMARY KEY REFERENCES studio_jobs(id),invoice_id TEXT NOT NULL REFERENCES studio_subscription_periods(invoice_id),reserved INTEGER NOT NULL,charged INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL CHECK(state IN ('reserved','charged','released'))) STRICT;
    CREATE INDEX IF NOT EXISTS studio_subscription_reservations ON studio_subscription_jobs(invoice_id,state);
    CREATE TABLE IF NOT EXISTS studio_billing_events(id TEXT PRIMARY KEY,type TEXT NOT NULL,created_at TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS studio_billing_revocations(invoice_id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE IF NOT EXISTS studio_billing_processor_settings(name TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
  `));
  const catalog=()=>enabled ? plans(settings) : [];
  const version=`${BILLING_VERSION}:${createHash('sha256').update(JSON.stringify(catalog())).digest('hex').slice(0,16)}`;
  async function stripe(path,body=null,key=null) {
    insist(enabled,503,'Subscriptions are not available yet.');
    let response;
    try { response=await fetcher(`https://api.stripe.com/v1/${path}`,{method:body?'POST':'GET',headers:{authorization:`Bearer ${settings.secret}`,'Stripe-Version':STRIPE_VERSION,...(body?{'content-type':'application/x-www-form-urlencoded'}:{}),...(key?{'Idempotency-Key':key}:{})},body:body?new URLSearchParams(body).toString():undefined,signal:AbortSignal.timeout(15000),redirect:'error'}); }
    catch { insist(false,503,'The payment service could not be reached. Retry the same action.'); }
    insist(response.ok,503,'The payment service did not confirm this action. Retry or contact support.');
    try { return await response.json(); } catch { insist(false,503,'The payment service returned an invalid response.'); }
  }
  async function exclusive(userId,fn) {
    insist(!locks.has(userId),409,'A payment action is already in progress. Please retry shortly.');
    locks.set(userId,true);try{return await fn();}finally{locks.delete(userId);}
  }
  function period(userId) {
    return store.db.prepare('SELECT p.*,s.cancel_at_end,s.status FROM studio_subscription_periods p JOIN studio_subscriptions s ON s.id=p.subscription_id WHERE p.user_id=? AND p.start_at<=? AND p.end_at>? ORDER BY p.start_at DESC LIMIT 1').get(userId,Date.now(),Date.now());
  }
  function view(userId) {
    const p=period(userId);
    const held=p ? store.db.prepare("SELECT coalesce(sum(reserved),0) amount FROM studio_subscription_jobs WHERE invoice_id=? AND state='reserved'").get(p.invoice_id).amount : 0;
    const usable=Boolean(p && !p.revoked);
    const limits=control(store,userId);
    return {enabled,version,hasCustomer:Boolean(store.db.prepare('SELECT 1 FROM studio_billing_customers WHERE user_id=?').get(userId)),limits:{dailyBuilds:limits.daily_limit,dailyBudgetMicros:limits.daily_budget},plans:catalog().map(({id,name,priceCents,credits})=>({id,name,priceCents,credits,available:canSell(userId,{credits})})),
      subscription:p ? {plan:p.plan,priceCents:p.price_cents,monthlyCredits:p.allowance/10000,status:p.status,cancelAtEnd:Boolean(p.cancel_at_end),renewsAt:new Date(p.end_at).toISOString(),revoked:Boolean(p.revoked)} : null,
      wallet:{balance:usable?Math.max(0,Math.floor((p.allowance-p.spent)/10000)):0,reserved:Math.ceil(held/10000),pending:0,available:usable?Math.max(0,Math.floor((p.allowance-p.spent-held)/10000)):0,version:p?.start_at || 0},
      paused:Boolean(usable && p.provider_spent+held>=p.allowance+p.failure_reserve)};
  }
  function reserve(jobId,userId,budget) {
    const p=period(userId);
    insist(p && !p.revoked,402,'Choose a subscription with a paid monthly allowance before generating. Your saved source remains available.');
    const held=store.db.prepare("SELECT coalesce(sum(reserved),0) amount FROM studio_subscription_jobs WHERE invoice_id=? AND state='reserved'").get(p.invoice_id).amount;
    insist(p.spent+held+budget<=p.allowance,402,'This build exceeds your remaining monthly allowance. Choose a smaller model or wait for renewal. No extra payment was taken.');
    insist(p.provider_spent+held+budget<=p.allowance+p.failure_reserve,503,'Generation is temporarily paused after provider failures. Your unused allowance is preserved. Contact support.');
    store.db.prepare("INSERT INTO studio_subscription_jobs(job_id,invoice_id,reserved,state) VALUES(?,?,?,'reserved')").run(jobId,p.invoice_id,budget);
  }
  function settle(jobId,delivered,cost,priced=true) {
    const receipt=store.db.prepare('SELECT * FROM studio_subscription_jobs WHERE job_id=?').get(jobId);
    if(!receipt || receipt.state!=='reserved')return;
    // Round only the display. Repeated tiny jobs still consume their full provider cost.
    const charged=delivered && priced ? Math.min(cost,receipt.reserved) : 0;
    store.db.prepare('UPDATE studio_subscription_periods SET spent=spent+?,provider_spent=provider_spent+? WHERE invoice_id=?').run(charged,cost,receipt.invoice_id);
    store.db.prepare('UPDATE studio_subscription_jobs SET charged=?,state=? WHERE job_id=?').run(charged,delivered?'charged':'released',jobId);
  }
  function recover() {
    const rows=store.db.prepare("SELECT j.id,j.status,j.cost,j.result FROM studio_subscription_jobs c JOIN studio_jobs j ON j.id=c.job_id WHERE c.state='reserved' AND j.status NOT IN ('queued','running')").all();
    if(rows.length)store.transaction(()=>{for(const row of rows)settle(row.id,['applied','review'].includes(row.status),row.cost,!JSON.parse(row.result || '{}').accounting);});
  }
  function history(userId) {
    return store.db.prepare("SELECT j.job_id AS jobId,j.state AS kind,j.charged,j.reserved,b.updated_at AS createdAt FROM studio_subscription_jobs j JOIN studio_jobs b ON b.id=j.job_id WHERE b.user_id=? ORDER BY b.updated_at DESC LIMIT 100").all(userId)
      .map(row=>({...row,amount:(row.kind==='charged'?row.charged:row.reserved)/10000,delta:row.kind==='charged'?-row.charged/10000:0,detail:row.kind==='released'?'No validated result delivered. Full allowance restored.':row.kind==='reserved'?'Maximum allowance reserved; no extra payment taken.':row.charged===0?'Validated result delivered. No allowance charge.':'Validated result delivered. Charged only for recorded provider usage.'}));
  }
  function describe(jobId) {
    const row=store.db.prepare('SELECT * FROM studio_subscription_jobs WHERE job_id=?').get(jobId);
    return row ? {amount:(row.state==='charged'?row.charged:row.reserved)/10000,state:row.state} : {amount:0,state:'not-used'};
  }
  function jobAllowed(jobId) {
    const row=store.db.prepare('SELECT p.revoked FROM studio_subscription_jobs j JOIN studio_subscription_periods p ON p.invoice_id=j.invoice_id WHERE j.job_id=?').get(jobId);
    return !row?.revoked;
  }
  async function syncSubscription(subscriptionId) {
    insist(id(subscriptionId,'sub'),400,'Invalid subscription reference.');
    const sub=await stripe(`subscriptions/${subscriptionId}`), checkout=store.db.prepare('SELECT * FROM studio_billing_checkouts WHERE id=?').get(sub.metadata?.nd_checkout || '');
    if(!checkout)return null;
    const customer=store.db.prepare('SELECT customer_id FROM studio_billing_customers WHERE user_id=?').get(checkout.user_id);
    insist(customer?.customer_id===objectId(sub.customer),409,'Payment account does not match.');
    const terms=JSON.parse(checkout.terms), item=sub.items?.data;
    insist(item?.length===1 && item[0].quantity===1 && item[0].price?.currency==='usd' && item[0].price.unit_amount===terms.priceCents && item[0].price.recurring?.interval==='month' && item[0].price.recurring.interval_count===1,409,'Subscription terms do not match the selected monthly plan.');
    // Re-read Stripe instead of applying potentially out-of-order event snapshots.
    store.transaction(()=>{
      store.db.prepare('INSERT INTO studio_subscriptions(id,user_id,status,cancel_at_end) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,cancel_at_end=excluded.cancel_at_end').run(sub.id,checkout.user_id,sub.status,Number(Boolean(sub.cancel_at_period_end)));
      store.db.prepare("UPDATE studio_billing_checkouts SET state='complete' WHERE id=?").run(checkout.id);
    });
    return {sub,checkout,terms};
  }
  async function paid(invoiceId) {
    insist(id(invoiceId,'in'),400,'Invalid invoice reference.');
    const invoice=await stripe(`invoices/${invoiceId}`);
    if(!invoice.subscription || invoice.status!=='paid')return;
    const snapshot=await syncSubscription(objectId(invoice.subscription));if(!snapshot)return;
    const {sub,checkout,terms}=snapshot;
    insist(id(objectId(invoice.charge),'ch'),409,'The invoice payment needs owner reconciliation.');
    const charge=await stripe(`charges/${objectId(invoice.charge)}`);
    const lines=invoice.lines?.data, line=lines?.[0];
    insist(['subscription_create','subscription_cycle'].includes(invoice.billing_reason) && invoice.currency==='usd' && invoice.amount_paid>=terms.priceCents && invoice.subtotal===terms.priceCents && !invoice.paid_out_of_band && !(invoice.discounts?.length) && !invoice.lines.has_more && lines.length===1 && !line.proration && line.price?.unit_amount===terms.priceCents && line.quantity===1 && objectId(invoice.customer)===objectId(sub.customer),409,'The paid invoice needs owner reconciliation before granting allowance.');
    const start=line.period?.start*1000,end=line.period?.end*1000;
    insist(Number.isSafeInteger(start) && Number.isSafeInteger(end) && end>start && end-start<=32*86400000,409,'Invalid monthly invoice period.');
    store.transaction(()=>{
      const overlap=store.db.prepare('SELECT 1 FROM studio_subscription_periods WHERE user_id=? AND subscription_id<>? AND start_at<? AND end_at>? AND revoked=0').get(checkout.user_id,sub.id,end,start);
      insist(!overlap,409,'Overlapping subscriptions require owner reconciliation.');
      const revoked=Boolean(charge.refunded || charge.disputed || charge.amount_refunded>0 || store.db.prepare('SELECT 1 FROM studio_billing_revocations WHERE invoice_id=?').get(invoice.id));
      store.db.prepare('INSERT OR IGNORE INTO studio_subscription_periods(invoice_id,subscription_id,user_id,plan,price_cents,start_at,end_at,allowance,failure_reserve,revoked) VALUES(?,?,?,?,?,?,?,?,?,?)').run(invoice.id,sub.id,checkout.user_id,checkout.plan,terms.priceCents,start,end,terms.credits*10000,terms.failureReserveCents*10000,Number(revoked));
      if(revoked)store.db.prepare('UPDATE studio_subscription_periods SET revoked=1 WHERE invoice_id=?').run(invoice.id);
    });
  }
  async function webhook(req,res) {
    const raw=await rawBody(req);verifyStripeSignature(raw,req.headers['stripe-signature'],settings.webhookSecret);
    let event;try{event=JSON.parse(raw);}catch{insist(false,400,'Invalid payment event.');}
    insist(id(event.id,'evt') && event.api_version===STRIPE_VERSION && typeof event.data?.object?.id==='string',400,'Configure snapshot payment events with the supported API version.');
    if(store.db.prepare('SELECT 1 FROM studio_billing_events WHERE id=?').get(event.id)){json(res,200,{ok:true});return;}
    const object=event.data.object;
    if(event.type==='invoice.paid')await paid(object.id);
    else if(['customer.subscription.created','customer.subscription.updated','customer.subscription.deleted'].includes(event.type))await syncSubscription(object.id);
    else if(event.type==='checkout.session.completed') {
      const session=await stripe(`checkout/sessions/${object.id}`);
      if(session.mode==='subscription' && session.subscription){const snapshot=await syncSubscription(objectId(session.subscription));if(snapshot?.sub.latest_invoice)await paid(objectId(snapshot.sub.latest_invoice));}
    } else if(['charge.refunded','charge.dispute.created'].includes(event.type)) {
      const chargeId=event.type==='charge.refunded'?object.id:objectId(object.charge);
      insist(id(chargeId,'ch'),400,'Invalid payment charge reference.');
      const charge=await stripe(`charges/${chargeId}`);
      if(charge.invoice)store.transaction(()=>{store.db.prepare('INSERT OR IGNORE INTO studio_billing_revocations VALUES(?)').run(objectId(charge.invoice));store.db.prepare('UPDATE studio_subscription_periods SET revoked=1 WHERE invoice_id=?').run(objectId(charge.invoice));});
    }
    store.db.prepare('INSERT OR IGNORE INTO studio_billing_events VALUES(?,?,?)').run(event.id,event.type,new Date().toISOString());
    json(res,200,{ok:true});
  }
  async function route(req,res,url) {
    const path=url.pathname,method=req.method;
    if(path==='/api/studio/plans' && method==='GET'){json(res,200,{enabled,version,plans:catalog().map(({id,name,priceCents,credits})=>({id,name,priceCents,credits}))});return true;}
    if(path==='/api/studio/billing/webhook') {insist(enabled,503,'Subscriptions are not enabled.');insist(method==='POST',405,'Use POST.');await webhook(req,res);return true;}
    if(!['/api/studio/billing','/api/studio/billing/checkout','/api/studio/billing/cancel','/api/studio/billing/refresh','/api/studio/billing/portal'].includes(path))return false;
    const a=await actor(req,method!=='GET');
    if(path==='/api/studio/billing' && method==='GET'){json(res,200,view(a.user.id));return true;}
    insist(enabled,503,'Subscriptions are not available yet.');insist(method==='POST',405,'Use POST.');
    const body=await readJson(req);a.check();
    await exclusive(a.user.id,async()=>{
      if(path==='/api/studio/billing/checkout') {
        fields(body,['planId','acceptedTerms','pricingVersion']);insist(body.acceptedTerms===true && body.pricingVersion===version,409,'Review the current monthly subscription terms.');
        const plan=catalog().find(plan=>plan.id===body.planId);insist(plan,400,'Choose a monthly plan.');
        insist(canSell(a.user.id,plan),503,'Subscriptions open when a compatible coding model and worker are available within this plan and your account limits. No payment was taken.');
        insist(!period(a.user.id),409,'Your current paid period is still active. Cancel renewal or wait for it to end before subscribing again.');
        insist(!store.db.prepare("SELECT 1 FROM studio_subscriptions WHERE user_id=? AND status NOT IN ('canceled','incomplete_expired')").get(a.user.id),409,'Manage your existing subscription before creating another.');
        let checkout=store.db.prepare("SELECT * FROM studio_billing_checkouts WHERE user_id=? AND state IN ('creating','open')").get(a.user.id);
        if(checkout?.session_id){const session=await stripe(`checkout/sessions/${checkout.session_id}`);a.check();if(session.status==='expired'){store.db.prepare("UPDATE studio_billing_checkouts SET state='expired' WHERE id=?").run(checkout.id);checkout=null;}else insist(session.status==='open',409,'Your checkout is being confirmed. Refresh your subscription shortly.');}
        if(checkout){insist(checkout.plan===plan.id,409,'Finish or let your existing checkout expire before choosing another plan.');insist(checkout.terms===JSON.stringify(plan),409,'Your existing checkout uses earlier pricing terms. Let it expire before starting another.');}
        else {const receipt=randomUUID();store.db.prepare("INSERT INTO studio_billing_checkouts(id,user_id,plan,terms,expires_at,state) VALUES(?,?,?,?,?,'creating')").run(receipt,a.user.id,plan.id,JSON.stringify(plan),Math.floor(Date.now()/1000)+3600);checkout=store.db.prepare('SELECT * FROM studio_billing_checkouts WHERE id=?').get(receipt);}
        if(!checkout.session_id) {
          insist(checkout.expires_at>Math.floor(Date.now()/1000),409,'An interrupted checkout needs owner reconciliation before another payment can be attempted.');
          const terms=JSON.parse(checkout.terms);
          let customer=store.db.prepare('SELECT customer_id FROM studio_billing_customers WHERE user_id=?').get(a.user.id)?.customer_id;
          if(!customer){const result=await stripe('customers',{'metadata[nd_user]':a.user.id},`ndai-customer-${a.user.id}`);a.check();insist(id(result.id,'cus'),503,'Invalid payment account response.');customer=result.id;store.db.prepare('INSERT INTO studio_billing_customers VALUES(?,?) ON CONFLICT(user_id) DO NOTHING').run(a.user.id,customer);}
          const result=await stripe('checkout/sessions',{mode:'subscription',customer,'payment_method_types[0]':'card','line_items[0][price_data][currency]':'usd','line_items[0][price_data][unit_amount]':String(terms.priceCents),'line_items[0][price_data][recurring][interval]':'month','line_items[0][price_data][product_data][name]':`ND AI Studio ${terms.name}`,'line_items[0][quantity]':'1','subscription_data[metadata][nd_checkout]':checkout.id,client_reference_id:a.user.id,success_url:`${config.origin}/workspace.html#billing`,cancel_url:`${config.origin}/workspace.html#billing`,expires_at:String(checkout.expires_at)},`ndai-checkout-${checkout.id}`);
          a.check();insist(id(result.id,'cs') && typeof result.url==='string' && result.url.startsWith('https://checkout.stripe.com/'),503,'Invalid checkout response.');
          store.db.prepare("UPDATE studio_billing_checkouts SET session_id=?,url=?,state='open' WHERE id=? AND state='creating'").run(result.id,result.url,checkout.id);
          checkout=store.db.prepare('SELECT * FROM studio_billing_checkouts WHERE id=?').get(checkout.id);
        }
        json(res,200,{url:checkout.url});
      } else if(path==='/api/studio/billing/cancel') {
        fields(body,['cancelAtEnd']);insist(typeof body.cancelAtEnd==='boolean',400,'Choose a renewal setting.');
        const p=period(a.user.id);insist(p,409,'No current paid subscription.');
        await stripe(`subscriptions/${p.subscription_id}`,{cancel_at_period_end:String(body.cancelAtEnd)});
        a.check();await syncSubscription(p.subscription_id);a.check();json(res,200,view(a.user.id));
      } else if(path==='/api/studio/billing/portal') {
        fields(body,[]);
        const customer=store.db.prepare('SELECT customer_id FROM studio_billing_customers WHERE user_id=?').get(a.user.id);insist(customer,409,'No billing account exists yet.');
        let configuration=store.db.prepare("SELECT value FROM studio_billing_processor_settings WHERE name='portal'").get()?.value;
        if(!configuration){
          const result=await stripe('billing_portal/configurations',{'business_profile[headline]':'Manage your ND AI Studio subscription','features[payment_method_update][enabled]':'true','features[invoice_history][enabled]':'true','features[subscription_cancel][enabled]':'true','features[subscription_cancel][mode]':'at_period_end','features[subscription_update][enabled]':'false'},'ndai-portal-20261026');
          a.check();insist(id(result.id,'bpc'),503,'Invalid billing portal response.');configuration=result.id;
          store.db.prepare("INSERT OR IGNORE INTO studio_billing_processor_settings VALUES('portal',?)").run(configuration);
        }
        const portal=await stripe(`billing_portal/configurations/${configuration}`);
        insist(portal.features?.subscription_update?.enabled===false && portal.features?.subscription_cancel?.mode==='at_period_end',503,'The billing portal configuration needs owner review before it can be opened.');
        const result=await stripe('billing_portal/sessions',{customer:customer.customer_id,configuration,return_url:`${config.origin}/workspace.html#billing`});
        a.check();insist(typeof result.url==='string' && result.url.startsWith('https://billing.stripe.com/'),503,'Invalid billing portal response.');json(res,200,{url:result.url});
      } else {
        fields(body,[]);
        const checkout=store.db.prepare("SELECT * FROM studio_billing_checkouts WHERE user_id=? AND session_id IS NOT NULL ORDER BY rowid DESC LIMIT 1").get(a.user.id);
        if(checkout){const session=await stripe(`checkout/sessions/${checkout.session_id}`);a.check();if(session.subscription){const snapshot=await syncSubscription(objectId(session.subscription));if(snapshot?.sub.latest_invoice)await paid(objectId(snapshot.sub.latest_invoice));}}
        a.check();json(res,200,view(a.user.id));
      }
    });return true;
  }
  return {enabled,route,view,reserve,settle,recover,history,describe,jobAllowed};
}
