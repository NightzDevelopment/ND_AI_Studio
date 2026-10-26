import { randomBytes } from 'node:crypto';
import { insist, fields, string, integer, digest, filePath, validateFiles, changedFiles, project, snapshot, saveRevision, control, studioSettings, audit } from './studio-domain.mjs';

export const AGENT_PROTOCOL = '1';
export const TERMINAL = new Set(['completed','conflict','failed','cancelled']);
export const ACTIONS = ['list_files','read_file','search_files','write_file','delete_file','validate_project','propose_plan','ask_user','finish'];
const OPERATIONS = ['create','edit','delete','dependencies','migrations'];
const PRESETS = {
  balanced:{create:'automatic',edit:'automatic',delete:'ask',dependencies:'ask',migrations:'ask'},
  strict:{create:'ask',edit:'ask',delete:'ask',dependencies:'ask',migrations:'ask'},
  trusted:{create:'automatic',edit:'automatic',delete:'automatic',dependencies:'automatic',migrations:'automatic'},
};
export const DEFAULT_AGENT_POLICY = Object.freeze({instructions:'',preset:'balanced',permissions:PRESETS.balanced,protectedPaths:[],continuation:'pause',disconnectSeconds:60});
const id = () => randomBytes(16).toString('hex');
const parse = text => JSON.parse(text);
const iso = now => new Date(now).toISOString();
const requestId = value => string(value,64,'request identifier') && insist(/^[a-zA-Z0-9_-]{16,64}$/.test(value),400,'Use a unique request identifier.');
export function protectedPath(path,policy) {
  const value=path.toLowerCase();
  return policy.protectedPaths.some(entry=>entry.endsWith('/**') ? value.startsWith(entry.slice(0,-2).toLowerCase()) : value===entry.toLowerCase());
}
export function policyData(body) {
  fields(body,['instructions','preset','permissions','protectedPaths','continuation','disconnectSeconds','version']);
  const instructions=string(body.instructions,12000,'project instructions',true);
  insist(['balanced','strict','trusted','custom'].includes(body.preset),400,'Choose a permission preset.');
  fields(body.permissions,OPERATIONS);
  insist(OPERATIONS.every(key=>['automatic','ask','prohibited'].includes(body.permissions[key])),400,'Set every source permission.');
  insist(Array.isArray(body.protectedPaths)&&body.protectedPaths.length<=64,400,'At most 64 protected paths are supported.');
  const paths=body.protectedPaths.map(value=>{
    string(value,183,'protected path');
    if(value.endsWith('/**')){
      const prefix=value.slice(0,-3);filePath(`${prefix}/check.txt`);return value;
    }
    return filePath(value);
  });
  insist(new Set(paths.map(value=>value.toLowerCase())).size===paths.length,400,'Remove duplicate protected paths.');
  insist(['pause','finish-current'].includes(body.continuation),400,'Choose pause or finish-current.');
  integer(body.disconnectSeconds,30,300,'disconnect grace period');
  return {instructions,preset:body.preset,permissions:body.preset==='custom'?body.permissions:{...PRESETS[body.preset]},protectedPaths:paths,continuation:body.continuation,disconnectSeconds:body.disconnectSeconds};
}
export function planData(value,policy) {
  fields(value,['goal','steps','changes','capabilities']);
  const goal=string(value.goal,2000,'plan goal');
  insist(Array.isArray(value.steps)&&value.steps.length>0&&value.steps.length<=16,400,'A plan needs 1 to 16 steps.');
  const steps=value.steps.map(step=>string(step,500,'plan step'));
  insist(Array.isArray(value.changes)&&value.changes.length<=64,400,'A plan supports at most 64 file changes.');
  const seen=new Set(),changes=value.changes.map(change=>{
    fields(change,['path','operation']);filePath(change.path);
    insist(['create','edit','delete'].includes(change.operation),400,'Invalid planned file operation.');
    insist(!seen.has(change.path.toLowerCase()),400,'Each file must appear once in the plan.');seen.add(change.path.toLowerCase());
    insist(!protectedPath(change.path,policy),403,`Protected file: ${change.path}`);
    insist(policy.permissions[change.operation]!=='prohibited',403,`Project policy prohibits ${change.operation}.`);
    return {path:change.path,operation:change.operation};
  });
  insist(Array.isArray(value.capabilities)&&value.capabilities.length<=5&&value.capabilities.every(cap=>OPERATIONS.includes(cap)),400,'Invalid plan capabilities.');
  const capabilities=[...new Set([...value.capabilities,...changes.map(change=>change.operation),...changes.filter(change=>/\.sql$/i.test(change.path)).map(()=>'migrations'),...changes.filter(change=>/(?:^|\/)package(?:-lock)?\.json$/i.test(change.path)).map(()=>'dependencies')])].sort();
  insist(capabilities.every(cap=>policy.permissions[cap]!=='prohibited'),403,'A planned capability is prohibited by project policy.');
  return {goal,steps,changes,capabilities};
}
export function actionData(value) {
  fields(value,['type','message','path','query','content','plan']);
  insist(ACTIONS.includes(value.type),400,'Unknown agent tool.');
  const message=string(value.message,2000,'action summary',true);
  const path=value.path===null?null:filePath(value.path);
  const query=value.query===null?null:string(value.query,200,'search query');
  insist(value.content===null||typeof value.content==='string'&&!value.content.includes('\0')&&Buffer.byteLength(value.content)<=65536,400,'Invalid tool content.');
  insist(value.plan===null||typeof value.plan==='object'&&!Array.isArray(value.plan),400,'Invalid plan result.');
  if(['read_file','write_file','delete_file'].includes(value.type))insist(path!==null,400,'This tool needs a path.');
  if(value.type==='write_file')insist(typeof value.content==='string',400,'Write the complete file content.');
  if(value.type==='search_files')insist(query!==null,400,'This tool needs a query.');
  if(value.type==='propose_plan')insist(value.plan!==null,400,'This tool needs a plan.');
  return {type:value.type,message,path,query,content:value.content,plan:value.plan};
}

