// Local QA only: real Studio HTTP/SQLite and built frontend, mocked external services.
// No test-login endpoint or production configuration is installed by this fixture.
import { createServer, request as requestHttp } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../../server/store.mjs';
import { createApp } from '../../server/app.mjs';
import { readConfig } from '../../server/config.mjs';
import { studioSettings } from '../../server/studio-domain.mjs';
import { runJob } from '../../worker/start.mjs';
import { generate } from '../../worker/provider.mjs';

process.umask(0o077);
const root=fileURLToPath(new URL('../../',import.meta.url));
const directory=mkdtempSync(join(tmpdir(),'nd-studio-launch-'));
const database=join(directory,'studio.sqlite'),log=join(directory,'requests.ndjson');
const workerToken='f'.repeat(64);
const identities={
  owner:{id:'100000000000000001',username:'qa_owner',displayName:'QA Owner',avatar:null},
  member:{id:'100000000000000002',username:'qa_member',displayName:'QA Member',avatar:null},
  other:{id:'100000000000000003',username:'qa_other',displayName:'QA Other',avatar:null},
};
let apiPort,staticPort,api,staticProcess,heartbeat,polling,closing=false,workerBusy=false;
const stopWorker=new AbortController();
const errors=[];
const gateway=createServer((req,res)=>{
  const path=new URL(req.url,'http://127.0.0.1').pathname;
  res.on('finish',()=>appendFileSync(log,JSON.stringify({method:req.method,path,status:res.statusCode})+'\n'));
  const upstream=requestHttp({hostname:'127.0.0.1',port:path.startsWith('/api/')||path.startsWith('/auth/')?apiPort:staticPort,path:req.url,method:req.method,headers:req.headers,timeout:20000},incoming=>{
    res.writeHead(incoming.statusCode,incoming.headers);incoming.pipe(res);
  });
  upstream.on('timeout',()=>upstream.destroy());
  upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502,{'content-type':'application/json'});res.end(JSON.stringify({error:'Local QA upstream unavailable.'}));});
  req.on('aborted',()=>upstream.destroy());req.pipe(upstream);
});
await new Promise((resolve,reject)=>{gateway.once('error',reject);gateway.listen(Number(process.env.ND_QA_PORT??3190),'127.0.0.1',resolve);});
const origin=`http://127.0.0.1:${gateway.address().port}`;
const store=new Store(database);
for(const identity of Object.values(identities))store.login(identity);
const config=readConfig({NODE_ENV:'development',APP_ORIGIN:origin,OWNER_DISCORD_IDS:identities.owner.id,DISCORD_CLIENT_ID:'100000000000000010',DISCORD_CLIENT_SECRET:'qa-only-oauth-fixture',STUDIO_WORKER_TOKEN:workerToken,DATABASE_PATH:database});
const catalog=JSON.parse(readFileSync(join(root,'config/tools.json'),'utf8'));
api=createApp({store,config,catalog,identity:async(_,code)=>{
  const identity=identities[code];if(!identity)throw new Error('QA OAuth rejected.');return identity;
},logger:{error:message=>{errors.push(message);console.error('QA_SERVER_ERROR',message);}}});
await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));apiPort=api.address().port;
const settings=studioSettings(store);delete settings.version;
settings.tools={'ai-script-generator':'owner','discord-bot-generator':'owner'};
store.db.prepare('UPDATE studio_settings SET value=? WHERE id=1').run(JSON.stringify(settings));
const fixtureModel={id:'qa-coding-fixture',provider:'openai',label:'QA coding fixture',tier:'standard',enabled:true,compatible:true,inputUsdPerMillion:1,cachedInputUsdPerMillion:.25,outputUsdPerMillion:2,maxOutputTokens:1024,maxCalls:2,maxBudgetMicros:100000,timeoutSeconds:180,creditsPerBuild:5};
store.db.prepare('UPDATE studio_model_settings SET value=? WHERE id=1').run(JSON.stringify({configured:true,models:[fixtureModel],defaultModelId:fixtureModel.id,creditsEnabled:true}));
for(const identity of Object.values(identities)){
  const user=store.db.prepare('SELECT id FROM users WHERE discord_id=?').get(identity.id);
  store.db.prepare('INSERT INTO studio_controls(user_id,daily_limit,daily_budget) VALUES(?,50,10000000)').run(user.id);
  store.db.prepare('INSERT INTO studio_credit_wallets(user_id,balance) VALUES(?,100)').run(user.id);
}
const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));staticPort=probe.address().port;await new Promise(resolve=>probe.close(resolve));
staticProcess=spawn(process.execPath,['scripts/serve.mjs'],{cwd:root,env:{...process.env,PORT:String(staticPort)},stdio:['ignore','ignore','inherit']});
staticProcess.on('exit',code=>{if(!closing){errors.push(`Static preview exited ${code}`);stop(1);}});
for(let attempt=0;attempt<40;attempt++){
  try{const response=await fetch(`http://127.0.0.1:${staticPort}/`);if(response.status===200)break;}catch{}
  if(attempt===39)throw new Error('Static preview did not become ready.');await delay(100);
}
const workerApi=async(path,body,{signal:requestSignal,timeout=15000}={})=>{
  const timeoutSignal=AbortSignal.timeout(timeout),signal=requestSignal?AbortSignal.any([requestSignal,timeoutSignal]):timeoutSignal;
  const response=await fetch(`http://127.0.0.1:${apiPort}${path}`,{method:'POST',signal,headers:{authorization:`Bearer ${workerToken}`,'content-type':'application/json'},body:JSON.stringify(body)});
  appendFileSync(log,JSON.stringify({method:'POST',path,status:response.status})+'\n');
  const data=await response.json();if(!response.ok)throw Object.assign(new Error(data.error||'QA worker API failure'),{status:response.status});return data;
};
await workerApi('/api/worker/heartbeat',{ready:true,providers:['openai']});
heartbeat=setInterval(()=>workerApi('/api/worker/heartbeat',{ready:true,providers:['openai']}).catch(error=>{if(!closing)errors.push(error.message);}),15000);
polling=setInterval(async()=>{
  if(workerBusy||closing)return;workerBusy=true;
  try{
    const {job}=await workerApi('/api/worker/claim',{});
    if(job)await runJob(job,{key:'qa-no-real-provider-key',api:workerApi,signal:stopWorker.signal,wait:async()=>{},preflight:async()=>{},
      generator:async(job,files,{signal,onPreview,spent=0,diagnostics=[]})=>{
        const live=job.prompt.includes('[live]');
        const prefix='-- Local QA streamed source only. No real provider or rootless container was contacted.\nRegisterCommand("nd_qatest", function()\n';
        const liveSource=prefix+'  print("QA fixture")\nend, false)\n';
        const generated=[{path:'README.md',content:'# QA fixture resource\nSynthetic output. No live provider or container was used.'},{path:'fxmanifest.lua',content:"fx_version 'cerulean'\ngame 'gta5'\nclient_script 'client/main.lua'\n"},{path:'client/main.lua',content:live?liveSource:'RegisterCommand("nd_qatest", function() print("QA fixture") end, false)\n'}];
        if(live){
          // Only the provider transport is synthetic. Exercise the production SSE
          // reader, incomplete JSON decoder, accounting and preview publisher.
          const changes=[generated.find(file=>file.path==='client/main.lua'),...generated.filter(file=>file.path!=='client/main.lua'),
            ...files.filter(file=>!generated.some(next=>next.path===file.path)).map(file=>({path:file.path,content:null}))];
          const output=JSON.stringify({summary:'QA fixture generated source',changes});
          const cutAfter=content=>{
            const encoded=JSON.stringify(content).slice(0,-1),start=output.indexOf(encoded);
            if(start<0)throw new Error('The synthetic SSE prefix did not match the final provider JSON.');
            return start+encoded.length;
          };
          const first=cutAfter(prefix),second=cutAfter(prefix+'  print("QA fixture")\n');
          const final={status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:output}]}],
            usage:{input_tokens:20,output_tokens:40,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}};
          const events=[
            [200,{type:'response.output_text.delta',delta:output.slice(0,first)}],
            [3200,{type:'response.output_text.delta',delta:output.slice(first,second)}],
            [6200,{type:'response.output_text.delta',delta:output.slice(second)}],
            [8000,{type:'response.completed',response:final}],
          ];
          const fetcher=async(endpoint,request)=>{
            if(endpoint!=='https://api.openai.com/v1/responses'||request.method!=='POST'||JSON.parse(request.body).stream!==true)throw new Error('The QA stream fixture expected the production OpenAI Responses streaming request.');
            const encoder=new TextEncoder(),timers=new Set();let stopped=false,abort;
            const cleanup=()=>{for(const timer of timers)clearTimeout(timer);timers.clear();if(abort)request.signal.removeEventListener('abort',abort);};
            const body=new ReadableStream({
              start(controller){
                abort=()=>{if(stopped)return;stopped=true;cleanup();controller.error(request.signal.reason||new Error('QA provider stream aborted.'));};
                request.signal.addEventListener('abort',abort,{once:true});
                if(request.signal.aborted){abort();return;}
                for(const [milliseconds,event]of events){
                  const timer=setTimeout(()=>{
                    timers.delete(timer);if(stopped)return;
                    controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
                    if(event.type==='response.completed'){stopped=true;cleanup();controller.close();}
                  },milliseconds);
                  timers.add(timer);
                }
              },
              cancel(){stopped=true;cleanup();},
            });
            return new Response(body,{status:200,headers:{'content-type':'text/event-stream'}});
          };
          return generate(job,files,{key:'qa-no-real-provider-key',signal,spent,diagnostics,onPreview,fetcher});
        }
        await delay(job.prompt.includes('[cancel]')?10000:job.prompt.includes('[slow]')?4000:500,undefined,{signal});
        if(job.prompt.includes('[fail]'))throw Object.assign(new Error('QA provider fixture failure.'),{status:503,providerCostMicros:0});
        return {files:generated,summary:'QA fixture generated source',cost:100};
      },validator:async()=>({ok:true,kind:'ok',checks:['QA syntax fixture passed. Live rootless validation was not performed.']})});
  }catch(error){if(!closing&&error.status!==409)console.error('QA_WORKER_ERROR',error.message);}
  finally{workerBusy=false;}
},1500);
const metadata={origin,directory,database,log,accounts:Object.keys(identities),mocked:['Discord identity','AI generation','provider Responses SSE transport','rootless validator']};
writeFileSync(join(directory,'metadata.json'),JSON.stringify(metadata,null,2));
console.log('ND_QA_READY '+JSON.stringify(metadata));
function stop(code=0){
  if(closing)return;closing=true;clearInterval(heartbeat);clearInterval(polling);stopWorker.abort();
  gateway.closeAllConnections();gateway.close();api?.closeAllConnections();api?.close(()=>{store.close();});staticProcess?.kill('SIGTERM');
  setTimeout(()=>{rmSync(directory,{recursive:true,force:true});process.exit(code);},250).unref();
}
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>stop());
