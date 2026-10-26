import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreviewPublisher } from '../worker/code-preview.mjs';
import { runJob } from '../worker/start.mjs';

const settle=()=>new Promise(resolve=>setImmediate(resolve));
const files=[{path:'README.md',content:'# Source'}];
const job={id:'live-job',lease:'live-lease',prompt:'Build source',settings:{model:'fixture-model',maxCalls:2,maxOutputTokens:1024,maxBudgetMicros:1000000,inputUsdPerMillion:1,outputUsdPerMillion:2},project:{name:'Test',tool_id:'ai-script-generator',target:'Standalone',requirements:'Test source',files:[]}};
function clock(){
  let time=0,next=0;const tasks=new Map();
  return {now:()=>time,schedule:(callback,delay)=>{const id=++next;tasks.set(id,{callback,at:time+delay});return id;},cancel:id=>tasks.delete(id),
    tick:milliseconds=>{time+=milliseconds;for(const [id,task]of [...tasks])if(task.at<=time){tasks.delete(id);task.callback();}},size:()=>tasks.size};
}

test('publisher serializes requests, coalesces snapshots and keeps job-wide sequence across repair attempts',async()=>{
  const time=clock(),calls=[];let release;
  const publisher=createPreviewPublisher({...time,auth:{id:job.id,lease:job.lease},api:async(path,body)=>{
    calls.push({path,body,time:time.now()});if(calls.length===1)await new Promise(resolve=>{release=resolve;});return {ok:true,accepted:true};
  }});
  publisher.offer(1,[{path:'a.js',content:'a',complete:false}]);await settle();
  publisher.offer(1,[{path:'a.js',content:'ab',complete:false}]);
  publisher.offer(2,[]);publisher.offer(2,[{path:'new.js',content:'new',complete:false}]);
  assert.equal(calls.length,1);release();await settle();time.tick(999);await settle();assert.equal(calls.length,1);
  time.tick(1);await settle();assert.equal(calls.length,2);
  assert.deepEqual(calls.map(call=>call.body.sequence),[1,2]);assert.deepEqual(calls.map(call=>call.body.attempt),[1,2]);
  assert.deepEqual(calls[1].body.changes,[{path:'new.js',content:'new',complete:false}]);assert.equal(calls[1].time-calls[0].time,1000);
  publisher.stop();
});

test('stale accepted:false snapshots do not abort generation or rewind the publisher sequence',async()=>{
  const time=clock(),calls=[];let revoked=0;
  const publisher=createPreviewPublisher({...time,auth:{id:job.id,lease:job.lease},onRevoked:()=>revoked++,api:async(_,body)=>{calls.push(body);return {ok:true,accepted:false,previewVersion:20};}});
  publisher.offer(1,[]);await settle();time.tick(1000);publisher.offer(1,[{path:'a.js',content:'x',complete:true}]);await settle();
  assert.deepEqual(calls.map(body=>body.sequence),[1,2]);assert.equal(revoked,0);publisher.stop();
});

test('preview publication failures disable the optional channel without corrupting validated completion',async()=>{
  for(const status of [undefined,400,404,405,413,500]){
    const calls=[];let generated=0,checked=0;
    await runJob(job,{key:'fixture-private-provider-key',preflight:async()=>{},
      generator:async(_,__,{onPreview})=>{generated++;onPreview([{path:'README.md',content:'# Pa',complete:false}]);await settle();onPreview([{path:'README.md',content:'# Source',complete:true}]);return {files,summary:'Source',cost:123};},
      validator:async()=>{checked++;return {ok:true,kind:'ok',checks:['Passed.']};},
      api:async(path,body)=>{calls.push({path,body});if(path==='/api/worker/preview')throw Object.assign(new Error('Optional preview unavailable'),status===undefined?{}:{status});return {ok:true};}
    });
    assert.equal(generated,1);assert.equal(checked,1);
    const completion=calls.find(call=>call.path==='/api/worker/complete');assert.deepEqual(completion.body.result.files,files);assert.equal(completion.body.costMicros,123);
    assert.equal(calls.filter(call=>call.path==='/api/worker/preview').length,1);
  }
});

test('preview409 lease revocation aborts active work without a paid retry or applying unchecked source',async()=>{
  const calls=[];let generated=0,checked=0;
  await runJob(job,{preflight:async()=>{},
    generator:async(_,__,{onPreview,signal})=>{generated++;onPreview([]);await settle();signal.throwIfAborted();return {files,summary:'Must not finish',cost:123};},
    validator:async()=>{checked++;return {ok:true,checks:[]};},
    api:async(path,body)=>{calls.push({path,body});if(path==='/api/worker/preview')throw Object.assign(new Error('Build lease expired or cancelled.'),{status:409});return {};}
  });
  assert.equal(generated,1);assert.equal(checked,0);
  const completion=calls.find(call=>call.path==='/api/worker/complete');assert.equal(completion.body.result.files,undefined);assert.equal(completion.body.costMicros,job.settings.maxBudgetMicros);
});

test('publisher stop cancels timers and in-flight requests before terminal completion',async()=>{
  const time=clock(),calls=[];let signal;
  const publisher=createPreviewPublisher({...time,auth:{id:job.id,lease:job.lease},api:async(path,body,options)=>{
    calls.push({path,body});signal=options.signal;assert.equal(options.timeout,2000);
    await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  }});
  publisher.offer(1,[]);await settle();publisher.offer(1,[{path:'a.js',content:'x',complete:false}]);publisher.stop();
  assert.equal(signal.aborted,true);time.tick(10000);await settle();assert.equal(calls.length,1);assert.equal(time.size(),0);
  let late=0;const stopped=createPreviewPublisher({auth:{},api:async()=>{late++;}});stopped.offer(1,[]);stopped.stop();await settle();assert.equal(late,0);
});

test('runJob closes a pending preview request before delivering its immutable validated result',async()=>{
  let previewSignal,completed=false;
  await runJob(job,{preflight:async()=>{},
    generator:async(_,__,{onPreview})=>{onPreview([{path:'README.md',content:'# Source',complete:true}]);await settle();return {files,summary:'Source',cost:123};},
    validator:async()=>({ok:true,kind:'ok',checks:['Passed.']}),
    api:async(path,body,options)=>{
      if(path==='/api/worker/preview'){previewSignal=options.signal;return new Promise((_,reject)=>previewSignal.addEventListener('abort',()=>reject(previewSignal.reason),{once:true}));}
      if(path==='/api/worker/complete'){assert.equal(previewSignal.aborted,true);assert.deepEqual(body.result.files,files);completed=true;}
      return {ok:true};
    }
  });
  assert.equal(completed,true);
});
