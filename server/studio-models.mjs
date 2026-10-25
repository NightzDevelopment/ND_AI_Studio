import { insist, fields, string, integer, studioSettings, audit } from './studio-domain.mjs';
import { VERIFIED_PRESETS } from './model-presets.mjs';

const DEFAULT = { configured:false, models:[], defaultModelId:'', creditsEnabled:false };
const PROVIDER_DEFAULTS={provider:'openai',cacheWritePolicy:'provider-default',cacheWrite30mUsdPerMillion:null,cacheWrite12hUsdPerMillion:null,longContextThreshold:null,longContextInputMultiplier:1,longContextOutputMultiplier:1};
const MODEL_FIELDS = ['id','label','tier','enabled','compatible','inputUsdPerMillion','cachedInputUsdPerMillion','outputUsdPerMillion','maxOutputTokens','maxCalls','maxBudgetMicros','timeoutSeconds','creditsPerBuild',...Object.keys(PROVIDER_DEFAULTS)];
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const now = () => new Date().toISOString();

export function validateModel(model) {
  fields(model,MODEL_FIELDS);
  model={...PROVIDER_DEFAULTS,...model};
  insist(typeof model.id === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(model.id),400,'Enter an exact provider API model identifier.');
  insist(['openai','deepseek'].includes(model.provider),400,'Choose a supported coding provider.');
  insist(['provider-default','disabled'].includes(model.cacheWritePolicy),400,'Choose a supported prompt-cache policy.');
  insist(model.provider==='openai'||model.cacheWritePolicy==='provider-default',400,'DeepSeek manages its cache automatically.');
  for(const key of ['cacheWrite30mUsdPerMillion','cacheWrite12hUsdPerMillion'])insist(model[key]===null||typeof model[key]==='number'&&Number.isFinite(model[key])&&model[key]>=0&&model[key]<=10000,400,'Invalid cache-write price.');
  if(model.longContextThreshold!==null)integer(model.longContextThreshold,1,10000000,'long-context input threshold');
  for(const key of ['longContextInputMultiplier','longContextOutputMultiplier'])insist(typeof model[key]==='number'&&Number.isFinite(model[key])&&model[key]>=1&&model[key]<=10,400,'Invalid long-context price multiplier.');
  insist(model.longContextThreshold!==null||(model.longContextInputMultiplier===1&&model.longContextOutputMultiplier===1),400,'Set a long-context threshold before price multipliers.');
  const label=string(model.label,80,'model label');
  insist(['budget','standard','premium'].includes(model.tier),400,'Choose a model tier.');
  insist(typeof model.enabled === 'boolean' && typeof model.compatible === 'boolean',400,'Invalid model availability.');
  insist(!model.enabled || model.compatible,400,'Confirm Responses API and structured JSON compatibility before enabling this model.');
  for (const key of ['inputUsdPerMillion','outputUsdPerMillion','cachedInputUsdPerMillion']) {
    insist(typeof model[key] === 'number' && Number.isFinite(model[key]) && model[key] >= 0 && model[key] <= 10000,400,'Invalid per-million token price.');
  }
  insist(!model.enabled || (model.inputUsdPerMillion > 0 && model.outputUsdPerMillion > 0),400,'Enabled models need positive input and output prices.');
  insist(model.cachedInputUsdPerMillion <= model.inputUsdPerMillion,400,'Cached input price cannot exceed the normal input price.');
  integer(model.maxOutputTokens,512,65536,'model output limit');
  integer(model.maxCalls,1,2,'model call limit');
  integer(model.maxBudgetMicros,10000,100000000,'model build budget');
  integer(model.timeoutSeconds,30,900,'model request timeout');
  integer(model.creditsPerBuild,0,1000000,'model credits');
  return {...model,label};
}

