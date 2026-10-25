import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { generate, providerPayload, reserveFor } from './provider.mjs';
import { validate, validatorReady } from './validate.mjs';

export async function runJob(job,{ key,image,api,generator=generate,validator=validate,signal }={}) {
  const controller=new AbortController();
  const abort=()=>controller.abort(); signal?.addEventListener('abort',abort,{once:true});
  if (signal?.aborted) controller.abort();
  const auth={ id:job.id,lease:job.lease }; let cost=0, uncertain=false, heartbeatBusy=false;
  const progress=async(stage,message)=>api('/api/worker/progress',{...auth,...(stage ? {stage,message} : {})});
  const timer=setInterval(async()=>{
    if (heartbeatBusy) return; heartbeatBusy=true;
    try { await progress(); } catch { controller.abort(); } finally { heartbeatBusy=false; }
  },10000);
  try {
    let files=job.project.files,summary='',checks=[];
    for (let attempt=0;attempt<job.settings.maxCalls;attempt++) {
      controller.signal.throwIfAborted();
      await progress(attempt ? 'repairing' : 'generating',attempt ? 'Repairing reported syntax or packaging errors within the remaining budget.' : 'Sending the approved project snapshot to the AI provider.');
      if (reserveFor(providerPayload(job,files,checks),job.settings)+cost > job.settings.maxBudgetMicros) {
        await api('/api/worker/complete',{...auth,costMicros:cost,result:{error:'The conservative cost estimate exceeds the remaining build budget. No further provider request was sent.'}}); return;
      }
      uncertain=true;
      const generated=await generator(job,files,{key,signal:controller.signal,spent:cost,diagnostics:checks});
      uncertain=false; cost+=generated.cost; files=generated.files; summary=generated.summary;
      await progress('checking','Checking project structure and syntax in an offline, resource-limited container.');
      const result=await validator(files,job.project.tool_id,{image,signal:controller.signal}); checks=result.checks;
      if (result.ok) {
        await progress('packaging','Preparing the file proposal for review. No project files have been overwritten.');
        await api('/api/worker/complete',{...auth,costMicros:cost,result:{files,summary,checks}}); return;
      }
    }
    await api('/api/worker/complete',{...auth,costMicros:cost,result:{error:`Validation did not pass within the call limit. ${checks.filter(check=>!check.includes('passed')&&!check.startsWith('Not tested')).slice(0,3).join(' ').slice(0,700)}`}});
  } catch (error) {
    // Unknown provider outcomes retain the full reservation. Cancellation never claims a refund.
    const reported=uncertain ? Math.max(cost,job.settings.maxBudgetMicros) : cost;
    const message=controller.signal.aborted ? 'Worker interrupted or build access revoked. Provider work already accepted may still be billed.' : (error?.status ? error.message : 'Build failed. No automatic retry was attempted; inspect the worker configuration and provider billing.');
    await api('/api/worker/complete',{...auth,costMicros:reported,result:{error:message.slice(0,1000)}}).catch(()=>{});
  } finally { clearInterval(timer); signal?.removeEventListener('abort',abort); }
}
export async function main(env=process.env) {
  const origin=new URL(env.STUDIO_ORIGIN || 'https://ai.nightz.dev');
  if (origin.protocol!=='https:' || origin.username || origin.password || origin.pathname!=='/' || origin.search || origin.hash) throw new Error('STUDIO_ORIGIN must be an HTTPS origin.');
  if (!/^[a-f0-9]{64}$/.test(env.STUDIO_WORKER_TOKEN || '')) throw new Error('A private worker token is required.');
  if (!env.OPENAI_API_KEY || /[\r\n]/.test(env.OPENAI_API_KEY)) throw new Error('Configure OPENAI_API_KEY privately on the worker.');
  await validatorReady(env.VALIDATOR_IMAGE);
  const stop=new AbortController(); for (const name of ['SIGINT','SIGTERM']) process.once(name,()=>stop.abort());
  const api=async(path,body)=>{
    const response=await fetch(`${origin.origin}${path}`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{authorization:`Bearer ${env.STUDIO_WORKER_TOKEN}`,'content-type':'application/json'},body:JSON.stringify(body)});
    if (!response.ok) throw new Error(`Worker API status ${response.status}.`);
    const raw=await response.text(); if (raw.length>2097152) throw new Error('Worker response is too large.'); return JSON.parse(raw);
  };
  let healthy=false;
  const heartbeat=setInterval(()=>api('/api/worker/heartbeat',{ready:healthy}).catch(()=>{}),15000);
  try {
    while (!stop.signal.aborted) {
      try {
        await validatorReady(env.VALIDATOR_IMAGE); healthy=true;
        await api('/api/worker/heartbeat',{ready:true});
        const {job}=await api('/api/worker/claim',{});
        if (job) await runJob(job,{key:env.OPENAI_API_KEY,image:env.VALIDATOR_IMAGE,api,signal:stop.signal});
        else await delay(3000,undefined,{signal:stop.signal});
      } catch {
        healthy=false;
        if (!stop.signal.aborted) { console.error('Worker unavailable. Check connectivity, credentials and isolated validator configuration.'); await delay(5000,undefined,{signal:stop.signal}).catch(()=>{}); }
      }
    }
  } finally { clearInterval(heartbeat); await api('/api/worker/heartbeat',{ready:false}).catch(()=>{}); }
}
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    // systemd launches through current; Node normally resolves that release symlink.
    // Canonicalize both paths, including when --preserve-symlinks-main is enabled.
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch { return false; }
}
if (isEntryPoint()) main().catch(()=>{console.error('Worker startup failed. Check its private environment and rootless validator.');process.exitCode=1;});
