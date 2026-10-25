import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { generate, providerPayload, reserveFor, price } from '../worker/provider.mjs';
import { validatorReady, validate, dockerArguments } from '../worker/validate.mjs';
import { runJob } from '../worker/start.mjs';
const image=`sha256:${'b'.repeat(64)}`;
const settings={model:'test-model',maxOutputTokens:1024,maxCalls:2,maxBudgetMicros:1000000,inputUsdPerMillion:1,outputUsdPerMillion:2};
const job={id:'c'.repeat(32),lease:'lease',prompt:'Create a simple resource',settings,project:{name:'ND_Test',tool_id:'ai-script-generator',target:'Standalone',requirements:'Configurable behavior',files:[]}};
const files=[{path:'fxmanifest.lua',content:"fx_version 'cerulean'\ngame 'gta5'\n"},{path:'README.md',content:'# Test source'}];
const response=(changes,extra={})=>new Response(JSON.stringify({status:'completed',usage:{input_tokens:100,output_tokens:200},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({summary:'Created source files',changes})}]}],...extra}),{headers:{'content-type':'application/json'}});
test('provider uses Responses structured output, private credentials and no storage',async()=>{
  let options;
  const result=await generate(job,[],{key:'test-provider-key',fetcher:async(url,value)=>{assert.equal(url,'https://api.openai.com/v1/responses');options=value;return response(files);}});
  const payload=JSON.parse(options.body);assert.equal(payload.store,false);assert.equal(payload.text.format.type,'json_schema');assert.equal(payload.text.format.strict,true);assert.equal(options.redirect,'error');assert.equal(result.cost,500);assert.equal(result.files.length,2);assert.equal(payload.max_output_tokens,1024);
  assert.equal(JSON.stringify(payload).includes('test-provider-key'),false);
});
test('provider estimates before spending, never retries a failed request',async()=>{
  let calls=0;
  await assert.rejects(generate({...job,settings:{...settings,maxBudgetMicros:1}},[],{key:'test-provider-key',fetcher:async()=>{calls++;return response(files);}}));assert.equal(calls,0);
  await assert.rejects(generate(job,[],{key:'test-provider-key',fetcher:async()=>{calls++;return new Response('{}',{status:429});}}));assert.equal(calls,1);
});
test('provider rejects incomplete, refusal, unsafe files and unknown usage',async()=>{
  for(const output of [response(files,{status:'incomplete'}),response(files,{output:[{type:'message',content:[{type:'refusal',refusal:'No'}]}]}),response([{path:'../escape.lua',content:'x'}]),response(files,{usage:{}})]){
    await assert.rejects(generate(job,[],{key:'test-provider-key',fetcher:async()=>output}));
  }
  assert.throws(()=>price({input_tokens:-1,output_tokens:5},settings));assert.ok(reserveFor(providerPayload(job,[]),settings)>2048);
});
test('validator refuses unpinned images, rootful Docker and missing cgroup enforcement',async()=>{
  await assert.rejects(validatorReady('nd-validator:latest'));
  for(const info of [{SecurityOptions:['rootless'],CgroupVersion:'1',CgroupDriver:'systemd'},{SecurityOptions:['seccomp'],CgroupVersion:'2',CgroupDriver:'systemd'},{SecurityOptions:['rootless'],CgroupVersion:'2',CgroupDriver:'none'}])await assert.rejects(validatorReady(image,async()=>({stdout:JSON.stringify(info)})));
});
test('validator arguments restrict network, mounts, privilege and resources',()=>{
  const args=dockerArguments(image,'job','/tmp/test','ai-script-generator');
  for(const value of ['--read-only','--network=none','--cap-drop=ALL','--security-opt=no-new-privileges','--pids-limit=32','--memory=256m','--cpus=1','--pull=never'])assert.ok(args.includes(value));
  assert.equal(args.filter(value=>value==='--mount').length,1);assert.ok(args.includes('type=bind,src=/tmp/test,dst=/workspace,readonly'));assert.equal(args.some(value=>value.includes('docker.sock')),false);
});
test('validator cleans its container and temporary source after an interrupted Docker client',async()=>{
  let directory;const calls=[];
  const runner=async(command,args)=>{calls.push(args);if(args[0]==='info')return {stdout:JSON.stringify({SecurityOptions:['name=rootless'],CgroupVersion:'2',CgroupDriver:'systemd'})};if(args[0]==='image')return {stdout:image};if(args[0]==='run'){directory=args[args.indexOf('--mount')+1].split(',src=')[1].split(',dst=')[0];await access(directory);throw new Error('Timed out');}return {stdout:''};};
  await assert.rejects(validate(files,'ai-script-generator',{image,runner}));assert.ok(calls.some(args=>args[0]==='rm'&&args[1]==='-f'));await assert.rejects(access(directory));
});
test('worker completes a reviewed result without executing or applying it',async()=>{
  const calls=[];await runJob(job,{preflight:async()=>{},key:'test-provider-key',image,api:async(path,body)=>{calls.push({path,body});return {};},generator:async()=>({files,summary:'Source prepared',cost:500}),validator:async()=>({ok:true,checks:['Syntax passed.','Not tested: in-game behavior.']})});
  const complete=calls.find(call=>call.path==='/api/worker/complete');assert.equal(complete.body.costMicros,500);assert.deepEqual(complete.body.result.files,files);assert.equal(calls.some(call=>call.path.includes('/apply')),false);
});
test('worker repairs once and never exceeds the configured call count',async()=>{
  let generated=0,checked=0;const calls=[];await runJob(job,{preflight:async()=>{},image,api:async(path,body)=>{calls.push({path,body});return {};},generator:async()=>{generated++;return {files,summary:'Prepared',cost:100};},validator:async()=>({ok:++checked===2,checks:['file.lua: syntax failed.']})});assert.equal(generated,2);assert.equal(calls.at(-1).body.costMicros,200);
});
test('worker keeps full reservation for an unknown provider outcome',async()=>{
  const calls=[];await runJob(job,{preflight:async()=>{},image,api:async(path,body)=>{calls.push({path,body});return {};},generator:async()=>{throw new Error('Network lost after sending request');}});assert.equal(calls.at(-1).body.costMicros,settings.maxBudgetMicros);assert.ok(calls.at(-1).body.result.error);
});
test('worker does not spend or call the provider when the estimate cannot fit',async()=>{
  const calls=[];let requested=false;await runJob({...job,settings:{...settings,maxBudgetMicros:1}},{preflight:async()=>{},image,api:async(path,body)=>{calls.push({path,body});return {};},generator:async()=>{requested=true;}});assert.equal(requested,false);assert.equal(calls.at(-1).body.costMicros,0);
});