export function migrateAgents(store) {
  store.transaction(()=>store.db.exec(`
    CREATE TABLE IF NOT EXISTS studio_agent_projects(project_id TEXT PRIMARY KEY REFERENCES studio_projects(id),value TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1) STRICT;
    CREATE TABLE IF NOT EXISTS studio_agent_chats(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES studio_projects(id),user_id TEXT NOT NULL REFERENCES users(id),title TEXT NOT NULL,created_at TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1) STRICT;
    CREATE TABLE IF NOT EXISTS studio_agent_chat_requests(user_id TEXT NOT NULL REFERENCES users(id),request_id TEXT NOT NULL,project_id TEXT NOT NULL,title TEXT NOT NULL,chat_id TEXT NOT NULL REFERENCES studio_agent_chats(id),PRIMARY KEY(user_id,request_id)) STRICT;
    CREATE INDEX IF NOT EXISTS studio_agent_chats_owner ON studio_agent_chats(user_id,project_id);
    CREATE TABLE IF NOT EXISTS studio_agent_messages(id INTEGER PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES studio_agent_chats(id),user_id TEXT NOT NULL REFERENCES users(id),role TEXT NOT NULL,text TEXT NOT NULL,request_id TEXT,created_at TEXT NOT NULL,UNIQUE(chat_id,request_id)) STRICT;
    CREATE TABLE IF NOT EXISTS studio_agent_tasks(id TEXT PRIMARY KEY REFERENCES studio_jobs(id),chat_id TEXT NOT NULL REFERENCES studio_agent_chats(id),project_id TEXT NOT NULL REFERENCES studio_projects(id),user_id TEXT NOT NULL REFERENCES users(id),session_hash TEXT NOT NULL,request_hash TEXT NOT NULL,mode TEXT NOT NULL,phase TEXT NOT NULL,state TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,policy TEXT NOT NULL,policy_version INTEGER NOT NULL,plan TEXT,plan_version INTEGER NOT NULL DEFAULT 0,approved_hash TEXT,files TEXT NOT NULL,history TEXT NOT NULL DEFAULT '[]',steps INTEGER NOT NULL DEFAULT 0,max_steps INTEGER NOT NULL,spent INTEGER NOT NULL DEFAULT 0,unreconciled INTEGER NOT NULL DEFAULT 0,lease TEXT,lease_until INTEGER,control TEXT NOT NULL DEFAULT '',redirect TEXT NOT NULL DEFAULT '',validated_hash TEXT,checks TEXT NOT NULL DEFAULT '[]',applied_version INTEGER,undo_version INTEGER,created_at TEXT NOT NULL,updated_at TEXT NOT NULL) STRICT;
    CREATE INDEX IF NOT EXISTS studio_agent_queue ON studio_agent_tasks(state,created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS studio_agent_one_writer ON studio_agent_tasks(project_id) WHERE state='running';
    CREATE TABLE IF NOT EXISTS studio_agent_presence(project_id TEXT NOT NULL REFERENCES studio_projects(id),session_hash TEXT NOT NULL,tab_id TEXT NOT NULL,seen_at INTEGER NOT NULL,PRIMARY KEY(project_id,session_hash,tab_id)) STRICT;
    CREATE TABLE IF NOT EXISTS studio_agent_steps(task_id TEXT NOT NULL REFERENCES studio_agent_tasks(id),step INTEGER NOT NULL,call_id TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,lease TEXT NOT NULL,estimate INTEGER NOT NULL,state TEXT NOT NULL,result_hash TEXT,response TEXT,usage TEXT,cost INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(task_id,step)) STRICT;
    CREATE TABLE IF NOT EXISTS studio_agent_receipts(task_id TEXT NOT NULL REFERENCES studio_agent_tasks(id),request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,response TEXT NOT NULL,PRIMARY KEY(task_id,request_id)) STRICT;
    CREATE TABLE IF NOT EXISTS studio_agent_worker(id INTEGER PRIMARY KEY CHECK(id=1),seen_at INTEGER NOT NULL) STRICT;
  `));
}

