import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { validateFiles, insist } from '../server/studio-domain.mjs';
const exec = promisify(execFile);
const options = { timeout:10000,maxBuffer:65536,env:{ ...process.env,DOCKER_CLI_HINTS:'false' } };
export async function validatorReady(image, runner=exec) {
  insist(typeof image === 'string' && /^sha256:[a-f0-9]{64}$/.test(image),503,'Pin VALIDATOR_IMAGE to a locally built immutable image ID.');
  const {stdout}=await runner('docker',['info','--format','{{json .}}'],options);
  const info=JSON.parse(stdout);
  insist(info.SecurityOptions?.some(value=>value.includes('rootless')) && info.CgroupVersion === '2' && info.CgroupDriver === 'systemd',503,'An isolated rootless Docker worker with cgroup v2/systemd is required.');
  const result=await runner('docker',['image','inspect',image,'--format','{{.Id}}'],options);
  insist(result.stdout.trim() === image,503,'Validator image is not present.');
  return true;
}
export function dockerArguments(image,name,directory,tool) {
  insist(['ai-script-generator','discord-bot-generator'].includes(tool),400,'Unsupported validator tool.');
  return ['run','--rm','--pull=never','--name',name,'--network=none','--read-only','--user','65534:65534',
    '--cap-drop=ALL','--security-opt=no-new-privileges','--pids-limit=32','--memory=256m','--memory-swap=256m','--cpus=1',
    '--ulimit','nofile=128:128','--ipc=none','--tmpfs','/tmp:rw,noexec,nosuid,size=16m',
    '--mount',`type=bind,src=${directory},dst=/workspace,readonly`,'--workdir','/workspace',image,tool];
}
export async function validate(files,tool,{image,signal,runner=exec}={}) {
  files=validateFiles(files); await validatorReady(image,runner);
  const directory=await mkdtemp(join(tmpdir(),'nd-ai-check-')), name=`nd-ai-check-${randomBytes(12).toString('hex')}`;
  const workspace=join(directory,'workspace');
  try {
    // Keep the parent private on the host. The container sees only its read-only
    // workspace mount, not this parent. Explicit chmod is needed under UMask=0077.
    await chmod(directory,0o700);
    await mkdir(workspace,{mode:0o755}); await chmod(workspace,0o755);
    for (const file of files) {
      const parts=file.path.split('/'); let parent=workspace;
      for (const part of parts.slice(0,-1)) {
        parent=join(parent,part); await mkdir(parent,{recursive:true,mode:0o755});
        await chmod(parent,0o755);
      }
      const target=join(workspace,file.path);
      await writeFile(target,file.content,{mode:0o644,flag:'wx'});
      await chmod(target,0o644);
    }
    const {stdout}=await runner('docker',dockerArguments(image,name,workspace,tool),{...options,timeout:30000,signal});
    const result=JSON.parse(stdout);
    insist(typeof result.ok === 'boolean' && Array.isArray(result.checks) && result.checks.every(check=>typeof check==='string' && check.length<=2000),502,'Validator returned invalid results.');
    if (result.kind === 'infrastructure' || result.checks.includes('Validator could not inspect the project.')) {
      const error=new Error('Validator infrastructure failed. Check the worker image and source permissions. No AI repair was requested.');
      error.status=503; error.code='VALIDATOR_INFRASTRUCTURE'; throw error;
    }
    return result;
  } catch (error) {
    if (signal?.aborted || error.status) throw error;
    const failure=new Error('Validator infrastructure is unavailable. Check the worker image, parser tools and source permissions. No AI repair was requested.');
    failure.status=503; failure.code='VALIDATOR_INFRASTRUCTURE'; throw failure;
  } finally {
    // A timed-out Docker client is not proof that its container stopped.
    await runner('docker',['rm','-f',name],options).catch(()=>{});
    await rm(directory,{recursive:true,force:true});
  }
}

export async function validateEnvironment(tool,options) {
  // A tiny trusted fixture exercises the same nested staging and parser path
  // before sending user content to a paid provider. It never executes source.
  const files=tool === 'ai-script-generator' ? [
    {path:'fxmanifest.lua',content:"fx_version 'cerulean'\ngame 'gta5'\nclient_script 'client/probe.lua'\n"},
    {path:'client/probe.lua',content:'local probe = true\n'},
    {path:'README.md',content:'# Validator readiness probe\n'},
  ] : [
    {path:'package.json',content:JSON.stringify({main:'src/probe.js',dependencies:{'discord.js':'*'}})},
    {path:'src/probe.js',content:'const probe = true;\n'},
    {path:'README.md',content:'# Validator readiness probe\n'},
  ];
  const result=await validate(files,tool,options);
  insist(result.ok,503,'Validator readiness probe failed. No provider request was sent. Rebuild the worker validator.');
}
