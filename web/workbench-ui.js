// Presentation only. Existing workspace/agent modules retain source, task and billing authority.
const FONT_MIN=12,FONT_MAX=20,FONT_DEFAULT=14;
const LAYOUTS=new Set(['balanced','focus']);
export function projectIdFromHash(value) {
  return /^#project\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.exec(value)?.[1] || null;
}
export function normalizeDisplay(value) {
  return {layout:LAYOUTS.has(value?.layout)?value.layout:'balanced',font:Number.isInteger(value?.font)&&value.font>=FONT_MIN&&value.font<=FONT_MAX?value.font:FONT_DEFAULT};
}
export function sourceLineCount(value) { return typeof value==='string'?value.split('\n').length:1; }
export function describeBuild(value) {
  const state=String(value||'idle').trim().toLowerCase();
  const descriptions={
    idle:['Idle','Choose a saved build to inspect its result, or describe your next change.'],
    queued:['Queued','Waiting for a worker. This build has not replaced your saved source.'],
    running:['Building','The worker is generating and checking source. Saved files and local drafts remain separate.'],
    applied:['Saved','Validated files were saved as a project revision. Review the changes or download the build. Runtime behavior still needs testing.'],
    review:['Review available','Generated files are available for comparison and export. Check the build details before applying a preserved result.'],
    failed:['Failed','This build failed. Inspect the technical log for the actual error. A failed build does not replace your saved project.'],
    cancelled:['Stopped','This build was stopped. Inspect its recorded usage and credit outcome in the technical log.'],
  };
  const known=Object.hasOwn(descriptions,state);
  return {state:known?state:'unknown',label:known?descriptions[state][0]:'Status unavailable',message:known?descriptions[state][1]:'Check the recorded build details. No success or billing outcome is inferred.'};
}

