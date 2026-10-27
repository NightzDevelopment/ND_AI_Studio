// Development fixture only. Never included by the production deployment scripts.
// Real HTTP, SQLite, agent middleware, provider adapter and worker. The identity,
// model transport, validator result and legacy-editor shim are explicit doubles.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {randomBytes,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Store} from '../../server/store.mjs';
import {createAgent} from '../../server/agent.mjs';
import {createModels} from '../../server/studio-models.mjs';
import {migrateStudio,newProject,studioSettings,project,snapshot,saveRevision,digest,insist} from '../../server/studio-domain.mjs';
import {runAgentTask} from '../../worker/agent.mjs';
import {requestAgentAction} from '../../worker/agent-provider.mjs';
const root=new URL('../../',import.meta.url);
const action=(type,more={})=>({type,message:({list_files:'Inspecting the project structure.',read_file:'Reading existing client behavior.',propose_plan:'Here is the proposed implementation. Review the exact file changes before approving.',write_file:'Updating the approved file in task staging.',validate_project:'Running isolated syntax and packaging checks.',finish:'The resource is saved. Test /ndhello in a development FiveM server.'}[type]||type),path:null,query:null,content:null,plan:null,...more});
export async function createFixture({autoWorker=false,billing=false}={}){
  const store=new Store(':memory:');migrateStudio(store);
  const user=store.login({id:'100000000000000001',username:'Jake',displayName:'Jake',avatar:null}),other=store.login({id:'100000000000000002',username:'Other',displayName:'Other',avatar:null});
  const token=randomBytes(32).toString('base64url'),csrf=randomBytes(32).toString('base64url');store.newSession(digest(token),user.id,csrf,3600);
  const otherToken=randomBytes(32).toString('base64url');store.newSession(digest(otherToken),other.id,'other-csrf',3600);
  const config={ownerIds:[user.discord_id],workerToken:'e'.repeat(64),origin:'',billing:{enabled:billing,feeBps:400,feeCents:50,overheadCents:300,failureCents:200}};
  const models=createModels({store,actor(){},readJson(){},json(){}});const settings=studioSettings(store);delete settings.version;Object.assign(settings,{model:'fixture-model',inputUsdPerMillion:1,outputUsdPerMillion:2,maxBudgetMicros:500000,tools:{'ai-script-generator':'owner','discord-bot-generator':'owner'}});store.db.prepare('UPDATE studio_settings SET value=?').run(JSON.stringify(settings));
  store.db.prepare('INSERT INTO studio_controls VALUES(?,?,?,?,?)').run(user.id,'active',100,100000000,1);
  const p=newProject(store,user.id,{name:'ND_AgentDemo',toolId:'ai-script-generator',target:'Standalone',requirements:'Create an /ndhello notification without external dependencies.'},{tools:[{id:'ai-script-generator',category:'create',engine:'coding'}]});
  saveRevision(store,project(store,user.id,p.id),[{path:'client/main.lua',content:'-- Existing project source\nlocal enabled = true\n'}],'Initial source',user.id);
  const readJson=async(req,limit=65536)=>{insist(req.headers['content-type']?.startsWith('application/json')&&!req.headers['content-encoding'],415,'Send application/json.');let data='';for await(const chunk of req){data+=chunk;insist(Buffer.byteLength(data)<=limit,413,'Request too large.');}try{return JSON.parse(data);}catch{throw Object.assign(new Error('Invalid JSON.'),{status:400});}};
  const required=req=>{const value=(req.headers.cookie||'').split(';').find(item=>item.trim().startsWith('fixture='))?.trim().slice(8);const session=value&&store.session(digest(value));insist(session,401,'Your session ended.');return session;};
  const mutation=(req,expected)=>{const session=required(req);insist(!expected||expected.hash===session.hash,401,'Session changed.');insist(req.headers.origin===config.origin&&req.headers['x-csrf-token']===session.csrf,403,'Security check failed.');return session;};
  const json=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(data));};
  const agent=createAgent({store,config,required,mutation,readJson,json});
  let behavior='success',paid=0,validatorCalls=0,timer,busy=false;
  const server=createServer(async(req,res)=>{try{
    const url=new URL(req.url,config.origin);
    if(url.pathname==='/__fixture/login'){res.writeHead(302,{'set-cookie':`fixture=${token}; Path=/; HttpOnly; SameSite=Lax`,location:`/agent.html#project/${p.id}`});res.end();return;}
    if(url.pathname==='/api/session'){let session;try{session=required(req);}catch{}json(res,200,{configured:true,user:session?{id:session.user_id,displayName:'Jake'}:null,csrf:session?.csrf||null});return;}
    if(await agent.route(req,res,url))return;
    if(url.pathname.startsWith('/api/worker/')){insist(req.headers.authorization===`Bearer ${config.workerToken}`,401,'Worker only.');const body=await readJson(req);if(url.pathname.endsWith('/heartbeat')){store.db.prepare('INSERT INTO studio_worker VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET checked_at=excluded.checked_at,ready=excluded.ready').run(Date.now(),Number(body.ready));store.db.prepare('INSERT INTO studio_worker_providers VALUES(1,?) ON CONFLICT(id) DO UPDATE SET providers=excluded.providers').run(JSON.stringify(body.providers));json(res,200,{ok:true});return;}if(url.pathname.endsWith('/claim')){json(res,200,{job:null});return;}}
    const match=/^\/api\/projects\/([a-f0-9-]{36})\/files$/.exec(url.pathname);if(match&&req.method==='PUT'){const session=mutation(req),body=await readJson(req,1048576);mutation(req,session);const current=project(store,session.user_id,match[1]),files=snapshot(store,current).files;const index=files.findIndex(file=>file.path===body.path);if(index<0)files.push({path:body.path,content:body.content});else files[index]={path:body.path,content:body.content};json(res,200,{project:store.transaction(()=>saveRevision(store,current,files,'Manual source update',session.user_id,body.version))});return;}
    const names=['agent.html','agent.js','agent.css','controls.js','workbench-ui.css','workbench-ui.js'];const name=url.pathname.slice(1);if(names.includes(name)){const data=await readFile(new URL(`web/${name}`,root));res.writeHead(200,{'content-type':name.endsWith('.html')?'text/html':name.endsWith('.css')?'text/css':'text/javascript','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'"});res.end(data);return;}
    if(name==='nd-logo.webp'||name==='favicon.ico'){try{const data=await readFile(new URL('web/nd-logo.webp',root)).catch(()=>readFile(new URL('tests/fixtures/nd-logo.png',root)));res.writeHead(200,{'content-type':data.subarray(0,4).toString()==='RIFF'?'image/webp':'image/png'});res.end(data);}catch{res.writeHead(204);res.end();}return;}
    json(res,404,{error:'Fixture route not found.'});
  }catch(error){if(!res.headersSent)json(res,error.status||500,{error:error.message});else res.end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));config.origin=`http://127.0.0.1:${server.address().port}`;
  const call=async(path,body,{worker=false,method=body===undefined?'GET':'POST',cookie=token,origin=config.origin,csrfValue=csrf,headers={}}={})=>{const response=await fetch(config.origin+path,{method,headers:{...(worker?{authorization:`Bearer ${config.workerToken}`,'x-nd-studio-agent':'1'}:{cookie:`fixture=${cookie}`,origin,'x-csrf-token':csrfValue}),...(body===undefined?{}:{'content-type':'application/json'}),...headers},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,data:await response.json()};};
  const workerApi=async(path,body)=>{const response=await call(path,body,{worker:true});if(response.status!==200)throw Object.assign(new Error(response.data.error||'Worker API failure'),{status:response.status});return response.data;};
  const fixtureTurn=async(context,prepared,options)=>{
    paid++;await new Promise(resolve=>setTimeout(resolve,120));
    if(behavior==='api-failure')return requestAgentAction(context,prepared,{...options,key:'fixture-provider-key',fetcher:async()=>new Response('',{status:503})});
    let act;
    if(context.phase==='ask')act=action('finish',{message:'This resource contains a client Lua file. No source was changed.'});
    else if(context.phase==='plan'){
      const reads=context.history.filter(item=>item.type==='read_file');
      if(!context.history.some(item=>item.type==='list_files'))act=action('list_files');
      else if(context.files.length&&!reads.length)act=action('read_file',{path:context.files[0].path});
      else act=action('propose_plan',{plan:{goal:'Build ND_AgentDemo as a standalone FiveM notification resource.',steps:['Preserve the existing client structure.','Add the command, resource manifest and installation notes.','Validate the staged files, then save a new revision.'],changes:[{path:'client/main.lua',operation:context.baseFiles.includes('client/main.lua')?'edit':'create'},{path:'fxmanifest.lua',operation:context.baseFiles.includes('fxmanifest.lua')?'edit':'create'},{path:'README.md',operation:context.baseFiles.includes('README.md')?'edit':'create'}],capabilities:[]}});
    }else{
      const files=[['client/main.lua',"RegisterCommand('ndhello', function()\n    BeginTextCommandThefeedPost('STRING')\n    AddTextComponentSubstringPlayerName('ND AI Studio is working.')\n    EndTextCommandThefeedPostTicker(false, false)\nend, false)\n"],['fxmanifest.lua',"fx_version 'cerulean'\ngame 'gta5'\nclient_script 'client/main.lua'\n"],['README.md','# ND_AgentDemo\n\nAdd the resource to a development server and ensure it. Test /ndhello in game.\n']];
      const pending=files.find(([path])=>!context.history.some(item=>item.type==='write_file'&&item.path===path&&item.ok));
      if(pending)act=action('write_file',{path:pending[0],content:pending[1]});
      else if(!context.history.some(item=>item.type==='validation_result'&&item.ok))act=action('validate_project');
      else act=action('finish');
    }
    return requestAgentAction(context,prepared,{...options,key:'fixture-provider-key',fetcher:async()=>new Response(JSON.stringify({status:'completed',usage:{input_tokens:100,output_tokens:80},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(act)}]}]}),{headers:{'content-type':'application/json'}})});
  };
  const tick=async()=>{if(busy)return;busy=true;try{await workerApi('/api/worker/heartbeat',{ready:true,providers:['openai']});const {job}=await workerApi('/api/worker/claim',{});if(job)await runAgentTask(job,{api:workerApi,turn:fixtureTurn,preflight:async()=>{},validator:async()=>{validatorCalls++;return {ok:true,kind:'ok',checks:['Fixture validator: syntax and packaging passed.','Not tested: FiveM execution.']};}});}finally{busy=false;}};
  await workerApi('/api/worker/heartbeat',{ready:true,providers:['openai']});
  if(autoWorker)timer=setInterval(()=>tick().catch(error=>console.error('Fixture worker:',error.message)),250);
  return {store,config,user,other,session:store.session(digest(token)),token,csrf,otherToken,agent,p,call,workerApi,tick,counts:()=>({paid,validatorCalls}),behavior:value=>behavior=value,close:async()=>{clearInterval(timer);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();}};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){const fixture=await createFixture({autoWorker:true});console.log(JSON.stringify({origin:fixture.config.origin,projectId:fixture.p.id}));for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>fixture.close().then(()=>process.exit(0)));}
