import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Store } from '../server/store.mjs';
import { createApp, hash } from '../server/app.mjs';
import { readConfig } from '../server/config.mjs';
import { studioSettings } from '../server/studio-domain.mjs';

test('a streamed Quick build cannot bypass a newly authorized project agent task',async t=>{
  const store=new Store(':memory:');
  const user=store.login({id:'100000000000000001',username:'owner',displayName:'Owner',avatar:null});
  const token=randomBytes(32).toString('base64url'),csrf=randomBytes(32).toString('base64url');
  store.newSession(hash(token),user.id,csrf,3600);
  const config=readConfig({NODE_ENV:'development',APP_ORIGIN:'http://127.0.0.1:3081',OWNER_DISCORD_IDS:user.discord_id,STUDIO_WORKER_TOKEN:'e'.repeat(64)});
  const server=createApp({store,config,catalog:JSON.parse(readFileSync(new URL('../config/tools.json',import.meta.url),'utf8')),logger:{error(){}}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));config.origin=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();});
  const headers={cookie:`${config.sessionCookie}=${token}`,origin:config.origin,'x-csrf-token':csrf,'content-type':'application/json'};
  const call=async(path,body)=>{const response=await fetch(config.origin+path,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined});return {status:response.status,data:await response.json()};};
  const settings=studioSettings(store);delete settings.version;Object.assign(settings,{model:'fixture-model',inputUsdPerMillion:1,outputUsdPerMillion:2,maxBudgetMicros:250000,tools:{'ai-script-generator':'owner','discord-bot-generator':'owner'}});
  store.db.prepare('UPDATE studio_settings SET value=?').run(JSON.stringify(settings));
  store.db.prepare('INSERT INTO studio_worker VALUES(1,?,1)').run(Date.now());
  store.db.prepare('INSERT INTO studio_worker_providers VALUES(1,?)').run('["openai"]');
  store.db.prepare('INSERT INTO studio_agent_worker VALUES(1,?)').run(Date.now());
  const created=await call('/api/projects',{name:'Source writer test',toolId:'ai-script-generator',target:'Standalone',requirements:'Test concurrent writers'});assert.equal(created.status,201);
  const project=created.data.project,path=`/api/projects/${project.id}/jobs`;
  const body=JSON.stringify({version:1,prompt:'Quick build',requestId:randomUUID()});
  let bodyStarted;
  const reading=new Promise(resolve=>{bodyStarted=resolve;});
  server.on('request',req=>{if(req.url===path){const listening=event=>{if(event==='data'){req.off('newListener',listening);bodyStarted();}};req.on('newListener',listening);}});
  const pending=new Promise((resolve,reject)=>{
    const req=request(config.origin+path,{method:'POST',timeout:10000,headers:{...headers,'content-length':Buffer.byteLength(body)}},res=>{let raw='';res.on('data',chunk=>raw+=chunk);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(raw)}));});
    req.on('timeout',()=>req.destroy(new Error('Streamed build test timed out.')));
    req.on('error',reject);req.flushHeaders();
    reading.then(async()=>{
      try{
        req.write('{');
        const chat=await call(`/api/agent/projects/${project.id}/chats`,{title:'Build agent',requestId:randomUUID()});assert.equal(chat.status,201);
        const catalog=(await call('/api/agent/bootstrap')).data.catalog;
        const task=await call(`/api/agent/chats/${chat.data.chat.id}/tasks`,{requestId:randomUUID(),message:'Plan a source change',mode:'build',maxSteps:16,continuation:'pause',projectVersion:1,modelId:catalog.models[0].id,pricingVersion:catalog.pricingVersion,quotedCredits:0});assert.equal(task.status,201,JSON.stringify(task.data));
        req.end(body.slice(1));
      }catch(error){req.destroy();reject(error);}
    });
  });
  const result=await pending;
  assert.equal(result.status,409,JSON.stringify(result.data));
  assert.equal(store.db.prepare('SELECT count(*) n FROM studio_jobs WHERE project_id=?').get(project.id).n,1);
});
