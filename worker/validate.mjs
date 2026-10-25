import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
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
  try {
    await chmod(directory,0o755);
    for (const file of files) {
      const target=join(directory,file.path); await mkdir(dirname(target),{recursive:true,mode:0o755});
      await writeFile(target,file.content,{mode:0o644,flag:'wx'});
    }
    const {stdout}=await runner('docker',dockerArguments(image,name,directory,tool),{...options,timeout:30000,signal});
    const result=JSON.parse(stdout);
    insist(typeof result.ok === 'boolean' && Array.isArray(result.checks) && result.checks.every(check=>typeof check==='string' && check.length<=2000),502,'Validator returned invalid results.');
    return result;
  } finally {
    // A timed-out Docker client is not proof that its container stopped.
    await runner('docker',['rm','-f',name],options).catch(()=>{});
    await rm(directory,{recursive:true,force:true});
  }
}
