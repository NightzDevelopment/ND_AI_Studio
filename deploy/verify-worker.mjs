import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
export async function workerRequest(path, body, env=process.env, fetcher=fetch) {
  if(env.STUDIO_ORIGIN!=='https://ai.nightz.dev' || !/^[a-f0-9]{64}$/.test(env.STUDIO_WORKER_TOKEN || '')) throw new Error('Invalid private worker configuration.');
  const response=await fetcher(`${env.STUDIO_ORIGIN}${path}`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),headers:{authorization:`Bearer ${env.STUDIO_WORKER_TOKEN}`,'content-type':'application/json'},body:JSON.stringify(body)});
  if(!response.ok) throw new Error(`Worker service check failed (${response.status}).`);
  return response.json();
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  try {
    if(process.argv[2]==='reset') await workerRequest('/api/worker/heartbeat',{ready:false});
    else if(process.argv[2]==='ready') {
      const expected=[['openai','OPENAI_API_KEY'],['deepseek','DEEPSEEK_API_KEY']].filter(([,name])=>Boolean(process.env[name])).map(([id])=>id);
      if(!expected.length)throw new Error('Configure at least one provider key privately before checking readiness.');
      const deadline=Date.now()+45000; let ready=false;
      while(Date.now()<deadline){try{const status=await workerRequest('/api/worker/status',{});const providers=status.providers ?? ['openai'];ready=status.ready===true && Array.isArray(providers) && expected.every(id=>providers.includes(id));}catch{}if(ready)break;await delay(1000);}
      if(!ready)throw new Error('The worker did not report ready within 45 seconds.');
    } else throw new Error('Use reset or ready.');
    console.log('Worker connectivity check passed.');
  } catch(error) { console.error(error.message); process.exitCode=1; }
}
