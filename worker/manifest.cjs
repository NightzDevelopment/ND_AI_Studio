'use strict';
// A bounded lexical inspection of literal manifest metadata, not a Lua evaluator.
// Dynamic expressions and external resources are disclosed, never executed or fetched.
const entries=new Set(['fx_version','game','games','client_script','client_scripts','server_script','server_scripts','shared_script','shared_scripts','file','files','ui_page','loadscreen','data_file','dependency','dependencies']);
const packEntries=new Set(['file','files','client_script','client_scripts','shared_script','shared_scripts']);
function longBracket(source,start) {
  if(source[start]!=='[')return null;
  let end=start+1;while(source[end]==='=')end++;
  if(source[end]!=='[')return null;
  const closing=']'+'='.repeat(end-start-1)+']',close=source.indexOf(closing,end+1);
  return {value:close<0?null:source.slice(end+1,close).replace(/^(?:\r\n|\n\r|\n|\r)/,'').replace(/\r\n|\n\r|\r/g,'\n'),end:close<0?source.length:close+closing.length};
}
function tokenize(source) {
  const tokens=[];let i=0,line=1;
  const newline=char=>char==='\n'||char==='\r';
  const pair=at=>newline(source[at])&&newline(source[at+1])&&source[at]!==source[at+1];
  const advance=end=>{while(i<end){if(newline(source[i])){line++;if(pair(i)&&i+1<end)i++;}i++;}};
  while(i<source.length) {
    if(/\s/.test(source[i])){advance(i+(pair(i)?2:1));continue;}
    if(source.startsWith('--',i)){const block=longBracket(source,i+2);let end=i+2;while(end<source.length&&!newline(source[end]))end++;advance(block?block.end:end);continue;}
    const start=i,at=line,block=longBracket(source,i);
    if(block){tokens.push({kind:'string',value:block.value,line:at});advance(block.end);continue;}
    if(source[i]==="'"||source[i]==='"') {
      const quote=source[i++];let value='',valid=true,closed=false;
      while(i<source.length) {
        let c=source[i++];
        if(c===quote){closed=true;break;}
        if(c!=='\\'){if(newline(c)){line++;valid=false;if(pair(i-1))i++;}value+=c;continue;}
        c=source[i++];
        const escapes={a:'\x07',b:'\b',f:'\f',n:'\n',r:'\r',t:'\t',v:'\v','\\':'\\',"'":"'",'"':'"'};
        if(Object.hasOwn(escapes,c)){value+=escapes[c];continue;}
        if(c==='z'){while(i<source.length&&/\s/.test(source[i]))advance(i+(pair(i)?2:1));continue;}
        if(newline(c)){if(pair(i-1))i++;line++;value+='\n';continue;}
        if(c==='x') {const hex=source.slice(i,i+2);if(!/^[\da-f]{2}$/i.test(hex))valid=false;else{value+=String.fromCharCode(parseInt(hex,16));i+=2;}continue;}
        if(c==='u'&&source[i]==='{') {const end=source.indexOf('}',i+1),hex=end<0?'':source.slice(i+1,end);if(!/^[\da-f]{1,8}$/i.test(hex)||parseInt(hex,16)>0x10ffff)valid=false;else{value+=String.fromCodePoint(parseInt(hex,16));i=end+1;}continue;}
        if(/[0-9]/.test(c||'')){let number=c;while(number.length<3&&/[0-9]/.test(source[i]||''))number+=source[i++];if(Number(number)>255)valid=false;else value+=String.fromCharCode(Number(number));continue;}
        valid=false;
      }
      tokens.push({kind:'string',value:valid&&closed?value:null,line:at});continue;
    }
    if(/[A-Za-z_]/.test(source[i])){i++;while(/[A-Za-z0-9_]/.test(source[i]||''))i++;tokens.push({kind:'id',value:source.slice(start,i),line:at});continue;}
    const operator=source.slice(i,i+2),symbol=['..','==','~=','<=','>=','::'].includes(operator)?operator:source[i];
    tokens.push({kind:'symbol',value:symbol,line:at});i+=symbol.length;
  }
  return tokens;
}
function groupEnd(tokens,start) {
  const closing={'(' : ')','{' : '}','[' : ']'},stack=[];
  for(let i=start;i<tokens.length;i++) {
    const token=tokens[i];if(token.kind!=='symbol')continue;
    if(closing[token.value])stack.push(closing[token.value]);
    else if([')',']','}'].includes(token.value)){if(stack.pop()!==token.value)return tokens.length;if(!stack.length)return i+1;}
  }
  return tokens.length;
}
function argument(tokens,start) {
  const token=tokens[start];
  if(!token)return {values:[],complete:false,next:start};
  if(token.kind==='string')return {values:token.value===null?[]:[token.value],complete:token.value!==null,next:start+1,arguments:1};
  if(token.kind!=='symbol'||!['(','{'].includes(token.value))return {values:[],complete:false,next:start};
  const next=groupEnd(tokens,start),close=token.value==='('?')':'}',values=[];let complete=tokens[next-1]?.value===close,expectValue=true,count=0;
  for(let i=start+1;i<next-1;i++) {
    const item=tokens[i];
    if(expectValue&&item.kind==='string'&&item.value!==null){values.push(item.value);expectValue=false;count++;}
    else if(!expectValue&&item.kind==='symbol'&&(item.value===','||(token.value==='{'&&item.value===';')))expectValue=true;
    else if(token.value==='('&&expectValue&&item.value==='{') {
      const nested=argument(tokens,i);if(!nested.complete||nested.next>next-1)complete=false;
      values.push(...nested.values);i=nested.next-1;expectValue=false;count++;
    } else complete=false;
  }
  if(token.value==='('&&expectValue&&values.length)complete=false;
  return {values:complete?values:[],complete,next,arguments:token.value==='{'?1:count};
}
function declarations(source) {
  const tokens=tokenize(source),calls=[],stack=[],shadowed=new Set();
  for(let i=0;i<tokens.length;i++) {
    const token=tokens[i],name=token.value,previous=tokens[i-1]?.value,next=tokens[i+1];
    if(token.kind==='id'&&name==='local') {
      let j=i+1;if(tokens[j]?.value==='function')j++;
      while(tokens[j]?.kind==='id'){if(entries.has(tokens[j].value))shadowed.add(tokens[j].value);if(tokens[j+1]?.value!==',')break;j+=2;}
    }
    if(token.kind==='id'&&name==='function'){if(entries.has(next?.value))shadowed.add(next.value);stack.push('function');continue;}
    if(token.kind==='id'&&['if','for','while','repeat'].includes(name)){stack.push(name);continue;}
    if(token.kind==='id'&&name==='do'){if(['for','while'].includes(stack.at(-1)))stack[stack.length-1]='loop';else stack.push('do');continue;}
    if(token.kind==='id'&&['end','until'].includes(name)){stack.pop();continue;}
    if(token.kind==='symbol'&&['(','{','['].includes(name)){i=groupEnd(tokens,i)-1;continue;}
    if(token.kind!=='id'||!entries.has(name)||['.',':','local','function'].includes(previous))continue;
    if(next?.value==='='){shadowed.add(name);continue;}
    if(!next||!(next.kind==='string'||['(','{'].includes(next.value)))continue;
    const first=argument(tokens,i+1);let values=first.values,complete=first.complete,end=first.next;
    if(name==='data_file'&&values.length===1) {
      const second=argument(tokens,end);values=[...values,...second.values];complete=complete&&second.complete;end=second.next;
    }
    if(name==='data_file'&&values.length!==2)complete=false;
    if(name!=='data_file'&&first.arguments!==1)complete=false;
    if(['..','.','[',':'].includes(tokens[end]?.value))complete=false;
    calls.push({name,values,complete:complete&&!stack.length&&!shadowed.has(name),line:token.line});
    i=Math.max(i,end-1);
  }
  return calls;
}
// Dynamic programming avoids regex backtracking for hostile wildcard patterns.
function globMatches(pattern,filename) {
  const parts=[];
  for(let i=0;i<pattern.length;i++) {
    if(pattern[i]!=='*'){parts.push({char:pattern[i]});continue;}
    let end=i+1;while(pattern[end]==='*')end++;
    const deep=end-i>1;
    if(deep&&pattern[end]==='/'&&(i===0||pattern[i-1]==='/')){parts.push({kind:'directory'});end++;}
    else parts.push({kind:deep?'deep':'star'});
    i=end-1;
  }
  let next=Array(filename.length+1).fill(false);next[filename.length]=true;
  for(let i=parts.length-1;i>=0;i--) {
    const part=parts[i],current=Array(filename.length+1).fill(false);let directoryTail=false;
    for(let j=filename.length;j>=0;j--) {
      if(part.char!==undefined)current[j]=j<filename.length&&filename[j]===part.char&&next[j+1];
      else if(part.kind==='directory') {directoryTail=j<filename.length&&((filename[j]==='/'&&next[j+1])||directoryTail);current[j]=next[j]||directoryTail;}
      else current[j]=next[j]||(j<filename.length&&(part.kind==='deep'||filename[j]!=='/')&&current[j+1]);
    }
    next=current;
  }
  return next[0];
}
function inspectManifest(source,files) {
  const errors=[],notes=[],seenNotes=new Set(),calls=declarations(source),available=new Set(files),pack=new Set(),pages=[];
  let localReferences=0,externalReferences=0,dynamicPack=false;
  const error=message=>errors.push(message.slice(0,1900));
  const note=message=>{if(!seenNotes.has(message)){seenNotes.add(message);notes.push(message.slice(0,1900));}};
  const label=call=>`fxmanifest.lua:${call.line} ${call.name}`;
  for(const [names,value] of [[['fx_version'],'cerulean'],[['game','games'],'gta5']]) {
    const found=calls.filter(call=>names.includes(call.name)),known=found.filter(call=>call.complete);
    if(!found.length)error(`fxmanifest.lua must declare ${names[0]} '${value}' outside comments and strings.`);
    else if(!known.some(call=>call.values.includes(value))&&!found.some(call=>!call.complete))error(`fxmanifest.lua must declare ${names[0]} '${value}'.`);
  }
  for(const call of calls) {
    if(!call.complete){note(`Not tested: ${label(call)} uses dynamic or scoped Lua metadata; its runtime values were not evaluated.`);if(packEntries.has(call.name))dynamicPack=true;continue;}
    if(['fx_version','game','games'].includes(call.name))continue;
    if(['dependency','dependencies'].includes(call.name)){for(const value of call.values)note(`Not tested: declared dependency ${JSON.stringify(value)} must be available on the target server.`);continue;}
    const isPage=['ui_page','loadscreen'].includes(call.name),isData=call.name==='data_file';
    const values=isData?call.values.slice(1):call.values;
    for(let value of values) {
      const display=JSON.stringify(value);
      if(isPage&&/^https?:\/\//i.test(value)){externalReferences++;note(`Not tested: ${label(call)} uses an external URL; it was not fetched.`);continue;}
      if(value.startsWith('@')) {
        const relative=value.slice(1),slash=relative.indexOf('/');
        if(slash<1||/[\\\x00-\x20\x7f:]/.test(relative)||relative.split('/').some(part=>!part||part==='.'||part==='..'))error(`${label(call)} has an invalid external resource reference ${display}.`);
        else {externalReferences++;note(`Not tested: external resource reference ${display} requires the target resource; it was not fetched.`);}
        continue;
      }
      if(isPage)value=value.split(/[?#]/)[0];
      value=value.replace(/^(?:\.\/)+/,'');
      if(!value||value.length>256||/[\\\x00-\x1f\x7f:]/.test(value)||value.startsWith('/')||value.split('/').some(part=>part==='..'||part==='.'||!part)) {
        error(`${label(call)} has an unsafe or unsupported local path ${display}. Use a resource-relative path.`);continue;
      }
      if(/[?\[\]{}]/.test(value)){note(`Not tested: ${label(call)} uses an unsupported path pattern ${display}; only * and ** globbing are inspected.`);if(packEntries.has(call.name))dynamicPack=true;continue;}
      const pattern=value.includes('*'),matches=pattern?files.filter(file=>globMatches(value,file)):available.has(value)?[value]:[];
      if(isPage&&pattern){error(`${label(call)} must name a page, not the glob ${display}.`);continue;}
      if(isData&&call.values[0]==='AUDIO_WAVEPACK'&&!pattern&&files.some(file=>file.startsWith(value+'/'))) {
        note(`Not tested: ${label(call)} references audio directory ${display}; audio formats were not validated.`);continue;
      }
      if(!matches.length) {
        if(pattern)note(`Warning: ${label(call)} pattern ${display} matches no supplied files. Confirm whether this empty glob is intentional.`);
        else {const similar=files.find(file=>file.toLowerCase()===value.toLowerCase());error(`${label(call)} references missing file ${display}.${similar?` Match the exact case of ${JSON.stringify(similar)}.`:''}`);}
        continue;
      }
      localReferences+=matches.length;
      if(packEntries.has(call.name))for(const file of matches)pack.add(file);
      if(isPage)pages.push({call,path:value});
    }
  }
  for(const page of pages)if(!pack.has(page.path)) {
    if(dynamicPack)note(`Not tested: client packfile coverage for ${JSON.stringify(page.path)} depends on dynamic metadata.`);
    else error(`${label(page.call)} page ${JSON.stringify(page.path)} is not included in the client packfile. Add it to files.`);
  }
  notes.push(`Manifest packaging: ${localReferences} supplied local file matches checked; ${externalReferences} external references not verified.`);
  return {errors,notes};
}
module.exports={inspectManifest,globMatches};
