import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { requestAgentAction, prepareAgentRequest } from '../worker/agent-provider.mjs';
import { runAgentTask } from '../worker/agent.mjs';
import { diagnosticData, failureDiagnostic } from '../server/agent-errors.mjs';
import { createFixture } from './fixtures/agent-http.mjs';

const privateText='PRIVATE_PROMPT_SOURCE_TOKEN_DO_NOT_EXPOSE';
const action=(type,extra={})=>({type,message:'Inspect source.',path:null,query:null,content:null,plan:null,...extra});
const context=()=>({phase:'plan',request:privateText,project:{name:'Test',tool:'ai-script-generator',target:'Standalone',requirements:privateText},files:[],baseFiles:[],history:[],conversation:[],steps:0,maxSteps:16,spentMicros:0,budgetMicros:500000,settings:{model:'fixture-model',provider:'openai',maxOutputTokens:1024,inputUsdPerMillion:1,outputUsdPerMillion:2}});
const response=(extra={})=>({id:'resp_fixture123',status:'completed',usage:{input_tokens:100,output_tokens:50},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(action('list_files'))}]}],...extra});
async function rejectWith(fetcher,category,c=context()) {
  let calls=0;
  await assert.rejects(requestAgentAction(c,prepareAgentRequest(c),{key:'fixture-private-key',fetcher:async(...args)=>{calls++;return fetcher(...args);}}),error=>{
    assert.equal(error.diagnostic?.category,category);
    assert.equal(JSON.stringify({message:error.message,diagnostic:error.diagnostic}).includes(privateText),false);
    assert.ok(error.diagnostic.nextStep.length>20);
    return true;
  });
  assert.equal(calls,1,'a failure never replays a paid POST');
}
for(const [status,code,category] of [[401,'invalid_api_key','provider_authentication'],[403,'permission_denied','provider_access'],[404,'model_not_found','provider_access'],[400,'invalid_json_schema','provider_request'],[422,'unsupported_parameter','provider_request'],[429,'rate_limit_exceeded','provider_rate_limit'],[429,'insufficient_quota','provider_quota'],[503,'server_error','provider_unavailable'],[504,'timeout','provider_timeout']]) {
  test(`HTTP ${status}/${code} is safely classified as ${category}`,async()=>{
    await rejectWith(async()=>new Response(JSON.stringify({error:{code,message:privateText,source:privateText}}),{status,headers:{'x-request-id':'req_fixture123'}}),category);
  });
}
test('provider diagnostics preserve only supported status, codes and safe request identifiers',async()=>{
  const c=context();
  await assert.rejects(requestAgentAction(c,prepareAgentRequest(c),{key:'fixture-private-key',fetcher:async()=>new Response(JSON.stringify({error:{code:'model_not_found',message:privateText}}),{status:404,headers:{'x-request-id':'req_fixture123'}})}),error=>{
    assert.deepEqual(error.diagnostic,failureDiagnostic('provider_access',{httpStatus:404,providerCode:'model_not_found',requestId:'req_fixture123'}));return true;
  });
  const value=diagnosticData({category:'provider_request',summary:privateText,nextStep:privateText,providerCode:privateText,requestId:privateText,responseId:privateText,httpStatus:999});
  assert.equal(JSON.stringify(value).includes(privateText),false);
  assert.throws(()=>diagnosticData({category:'platform',rawBody:privateText}));
  assert.throws(()=>diagnosticData({category:privateText}));
});
test('interrupted network and timeout failures are distinct and sanitized',async()=>{
  await rejectWith(async()=>{throw new TypeError(privateText);},'provider_network');
  await rejectWith(async()=>{throw new DOMException(privateText,'TimeoutError');},'provider_timeout');
});
test('a response body interrupted after HTTP headers remains a transport failure',async()=>{
  await rejectWith(async()=>new Response(new ReadableStream({start(controller){controller.error(new TypeError(privateText));}})),'provider_network');
});
for(const [label,data,category] of [
  ['incomplete',response({status:'incomplete'}),'provider_incomplete'],
  ['failed response',response({status:'failed',error:{code:'server_error',message:privateText}}),'provider_unknown'],
  ['missing completion state',response({status:null}),'provider_output'],
  ['refusal',response({output:[{type:'message',content:[{type:'refusal',refusal:privateText}]}]}),'provider_refusal'],
  ['malformed output',response({output:[{type:'message',content:[{type:'output_text',text:privateText}]}]}),'provider_output'],
  ['invalid action',response({output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(action('read_file',{path:''}))}]}]}),'invalid_action'],
  ['invalid usage',response({usage:{input_tokens:-1,output_tokens:1}}),'usage_unreconciled'],
])test(`${label} is not mislabeled as a generic API rejection`,async()=>{
  await rejectWith(async()=>new Response(JSON.stringify(data)),category);
});
test('malformed transport JSON is sanitized and cannot authorize a tool',async()=>{
  await rejectWith(async()=>new Response(privateText),'provider_output');
});
test('missing cache lifetimes preserve the action and full exposure without inventing rates',async()=>{
  const c=context(),r=await requestAgentAction(c,prepareAgentRequest(c),{key:'fixture-private-key',fetcher:async()=>new Response(JSON.stringify(response({usage:{input_tokens:100,output_tokens:50,input_tokens_details:{cached_tokens:10,cache_write_tokens:20}}})))});
  assert.equal(r.action.type,'list_files');assert.equal(r.unreconciled,true);assert.equal(r.costMicros,c.budgetMicros);
});
async function start(t,{billing=false}={}) {
  const f=await createFixture({billing});t.after(()=>f.close());
  if(billing){f.store.db.prepare('INSERT INTO studio_subscriptions VALUES(?,?,?,0)').run('sub_diagnostics',f.user.id,'active');f.store.db.prepare('INSERT INTO studio_subscription_periods(invoice_id,subscription_id,user_id,plan,price_cents,start_at,end_at,allowance,failure_reserve) VALUES(?,?,?,?,?,?,?,?,?)').run('in_diagnostics','sub_diagnostics',f.user.id,'starter',1999,Date.now()-60000,Date.now()+86400000,10000000,2000000);}
  else{const model=f.agent.engine.models.configuration().models[0];f.store.db.prepare('UPDATE studio_model_settings SET value=?').run(JSON.stringify({configured:true,models:[{...model,creditsPerBuild:20}],defaultModelId:model.id,creditsEnabled:true}));f.store.db.prepare('INSERT INTO studio_credit_wallets VALUES(?,100,1)').run(f.user.id);}
  const chat=(await f.call(`/api/agent/projects/${f.p.id}/chats`,{title:'Diagnose',requestId:randomUUID()})).data.chat;
  await f.call(`/api/agent/projects/${f.p.id}/presence`,{tabId:randomUUID()});
  const catalog=(await f.call('/api/agent/bootstrap')).data.catalog,model=catalog.models[0];
  const created=await f.call(`/api/agent/chats/${chat.id}/tasks`,{requestId:randomUUID(),message:'Keep improving the script and ask questions if needed.',mode:'build',maxSteps:16,continuation:'pause',projectVersion:2,modelId:model.id,pricingVersion:catalog.pricingVersion,quotedCredits:model.creditsPerBuild});
  assert.equal(created.status,201,JSON.stringify(created.data));
  const job=(await f.workerApi('/api/worker/claim',{})).job;
  return {...f,job};
}
test('real HTTP neutral action receipt reaches approval without mutating source or refunding a false API failure',async t=>{
  const f=await start(t);let paid=0;
  await runAgentTask(f.job,{api:f.workerApi,key:'fixture-private-key',turn:async(c,p,options)=>{paid++;return requestAgentAction(c,p,{...options,fetcher:async()=>new Response(JSON.stringify(response({output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(action('propose_plan',{path:'',query:'',content:'',plan:{goal:'Inspect and improve the script',steps:['Read source and ask for any missing requirements'],changes:[],capabilities:[]}}))}]}]})))});}});
  assert.equal(paid,1);const view=(await f.call(`/api/agent/tasks/${f.job.id}`)).data.task;
  assert.equal(view.state,'awaiting_approval');assert.equal(view.failure,null);assert.equal(view.credits.state,'reserved');
  assert.equal(f.store.db.prepare('SELECT version FROM studio_projects WHERE id=?').get(f.p.id).version,2);
});
for(const billing of [false,true])test(`HTTP classified failure refunds ${billing?'subscription':'fixed wallet'} exactly once and preserves diagnostics`,async t=>{
  const f=await start(t,{billing});let paid=0,failed;
  const api=async(path,body)=>{if(path.endsWith('/fail'))failed=body;return f.workerApi(path,body);};
  await runAgentTask(f.job,{api,key:'fixture-private-key',turn:async(c,p,options)=>{paid++;return requestAgentAction(c,p,{...options,fetcher:async()=>new Response(JSON.stringify({error:{code:'invalid_json_schema',message:privateText}}),{status:400,headers:{'x-request-id':'req_fixture123'}})});}});
  assert.equal(paid,1);const view=(await f.call(`/api/agent/tasks/${f.job.id}`)).data.task;
  assert.equal(view.state,'failed');assert.equal(view.failure.category,'provider_request');assert.equal(view.failure.requestId,'req_fixture123');assert.equal(view.credits.state,'released');assert.equal(view.unreconciled,true);assert.equal(view.spentMicros,500000);
  assert.equal(JSON.stringify(view).includes(privateText),false);
  await f.workerApi('/api/agent/worker/fail',failed);
  if(billing){const period=f.store.db.prepare('SELECT * FROM studio_subscription_periods').get();assert.equal(period.spent,0);assert.equal(period.provider_spent,500000);}
  else{assert.equal(f.agent.engine.models.wallet(f.user.id).balance,100);assert.equal(f.store.db.prepare("SELECT count(*) n FROM studio_credit_ledger WHERE kind='released'").get().n,1);}
  assert.equal(f.store.db.prepare('SELECT version FROM studio_projects WHERE id=?').get(f.p.id).version,2);
});
test('server action validation rejection is not reported as provider authentication or API transport failure',async t=>{
  const f=await start(t);let paid=0;
  await runAgentTask(f.job,{api:f.workerApi,turn:async()=>{paid++;return {action:action('read_file',{path:''}),costMicros:200,usage:{input_tokens:100,output_tokens:50},unreconciled:false};}});
  const view=(await f.call(`/api/agent/tasks/${f.job.id}`)).data.task;
  assert.equal(paid,1);assert.equal(view.state,'failed');assert.equal(view.failure.category,'invalid_action');assert.equal(view.spentMicros,200);assert.equal(view.unreconciled,false);assert.equal(view.credits.state,'released');
});
test('uncertain failure retains a known minimum above the captured reservation',async t=>{
  const f=await start(t),body={id:f.job.id,lease:f.job.lease,callId:'fixture-call',reason:'provider',costMicros:600000,uncertain:true,diagnostic:failureDiagnostic('usage_unreconciled')};
  await f.workerApi('/api/agent/worker/fail',body);await f.workerApi('/api/agent/worker/fail',body);
  const view=(await f.call(`/api/agent/tasks/${f.job.id}`)).data.task;
  assert.equal(view.spentMicros,600000);assert.equal(view.unreconciled,true);assert.equal(view.credits.state,'released');
});
test('validator preflight failure is distinct, refunds the task and does not request a paid repair',async t=>{
  const f=await start(t);
  await runAgentTask(f.job,{api:f.workerApi,turn:async()=>({action:action('propose_plan',{plan:{goal:'Inspect source',steps:['Validate the existing source'],changes:[],capabilities:[]}}),costMicros:200,usage:{input_tokens:100,output_tokens:50},unreconciled:false})});
  const proposed=(await f.call(`/api/agent/tasks/${f.job.id}`)).data.task;
  const approved=await f.call(`/api/agent/tasks/${f.job.id}/approve`,{version:proposed.version,planVersion:proposed.planVersion,planHash:proposed.planHash,requestId:randomUUID()});assert.equal(approved.status,200);
  const claimed=(await f.workerApi('/api/worker/claim',{})).job;let paid=0;
  await runAgentTask(claimed,{api:f.workerApi,preflight:async()=>{throw new Error(privateText);},turn:async()=>{paid++;throw new Error('No paid call should occur.');}});
  const view=(await f.call(`/api/agent/tasks/${f.job.id}`)).data.task;
  assert.equal(paid,0);assert.equal(view.failure.category,'validator_infrastructure');assert.equal(view.spentMicros,200);assert.equal(view.credits.state,'released');assert.equal(JSON.stringify(view).includes(privateText),false);
});
test('local approval rejection is reported as an action permission failure, not a provider API failure',async t=>{
  const f=await start(t);let paid=0;
  await runAgentTask(f.job,{api:f.workerApi,turn:async()=>{paid++;return {action:action('write_file',{path:'new.lua',content:'print(1)'}),costMicros:200,unreconciled:false};}});
  const view=(await f.call(`/api/agent/tasks/${f.job.id}`)).data.task;
  assert.equal(paid,1);assert.equal(view.state,'awaiting_input');assert.equal(view.history.at(-1).diagnostic.category,'action_permission');assert.equal(view.failure,null);
  assert.equal(f.store.db.prepare('SELECT version FROM studio_projects WHERE id=?').get(f.p.id).version,2);
});