export function initializeWorkbench(doc=document,win=window) {
  const body=doc.body,kind=body?.dataset.workspace;
  if(!['source','agent'].includes(kind)||body.dataset.workbenchEnhanced==='true')return;
  body.dataset.workbenchEnhanced='true';
  const byId=id=>doc.getElementById(id),key=`nd-studio-display-v1:${kind}`;
  let display=normalizeDisplay(null),scheduled=false,lastProject=null,lastText=null,lastStatus=null;
  let disposed=false;
  try{display=normalizeDisplay(JSON.parse(win.localStorage.getItem(key)));}catch{}
  const listeners=[],observers=[];
  const listen=(target,type,fn,options)=>{target?.addEventListener(type,fn,options);listeners.push(()=>target?.removeEventListener(type,fn,options));};
  function persist(){try{win.localStorage.setItem(key,JSON.stringify(display));}catch{/* Display preferences never gate saving source. */}}
  function paintDisplay(){
    body.dataset.workbenchLayout=display.layout;body.dataset.codeSize=String(display.font);
    for(const button of doc.querySelectorAll('button[data-workbench-layout]'))button.setAttribute('aria-pressed',String(button.dataset.workbenchLayout===display.layout));
    if(byId('workbench-font-size'))byId('workbench-font-size').textContent=`${display.font} px`;
    for(const button of doc.querySelectorAll('[data-font-size]'))button.disabled=button.dataset.fontSize==='decrease'?display.font===FONT_MIN:display.font===FONT_MAX;
  }
  for(const button of doc.querySelectorAll('button[data-workbench-layout]'))listen(button,'click',()=>{
    display=normalizeDisplay({...display,layout:button.dataset.workbenchLayout});paintDisplay();persist();
  });
  for(const button of doc.querySelectorAll('[data-font-size]'))listen(button,'click',()=>{
    const delta=button.dataset.fontSize==='decrease'?-1:1;
    display.font=Math.max(FONT_MIN,Math.min(FONT_MAX,display.font+delta));paintDisplay();persist();syncGutter();
  });
  paintDisplay();

  const input=byId('workbench-file-search'),list=byId(kind==='source'?'file-list':'files');
  function filterFiles(){
    if(!list)return;
    const query=(input?.value||'').trim().toLowerCase(),buttons=[...list.querySelectorAll('button')];
    let visible=0;
    for(const button of buttons){const matches=(button.textContent||'').toLowerCase().includes(query);button.hidden=!matches;if(matches)visible++;}
    const empty=byId('workbench-file-empty');if(empty)empty.hidden=!query||visible>0;
    const count=byId('workbench-file-count'),message=query?`${visible} of ${buttons.length} files`:`${buttons.length} ${buttons.length===1?'file':'files'}`;if(count&&count.textContent!==message)count.textContent=message;
  }
  listen(input,'input',filterFiles);
  listen(input,'keydown',event=>{if(event.key==='Escape'&&input.value){event.preventDefault();event.stopPropagation();input.value='';filterFiles();}});

  const source=byId(kind==='source'?'code-editor':'code');
  let gutter=null;
  if(source){
    const parent=source.parentElement;
    gutter=doc.createElement('div');gutter.className='source-gutter';gutter.setAttribute('aria-hidden','true');
    gutter.append(doc.createElement('pre'));
    if(kind==='agent'){
      const shell=doc.createElement('div');shell.className='source-code-shell';parent.insertBefore(shell,source);shell.append(gutter,source);
    }else parent.prepend(gutter);
    listen(source,'input',()=>schedule());
    listen(source,'scroll',syncGutter,{passive:true});
  }
  function syncGutter(){
    if(!gutter||!source)return;
    if(source.value!==lastText){lastText=source.value;gutter.firstElementChild.textContent=Array.from({length:sourceLineCount(lastText)},(_,i)=>i+1).join('\n');}
    gutter.scrollTop=source.scrollTop;
  }
  function updateLinks(){
    const id=projectIdFromHash(win.location.hash);
    if(id!==lastProject){lastProject=id;if(input)input.value='';}
    for(const link of doc.querySelectorAll('[data-agent-link]'))link.href=id?`/agent.html#project/${id}`:'/agent.html';
    for(const link of doc.querySelectorAll('[data-source-link],#workbench-source-link'))link.href=id?`/workspace.html#project/${id}`:'/workspace.html#projects';
    if(kind==='source')body.dataset.projectOpen=String(Boolean(id&&byId('editor-view')&&!byId('editor-view').hidden));
  }
  function buildSummary(){
    if(kind!=='source')return;
    const descriptor=describeBuild(byId('build-state')?.textContent),badge=byId('workbench-build-status'),copy=byId('workbench-build-summary');
    if(badge){if(badge.textContent!==descriptor.label)badge.textContent=descriptor.label;badge.dataset.state=descriptor.state;}
    if(copy&&copy.textContent!==descriptor.message)copy.textContent=descriptor.message;
    if(descriptor.state==='failed'&&lastStatus!=='failed'&&byId('build-log-disclosure'))byId('build-log-disclosure').open=true;
    lastStatus=descriptor.state;
  }
  function update(){if(disposed)return;updateLinks();filterFiles();syncGutter();buildSummary();}
  function schedule(){if(scheduled||disposed)return;scheduled=true;win.requestAnimationFrame(()=>{scheduled=false;update();});}
  function observe(node,options){if(!node)return;const observer=new win.MutationObserver(schedule);observer.observe(node,options);observers.push(observer);}
  observe(list,{childList:true,subtree:true,characterData:true});
  observe(byId('code-highlight'),{childList:true,subtree:true,characterData:true});
  observe(byId('build-state'),{childList:true,subtree:true,characterData:true});
  observe(byId('editor-view'),{attributes:true,attributeFilter:['hidden']});
  listen(doc,'studio:workbench-view',schedule);listen(win,'hashchange',schedule);
  listen(byId('workbench-show-log'),'click',()=>{
    const disclosure=byId('build-log-disclosure');if(!disclosure)return;disclosure.open=true;
    disclosure.querySelector('summary')?.focus({preventScroll:true});disclosure.scrollIntoView({block:'nearest'});
  });
  const tabs=[...doc.querySelectorAll(kind==='agent'?'.mobile-tabs button[data-panel]':'.mobile-panels button[data-panel]')];
  for(const button of tabs)listen(button,'keydown',event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();const index=tabs.indexOf(button);
    const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
    tabs[next].click();tabs[next].focus();
  });
  update();
  return ()=>{disposed=true;for(const disconnect of listeners)disconnect();for(const observer of observers)observer.disconnect();};
}
if(typeof document!=='undefined')initializeWorkbench();
