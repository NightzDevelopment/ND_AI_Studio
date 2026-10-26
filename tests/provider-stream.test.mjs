import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../worker/provider.mjs';
import { partialChanges } from '../worker/code-preview.mjs';
import { runJob } from '../worker/start.mjs';

const settings={model:'fixture-model',maxOutputTokens:1024,maxCalls:2,maxBudgetMicros:1000000,inputUsdPerMillion:1,outputUsdPerMillion:2};
const job={id:'stream-job',lease:'stream-lease',prompt:'Build source',settings,project:{name:'Test',tool_id:'ai-script-generator',target:'Standalone',requirements:'Test source',files:[]}};
const files=[{path:'client/main.lua',content:'local message = "Hello café"\n'},{path:'README.md',content:'# Source'}];
const source=JSON.stringify({summary:'Source ready',changes:files});
const completed=(extra={})=>({status:'completed',usage:{input_tokens:100,output_tokens:200},output:[{type:'message',content:[{type:'output_text',text:source}]}],...extra});
const event=(type,fields={},multiline=false)=>`event: ${type}\r\n${JSON.stringify({type,...fields},null,multiline?2:0).split('\n').map(line=>'data: '+line).join('\r\n')}\r\n\r\n`;
function stream(text,{fragment=37,onCancel=()=>{}}={}){
  const raw=typeof text==='string'?Buffer.from(text):text;let position=0;
  return new Response(new ReadableStream({pull(controller){if(position>=raw.length){controller.close();return;}controller.enqueue(raw.subarray(position,position+=fragment));},cancel:onCancel}),{headers:{'content-type':'text/event-stream; charset=utf-8'}});
}
const invoke=(response,onPreview=()=>{},current=job)=>generate(current,[],{key:'fixture-private-provider-key',onPreview,fetcher:async(_,options)=>{assert.equal(JSON.parse(options.body).stream,true);return response;}});

test('Responses SSE decodes fragmented UTF-8, CRLF, multiline data and publishes only structured code',async()=>{
  const prefix='{"summary":"Source ready","changes":[{"path":"client/main.lua","content":"local';
  const previews=[];
  const raw=': keepalive\r\nid: 1\r\n\r\n'+event('response.reasoning_text.delta',{delta:'{"changes":[{"path":"private.md","content":"reasoning"}]}'})
    +event('response.output_text.delta',{delta:prefix},true)+event('response.output_text.delta',{delta:source.slice(prefix.length)})
    +event('response.completed',{response:completed()},true);
  const result=await invoke(stream(raw,{fragment:1}),changes=>previews.push(changes));
  assert.deepEqual(result.files,[...files].sort((a,b)=>a.path.localeCompare(b.path)));assert.equal(result.cost,500);
  assert.ok(previews.some(items=>items.some(item=>item.path==='client/main.lua'&&item.content==='local'&&!item.complete)));
  assert.deepEqual(previews.at(-1),files.map(file=>({...file,complete:true})));
  assert.equal(JSON.stringify(previews).includes('reasoning'),false);
});

test('authoritative terminal usage survives trailing malformed events and preview callback failures',async()=>{
  let cancelled=false;
  const result=await invoke(stream(event('response.completed',{response:completed()})+'data: malformed trailer\n\n',{onCancel:()=>{cancelled=true;}}),()=>{throw new Error('Preview UI unavailable');});
  assert.equal(result.cost,500);assert.equal(result.files.length,2);assert.equal(cancelled,true);
  await invoke(stream(event('response.completed',{response:completed()})),async()=>{throw new Error('Asynchronous preview failure');});
});

test('SSE media types are case insensitive and unrelated content-type parameters cannot select streaming',async()=>{
  const body=event('response.completed',{response:completed()});
  const mixed=new Response(body,{headers:{'content-type':'Text/Event-Stream; Charset=UTF-8'}});
  assert.equal((await invoke(mixed)).cost,500);
  const json=new Response(JSON.stringify(completed()),{headers:{'content-type':'application/json; note="text/event-stream"'}});
  assert.equal((await invoke(json)).cost,500);
});

