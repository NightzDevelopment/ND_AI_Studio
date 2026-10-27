import { setTimeout as delay } from 'node:timers/promises';
import { digest } from '../server/studio-domain.mjs';
import { prepareAgentRequest, requestAgentAction } from './agent-provider.mjs';
import { validate, validateEnvironment } from './validate.mjs';
import { failureDiagnostic } from '../server/agent-errors.mjs';

// Retry only immutable API receipts. This never repeats a paid provider request.
export async function deliverAgentReceipt(api,path,body,{wait=delay}={}) {
  const frozen=JSON.stringify(body);let last;
  for(let attempt=0;attempt<3;attempt++){
    try{return await api(path,JSON.parse(frozen));}
    catch(error){last=error;if(error.status&&error.status<500&&error.status!==429)throw error;if(attempt<2)await wait(250*(attempt+1));}
  }
  throw last;
}
export async function runAgentTask(job,{key,image,api,signal,turn=requestAgentAction,validator=validate,preflight=validateEnvironment,wait=delay}={}) {
  const auth={id:job.id,lease:job.lease},controller=new AbortController();
  const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)controller.abort();
  let busy=false,ready=false,inFlight=null,receiptPending=false;
  const heartbeat=setInterval(async()=>{
    if(busy)return;busy=true;
    try{await api('/api/agent/worker/heartbeat',auth);}
    catch(error){if(error.status===409)controller.abort();}
    finally{busy=false;}
  },10000);
  const send=(path,body)=>deliverAgentReceipt(api,path,body,{wait});
  const fail=(reason,error,callId)=>send('/api/agent/worker/fail',{...auth,callId:callId||null,reason,
    costMicros:Number.isSafeInteger(error?.providerCostMicros)?error.providerCostMicros:0,
    uncertain:Boolean(error?.providerAccounting||error?.uncertain||callId&&!Number.isSafeInteger(error?.providerCostMicros)),
    diagnostic:error?.diagnostic||failureDiagnostic(reason==='provider'?'provider_unknown':reason==='action'?'invalid_action':reason==='budget'?'budget':'platform')});
  try{
    while(!controller.signal.aborted){
      const next=await api('/api/agent/worker/next',auth);if(next.stopped)return;
      const context=next.context;
      if(!ready&&context.phase==='build'){
        try{await preflight(context.project.tool,{image,signal:controller.signal});ready=true;}
        catch(error){if(controller.signal.aborted)throw error;await fail('platform',{providerCostMicros:0,diagnostic:failureDiagnostic('validator_infrastructure')});return;}
      }
      let prepared;
      try{prepared=prepareAgentRequest(context);}
      catch(error){await fail('platform',error);return;}
      if(context.spentMicros+prepared.estimateMicros>context.budgetMicros){await fail('budget',{providerCostMicros:0});return;}
      // A lost dispatch acknowledgement cannot be retried: acceptance may already
      // have consumed this call identity. Expiry fails/refunds rather than replaying.
      const dispatch=await api('/api/agent/worker/dispatch',{...auth,index:context.steps,requestHash:prepared.requestHash,estimateMicros:prepared.estimateMicros});
      if(!dispatch.allowed)return;
      inFlight=dispatch.callId;
      let generated;
      try{generated=await turn(context,prepared,{key,signal:controller.signal});}
      catch(error){await fail(error.diagnostic?.category==='invalid_action'?'action':error.providerFailure===false?'platform':'provider',error,inFlight);inFlight=null;return;}
      // Keep delivery outside the provider catch. A committed success with a lost
      // acknowledgement must never be replaced by a failure or a refund.
      receiptPending=true;
      let result;
      try{result=await send('/api/agent/worker/step',{...auth,callId:inFlight,...generated});}
      catch(error){
        if([400,413,422].includes(error.status)){receiptPending=false;await fail('action',{providerCostMicros:generated.costMicros,uncertain:generated.unreconciled,diagnostic:failureDiagnostic('invalid_action')},inFlight);inFlight=null;return;}
        throw error;
      }
      receiptPending=false;const callId=inFlight;inFlight=null;
      if(result.stopped)return;
      if(result.validation){
        let checked;
        try{checked=await validator(result.files,context.project.tool,{image,signal:controller.signal});}
        catch(error){if(controller.signal.aborted)throw error;checked={ok:false,kind:'infrastructure',checks:['Isolated validation infrastructure could not complete. No paid repair was requested.']};}
        receiptPending=true;
        const saved=await send('/api/agent/worker/validation',{...auth,callId,filesHash:digest(JSON.stringify(result.files)),result:checked});
        receiptPending=false;if(saved.state!=='running')return;
      }
    }
  }catch(error){
    // Preserve uncertain dispatch or committed receipt state for durable recovery.
    // Do not invent a second completion or provider request after transport loss.
    if(error?.status===409)return;
    if(!inFlight&&!receiptPending&&!controller.signal.aborted){await fail('platform',{providerCostMicros:0}).catch(()=>{});}
    throw error;
  }finally{clearInterval(heartbeat);signal?.removeEventListener('abort',abort);}
}