export function createModels({store,actor,readJson,json,workerReady=()=>true}) {
  store.transaction(()=>store.db.exec(`
    CREATE TABLE IF NOT EXISTS studio_model_settings(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1) STRICT;
    CREATE TABLE IF NOT EXISTS studio_credit_wallets(user_id TEXT PRIMARY KEY REFERENCES users(id),balance INTEGER NOT NULL DEFAULT 0 CHECK(balance>=0 AND balance<=1000000000),version INTEGER NOT NULL DEFAULT 1) STRICT;
    CREATE TABLE IF NOT EXISTS studio_job_credits(job_id TEXT PRIMARY KEY REFERENCES studio_jobs(id),user_id TEXT NOT NULL REFERENCES users(id),amount INTEGER NOT NULL CHECK(amount>=0),state TEXT NOT NULL CHECK(state IN ('reserved','pending','charged','released')),updated_at TEXT NOT NULL) STRICT;
    CREATE INDEX IF NOT EXISTS studio_credit_states ON studio_job_credits(state,job_id);
    CREATE INDEX IF NOT EXISTS studio_credit_holds ON studio_job_credits(user_id,state);
    CREATE TABLE IF NOT EXISTS studio_credit_ledger(id INTEGER PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),actor TEXT NOT NULL,request_id TEXT NOT NULL,kind TEXT NOT NULL,delta INTEGER NOT NULL,amount INTEGER NOT NULL,job_id TEXT,detail TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(actor,request_id)) STRICT;
    CREATE INDEX IF NOT EXISTS studio_credit_history ON studio_credit_ledger(user_id,id DESC);
  `));
  store.db.prepare('INSERT OR IGNORE INTO studio_model_settings(id,value) VALUES(1,?)').run(JSON.stringify(DEFAULT));

  function configuration() {
    const row=store.db.prepare('SELECT * FROM studio_model_settings WHERE id=1').get();
    const data={...DEFAULT,...JSON.parse(row.value)};
    if (!data.configured) {
      const s=studioSettings(store);
      if (s.model && s.inputUsdPerMillion > 0 && s.outputUsdPerMillion > 0) {
        data.models=[{...PROVIDER_DEFAULTS,id:s.model,label:s.model,tier:'standard',enabled:true,compatible:true,
          inputUsdPerMillion:s.inputUsdPerMillion,cachedInputUsdPerMillion:s.inputUsdPerMillion,
          outputUsdPerMillion:s.outputUsdPerMillion,maxOutputTokens:s.maxOutputTokens,maxCalls:s.maxCalls,
          maxBudgetMicros:s.maxBudgetMicros,timeoutSeconds:180,creditsPerBuild:0}];
        data.defaultModelId=s.model;
      }
      return {...data,version:row.version,pricingVersion:`legacy:${s.version}`};
    }
    return {...data,models:data.models.map(model=>({...PROVIDER_DEFAULTS,...model})),version:row.version,pricingVersion:`catalog:${row.version}`};
  }
  function wallet(userId) {
    const row=store.db.prepare('SELECT balance,version FROM studio_credit_wallets WHERE user_id=?').get(userId) || {balance:0,version:0};
    const holds=store.db.prepare("SELECT coalesce(sum(CASE WHEN state='reserved' THEN amount ELSE 0 END),0) reserved,coalesce(sum(CASE WHEN state='pending' THEN amount ELSE 0 END),0) pending FROM studio_job_credits WHERE user_id=? AND state IN ('reserved','pending')").get(userId);
    return {...row,...holds,available:row.balance-holds.reserved-holds.pending};
  }
  function entry(userId,actorId,requestId,kind,delta,amount,jobId,detail) {
    store.db.prepare('INSERT INTO studio_credit_ledger(user_id,actor,request_id,kind,delta,amount,job_id,detail,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(userId,actorId,requestId,kind,delta,amount,jobId,detail,now());
  }
  function publicCatalog(userId) {
    const data=configuration();
    return {pricingVersion:data.pricingVersion,defaultModelId:data.defaultModelId,creditsEnabled:data.creditsEnabled,
      models:data.models.filter(model=>model.enabled && model.compatible).map(model=>({id:model.id,label:model.label,tier:model.tier,provider:model.provider,workerReady:workerReady(model.provider),
        creditsPerBuild:model.creditsPerBuild,maxBudgetMicros:model.maxBudgetMicros,maxOutputTokens:model.maxOutputTokens,maxCalls:model.maxCalls})),wallet:wallet(userId)};
  }
  function select(body) {
    const data=configuration(), id=body.modelId ?? data.defaultModelId;
    const model=data.models.find(model=>model.id===id && model.enabled && model.compatible);
    insist(model,503,'Choose an enabled coding model. The owner must configure compatible models and current prices first.');
    if (data.configured || data.creditsEnabled || body.modelId !== undefined) {
      insist(body.pricingVersion === data.pricingVersion,409,'Model pricing changed. Reload the model selector and confirm the current price.');
      insist(body.quotedCredits === (data.creditsEnabled ? model.creditsPerBuild : 0),409,'The credit quote changed. Review it before generating.');
    }
    const s=studioSettings(store);
    return {...s,...Object.fromEntries(Object.keys(PROVIDER_DEFAULTS).map(key=>[key,model[key]])),model:model.id,modelLabel:model.label,modelTier:model.tier,
      inputUsdPerMillion:model.inputUsdPerMillion,cachedInputUsdPerMillion:model.cachedInputUsdPerMillion,outputUsdPerMillion:model.outputUsdPerMillion,
      maxOutputTokens:model.maxOutputTokens,maxCalls:model.maxCalls,maxBudgetMicros:model.maxBudgetMicros,timeoutSeconds:model.timeoutSeconds,
      pricingVersion:data.pricingVersion,creditsPerBuild:data.creditsEnabled ? model.creditsPerBuild : 0,creditsEnabled:data.creditsEnabled,
      creditSettlement:'proposal-success-otherwise-review'};
  }
  function reserve(jobId,userId,settings) {
    const amount=settings.creditsEnabled ? settings.creditsPerBuild : 0;
    if (!amount) return;
    insist(wallet(userId).available >= amount,409,'Not enough available Studio credits for this model. Pending reservations cannot be spent twice.');
    store.db.prepare('INSERT INTO studio_job_credits VALUES(?,?,?,?,?)').run(jobId,userId,amount,'reserved',now());
    entry(userId,'system',`reserve:${jobId}`,'reserve',0,amount,jobId,'Reserved for a successful generation proposal.');
  }
  function settle(jobId,next,actorId='system',reason='') {
    insist(['charged','released','pending'].includes(next),400,'Invalid credit settlement.');
    const row=store.db.prepare('SELECT * FROM studio_job_credits WHERE job_id=?').get(jobId);
    if (!row || ['charged','released'].includes(row.state) || row.state===next) return;
    if (next==='charged') {
      insist(store.db.prepare('UPDATE studio_credit_wallets SET balance=balance-?,version=version+1 WHERE user_id=? AND balance>=?').run(row.amount,row.user_id,row.amount).changes,409,'Credit reconciliation is required. No project balance was changed.');
    }
    store.db.prepare('UPDATE studio_job_credits SET state=?,updated_at=? WHERE job_id=? AND state=?').run(next,now(),jobId,row.state);
    entry(row.user_id,actorId,`${next}:${jobId}`,next,next==='charged' ? -row.amount : 0,row.amount,jobId,reason || (next==='pending'?'Awaiting owner review. This hold is not a finalized charge.':next==='released'?'Credit reservation released.':'Successful proposal delivered.'));
  }
  function recover() {
    // Complete any interrupted settlement without replaying provider requests.
    const rows=store.db.prepare("SELECT c.job_id,j.status,j.cost FROM studio_job_credits c JOIN studio_jobs j ON j.id=c.job_id WHERE c.state='reserved' AND j.status NOT IN ('queued','running')").all();
    if (rows.length) store.transaction(()=>{
      for (const row of rows) settle(row.job_id,['review','applied'].includes(row.status)?'charged':row.cost===0?'released':'pending');
    });
  }
  function describe(row) {
    const s=JSON.parse(row.settings), credit=store.db.prepare('SELECT amount,state FROM studio_job_credits WHERE job_id=?').get(row.id);
    return {model:s.model,modelLabel:s.modelLabel || s.model,provider:s.provider||'openai',pricingVersion:s.pricingVersion || null,
      credits:credit || {amount:0,state:'not-used'}};
  }
  function history(userId) {
    return store.db.prepare('SELECT id,kind,delta,amount,job_id AS jobId,detail,created_at AS createdAt FROM studio_credit_ledger WHERE user_id=? ORDER BY id DESC LIMIT 100').all(userId);
  }
  async function route(req,res,url) {
    const path=url.pathname, method=req.method;
    if (!['/api/studio/models','/api/studio/credits','/api/admin/models','/api/admin/credits','/api/admin/credits/pending','/api/admin/credits/resolve'].includes(path)) return false;
    const a=await actor(req,method!=='GET',path.startsWith('/api/admin/')?'settings:manage':null);
    if (path.startsWith('/api/admin/')) insist(a.owner,403,'Only the configured owner can manage model pricing or credits.');
    if (path==='/api/studio/models' && method==='GET') { json(res,200,publicCatalog(a.user.id)); return true; }
    if (path==='/api/studio/credits' && method==='GET') { json(res,200,{wallet:wallet(a.user.id),items:history(a.user.id)}); return true; }
    if (path==='/api/admin/models' && method==='GET') { json(res,200,{...configuration(),presets:VERIFIED_PRESETS}); return true; }
    if (path==='/api/admin/models' && method==='PATCH') {
      const body=await readJson(req,131072); fields(body,['version','models','defaultModelId','creditsEnabled']);
      integer(body.version,1,1000000000,'model catalog revision'); insist(typeof body.creditsEnabled==='boolean',400,'Invalid credit enforcement.');
      insist(Array.isArray(body.models) && body.models.length<=40,400,'At most 40 models can be configured.');
      const models=body.models.map(validateModel), ids=new Set(models.map(model=>model.id));
      insist(ids.size===models.length,400,'Each model identifier can be configured once.');
      insist(body.defaultModelId==='' || models.some(model=>model.id===body.defaultModelId && model.enabled),400,'The default model must be enabled.');
      insist(!models.some(model=>model.enabled) || body.defaultModelId!=='',400,'Choose a default model.');
      const data={configured:true,models,defaultModelId:body.defaultModelId,creditsEnabled:body.creditsEnabled};
      store.transaction(()=>{
        insist(store.db.prepare('UPDATE studio_model_settings SET value=?,version=version+1 WHERE id=1 AND version=?').run(JSON.stringify(data),body.version).changes,409,'Model settings changed. Reload before saving.');
        audit(store,a.user.id,'models.update','catalog');
      }); json(res,200,configuration()); return true;
    }
    if (path==='/api/admin/credits/pending' && method==='GET') {
      const items=store.db.prepare("SELECT c.job_id AS jobId,c.amount,c.updated_at AS updatedAt,u.discord_id AS discordId,u.display_name AS displayName,j.status,j.cost AS providerCostMicros,p.name AS projectName FROM studio_job_credits c JOIN users u ON u.id=c.user_id JOIN studio_jobs j ON j.id=c.job_id JOIN studio_projects p ON p.id=j.project_id WHERE c.state='pending' ORDER BY c.updated_at LIMIT 100").all();
      json(res,200,{items}); return true;
    }
    if (path==='/api/admin/credits/resolve' && method==='POST') {
      const body=await readJson(req); fields(body,['jobId','action','reason']);
      insist(typeof body.jobId==='string' && /^[a-f0-9]{32}$/.test(body.jobId),400,'Invalid build identifier.');
      insist(['charged','released'].includes(body.action),400,'Choose charge or release.'); const reason=string(body.reason,300,'reconciliation reason');
      store.transaction(()=>{
        const row=store.db.prepare('SELECT state FROM studio_job_credits WHERE job_id=?').get(body.jobId);
        insist(row && row.state==='pending',409,'This hold is no longer awaiting review.');
        settle(body.jobId,body.action,a.user.id,reason); audit(store,a.user.id,'credits.resolve',body.jobId,`${body.action}: ${reason}`);
      }); json(res,200,{ok:true}); return true;
    }
    if (path==='/api/admin/credits') {
      const body=method==='POST' ? await readJson(req) : null;
      if (body) fields(body,['discordId','amount','reason','requestId','version']);
      const discordId=body?.discordId || url.searchParams.get('discordId');
      insist(typeof discordId==='string' && /^\d{17,20}$/.test(discordId),400,'Enter the member\'s personal Discord user ID.');
      const user=store.db.prepare('SELECT id,discord_id,display_name FROM users WHERE discord_id=?').get(discordId);
      insist(user,404,'This Discord user has not registered in Studio.');
      if (method==='POST') {
        const amount=integer(body.amount,-1000000,1000000,'credit adjustment'); insist(amount!==0,400,'Enter a non-zero credit adjustment.');
        const reason=string(body.reason,300,'adjustment reason'); insist(uuid(body.requestId),400,'Invalid adjustment request identifier.');
        integer(body.version,0,1000000000,'wallet revision');
        store.transaction(()=>{
          const previous=store.db.prepare('SELECT * FROM studio_credit_ledger WHERE actor=? AND request_id=?').get(a.user.id,body.requestId);
          if (previous) { insist(previous.user_id===user.id && previous.delta===amount && previous.detail===reason,409,'This adjustment identifier was already used.'); return; }
          const w=wallet(user.id); insist(w.version===body.version,409,'This wallet changed. Reload before adjusting credits.');
          insist(w.available+amount>=0 && w.balance+amount<=1000000000,409,'The adjustment would use reserved credits or exceed the wallet limit.');
          store.db.prepare('INSERT OR IGNORE INTO studio_credit_wallets(user_id,balance,version) VALUES(?,0,0)').run(user.id);
          store.db.prepare('UPDATE studio_credit_wallets SET balance=balance+?,version=version+1 WHERE user_id=?').run(amount,user.id);
          entry(user.id,a.user.id,body.requestId,'adjustment',amount,Math.abs(amount),null,reason); audit(store,a.user.id,'credits.adjust',user.id,`${amount}: ${reason}`);
        });
      } else insist(method==='GET',405,'Use GET or POST.');
      json(res,200,{user:{id:user.id,discordId:user.discord_id,displayName:user.display_name},wallet:wallet(user.id),items:history(user.id)}); return true;
    }
    insist(false,405,'Method not supported.');
  }
  return {route,select,reserve,settle,recover,describe,configuration,wallet,publicCatalog};
}