test('incomplete, refused and invalid final source preserve known usage and never turn a preview into success',async()=>{
  const responses=[['response.incomplete',completed({status:'incomplete'})],['response.failed',completed({status:'failed'})],
    ['response.completed',completed({output:[{type:'message',content:[{type:'refusal',refusal:'Declined'}]}]})],
    ['response.completed',completed({output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({summary:'Unsafe',changes:[{path:'../escape.lua',content:'x'}]})}]}]})]];
  for(const [type,response]of responses){
    await assert.rejects(invoke(stream(event('response.output_text.delta',{delta:source})+event(type,{response}))),error=>error.providerCostMicros===500);
  }
});

test('stream truncation, malformed framing, invalid UTF-8 and missing usage remain uncertain failures',async()=>{
  const malformed=[event('response.output_text.delta',{delta:source})+'data: [DONE]\n\n','data: {bad json}\n\n',
    'event: response.completed\ndata: {"type":"response.output_text.delta","delta":"x"}\n\n',Buffer.from([0xff,0xfe]),
    event('response.completed',{response:completed({usage:{}})})];
  for(const raw of malformed)await assert.rejects(invoke(stream(raw)),error=>error.providerCostMicros===undefined);
});

test('completed SSE source with aggregate cache writes is validated and delivered with the full unpriced reservation',async()=>{
  const usage={input_tokens:100,output_tokens:200,input_tokens_details:{cached_tokens:10,cache_write_tokens:30}};
  const receipts=[];let requests=0,validated=0;
  await runJob(job,{key:'fixture-private-provider-key',preflight:async()=>{},
    generator:async(current,base,options)=>generate(current,base,{...options,fetcher:async(_,request)=>{
      requests++;assert.equal(JSON.parse(request.body).stream,true);
      return stream(event('response.output_text.delta',{delta:source})+event('response.completed',{response:completed({usage})}),{fragment:1});
    }}),
    validator:async source=>{validated++;assert.deepEqual(source,[...files].sort((a,b)=>a.path.localeCompare(b.path)));return {ok:true,kind:'ok',checks:['Syntax passed.']};},
    api:async(path,body)=>{if(path==='/api/worker/complete')receipts.push(body);return {};}
  });
  assert.equal(requests,1);assert.equal(validated,1);assert.equal(receipts.length,1);
  assert.equal(receipts[0].costMicros,settings.maxBudgetMicros);assert.equal(receipts[0].result.error,undefined);
  assert.deepEqual(receipts[0].result.accounting,{status:'unreconciled',reason:'cache-write-lifetimes-unavailable'});
});

test('unpriced SSE final usage does not salvage incomplete or malformed authoritative output',async()=>{
  const usage={input_tokens:100,output_tokens:200,input_tokens_details:{cache_write_tokens:30}};
  const invalid=completed({usage,output:[{type:'message',content:[{type:'output_text',text:'{malformed final source'}]}]});
  for(const [type,response]of [['response.incomplete',completed({usage,status:'incomplete'})],['response.completed',invalid]]){
    await assert.rejects(invoke(stream(event('response.output_text.delta',{delta:source})+event(type,{response}))),error=>{
      assert.equal(error.providerCostMicros,settings.maxBudgetMicros);
      assert.deepEqual(error.providerAccounting,{status:'unreconciled',reason:'cache-write-lifetimes-unavailable'});return true;
    });
  }
});

test('decoded output and event lines remain bounded independently from stream framing overhead',async()=>{
  await assert.rejects(invoke(stream(event('response.output_text.delta',{delta:'x'.repeat(2097153)}),{fragment:65536})),/size limit/);
  const many=Array.from({length:6000},()=>': '+('keepalive '.repeat(40))+'\n').join('');
  assert.ok(Buffer.byteLength(many)>2097152);
  const result=await invoke(stream(many+event('response.completed',{response:completed()}),{fragment:65536}));
  assert.equal(result.cost,500);
});