export class AgentEngine {
  constructor({store,models,config,now=Date.now,jobAllowed=()=>true}){this.store=store;this.db=store.db;this.models=models;this.config=config;this.now=now;this.jobAllowed=jobAllowed;migrateAgents(store);}
  stamp(){return iso(this.now());}
  policy(projectId){const row=this.db.prepare('SELECT * FROM studio_agent_projects WHERE project_id=?').get(projectId);return row?{...parse(row.value),version:row.version}:{...DEFAULT_AGENT_POLICY,permissions:{...PRESETS.balanced},protectedPaths:[],version:0};}
  owner(userId){const user=this.store.user(userId);insist(user&&(this.config.ownerIds||[]).includes(user.discord_id),403,'Live agent is currently owner-only.');insist(control(this.store,userId).status!=='suspended',403,'Studio access is suspended.');return user;}
  source(userId,projectId,write=false){this.owner(userId);const p=project(this.store,userId,projectId);if(write)insist(!p.archived,409,'Unarchive this project first.');return p;}
  chat(userId,chatId){this.owner(userId);const row=this.db.prepare('SELECT * FROM studio_agent_chats WHERE id=? AND user_id=?').get(chatId,userId);insist(row,404,'Conversation not found.');this.source(userId,row.project_id);return row;}
  task(taskId){const task=this.db.prepare('SELECT * FROM studio_agent_tasks WHERE id=?').get(taskId);insist(task,404,'Agent task not found.');return task;}
  job(task){return this.db.prepare('SELECT * FROM studio_jobs WHERE id=?').get(task.id);}
  publicTask(task,details=true){const job=this.job(task);return {id:task.id,requestId:job.request_id,chatId:task.chat_id,projectId:task.project_id,mode:task.mode,phase:task.phase,state:task.state,version:task.version,plan:task.plan?parse(task.plan):null,planVersion:task.plan_version,planHash:task.plan?digest(task.plan):null,baseVersion:job.base_version,policyVersion:task.policy_version,steps:task.steps,maxSteps:task.max_steps,spentMicros:task.spent,reservedMicros:job.reserve,unreconciled:Boolean(task.unreconciled),appliedVersion:task.applied_version,undoVersion:task.undo_version,continuation:parse(task.policy).continuation,control:task.control,working:Boolean(this.db.prepare("SELECT 1 FROM studio_agent_steps WHERE task_id=? AND state='dispatched'").get(task.id)),model:parse(job.settings).model,provider:parse(job.settings).provider||'openai',billingMode:parse(job.settings).subscriptionBilling?'metered':'fixed',credits:this.models.describe(job).credits,checks:parse(task.checks),history:details?parse(task.history).map(({type,message,path,at,ok,error})=>({type,message,path,at,ok,error})):[],error:job.result?parse(job.result).error||null:null,createdAt:task.created_at,updatedAt:task.updated_at};}
  view(userId,chatId){const chat=this.chat(userId,chatId);return {chat,messages:this.db.prepare('SELECT id,role,text,created_at AS createdAt FROM studio_agent_messages WHERE chat_id=? ORDER BY id DESC LIMIT 100').all(chatId).reverse(),tasks:this.db.prepare('SELECT * FROM studio_agent_tasks WHERE chat_id=? ORDER BY created_at DESC LIMIT 50').all(chatId).map(task=>this.publicTask(task,false))};}
  note(task,role,text,request=null){if(role.startsWith('user'))insist(this.db.prepare('SELECT coalesce(sum(length(CAST(text AS BLOB))),0) n FROM studio_agent_messages WHERE user_id=?').get(task.user_id).n+Buffer.byteLength(text)<=8388608,409,'Account conversation storage reached 8 MiB. Export important conversations before requesting more storage.');this.db.prepare('INSERT INTO studio_agent_messages(chat_id,user_id,role,text,request_id,created_at) VALUES(?,?,?,?,?,?)').run(task.chat_id,task.user_id,role,text.slice(0,12000),request,this.stamp());}
  savePolicy(userId,projectId,body){this.source(userId,projectId,true);const data=policyData(body);integer(body.version,0,1e9,'instruction revision');return this.store.transaction(()=>{const current=this.policy(projectId);insist(current.version===body.version,409,'Project instructions changed. Reload before saving.');this.db.prepare('INSERT INTO studio_agent_projects VALUES(?,?,1) ON CONFLICT(project_id) DO UPDATE SET value=excluded.value,version=studio_agent_projects.version+1').run(projectId,JSON.stringify(data));audit(this.store,userId,'agent.policy.update',projectId,`Preset ${data.preset}; revision ${current.version+1}`);return this.policy(projectId);});}
  createChat(userId,projectId,title,request=null){this.source(userId,projectId,true);title=string(title,80,'conversation title');if(request!==null)requestId(request);return this.store.transaction(()=>{
    if(request){const prior=this.db.prepare('SELECT * FROM studio_agent_chat_requests WHERE user_id=? AND request_id=?').get(userId,request);if(prior){insist(prior.project_id===projectId&&prior.title===title,409,'This conversation identifier belongs to a different request.');return this.chat(userId,prior.chat_id);}}
    insist(this.db.prepare('SELECT count(*) n FROM studio_agent_chats WHERE project_id=?').get(projectId).n<50,409,'Project reached its 50-conversation limit.');const chatId=id();this.db.prepare('INSERT INTO studio_agent_chats(id,project_id,user_id,title,created_at) VALUES(?,?,?,?,?)').run(chatId,projectId,userId,title,this.stamp());if(request)this.db.prepare('INSERT INTO studio_agent_chat_requests VALUES(?,?,?,?,?)').run(userId,request,projectId,title,chatId);return this.chat(userId,chatId);
  });}
  presence(userId,projectId,session,tabId){this.source(userId,projectId);requestId(tabId);this.db.prepare('DELETE FROM studio_agent_presence WHERE seen_at<?').run(this.now()-600000);insist(this.db.prepare('SELECT count(*) n FROM studio_agent_presence WHERE project_id=?').get(projectId).n<64||this.db.prepare('SELECT 1 FROM studio_agent_presence WHERE project_id=? AND session_hash=? AND tab_id=?').get(projectId,session.hash,tabId),429,'Too many active project tabs.');this.db.prepare('INSERT INTO studio_agent_presence VALUES(?,?,?,?) ON CONFLICT(project_id,session_hash,tab_id) DO UPDATE SET seen_at=excluded.seen_at').run(projectId,session.hash,tabId,this.now());}
  present(task){const policy=parse(task.policy);if(policy.continuation==='finish-current')return true;return Boolean(this.db.prepare('SELECT 1 FROM studio_agent_presence p JOIN sessions s ON s.hash=p.session_hash WHERE p.project_id=? AND s.user_id=? AND s.expires_at>? AND p.seen_at>? LIMIT 1').get(task.project_id,task.user_id,this.now(),this.now()-policy.disconnectSeconds*1000));}
  authorized(task){const p=this.source(task.user_id,task.project_id,true),session=this.store.session(task.session_hash);insist(session?.user_id===task.user_id,409,'The authorizing session ended. Resume after signing in.');insist(this.policy(task.project_id).version===task.policy_version,409,'Project instructions or permissions changed. Start a revised plan.');insist(['owner','members'].includes(studioSettings(this.store).tools[p.tool_id]),409,'The generator was disabled.');insist(this.jobAllowed(task.id),409,'The task allowance was revoked.');const captured=parse(this.job(task).settings);insist(this.models.configuration().models.some(model=>model.id===captured.model&&(model.provider||'openai')===(captured.provider||'openai')&&model.enabled&&model.compatible),409,'The approved model was disabled. Stop or resume after restoring access.');return p;}
  createTask(userId,chatId,session,body){
    fields(body,['requestId','message','mode','modelId','pricingVersion','quotedCredits','maxSteps','continuation','projectVersion']);requestId(body.requestId);
    const chat=this.chat(userId,chatId),p=this.source(userId,chat.project_id,true),message=string(body.message,12000,'task request');
    insist(['ask','build','debug'].includes(body.mode),400,'Choose Ask, Build or Debug.');integer(body.maxSteps,4,24,'maximum agent calls');
    insist(['pause','finish-current'].includes(body.continuation),400,'Invalid continuation policy.');integer(body.projectVersion,1,1e9,'source revision');
    const fingerprint=digest(JSON.stringify({chatId,...body}));
    return this.store.transaction(()=>{
      const previous=this.db.prepare('SELECT t.* FROM studio_agent_tasks t JOIN studio_jobs j ON j.id=t.id WHERE j.user_id=? AND j.request_id=?').get(userId,body.requestId);
      if(previous){insist(previous.request_hash===fingerprint,409,'This task identifier belongs to a different request.');return this.publicTask(previous);}
      insist(!this.db.prepare('SELECT 1 FROM studio_jobs WHERE user_id=? AND request_id=?').get(userId,body.requestId),409,'This request identifier already belongs to another build.');
      insist(p.version===body.projectVersion,409,'Source changed. Review the current project before planning.');
      insist(['owner','members'].includes(studioSettings(this.store).tools[p.tool_id]),403,'Enable this coding tool for owner testing first.');
      insist(this.db.prepare('SELECT count(*) n FROM studio_agent_tasks WHERE project_id=?').get(p.id).n<100,409,'Project reached its 100-task limit.');
      insist(!this.db.prepare("SELECT 1 FROM studio_jobs WHERE project_id=? AND status IN ('queued','running','agent')").get(p.id),409,'Finish or stop the active project task first. Queued messages remain in the conversation.');
      insist(this.db.prepare("SELECT count(*) n FROM studio_jobs WHERE status IN ('queued','running','agent')").get().n<20,503,'The build queue is full.');
      const settings=this.models.select(body,userId);settings.agentProtocol=AGENT_PROTOCOL;
      const limits=control(this.store,userId),usage=this.db.prepare("SELECT count(*) n,coalesce(sum(CASE WHEN status IN ('queued','running') THEN reserve ELSE cost END),0) cost FROM studio_jobs WHERE user_id=? AND created_at>=?").get(userId,this.stamp().slice(0,10));
      insist(usage.n<limits.daily_limit&&usage.cost+settings.maxBudgetMicros<=limits.daily_budget,429,'Daily task or provider-spending limit reached.');
      const policy={...this.policy(p.id),continuation:body.continuation};delete policy.version;
      const taskId=id(),stamp=this.stamp(),source=snapshot(this.store,p);
      this.db.prepare("INSERT INTO studio_jobs(id,user_id,project_id,request_id,base_version,prompt,settings,status,cost,reserve,created_at,updated_at,application_mode) VALUES(?,?,?,?,?,?,?,'agent',?,?,?,?, 'automatic')").run(taskId,userId,p.id,body.requestId,p.version,message,JSON.stringify(settings),settings.maxBudgetMicros,settings.maxBudgetMicros,stamp,stamp);
      this.db.prepare("INSERT INTO studio_agent_tasks(id,chat_id,project_id,user_id,session_hash,request_hash,mode,phase,state,policy,policy_version,files,max_steps,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'queued',?,?,?,?,?,?)").run(taskId,chatId,p.id,userId,session.hash,fingerprint,body.mode,body.mode==='ask'?'ask':'plan',JSON.stringify(policy),this.policy(p.id).version,JSON.stringify(source.files),body.maxSteps,stamp,stamp);
      this.models.reserve(taskId,userId,settings);const task=this.task(taskId);this.note(task,'user',message,`task:${body.requestId}`);this.note(task,'system',`Task queued for ${body.mode==='ask'?'read-only assistance':'read-only planning'}. Source edits require plan approval. The selected model and task allowance are fixed.`);return this.publicTask(task);
    });
  }
  changeState(task,state,controlValue=''){this.db.prepare('UPDATE studio_agent_tasks SET state=?,control=?,version=version+1,updated_at=? WHERE id=?').run(state,controlValue,this.stamp(),task.id);}
  receipt(taskId,request,fingerprint,action){const previous=this.db.prepare('SELECT * FROM studio_agent_receipts WHERE task_id=? AND request_id=?').get(taskId,request);if(previous){insist(previous.fingerprint===fingerprint,409,'This operation identifier was already used.');return parse(previous.response);}const result=action();this.db.prepare('INSERT INTO studio_agent_receipts VALUES(?,?,?,?)').run(taskId,request,fingerprint,JSON.stringify(result));return result;}
  approve(userId,taskId,session,body){insist(this.task(taskId).user_id===userId,404,'Task not found.');this.owner(userId);fields(body,['version','planVersion','planHash','requestId']);requestId(body.requestId);return this.store.transaction(()=>this.receipt(taskId,body.requestId,digest(JSON.stringify(body)),()=>{const t=this.task(taskId);insist(t.user_id===userId,404,'Task not found.');this.authorized({...t,session_hash:session.hash});const p=this.source(userId,t.project_id,true),j=this.job(t);insist(t.version===body.version&&t.plan_version===body.planVersion&&t.plan&&digest(t.plan)===body.planHash,409,'The plan changed. Review the current plan.');insist(t.state==='awaiting_approval'&&p.version===j.base_version,409,'Source or task changed. Prepare a new plan against the current source.');const plan=planData(parse(t.plan),parse(t.policy));const basePaths=new Set(snapshot(this.store,p,j.base_version).files.map(file=>file.path));for(const change of plan.changes)insist(change.operation==='create'?!basePaths.has(change.path):basePaths.has(change.path),409,'Planned operations must match the original source snapshot.');this.planCovers(t,plan);insist(digest(JSON.stringify(plan))===body.planHash,409,'Plan approval no longer matches.');this.db.prepare("UPDATE studio_agent_tasks SET approved_hash=?,phase='build',state='queued',session_hash=?,version=version+1,updated_at=? WHERE id=?").run(body.planHash,session.hash,this.stamp(),t.id);audit(this.store,userId,'agent.plan.approve',t.id,`Plan revision ${t.plan_version}; ${body.planHash}`);this.note(t,'system','Plan approved. The agent may perform only the listed source changes under the captured permissions and allowance.');return this.publicTask(this.task(t.id));}));}
  editPlan(userId,taskId,body){fields(body,['version','plan']);return this.store.transaction(()=>{const t=this.task(taskId);insist(t.user_id===userId,404,'Task not found.');this.source(userId,t.project_id,true);insist(t.state==='awaiting_approval'&&t.version===body.version,409,'This plan is not editable or changed.');const plan=planData(body.plan,parse(t.policy));this.db.prepare('UPDATE studio_agent_tasks SET plan=?,plan_version=plan_version+1,approved_hash=NULL,version=version+1,updated_at=? WHERE id=?').run(JSON.stringify(plan),this.stamp(),t.id);return this.publicTask(this.task(t.id));});}
  userControl(userId,taskId,session,body){insist(this.task(taskId).user_id===userId,404,'Task not found.');this.owner(userId);fields(body,['action','version','requestId']);requestId(body.requestId);insist(['pause','resume','stop','undo'].includes(body.action),400,'Invalid task control.');return this.store.transaction(()=>this.receipt(taskId,body.requestId,digest(JSON.stringify(body)),()=>{
    const t=this.task(taskId);insist(t.user_id===userId,404,'Task not found.');this.source(userId,t.project_id,body.action!=='stop');insist(t.version===body.version,409,'Task state changed. Refresh and retry.');
    if(body.action==='undo'){
      insist(t.state==='completed'&&t.applied_version,409,'Only a source-writing completed task can be undone.');
      if(!t.undo_version){const p=this.source(userId,t.project_id,true);insist(p.version===t.applied_version,409,'Newer source exists. Compare revisions instead of overwriting it.');const saved=saveRevision(this.store,p,snapshot(this.store,p,this.job(t).base_version).files,`Undo agent task ${t.id}`,userId,p.version);this.db.prepare('UPDATE studio_agent_tasks SET undo_version=?,version=version+1,updated_at=? WHERE id=?').run(saved.version,this.stamp(),t.id);this.note(t,'system',`Task undone as revision ${saved.version}. The previous source remains in history.`);}
    } else {
      insist(!TERMINAL.has(t.state),409,'This task has ended.');
      if(body.action==='resume'){
        insist(['paused','awaiting_input'].includes(t.state)&&!t.unreconciled,409,'This task cannot resume until its blocker is resolved.');this.authorized({...t,session_hash:session.hash});
        const nextPhase=t.redirect?'plan':t.phase;
        this.db.prepare("UPDATE studio_agent_tasks SET state='queued',phase=?,session_hash=?,control='',lease=NULL,lease_until=NULL,approved_hash=CASE WHEN redirect<>'' THEN NULL ELSE approved_hash END,plan=CASE WHEN redirect<>'' THEN NULL ELSE plan END,version=version+1,updated_at=? WHERE id=?").run(nextPhase,session.hash,this.stamp(),t.id);
      }else if(t.state==='running')this.changeState(t,'running',body.action);
      else if(body.action==='stop')this.finish(t,'cancelled','Task stopped. Reserved Studio credits were returned.',null,'cancelled');
      else this.changeState(t,'paused');
    }
    audit(this.store,userId,`agent.task.${body.action}`,t.id);return this.publicTask(this.task(t.id));
  }));}
  message(userId,chatId,body){fields(body,['text','mode','requestId']);requestId(body.requestId);insist(['queue','pause','redirect'].includes(body.mode),400,'Choose queue, pause or redirect.');const chat=this.chat(userId,chatId),text=string(body.text,12000,'message');return this.store.transaction(()=>{const previous=this.db.prepare('SELECT text,role FROM studio_agent_messages WHERE chat_id=? AND request_id=?').get(chatId,body.requestId);if(previous){insist(previous.text===text&&previous.role===`user-${body.mode}`,409,'Message request identifier already used.');return {ok:true};}insist(this.db.prepare('SELECT count(*) n FROM studio_agent_messages WHERE chat_id=?').get(chatId).n<1000,409,'Conversation message limit reached.');this.note({chat_id:chatId,user_id:userId},`user-${body.mode}`,text,body.requestId);const t=this.db.prepare("SELECT * FROM studio_agent_tasks WHERE project_id=? AND state NOT IN ('completed','conflict','failed','cancelled') ORDER BY created_at DESC LIMIT 1").get(chat.project_id);if(t&&body.mode!=='queue'){
      insist(t.chat_id===chatId,409,'Open the active task conversation before pausing or redirecting it.');
      // A redirect is user input, never a permission grant. Replanning needs approval.
      if(body.mode==='redirect')this.db.prepare('UPDATE studio_agent_tasks SET redirect=? WHERE id=?').run(text,t.id);
      this.changeState(t,t.state==='running'?'running':'paused',t.state==='running'?'pause':'');
    }return {ok:true};});}
  finish(task,state,message,cost=null,reason='failure'){
    if(TERMINAL.has(task.state))return;
    const job=this.job(task),spent=cost===null?task.spent:Math.max(task.spent,cost);
    this.db.prepare('UPDATE studio_agent_tasks SET state=?,spent=?,lease=NULL,lease_until=NULL,control=\'\',version=version+1,updated_at=? WHERE id=?').run(state,spent,this.stamp(),task.id);
    this.db.prepare('UPDATE studio_jobs SET status=?,cost=?,result=?,updated_at=? WHERE id=?').run(state==='completed'?'applied':state==='conflict'?'review':state,spent,JSON.stringify({error:message,reason,...(task.unreconciled?{accounting:{status:'unreconciled',reason:'agent-usage-unreconciled'}}:{})}),this.stamp(),task.id);
    // Preserve the captured catalog billing mode: fixed task credits or the
    // existing metered subscription allowance. Failures release customer holds;
    // provider expenditure is recorded separately and never becomes a retry.
    this.models.settle(task.id,['completed','conflict'].includes(state)?'charged':'released','system',message);
    this.note(task,'system',message);
  }
  recover(){
    const rows=this.db.prepare("SELECT * FROM studio_agent_tasks WHERE state='running' AND lease_until<?").all(this.now());
    for(const t of rows)this.store.transaction(()=>{const current=this.task(t.id);if(current.state!=='running'||current.lease_until>=this.now())return;const pending=this.db.prepare("SELECT 1 FROM studio_agent_steps WHERE task_id=? AND state='dispatched'").get(t.id);if(pending){this.db.prepare('UPDATE studio_agent_tasks SET unreconciled=1 WHERE id=?').run(t.id);current.unreconciled=1;}this.finish(current,'failed',pending?'Worker stopped during a provider request. No request was replayed. Studio credits were returned; provider cost remains unreconciled.':'Worker stopped. Studio credits were returned. No paid step was replayed.',pending?this.job(t).reserve:null,'worker');});
  }
  claim(providers=['openai','deepseek']){this.recover();return this.store.transaction(()=>{const rows=this.db.prepare("SELECT * FROM studio_agent_tasks WHERE state='queued' ORDER BY created_at,id LIMIT 100").all();for(const t of rows){
    if(!providers.includes(parse(this.job(t).settings).provider||'openai'))continue;
    if(this.db.prepare("SELECT 1 FROM studio_agent_tasks WHERE project_id=? AND state='running'").get(t.project_id))continue;
    try{this.authorized(t);}catch{this.changeState(t,'paused');continue;}
    if(!this.present(t)){this.changeState(t,'paused');continue;}
    const lease=randomBytes(32).toString('base64url');this.db.prepare("UPDATE studio_agent_tasks SET state='running',lease=?,lease_until=?,version=version+1,updated_at=? WHERE id=?").run(digest(lease),this.now()+120000,this.stamp(),t.id);
    return {id:t.id,lease,agent:true,settings:parse(this.job(t).settings),project:{tool_id:this.source(t.user_id,t.project_id).tool_id}};
  }return null;});}
  workerTask(body,allowTerminal=false){const t=this.task(body.id);insist(typeof body.lease==='string'&&t.lease===digest(body.lease)&&t.lease_until>this.now()&&(allowTerminal||t.state==='running'),409,'Agent lease expired or ended.');return t;}
  context(task){const p=this.source(task.user_id,task.project_id),j=this.job(task),policy=parse(task.policy),files=parse(task.files),history=parse(task.history);return {id:task.id,phase:task.phase,request:j.prompt,redirect:task.redirect,instructions:policy.instructions,permissions:policy.permissions,protectedPaths:policy.protectedPaths,plan:task.plan?parse(task.plan):null,project:{name:p.name,target:p.target,tool:p.tool_id,requirements:p.requirements},files:files.filter(file=>!protectedPath(file.path,policy)).map(file=>({path:file.path,bytes:Buffer.byteLength(file.content)})),baseFiles:snapshot(this.store,p,j.base_version).files.filter(file=>!protectedPath(file.path,policy)).map(file=>file.path),conversation:this.db.prepare("SELECT role,text FROM studio_agent_messages WHERE chat_id=? AND (role<>'user-queue' OR id<coalesce((SELECT id FROM studio_agent_messages WHERE chat_id=? AND request_id=?),0)) ORDER BY id DESC LIMIT 20").all(task.chat_id,task.chat_id,`task:${j.request_id}`).reverse().map(message=>({role:message.role,text:message.text.slice(0,2000)})),history:history.slice(-24),steps:task.steps,maxSteps:task.max_steps,spentMicros:task.spent,budgetMicros:j.reserve,settings:parse(j.settings)};}
  checkpointStop(t){
    if(t.control==='stop'){this.finish(t,'cancelled','Task stopped. Studio credits were returned. Provider usage already incurred remains recorded.');return true;}
    let valid=true;try{this.authorized(t);}catch{valid=false;}
    if(!valid||t.control==='pause'||!this.present(t)||t.unreconciled){this.changeState(t,'paused');this.db.prepare('UPDATE studio_agent_tasks SET lease=NULL,lease_until=NULL WHERE id=?').run(t.id);return true;}
    return false;
  }
  heartbeat(body){return this.store.transaction(()=>{const t=this.workerTask(body);this.db.prepare('UPDATE studio_agent_tasks SET lease_until=? WHERE id=?').run(this.now()+120000,t.id);return {ok:true,control:t.control};});}
  next(body){return this.store.transaction(()=>{const t=this.workerTask(body);if(this.checkpointStop(t))return {stopped:true};if(t.steps>=t.max_steps){this.finish(t,'failed','The approved model-call limit was reached. Staged work was preserved and Studio credits returned.');return {stopped:true};}return {stopped:false,context:this.context(t)};});}
  dispatch(body){fields(body,['id','lease','index','requestHash','estimateMicros']);integer(body.index,0,23,'agent call number');integer(body.estimateMicros,0,1e9,'request estimate');insist(typeof body.requestHash==='string'&&/^[a-f0-9]{64}$/.test(body.requestHash),400,'Invalid request fingerprint.');return this.store.transaction(()=>{const t=this.workerTask(body);if(this.checkpointStop(t))return {allowed:false,reason:'paused'};const old=this.db.prepare('SELECT * FROM studio_agent_steps WHERE task_id=? AND step=?').get(t.id,body.index);if(old){insist(old.request_hash===body.requestHash&&old.estimate===body.estimateMicros,409,'The call was already recorded with different data.');return {allowed:false,reason:'already-recorded'};}insist(body.index===t.steps&&t.steps<t.max_steps,409,'The agent step changed.');insist(t.spent+body.estimateMicros<=this.job(t).reserve,409,'The next call does not fit the approved task budget.');const callId=id();this.db.prepare("INSERT INTO studio_agent_steps(task_id,step,call_id,request_hash,lease,estimate,state) VALUES(?,?,?,?,?,?,'dispatched')").run(t.id,t.steps,callId,body.requestHash,t.lease,body.estimateMicros);return {allowed:true,callId};});}
  addHistory(task,item){const history=parse(task.history);history.push({...item,at:this.stamp()});let raw=JSON.stringify(history);while(Buffer.byteLength(raw)>524288&&history.length>1){history.shift();raw=JSON.stringify(history);}insist(Buffer.byteLength(raw)<=524288,413,'Agent context is too large.');this.db.prepare('UPDATE studio_agent_tasks SET history=?,updated_at=? WHERE id=?').run(raw,this.stamp(),task.id);}
  planCovers(task,plan){
    const p=this.source(task.user_id,task.project_id),base=snapshot(this.store,p,this.job(task).base_version).files;
    const before=new Map(base.map(file=>[file.path,file.content])),after=new Map(parse(task.files).map(file=>[file.path,file.content]));
    for(const path of new Set([...before.keys(),...after.keys()])){
      if(before.get(path)===after.get(path))continue;
      const operation=!after.has(path)?'delete':before.has(path)?'edit':'create';
      insist(plan.changes.some(change=>change.path===path&&change.operation===operation),403,'The plan must cover all staged changes, including work from before a redirect.');
    }
  }
  execute(task,action){
    const policy=parse(task.policy),files=parse(task.files),entry=files.find(file=>file.path===action.path);
    const result={type:action.type,message:action.message,path:action.path,ok:true};
    if(action.path)insist(!protectedPath(action.path,policy),403,'The requested path is protected.');
    if(action.type==='list_files')result.output=files.filter(file=>!protectedPath(file.path,policy)).map(file=>file.path);
    else if(action.type==='read_file'){insist(entry,404,'File not found.');result.output={path:entry.path,content:entry.content};}
    else if(action.type==='search_files'){
      const matches=[];for(const file of files){if(protectedPath(file.path,policy))continue;const lines=file.content.split('\n');for(let n=0;n<lines.length&&matches.length<40;n++)if(lines[n].toLowerCase().includes(action.query.toLowerCase()))matches.push({path:file.path,line:n+1,text:lines[n].slice(0,1000)});}result.output=matches;
    }else if(action.type==='propose_plan'){
      insist(task.phase==='plan',409,'Plans are proposed only during planning.');const plan=planData(action.plan,policy);
      this.db.prepare("UPDATE studio_agent_tasks SET plan=?,plan_version=plan_version+1,state='awaiting_approval',approved_hash=NULL,control='',lease=NULL,lease_until=NULL,redirect='',version=version+1 WHERE id=?").run(JSON.stringify(plan),task.id);this.note(task,'assistant',action.message||plan.goal);result.output=plan;
    }else if(action.type==='ask_user'){
      this.changeState(task,'awaiting_input');this.db.prepare('UPDATE studio_agent_tasks SET lease=NULL,lease_until=NULL WHERE id=?').run(task.id);this.note(task,'assistant',action.message);result.output='Waiting for a user message and explicit Resume.';
    }else if(['write_file','delete_file'].includes(action.type)){
      insist(task.phase==='build'&&task.plan&&task.approved_hash===digest(task.plan),403,'Source changes require an approved plan.');const plan=parse(task.plan),operation=action.type==='delete_file'?'delete':entry?'edit':'create';
      // A created file may subsequently be edited as part of the same approved change.
      insist(plan.changes.some(change=>change.path===action.path&&(change.operation===operation||operation==='edit'&&change.operation==='create')),403,'This file operation is outside the approved plan. Pause and request a revised plan.');
      insist(policy.permissions[operation]!=='prohibited',403,'The operation is prohibited.');
      if(/\.sql$/i.test(action.path))insist(plan.capabilities.includes('migrations')&&policy.permissions.migrations!=='prohibited',403,'Database source changes need explicit plan authorization.');
      if(/(?:^|\/)package(?:-lock)?\.json$/i.test(action.path))insist(plan.capabilities.includes('dependencies')&&policy.permissions.dependencies!=='prohibited',403,'Package changes need explicit plan authorization.');
      if(action.type==='write_file'&&entry)insist(parse(task.history).some(item=>item.type==='read_file'&&item.output?.path===entry.path&&item.output.content===entry.content),409,'Read the current staged file before editing it.');
      if(action.type==='delete_file')insist(entry,404,'File not found.');
      const next=changedFiles(files,[{path:action.path,content:action.type==='delete_file'?null:action.content}]);
      this.db.prepare('UPDATE studio_agent_tasks SET files=?,validated_hash=NULL,checks=\'[]\' WHERE id=?').run(JSON.stringify(next),task.id);result.output={path:action.path,operation,staged:true};
    }else if(action.type==='validate_project'){
      insist(task.phase==='build'&&task.approved_hash===digest(task.plan||''),403,'Validation requires an approved build plan.');result.output='Run the isolated validator on the staged snapshot.';result.validation=true;
    }else if(action.type==='finish'){
      if(task.phase==='ask'){this.finish(task,'completed',action.message);this.db.prepare('UPDATE studio_jobs SET result=? WHERE id=?').run(JSON.stringify({summary:action.message,checks:[],files:[],...(task.unreconciled?{accounting:{status:'unreconciled',reason:'agent-usage-unreconciled'}}:{})}),task.id);this.note(task,'assistant',action.message);}
      else {
        insist(task.phase==='build'&&task.approved_hash===digest(task.plan||''),403,'Finish requires an approved build plan.');
        insist(task.validated_hash===digest(task.files)&&files.length>0,409,'Validate the current staged source before finishing.');this.planCovers(task,parse(task.plan));
        const p=this.authorized(task),j=this.job(task);let version=null,conflict=null;
        try{version=saveRevision(this.store,p,files,`Agent: ${action.message.slice(0,400)}`,task.user_id,j.base_version).version;}
        catch(error){if(error.status!==409)throw error;conflict=error.message;}
        const state=conflict?'conflict':'completed';this.finish(task,state,conflict?'Validated output preserved. Newer source or quota prevented automatic saving.':`Validated files saved as revision ${version}. In-game behavior has not been tested.`);
        this.db.prepare('UPDATE studio_agent_tasks SET applied_version=? WHERE id=?').run(version,task.id);
        this.db.prepare('UPDATE studio_jobs SET result=?,applied_version=?,application_error=? WHERE id=?').run(JSON.stringify({files,summary:action.message,checks:parse(task.checks),...(task.unreconciled?{accounting:{status:'unreconciled',reason:'agent-usage-unreconciled'}}:{})}),version,conflict,task.id);this.note(task,'assistant',action.message);result.output={state,appliedVersion:version};
      }
    }
    return result;
  }
  step(body){fields(body,['id','lease','callId','costMicros','action','usage','unreconciled']);integer(body.costMicros,0,1e9,'provider cost');insist(body.unreconciled===undefined||typeof body.unreconciled==='boolean',400,'Invalid accounting status.');const action=actionData(body.action),fingerprint=digest(JSON.stringify({cost:body.costMicros,action,usage:body.usage??null,unreconciled:Boolean(body.unreconciled)}));return this.store.transaction(()=>{
    const t=this.task(body.id),call=this.db.prepare('SELECT * FROM studio_agent_steps WHERE task_id=? AND call_id=?').get(t.id,body.callId);
    insist(call&&typeof body.lease==='string'&&call.lease===digest(body.lease),409,'Unknown agent call receipt.');
    if(call.state==='completed'){insist(call.result_hash===fingerprint,409,'A different result was already recorded for this call.');return parse(call.response);}
    this.workerTask(body);insist(call.step===t.steps,409,'Agent call order changed.');
    const spent=t.spent+body.costMicros;insist(Number.isSafeInteger(spent),400,'Invalid cost total.');
    this.db.prepare('UPDATE studio_agent_tasks SET steps=steps+1,spent=?,unreconciled=?,version=version+1,updated_at=? WHERE id=?').run(spent,Number(Boolean(body.unreconciled)),this.stamp(),t.id);
    let current=this.task(t.id),result;
    if(spent>this.job(t).reserve){this.finish(current,'failed','Provider cost exceeded the approved estimate. Source was not changed and Studio credits were returned.',spent,'budget');result={stopped:true};}
    else if(current.control==='stop'){this.finish(current,'cancelled','Task stopped. Source was not changed by the returned action and Studio credits were returned.');result={stopped:true};}
    else {
      try{this.authorized(current);result=this.execute(current,action);}
      catch(error){if(!error.status)throw error;result={type:action.type,message:action.message,path:action.path,ok:false,error:error.message};if([401,403].includes(error.status)){this.changeState(current,'awaiting_input');this.db.prepare('UPDATE studio_agent_tasks SET lease=NULL,lease_until=NULL WHERE id=?').run(t.id);}}
      this.addHistory(this.task(t.id),result);current=this.task(t.id);
      if(!TERMINAL.has(current.state)&&current.state==='running'&&!result.validation)this.checkpointStop(current);
    }
    const state=this.task(t.id).state,response={...result,state,stopped:state!=='running',validation:Boolean(result?.validation&&state==='running')};
    if(response.validation)response.files=parse(this.task(t.id).files);
    const usage=body.usage===undefined?null:JSON.stringify(body.usage);insist(usage===null||Buffer.byteLength(usage)<=8192,400,'Usage receipt is too large.');
    this.db.prepare("UPDATE studio_agent_steps SET state='completed',result_hash=?,response=?,cost=?,usage=? WHERE task_id=? AND call_id=?").run(fingerprint,JSON.stringify(response),body.costMicros,usage,t.id,body.callId);return response;
  });}
  validation(body){fields(body,['id','lease','callId','filesHash','result']);const fingerprint=digest(JSON.stringify(body.result));return this.store.transaction(()=>this.receipt(body.id,`validate:${body.callId}`,`${digest(typeof body.lease==='string'?body.lease:'')}:${body.filesHash}:${fingerprint}`,()=>{const t=this.workerTask(body);this.authorized(t);const call=this.db.prepare('SELECT * FROM studio_agent_steps WHERE task_id=? AND call_id=?').get(t.id,body.callId);insist(call?.state==='completed'&&parse(call.response).validation&&body.filesHash===digest(t.files),409,'Validation snapshot changed.');const r=body.result;insist(r&&['ok','source','infrastructure'].includes(r.kind)&&typeof r.ok==='boolean'&&r.ok===(r.kind==='ok')&&Array.isArray(r.checks)&&r.checks.length<=100&&r.checks.every(v=>typeof v==='string'&&v.length<=2000),400,'Invalid validation result.');
      const policy=parse(t.policy),protectedNames=parse(t.files).filter(file=>protectedPath(file.path,policy)).map(file=>file.path);
      const checks=r.checks.map(check=>protectedNames.some(path=>check.includes(path))?'A protected file has a validation result. Its contents were not sent to the model.':check);
      this.db.prepare('UPDATE studio_agent_tasks SET validated_hash=?,checks=?,version=version+1 WHERE id=?').run(r.ok?body.filesHash:null,JSON.stringify(checks),t.id);this.addHistory(t,{type:'validation_result',ok:r.ok,message:r.ok?'Isolated syntax and packaging checks passed.':'Validation needs attention.',output:checks});
      if(r.kind==='infrastructure')this.finish(this.task(t.id),'failed','Validator infrastructure failed. No paid repair was requested and Studio credits were returned.');else this.checkpointStop(this.task(t.id));
      return {ok:true,state:this.task(t.id).state};}));}
  fail(body){fields(body,['id','lease','callId','reason','costMicros','uncertain']);insist(['provider','platform','budget','exhausted'].includes(body.reason),400,'Invalid failure category.');integer(body.costMicros,0,1e9,'known provider cost');insist(typeof body.uncertain==='boolean',400,'Invalid accounting certainty.');return this.store.transaction(()=>this.receipt(body.id,`failure:${body.callId||'preflight'}`,digest(JSON.stringify(body)),()=>{const t=this.workerTask(body),cost=body.uncertain?Math.max(t.spent,this.job(t).reserve):t.spent+body.costMicros;if(body.uncertain){this.db.prepare('UPDATE studio_agent_tasks SET unreconciled=1 WHERE id=?').run(t.id);t.unreconciled=1;}const message=body.reason==='provider'?'Provider API failure. All task Studio credits were returned. No automatic retry was made.':body.reason==='budget'?'The next step does not fit the approved budget. Staged progress is preserved and Studio credits were returned.':'Task stopped after an execution failure. Staged progress is preserved and Studio credits were returned.';this.finish(t,t.control==='stop'?'cancelled':'failed',message,cost,body.reason);return {ok:true,state:this.task(t.id).state};}));}
}
