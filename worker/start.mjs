import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { generate, providerPayload, reserveFor, providerLabel, configuredProviders } from './provider.mjs';
import { validate, validatorReady, validateEnvironment } from './validate.mjs';
import { createPreviewPublisher } from './code-preview.mjs';
import { runAgentTask } from './agent.mjs';

async function deliverCompletion(api,body,wait) {
  // This receipt is safe to replay. Provider requests and generation are never retried here.
  const receipt=JSON.stringify(body);
  for (let attempt=0;attempt<3;attempt++) {
    try { return await api('/api/worker/complete',JSON.parse(receipt)); }
    catch (error) {
      const status=error?.status;
      const transient=status === undefined || [408,425,429].includes(status) || (status>=500 && status<600);
      if (!transient || attempt===2) throw error;
      await wait(attempt===0 ? 250 : 1000);
    }
  }
}
export async function runJob(job,{ key,image,api,generator=generate,validator=validate,preflight=validateEnvironment,signal,wait=delay }={}) {
  const controller=new AbortController();
  const abort=()=>controller.abort(); signal?.addEventListener('abort',abort,{once:true});
  if (signal?.aborted) controller.abort();
  const auth={ id:job.id,lease:job.lease }; let cost=0, uncertain=false, heartbeatBusy=false, completion,accounting;
  const preview=createPreviewPublisher({api,auth,signal:controller.signal,onRevoked:()=>controller.abort()});
  const progress=async(stage,message)=>api('/api/worker/progress',{...auth,...(stage ? {stage,message} : {})});
  const timer=setInterval(async()=>{
    if (heartbeatBusy) return; heartbeatBusy=true;
    try { await progress(); } catch { controller.abort(); } finally { heartbeatBusy=false; }
  },10000);
  try {
    controller.signal.throwIfAborted();
    await progress('checking','Checking validator readiness before any paid provider request.');
    controller.signal.throwIfAborted();
    await preflight(job.project.tool_id,{image,signal:controller.signal});
    let files=job.project.files,summary='',checks=[];
    for (let attempt=0;attempt<job.settings.maxCalls;attempt++) {
      controller.signal.throwIfAborted();
      await progress(attempt ? 'repairing' : 'generating',attempt ? 'Repairing reported syntax or packaging errors within the remaining budget.' : `Sending the approved project snapshot to ${providerLabel(job.settings)} model ${job.settings.model}.`);
      controller.signal.throwIfAborted();
      if (reserveFor(providerPayload(job,files,checks),job.settings)+cost > job.settings.maxBudgetMicros) {
        completion={...auth,costMicros:cost,result:{error:'The conservative cost estimate exceeds the remaining build budget. No further provider request was sent.'}}; break;
      }
      preview.offer(attempt+1,[]);
      uncertain=true;
      const generated=await generator(job,files,{key,signal:controller.signal,spent:cost,diagnostics:checks,onPreview:changes=>preview.offer(attempt+1,changes)});
      uncertain=false; cost+=generated.cost; files=generated.files; summary=generated.summary;
      accounting=generated.accounting || accounting;
      controller.signal.throwIfAborted();
      await progress('checking',accounting ? 'Cache-write cost needs reconciliation. The full API budget is retained while source is checked in the offline validator.' : 'Checking project structure and syntax in an offline, resource-limited container.');
      controller.signal.throwIfAborted();
      const result=await validator(files,job.project.tool_id,{image,signal:controller.signal}); checks=result.checks;
      controller.signal.throwIfAborted();
      if (result.kind === 'infrastructure' || (!result.ok && result.kind!=='source')) {
        const failure=new Error('Validator infrastructure failed. No AI repair was requested.'); failure.status=503; throw failure;
      }
      if (result.ok) {
        await progress('packaging','Packaging validated files for Studio to save as a new revision when the project still matches the build snapshot. Runtime behavior has not been tested.');
        controller.signal.throwIfAborted();
        completion={...auth,costMicros:cost,result:{files,summary,checks}}; break;
      }
      if(accounting) {
        completion={...auth,costMicros:cost,result:{error:`Generated source did not pass validation. Cache-write cost needs reconciliation, so no further provider request was sent. ${checks.filter(check=>!check.includes('passed')&&!check.startsWith('Not tested')).slice(0,3).join(' ').slice(0,700)}`}};break;
      }
    }
    completion ||= {...auth,costMicros:cost,result:{error:`Validation did not pass within the call limit. ${checks.filter(check=>!check.includes('passed')&&!check.startsWith('Not tested')).slice(0,3).join(' ').slice(0,700)}`}};
  } catch (error) {
    // Unknown provider outcomes retain the full reservation. Cancellation never claims a refund.
    if (uncertain && Number.isSafeInteger(error?.providerCostMicros) && error.providerCostMicros>=0) {
      cost+=error.providerCostMicros; uncertain=false;
      accounting=error.providerAccounting || accounting;
    }
    const reported=uncertain ? Math.max(cost,job.settings.maxBudgetMicros) : cost;
    const message=controller.signal.aborted ? 'Worker interrupted or build access revoked. Provider work already accepted may still be billed.' : (error?.status ? error.message : 'Build failed. No automatic retry was attempted; inspect the worker configuration and provider billing.');
    completion={...auth,costMicros:reported,result:{error:message.slice(0,1000)}};
  } finally { preview.stop();clearInterval(timer); signal?.removeEventListener('abort',abort); }
  if(accounting)completion.result.accounting=accounting;
  // Terminal progress rejects a completed lease. Stop heartbeats before delivery and keep
  // delivery failures outside the generation catch so a saved result cannot become an error.
  return deliverCompletion(api,completion,wait);
}
export async function main(env=process.env) {
  const origin=new URL(env.STUDIO_ORIGIN || 'https://ai.nightz.dev');
  if (origin.protocol!=='https:' || origin.username || origin.password || origin.pathname!=='/' || origin.search || origin.hash) throw new Error('STUDIO_ORIGIN must be an HTTPS origin.');
  if (!/^[a-f0-9]{64}$/.test(env.STUDIO_WORKER_TOKEN || '')) throw new Error('A private worker token is required.');
  const providers=configuredProviders(env);
  const keys={openai:env.OPENAI_API_KEY,deepseek:env.DEEPSEEK_API_KEY};
  await validatorReady(env.VALIDATOR_IMAGE);
  const stop=new AbortController(); for (const name of ['SIGINT','SIGTERM']) process.once(name,()=>stop.abort());
  const api=async(path,body,{signal:requestSignal,timeout=15000}={})=>{
    const timeoutSignal=AbortSignal.timeout(timeout),signal=requestSignal?AbortSignal.any([requestSignal,timeoutSignal]):timeoutSignal;
    const response=await fetch(`${origin.origin}${path}`,{method:'POST',redirect:'error',signal,headers:{authorization:`Bearer ${env.STUDIO_WORKER_TOKEN}`,'content-type':'application/json','x-nd-studio-agent':'1'},body:JSON.stringify(body)});
    if (!response.ok) { const error=new Error(`Worker API status ${response.status}.`); error.status=response.status; throw error; }
    const raw=await response.text(); if (raw.length>2097152) throw new Error('Worker response is too large.'); return JSON.parse(raw);
  };
  let healthy=false;
  const heartbeat=setInterval(()=>api('/api/worker/heartbeat',{ready:healthy,providers}).catch(()=>{}),15000);
  try {
    while (!stop.signal.aborted) {
      try {
        await validatorReady(env.VALIDATOR_IMAGE); healthy=true;
        await api('/api/worker/heartbeat',{ready:true,providers});
        const {job}=await api('/api/worker/claim',{});
        if (job) {
          const provider=job.settings.provider ?? 'openai';
          if (!providers.includes(provider)) throw new Error('The claimed provider is not configured on this worker.');
          try { await (job.agent ? runAgentTask : runJob)(job,{key:keys[provider],image:env.VALIDATOR_IMAGE,api,signal:stop.signal}); }
          catch (error) {
            // Cancellation, revocation and expired leases end this job, not worker readiness.
            if (error?.status!==409) throw error;
          }
        }
        else await delay(3000,undefined,{signal:stop.signal});
      } catch {
        healthy=false;
        if (!stop.signal.aborted) { console.error('Worker unavailable. Check connectivity, credentials and isolated validator configuration.'); await delay(5000,undefined,{signal:stop.signal}).catch(()=>{}); }
      }
    }
  } finally { clearInterval(heartbeat); await api('/api/worker/heartbeat',{ready:false,providers}).catch(()=>{}); }
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