test('stream cancellation closes its body and cannot succeed without terminal authority',async()=>{
  const stop=new AbortController();let cancelled=false,requested=0;
  const body=new ReadableStream({start(controller){controller.enqueue(Buffer.from(event('response.output_text.delta',{delta:'{"changes":['})));},cancel(){cancelled=true;}});
  const pending=generate(job,[],{key:'fixture-private-provider-key',signal:stop.signal,onPreview:()=>{},fetcher:async()=>{requested++;return new Response(body,{headers:{'content-type':'text/event-stream'}});}});
  await new Promise(resolve=>setImmediate(resolve));stop.abort();
  await assert.rejects(pending,error=>error.name==='AbortError'&&error.providerCostMicros===undefined);
  assert.equal(requested,1);assert.equal(cancelled,true);
});

test('DeepSeek remains a single non-streaming request and offers only its complete safe output preview',async()=>{
  const previews=[];let requests=0;
  const result=await generate({...job,settings:{...settings,provider:'deepseek'}},[],{key:'deepseek-fixture-private-key',onPreview:items=>previews.push(items),fetcher:async(address,options)=>{
    requests++;assert.equal(address,'https://api.deepseek.com/responses');assert.equal(JSON.parse(options.body).stream,undefined);
    return new Response(JSON.stringify(completed()),{headers:{'content-type':'application/json'}});
  }});
  assert.equal(requests,1);assert.equal(result.cost,500);assert.deepEqual(previews,[files.map(file=>({...file,complete:true}))]);
});

test('partial structured JSON never treats summary strings as paths or evaluates malformed escapes',()=>{
  const fake=JSON.stringify({summary:'fake "changes":[{"path":"evil.lua","content":"not code"}]',changes:[]});
  assert.deepEqual(partialChanges(fake),[]);
  const base='{"changes":[{"path":"client/main.lua","content":"';
  assert.deepEqual(partialChanges(base+'a\\n\\"b\\u00'),[{path:'client/main.lua',content:'a\n"b',complete:false}]);
  assert.deepEqual(partialChanges(base+'\\uD83D'),[{path:'client/main.lua',content:'',complete:false}]);
  assert.deepEqual(partialChanges(base+'\\uD83D\\uDE80'),[{path:'client/main.lua',content:String.fromCodePoint(0x1f680),complete:false}]);
  assert.deepEqual(partialChanges(base+'\\q'),[]);assert.deepEqual(partialChanges(base+'x\n'),[]);
  assert.deepEqual(partialChanges('{"changes":[{"path":"incomplete'),[]);
  assert.deepEqual(partialChanges('{"changes":[{"path":"old.js","content":nul'),[]);
  assert.deepEqual(partialChanges('{"changes":[{"path":"old.js","content":null'),[{path:'old.js',content:null,complete:true}]);
});

test('preview paths, collisions and per-file/project sizes use the existing source limits',()=>{
  for(const changes of [
    [{path:'../escape.lua',content:'x'}],[{path:'.env',content:'x'}],[{path:'file.js',content:'x'},{path:'FILE.js',content:'y'}],
    [{path:'file.js',content:'x'},{path:'file.js/child.js',content:'y'}],[{path:'file.js',content:'x'.repeat(65537)}],
    Array.from({length:65},(_,index)=>({path:`f${index}.js`,content:'x'})),
    Array.from({length:3},(_,index)=>({path:`f${index}.js`,content:'x'.repeat(65536)})),
  ])assert.deepEqual(partialChanges(JSON.stringify({changes})),[]);
  assert.deepEqual(partialChanges('{"changes":[],"changes":[{"path":"a.js","content":"x"}]}'),[]);
  assert.deepEqual(partialChanges('\u00a0{"changes":[{"path":"a.js","content":"x"}]}'),[]);
  assert.deepEqual(partialChanges(JSON.stringify({changes:Array.from({length:2000},()=>({}))})),[]);
});
