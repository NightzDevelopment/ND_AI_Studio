import { filePath,validateFiles } from '../server/studio-domain.mjs';

// Read a JSON prefix as data. Incomplete strings retain only fully decoded escapes;
// the final provider response still goes through the ordinary strict validation.
export function partialChanges(text) {
  if(typeof text!=='string'||Buffer.byteLength(text)>2097152)return [];
  let position=0,nodes=0;
  const whitespace=()=>{while(/[ \t\r\n]/.test(text[position]||'')&&position<text.length)position++;};
  function string(){
    position++;let value='';
    while(position<text.length){
      const char=text[position++];
      if(char==='"')return {type:'string',value,complete:true};
      if(char.charCodeAt(0)<32)throw new Error('Invalid JSON string.');
      if(char!=='\\'){value+=char;continue;}
      if(position===text.length)break;
      const escaped=text[position++],simple={'"':'"','\\':'\\','/':'/',b:'\b',f:'\f',n:'\n',r:'\r',t:'\t'};
      if(Object.hasOwn(simple,escaped)){value+=simple[escaped];continue;}
      if(escaped!=='u')throw new Error('Invalid JSON escape.');
      const digits=text.slice(position,position+4);
      if(!/^[a-fA-F0-9]*$/.test(digits))throw new Error('Invalid Unicode escape.');
      if(digits.length<4){position=text.length;break;}
      value+=String.fromCharCode(parseInt(digits,16));position+=4;
    }
    // Do not publish half of an escaped surrogate pair between provider deltas.
    if(/[\uD800-\uDBFF]$/.test(value))value=value.slice(0,-1);
    return {type:'string',value,complete:false};
  }
  function value(depth=0){
    if(depth>12)throw new Error('JSON nesting exceeds preview bounds.');
    if(++nodes>1024)throw new Error('JSON structure exceeds preview bounds.');
    whitespace();if(position===text.length)return null;
    if(text[position]==='"')return string();
    const char=text[position];
    if(char==='{'||char==='['){
      position++;const object=char==='{',node={type:object?'object':'array',members:new Map(),items:[],complete:false};
      whitespace();if(text[position]===(object?'}':']')){position++;node.complete=true;return node;}
      while(position<text.length){
        let key;
        if(object){
          whitespace();if(position===text.length)return node;
          if(text[position]!=='"')throw new Error('Invalid object key.');
          const name=string();if(!name.complete)return node;key=name.value;
          if(node.members.has(key))throw new Error('Duplicate object key.');
          whitespace();if(position===text.length)return node;
          if(text[position++]!==':')throw new Error('Invalid object separator.');
        }
        const item=value(depth+1);if(!item)return node;
        if(object)node.members.set(key,item);else node.items.push(item);
        if(!item.complete)return node;
        whitespace();if(position===text.length)return node;
        const next=text[position++];
        if(next===(object?'}':']')){node.complete=true;return node;}
        if(next!==',')throw new Error('Invalid JSON separator.');
        whitespace();if(position===text.length)return node;
      }
      return node;
    }
    for(const literal of ['null','true','false'])if(text[position]===literal[0]){
      const remaining=text.slice(position,position+literal.length);
      if(!literal.startsWith(remaining))throw new Error('Invalid JSON literal.');
      position+=remaining.length;return {type:literal,value:literal==='null'?null:literal==='true',complete:remaining===literal};
    }
    const number=/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(position));
    if(!number)throw new Error('Invalid JSON value.');
    position+=number[0].length;return {type:'number',value:Number(number[0]),complete:true};
  }
  try{
    const root=value();whitespace();if(root?.complete&&position!==text.length)return [];
    const changes=root?.type==='object'?root.members.get('changes'):null;
    if(changes?.type!=='array'||changes.items.length>64)return [];
    const preview=[];
    for(const item of changes.items){
      if(item.type!=='object')return [];
      const path=item.members.get('path'),content=item.members.get('content');
      if(!path?.complete||path.type!=='string'||!content)continue;
      filePath(path.value);
      if(content.type==='null'&&content.complete)preview.push({path:path.value,content:null,complete:true});
      else if(content.type==='string'&&content.value.isWellFormed())preview.push({path:path.value,content:content.value,complete:content.complete});
    }
    validateFiles(preview.map(item=>({path:item.path,content:item.content??''})));
    return preview;
  }catch{return [];}
}

export function createPreviewPublisher({api,auth,signal,onRevoked,now=Date.now,schedule=setTimeout,cancel=clearTimeout,interval=1000}) {
  let latest=null,running=false,closed=false,disabled=false,timer=null,lastStarted=-Infinity,sequence=0,request=null;
  function pump(){
    if(closed||disabled||signal?.aborted||running||timer||!latest)return;
    const remaining=interval-(now()-lastStarted);
    if(remaining>0){timer=schedule(()=>{timer=null;pump();},remaining);timer?.unref?.();return;}
    const snapshot=latest;latest=null;running=true;lastStarted=now();request=new AbortController();
    const requestSignal=signal?AbortSignal.any([signal,request.signal]):request.signal;
    Promise.resolve().then(()=>{if(closed||signal?.aborted)return;return api('/api/worker/preview',{...auth,sequence:++sequence,...snapshot},{signal:requestSignal,timeout:2000});}).catch(error=>{
      if(closed)return;
      disabled=true;latest=null;
      if(error?.status===409)onRevoked?.();
    }).finally(()=>{running=false;request=null;pump();});
  }
  return {
    offer(attempt,changes){
      if(closed||disabled||signal?.aborted)return;
      // Retain only one bounded latest snapshot while the previous request is pending.
      try{const raw=JSON.stringify({attempt,changes});if(Buffer.byteLength(raw)>1048576)return;latest=JSON.parse(raw);}catch{return;}
      pump();
    },
    stop(){closed=true;latest=null;if(timer)cancel(timer);timer=null;request?.abort();},
  };
}
