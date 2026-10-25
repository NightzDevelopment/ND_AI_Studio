import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,mkdir,chmod,rm,stat,access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { validate,validateEnvironment,dockerArguments } from '../worker/validate.mjs';
import { runJob } from '../worker/start.mjs';
import { price,generate } from '../worker/provider.mjs';
const require=createRequire(import.meta.url),{inspectProject}=require('../worker/check.cjs');
const image=`sha256:${'b'.repeat(64)}`;
const files=[{path:'fxmanifest.lua',content:"fx_version 'cerulean'\ngame 'gta5'\n"},{path:'README.md',content:'# Source'},{path:'client/deep/main.lua',content:'local ok = true\n'}];
const settings={model:'test-model',maxOutputTokens:1024,maxCalls:2,maxBudgetMicros:1000000,inputUsdPerMillion:1,outputUsdPerMillion:2};
const job={id:'c'.repeat(32),lease:'test-lease',prompt:'Test',settings,project:{name:'Test',tool_id:'ai-script-generator',target:'Standalone',requirements:'Test',files:[]}};
const info=()=>({stdout:JSON.stringify({SecurityOptions:['name=rootless'],CgroupVersion:'2',CgroupDriver:'systemd'})});

test('private service mask is reproduced: requested 0644 becomes unreadable 0600',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'nd-mask-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const script="const fs=require('fs');process.umask(0o077);fs.mkdirSync(process.argv[1]+'/client',{mode:0o755});fs.writeFileSync(process.argv[1]+'/manifest.lua','test',{mode:0o644});";
  assert.equal(spawnSync(process.execPath,['-e',script,directory]).status,0);
  assert.equal((await stat(join(directory,'client'))).mode & 0o777,0o700);assert.equal((await stat(join(directory,'manifest.lua'))).mode & 0o777,0o600);
});
test('staging under UMask=0077 is readable inside the mount but private to host peers',async()=>{
  let workspace,parent;
  const original=process.umask(0o077);
  try {
    const result=await validate(files,'ai-script-generator',{image,runner:async(command,args)=>{
      if(args[0]==='info')return info();if(args[0]==='image')return {stdout:image};
      if(args[0]==='run'){
        workspace=args[args.indexOf('--mount')+1].split(',src=')[1].split(',dst=')[0];parent=dirname(workspace);
        assert.equal((await stat(parent)).mode & 0o777,0o700);assert.equal((await stat(workspace)).mode & 0o777,0o755);
        assert.equal((await stat(join(workspace,'client/deep'))).mode & 0o777,0o755);
        for(const file of files)assert.equal((await stat(join(workspace,file.path))).mode & 0o777,0o644);
        if(process.getuid?.()===0){
          // Start inside the mount root before dropping privileges. Relative reads
          // model the container view, which does not traverse the private host parent.
          const child=spawnSync(process.execPath,['-e',"const fs=require('fs');for(const f of ['fxmanifest.lua','README.md','client/deep/main.lua'])fs.readFileSync(f);console.log('readable');"],{cwd:workspace,uid:65534,gid:65534,encoding:'utf8'});
          assert.equal(child.status,0,child.stderr);assert.equal(child.stdout.trim(),'readable');
        }
        return {stdout:JSON.stringify({ok:true,kind:'ok',checks:['Readable source.']})};
      }
      return {stdout:''};
    }});assert.equal(result.ok,true);
  } finally {process.umask(original);}
  await assert.rejects(access(parent));await assert.rejects(access(workspace));
});
test('inspector classifies filesystem failure as infrastructure rather than repairable source',()=>{
  const result=inspectProject('/path-that-does-not-exist-nd-validator','ai-script-generator');
  assert.equal(result.ok,false);assert.equal(result.kind,'infrastructure');assert.match(result.checks[0],/ENOENT/);
});
test('inspector distinguishes source syntax errors from missing parser tools',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'nd-inspect-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  await writeFile(join(directory,'fxmanifest.lua'),files[0].content);await writeFile(join(directory,'README.md'),'# Source');
  const syntax=inspectProject(directory,'ai-script-generator',()=>({status:1,stderr:'syntax error'}));assert.equal(syntax.kind,'source');
  const infrastructure=inspectProject(directory,'ai-script-generator',()=>({status:null,error:{code:'ENOENT'}}));assert.equal(infrastructure.kind,'infrastructure');
});
test('infrastructure response and legacy unreadable response fail without source repair',async()=>{
  for(const result of [{ok:false,kind:'infrastructure',checks:['Unreadable.']},{ok:false,checks:['Validator could not inspect the project.']}]){
    await assert.rejects(validate(files,'ai-script-generator',{image,runner:async(_,args)=>args[0]==='info'?info():args[0]==='image'?{stdout:image}:{stdout:JSON.stringify(result)}}),error=>error.code==='VALIDATOR_INFRASTRUCTURE');
  }
});
test('preflight exercises nested source staging and never calls a provider',async()=>{
  let checked=false;await validateEnvironment('ai-script-generator',{image,runner:async(_,args)=>{
    if(args[0]==='info')return info();if(args[0]==='image')return {stdout:image};if(args[0]==='run'){const workspace=args[args.indexOf('--mount')+1].split(',src=')[1].split(',dst=')[0];await access(join(workspace,'client/probe.lua'));checked=true;return {stdout:JSON.stringify({ok:true,kind:'ok',checks:[]})};}return {stdout:''};
  }});assert.equal(checked,true);
});
test('failed preflight completes at zero cost without calling generation or repair',async()=>{
  const calls=[];let generated=0;await runJob(job,{image,api:async(path,body)=>{calls.push({path,body});return {};},preflight:async()=>{throw Object.assign(new Error('Validator unavailable.'),{status:503});},generator:async()=>{generated++;}});
  assert.equal(generated,0);assert.equal(calls.at(-1).body.costMicros,0);assert.match(calls.at(-1).body.result.error,/Validator/);
});
test('infrastructure failure after generation never spends a second model call',async()=>{
  const calls=[];let generated=0;await runJob(job,{image,api:async(path,body)=>{calls.push({path,body});return {};},preflight:async()=>{},generator:async()=>{generated++;return {files,summary:'Test',cost:123};},validator:async()=>({ok:false,kind:'infrastructure',checks:['EACCES']})});
  assert.equal(generated,1);assert.equal(calls.at(-1).body.costMicros,123);assert.match(calls.at(-1).body.result.error,/infrastructure/);assert.equal(calls.some(call=>call.body.stage==='repairing'),false);
});
test('cached input uses its configured price and reasoning output is not double counted',()=>{
  const usage={input_tokens:100,output_tokens:80,input_tokens_details:{cached_tokens:40},output_tokens_details:{reasoning_tokens:30}};
  assert.equal(price(usage,{inputUsdPerMillion:2,cachedInputUsdPerMillion:.5,outputUsdPerMillion:10}),940);
  assert.equal(price(usage,{inputUsdPerMillion:2,outputUsdPerMillion:10}),1000);
  assert.throws(()=>price({...usage,input_tokens_details:{cached_tokens:101}},settings));
});
test('known provider usage is preserved even when generated structured output is invalid',async()=>{
  const fetcher=async()=>new Response(JSON.stringify({status:'incomplete',usage:{input_tokens:10,output_tokens:20},output:[]}));
  let failure;try{await generate(job,[],{key:'unit-test-key',fetcher});}catch(error){failure=error;}
  assert.equal(failure.providerCostMicros,50);
  const calls=[];await runJob(job,{image,api:async(path,body)=>{calls.push({path,body});return {};},preflight:async()=>{},generator:async()=>{throw failure;}});
  assert.equal(calls.at(-1).body.costMicros,50);
});
test('validation still disables network, drops capabilities and uses a non-root container user',()=>{
  const args=dockerArguments(image,'test','/tmp/test/workspace','ai-script-generator');
  for(const value of ['--network=none','--read-only','--cap-drop=ALL','65534:65534','--security-opt=no-new-privileges','--memory=256m','--pids-limit=32'])assert.ok(args.includes(value));
});
