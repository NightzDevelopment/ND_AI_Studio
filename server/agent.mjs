import { timingSafeEqual } from 'node:crypto';
import { AgentEngine, AGENT_PROTOCOL, TERMINAL } from './agent-domain.mjs';
import { createModels } from './studio-models.mjs';
import { createSubscriptions } from './subscriptions.mjs';
import { StudioError, digest, insist, fields, string, snapshot, zipFiles } from './studio-domain.mjs';

// Mounted before the existing Studio router. No provider keys or host commands
// exist in this API. Existing generation remains available independently.
export function createAgent({store,config,required,mutation,readJson,json}) {
  const workerReady=provider=>{
    const state=store.db.prepare('SELECT * FROM studio_worker WHERE id=1').get();
    const capability=store.db.prepare('SELECT * FROM studio_agent_worker WHERE id=1').get();
    const providers=store.db.prepare('SELECT providers FROM studio_worker_providers WHERE id=1').get();
    return Boolean(state?.ready&&state.checked_at>Date.now()-45000&&capability?.seen_at>Date.now()-45000&&JSON.parse(providers?.providers||'[]').includes(provider));
  };
  // The existing catalog and credit ledger are shared, but no administrative
  // route is duplicated here. Agent holds use the explicit nonterminal status.
  // Reuse the existing subscription accounting without exposing another payment
  // router or issuing Stripe calls from an agent action. Payment routes remain in Studio.
  const subscriptions=createSubscriptions({store,config,actor:()=>{throw new Error('Agent payment routes are not public.');},readJson,json,fetcher:()=>{throw new Error('Agent actions cannot call payment providers.');},canSell:()=>false});
  const models=createModels({store,actor:()=>{throw new Error('Agent catalog routes are not public.');},readJson,json,workerReady,subscriptions});
  const engine=new AgentEngine({store,models,config,jobAllowed:subscriptions.jobAllowed});
  function workerAuth(req){const actual=req.headers.authorization||'',expected=`Bearer ${config.workerToken||''}`;insist(config.workerToken?.length===64&&timingSafeEqual(Buffer.from(digest(actual)),Buffer.from(digest(expected))),401,'Worker authentication required.');}
  function actor(req,write=false){const session=write?mutation(req):required(req);engine.owner(session.user_id);return {session,userId:session.user_id,check(){const current=write?mutation(req,session):required(req);insist(current.hash===session.hash&&current.user_id===session.user_id,401,'Your session changed. Sign in again.');engine.owner(session.user_id);return current;}};}
  async function body(req,a,limit=1048576){const value=await readJson(req,limit);a?.check();return value;}
  const send=(res,data,status=200)=>{json(res,status,data);return true;};
  async function route(req,res,url){
    const path=url.pathname,method=req.method;
    const workerBridge=['/api/worker/heartbeat','/api/worker/claim'].includes(path)&&req.headers['x-nd-studio-agent']===AGENT_PROTOCOL;
    const legacyWrite=/^\/api\/projects\/[a-f0-9-]{36}\/jobs$/.test(path)&&method==='POST';
    if(!workerBridge&&!legacyWrite&&!path.startsWith('/api/agent/'))return false;
    try{
      engine.recover();
      if(legacyWrite){const session=required(req),a={userId:session.user_id};const projectId=path.split('/')[3];if(store.db.prepare("SELECT 1 FROM studio_agent_tasks WHERE project_id=? AND user_id=? AND state NOT IN ('completed','conflict','failed','cancelled')").get(projectId,a.userId))throw new StudioError(409,'Finish or stop the project agent task before starting a separate build.');return false;}
      if(workerBridge){
        workerAuth(req);insist(method==='POST',405,'Use POST.');
        if(path.endsWith('/heartbeat')){store.db.prepare('INSERT INTO studio_agent_worker VALUES(1,?) ON CONFLICT(id) DO UPDATE SET seen_at=excluded.seen_at').run(Date.now());return false;}
        const providers=JSON.parse(store.db.prepare('SELECT providers FROM studio_worker_providers WHERE id=1').get()?.providers||'[]');
        const queued=store.db.prepare("SELECT j.settings FROM studio_agent_tasks t JOIN studio_jobs j ON j.id=t.id WHERE t.state='queued' ORDER BY t.created_at,t.id LIMIT 100").all();
        if(!queued.some(row=>providers.includes(JSON.parse(row.settings).provider||'openai')))return false;
        fields(await body(req),[]);workerAuth(req);
        return send(res,{job:engine.claim(providers)});
      }
      if(path.startsWith('/api/agent/worker/')){
        workerAuth(req);insist(method==='POST',405,'Use POST.');const data=await body(req);workerAuth(req);
        const name=path.slice('/api/agent/worker/'.length);
        if(['next','heartbeat'].includes(name))fields(data,['id','lease']);
        insist(['next','heartbeat','dispatch','step','validation','fail'].includes(name),404,'Agent worker endpoint not found.');
        return send(res,engine[name](data));
      }
      const a=actor(req,method!=='GET');
      if(path==='/api/agent/bootstrap'&&method==='GET')return send(res,{owner:true,protocol:AGENT_PROTOCOL,catalog:models.publicCatalog(a.userId),projects:store.db.prepare('SELECT id,name,target,tool_id,version,archived FROM studio_projects WHERE user_id=? ORDER BY updated_at DESC LIMIT 100').all(a.userId),capabilities:{tools:['list_files','read_file','search_files','write_file','delete_file','validate_project'],interactivePreview:false,imports:false,smartPricing:false,refundPreset:'customer-first',recoveryPreset:'stop-and-refund'}});
      let match=/^\/api\/agent\/projects\/([a-f0-9-]{36})(?:\/(policy|chats|presence))?$/.exec(path);
      if(match){
        const p=engine.source(a.userId,match[1],method!=='GET'),action=match[2];
        if(!action&&method==='GET')return send(res,{project:snapshot(store,p),policy:engine.policy(p.id),chats:store.db.prepare('SELECT id,title,version,created_at FROM studio_agent_chats WHERE project_id=? AND user_id=? ORDER BY created_at').all(p.id,a.userId)});
        if(action==='policy'&&method==='PATCH')return send(res,{policy:engine.savePolicy(a.userId,p.id,await body(req,a))});
        if(action==='presence'&&method==='POST'){const data=await body(req,a);fields(data,['tabId']);engine.presence(a.userId,p.id,a.session,data.tabId);return send(res,{ok:true});}
        if(action==='chats'&&method==='POST'){const data=await body(req,a);fields(data,['title','requestId']);return send(res,{chat:engine.createChat(a.userId,p.id,data.title,data.requestId??null)},201);}
      }
      match=/^\/api\/agent\/chats\/([a-f0-9]{32})(?:\/(messages|tasks))?$/.exec(path);
      if(match){
        const chat=engine.chat(a.userId,match[1]),action=match[2];
        if(!action&&method==='GET')return send(res,engine.view(a.userId,chat.id));
        if(!action&&method==='PATCH'){const data=await body(req,a);fields(data,['title','version']);const title=string(data.title,80,'conversation title');insist(store.db.prepare('UPDATE studio_agent_chats SET title=?,version=version+1 WHERE id=? AND user_id=? AND version=?').run(title,chat.id,a.userId,data.version).changes,409,'Conversation changed. Reload before renaming.');return send(res,{chat:engine.chat(a.userId,chat.id)});}
        if(action==='messages'&&method==='POST')return send(res,engine.message(a.userId,chat.id,await body(req,a)),201);
        if(action==='tasks'&&method==='POST'){
          const data=await body(req,a),previous=store.db.prepare('SELECT 1 FROM studio_jobs WHERE user_id=? AND request_id=?').get(a.userId,typeof data?.requestId==='string'?data.requestId:'');
          if(!previous){const settings=models.select(data,a.userId);insist(workerReady(settings.provider||'openai'),503,'Upgrade and connect the agent worker before starting a paid task.');}
          return send(res,{task:engine.createTask(a.userId,chat.id,a.session,data)},201);
        }
      }
      match=/^\/api\/agent\/tasks\/([a-f0-9]{32})(?:\/(approve|plan|control|files|export))?$/.exec(path);
      if(match){
        const t=engine.task(match[1]);insist(t.user_id===a.userId,404,'Task not found.');engine.source(a.userId,t.project_id);const action=match[2];
        if(!action&&method==='GET')return send(res,{task:engine.publicTask(t)});
        if(action==='approve'&&method==='POST')return send(res,{task:engine.approve(a.userId,t.id,a.session,await body(req,a))});
        if(action==='plan'&&method==='PATCH')return send(res,{task:engine.editPlan(a.userId,t.id,await body(req,a))});
        if(action==='control'&&method==='POST')return send(res,{task:engine.userControl(a.userId,t.id,a.session,await body(req,a))});
        if(action==='files'&&method==='GET')return send(res,{files:JSON.parse(t.files),validated:t.validated_hash===digest(t.files),terminal:TERMINAL.has(t.state)});
        if(action==='export'&&method==='GET'){const zip=zipFiles(JSON.parse(t.files));res.writeHead(200,{'content-type':'application/zip','content-disposition':`attachment; filename="agent-${t.validated_hash===digest(t.files)?'validated':'unvalidated'}-${t.id}.zip"`,'content-length':zip.length});res.end(zip);return true;}
      }
      throw new StudioError(404,'Agent endpoint not found.');
    }catch(error){
      const status=error instanceof StudioError||Number.isInteger(error.status)?error.status:500;
      return send(res,{error:status>=500&&!(error instanceof StudioError)?'Agent service could not complete this operation. Check availability and retry without changing credentials.':error.message},status);
    }
  }
  return {route,engine};
}
