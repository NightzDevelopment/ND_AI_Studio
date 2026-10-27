import { refreshSelects, confirmAction } from './controls.js';
import { createModelControls } from './models.js';
import { renderBilling } from './billing.js';
import { SourceDrafts, draftStorageKey } from './workspace-drafts.js';
const $=id=>document.getElementById(id);
const state={ session:null, capabilities:null, catalog:null, projects:[], project:null, selected:null, tabs:[], drafts:new SourceDrafts(), jobs:[], job:null, briefList:[], editingProject:false, fileMode:'new', managedUser:null, adminTab:null, settings:null, review:null, route:location.hash || '#projects', pollBusy:false, capabilitiesAt:0, buildSubmitting:false, draftStorageFailed:false, draftRecovery:null, sourceJobsAt:'', projectDialog:null, fileDialog:null, sourceWrites:new Set(), selectedJobId:null, draftOwnerId:null, blockedDraftKeys:new Set(), initialized:false, previewFile:null, previewJobId:null, previewSignature:'', syncUnavailable:false, lastSyncError:null };
let toastTimer, routeSequence=0, highlightFrame=0;
let pendingBuildRequest=null, jobsRequestSequence=0, jobSelectionSequence=0, adminViewSequence=0, userSearchSequence=0, jobDetailSequence=0, jobsLoad=null, idlePollTick=false, rescueUrl=null;
const models=createModelControls({api,el,button,field,selectField,table,notice,confirmAction,reasonDialog,getUserId:()=>state.session?.user?.id||null,onChange:renderBuilds});
function el(tag,className,text) { const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node; }
function button(label,action,className='') { const node=el('button',className,label);node.type='button';node.addEventListener('click',()=>task(node,action));return node; }
function link(label,href,className='') { const node=el('a',className,label);node.href=href;return node; }
function notice(message) { $('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,5500); }
function error(message) { $('error').textContent=message;$('error').hidden=false; }
async function task(node,action) { if(node?.disabled)return; const sequence=routeSequence;if(node){$('error').hidden=true;node.disabled=true;}try{await action();}catch(failure){if(sequence===routeSequence||failure.status===401&&!failure.staleAuthentication)error(failure.message || 'This action could not be completed.');}finally{if(node)node.disabled=false;updateSaveState();if(node===$('generate-button'))renderBuilds();} }
function closeDialogs(){document.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close());}
function expireSession(){
  if(state.session?.user){persistDrafts();routeSequence++;state.session.user=null;state.session.csrf=null;}
  state.capabilities=null;state.projectDialog=null;state.fileDialog=null;state.review=null;state.draftRecovery=null;
  $('new-project').disabled=true;$('admin-nav').hidden=true;
  closeDialogs();show('login');
  if(dirty()){
    if(rescueUrl)URL.revokeObjectURL(rescueUrl);
    const files=[...state.drafts.keys()].map(path=>({path,content:state.drafts.get(path),baseVersion:state.drafts.record(path).baseVersion}));
    rescueUrl=URL.createObjectURL(new Blob([JSON.stringify({projectId:state.project?.id,files},null,2)],{type:'application/json'}));
    let rescue=$('recover-expired-drafts');if(!rescue){rescue=el('a','secondary','Download unsaved drafts');rescue.id='recover-expired-drafts';$('login').append(rescue);}
    rescue.href=rescueUrl;rescue.download='nd-studio-unsaved-drafts.json';
  }
}
async function api(path,{method='GET',body}={}) {
  if(method!=='GET'&&!state.session?.user)throw new Error('Sign in again before changing your workspace. Your local drafts have been preserved.');
  const authentication={userId:state.session?.user?.id??null,csrf:state.session?.csrf??null};
  const headers={};if(body!==undefined){headers['content-type']='application/json';headers['x-csrf-token']=state.session?.csrf || '';}
  const response=await fetch(path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',credentials:'same-origin',redirect:'error',signal:AbortSignal.timeout(20000)});
  const staleAuthentication=response.status===401&&(authentication.userId!==(state.session?.user?.id??null)||authentication.csrf!==(state.session?.csrf??null));
  if(response.status===401&&!staleAuthentication)expireSession();
  let data;try{data=await response.json();}catch{const failure=new Error(staleAuthentication?'Your sign-in changed while this request was running. Retry the action in your current session.':response.status===401?'Your session ended. Sign in again. Your local drafts are preserved.':'The server returned an unexpected response. Check the Studio deployment.');failure.status=response.status;failure.staleAuthentication=staleAuthentication;throw failure;}
  if(!response.ok){const failure=new Error(staleAuthentication?'Your sign-in changed while this request was running. Retry the action in your current session.':data?.error || `Request failed (${response.status}).`);failure.status=response.status;failure.staleAuthentication=staleAuthentication;throw failure;}return data;
}
function workspaceContext(projectRequired=true){
  const userId=state.session?.user?.id;
  if(!userId||projectRequired&&(!state.project||state.draftOwnerId!==userId))throw new Error('Open a project after signing in before changing source.');
  return {userId,projectId:projectRequired?state.project.id:null,version:projectRequired?state.project.version:null,sequence:routeSequence};
}
function contextCurrent(context,revision=false){
  return Boolean(context&&context.userId===state.session?.user?.id&&context.sequence===routeSequence&&(!context.projectId||context.projectId===state.project?.id&&state.draftOwnerId===context.userId)&&(!revision||context.version===state.project?.version));
}
function requireContext(context,revision=true){if(!contextCurrent(context,revision))throw new Error('The workspace changed. Reopen this action in the current project before saving.');}
const writeKey=context=>`${context.userId}:${context.projectId}`;
function sourceBusy(){return Boolean(state.project&&state.sourceWrites.has(`${state.session?.user?.id}:${state.project.id}`));}
async function sourceWrite(context,action){
  requireContext(context);
  const key=writeKey(context);if(state.sourceWrites.has(key))throw new Error('A source change is still being saved. Wait for it to finish before saving another change.');
  state.sourceWrites.add(key);updateSaveState();renderBuilds();
  try{return await action();}
  catch(failure){
    if(failure.status===409&&contextCurrent(context)){
      try{const {project}=await api(`/api/projects/${context.projectId}`);if(contextCurrent(context)){setProject(project,true);renderEditor();}}catch{}
    }
    throw failure;
  }finally{state.sourceWrites.delete(key);updateSaveState();renderBuilds();}
}

const money=value=>`$${(value/1000000).toFixed(4)}`;
const minimumMoney=value=>`$${(value/1000000).toFixed(6).replace(/0{1,2}$/,'')}`;
const time=value=>new Date(value).toLocaleString();
function dirty(){return state.drafts.size>0;}
function panel(name){$('workbench').dataset.panel=name;document.querySelectorAll('[data-panel]').forEach(node=>{if(node.tagName==='BUTTON')node.setAttribute('aria-pressed',String(node.dataset.panel===name));});}
function show(name){if(name!=='editor-view')clearLivePreview();for(const id of ['loading','login','route-error','dashboard','editor-view','admin-view','billing-view'])$(id).hidden=id!==name;}
function toolName(id){return state.catalog?.tools.find(tool=>tool.id===id)?.name || id;}
function formError(form,message){const target=form.querySelector('.form-error');target.textContent=message;target.hidden=!message;}
async function submit(form,action){
  const node=form.querySelector('[type=submit]'),sequence=routeSequence;if(node.disabled)return;
  const freeze=['project-form','file-form','user-form'].includes(form.id),controls=freeze?[...form.querySelectorAll('input,textarea,select')].map(input=>[input,input.disabled]):[];
  $('error').hidden=true;node.disabled=true;for(const [input]of controls)input.disabled=true;if(freeze)refreshSelects(form);formError(form,'');
  try{await action();}catch(failure){if(sequence===routeSequence)formError(form,failure.message);else if(failure.status===401&&!failure.staleAuthentication)error(failure.message);}
  finally{for(const [input,disabled]of controls)input.disabled=disabled;node.disabled=false;if(freeze)refreshSelects(form);}
}
function field(labelText,type,value,name){const label=el('label','',labelText),input=el('input');input.type=type;input.name=name;input.value=value;label.append(input);return {label,input};}
function selectField(labelText,options,value,name){const label=el('label','',labelText),select=el('select');select.name=name;for(const [id,text] of options){const option=el('option','',text);option.value=id;select.append(option);}select.value=value;label.append(select);return {label,input:select};}
function table(headers){const wrap=el('div','table-wrap'),table=el('table'),head=el('thead'),tr=el('tr'),body=el('tbody');headers.forEach(text=>tr.append(el('th','',text)));head.append(tr);table.append(head,body);wrap.append(table);return {wrap,body};}
function workerStatus(){const ready=state.capabilities?.workerReady;$('worker-status').textContent=ready?'Isolated worker connected':'Generation worker not connected';$('worker-status').classList.toggle('ready',Boolean(ready));}
function renderProjects(){
  const query=$('project-search').value.toLowerCase().trim(),filter=$('project-filter').value;
  let rows=state.projects.filter(project=>(filter==='all'||(filter==='archived'?project.archived:!project.archived))&&(filter!=='favorites'||project.favorite)&&`${project.name} ${project.requirements} ${project.target}`.toLowerCase().includes(query));
  rows.sort($('project-sort').value==='name'?(a,b)=>a.name.localeCompare(b.name):(a,b)=>b.updated_at.localeCompare(a.updated_at));
  $('project-count').textContent=`${rows.length} of ${state.projects.length} private projects`;
  $('project-grid').replaceChildren(...rows.map(project=>{
    const card=el('article','project-card'),top=el('div','card-heading');top.append(el('span','tool-label',toolName(project.tool_id)),el('span','favorite',project.archived?'Archived':project.favorite?'Favorite':''));
    const footer=el('div','card-footer');footer.append(el('span','',`Revision ${project.version} / ${new Date(project.updated_at).toLocaleDateString()}`),link('Open project',`#project/${project.id}`,'secondary'));
    card.append(top,el('h2','',project.name),el('p','',project.requirements.slice(0,160)+(project.requirements.length>160?'...':'')),footer);return card;
  }));
  if(!rows.length){const empty=el('div','empty');empty.append(el('h2','',query?'No matching projects.':'Your next build starts here.'),el('p','',query?'Try another search or view.':'Create a private source workspace or turn a saved brief into a project.'),button('Create a project',()=>openProjectDialog(), 'primary'));$('project-grid').append(empty);}
}
async function loadDashboard(){const context=workspaceContext(false),result=await api('/api/projects');if(!contextCurrent(context))return;state.projects=result.projects;workerStatus();renderProjects();}
async function openProjectDialog(edit=false){
  if($('project-form').querySelector('[type=submit]').disabled)throw new Error('The previous project change is still being saved. Wait for it to finish before opening another project form.');
  const context=workspaceContext(edit),descriptor={context,edit};state.projectDialog=descriptor;
  state.editingProject=edit;const form=$('project-form');form.reset();formError(form,'');$('project-flags').hidden=!edit;$('brief-import-label').hidden=edit;$('project-dialog-title').textContent=edit?'Project details.':'Start a new project.';
  $('project-tool').replaceChildren(...state.catalog.tools.filter(tool=>tool.category!=='browse').map(tool=>{const option=el('option','',tool.name);option.value=tool.id;return option;}));
  if(edit){const p=state.project;form.elements.name.value=p.name;form.elements.requirements.value=p.requirements;form.elements.toolId.value=p.tool_id;form.elements.target.value=p.target;form.elements.favorite.checked=Boolean(p.favorite);form.elements.archived.checked=Boolean(p.archived);}
  else {const {briefs}=await api('/api/briefs');if(state.projectDialog!==descriptor||!contextCurrent(context))return;state.briefList=briefs;$('brief-import').replaceChildren(new Option('Start from scratch',''),...state.briefList.map(brief=>new Option(brief.name,brief.id)));form.elements.target.value=state.session.user.preferredFramework || 'Standalone';}
  if(state.projectDialog!==descriptor||!contextCurrent(context,edit))return;
  form.elements.toolId.disabled=edit;form.elements.target.disabled=edit;refreshSelects(form);$('project-dialog').showModal();form.elements.name.focus();
}
$('brief-import').addEventListener('change',()=>{const brief=state.briefList.find(brief=>brief.id===$('brief-import').value);if(!brief)return;const form=$('project-form');for(const key of ['name','requirements','toolId','target'])form.elements[key].value=brief[key];refreshSelects(form);});
$('project-form').addEventListener('submit',event=>{event.preventDefault();submit(event.currentTarget,async()=>{
  const form=event.currentTarget,e=form.elements,descriptor=state.projectDialog;
  if(!descriptor)throw new Error('Reopen project setup before saving.');
  const {context,edit}=descriptor;requireContext(context,edit);
  const body=edit?{version:context.version,name:e.name.value.trim(),requirements:e.requirements.value.trim(),favorite:e.favorite.checked,archived:e.archived.checked}:{name:e.name.value.trim(),requirements:e.requirements.value.trim(),toolId:e.toolId.value,target:e.target.value};
  const save=()=>api(edit?`/api/projects/${context.projectId}`:'/api/projects',{method:edit?'PATCH':'POST',body});
  const result=edit?await sourceWrite(context,save):await save();
  if(state.projectDialog!==descriptor||!contextCurrent(context))return;
  $('project-dialog').close();if(edit){setProject(result.project,true);renderEditor();}else{location.hash=`project/${result.project.id}`;}notice('Project saved.');
});});
function persistDrafts(){
  if(!state.project||!state.draftOwnerId)return;
  try{
    const key=draftStorageKey(state.draftOwnerId,state.project.id);
    if(state.blockedDraftKeys.has(key))throw new Error('Unreadable recovery data is preserved.');
    if(dirty())sessionStorage.setItem(key,state.drafts.serialize(state.draftOwnerId,state.project.id,state.tabs,state.selected,state.project.version));
    else sessionStorage.removeItem(key);
    state.draftStorageFailed=false;
  }catch{state.draftStorageFailed=true;}
  $('draft-storage-warning').hidden=!state.draftStorageFailed;
}
function restoreDrafts(project){
  const userId=state.session.user.id,key=draftStorageKey(userId,project.id);state.draftOwnerId=userId;
  try{
    const raw=sessionStorage.getItem(key);
    if(raw){try{const recovered=state.drafts.restore(raw,userId,project.id);state.tabs=recovered.tabs;state.selected=recovered.selected;notice('Unsaved source drafts recovered in this browser tab.');}catch(failure){state.blockedDraftKeys.add(key);throw failure;}}
    state.draftStorageFailed=false;$('draft-storage-warning').hidden=true;
  }catch{state.draftStorageFailed=true;$('draft-storage-warning').hidden=false;error('Browser draft recovery is unavailable or contains invalid data. Existing recovery data has been left untouched. Keep this tab open and copy important unsaved source before leaving.');}
}
function setProject(project,preserve=false){
  if(preserve&&state.project?.id===project.id&&project.version<state.project.version)return false;
  if(!preserve||state.project?.id!==project.id||state.draftOwnerId!==state.session?.user?.id){persistDrafts();state.drafts.clear();state.tabs=[];state.selected=null;state.project=project;restoreDrafts(project);}
  else state.project=project;
  const paths=new Set(state.drafts.paths(project));state.tabs=state.tabs.filter(path=>paths.has(path));
  if(!paths.has(state.selected))state.selected=state.tabs[0]||project.files[0]?.path||state.drafts.keys().next().value||null;
  if(state.selected&&!state.tabs.includes(state.selected))state.tabs.push(state.selected);
  return true;
}
function renderEditor(){
  const p=state.project;$('project-name').textContent=p.name;$('project-meta').textContent=`${toolName(p.tool_id)} / ${p.target} / revision ${p.version}${p.archived?' / archived':''}`;$('export-project').href=`/api/projects/${p.id}/export`;
  $('file-list').replaceChildren(...state.drafts.paths(p).map(path=>{const node=button(`${state.drafts.has(path)?'* ':''}${path}${p.files.some(file=>file.path===path)?'':' (local draft)'}`,()=>selectFile(path));node.classList.toggle('active',state.selected===path);return node;}));
  if(!p.files.length&&!dirty())$('file-list').append(el('p','panel-note','No source files yet.'));
  $('file-tabs').replaceChildren(...state.tabs.map(path=>{const tab=el('div','file-tab'),select=button(`${state.drafts.has(path)?'* ':''}${path}`,()=>selectFile(path));select.setAttribute('role','tab');select.setAttribute('aria-selected',String(path===state.selected));const close=button('×',()=>closeTab(path),'close-tab');close.setAttribute('aria-label',`Close ${path}`);tab.append(select,close);return tab;}));
  $('code-empty').hidden=Boolean(state.selected);$('code-wrap').hidden=!state.selected;$('file-label').textContent=state.selected || 'Choose a file';
  if(state.selected){
    const editor=$('code-editor'),content=state.drafts.get(state.selected)??p.files.find(file=>file.path===state.selected)?.content??'';
    const unchanged=editor.dataset.projectId===p.id&&editor.dataset.path===state.selected&&editor.value===content;
    if(!unchanged){editor.value=content;editor.dataset.projectId=p.id;editor.dataset.path=state.selected;highlight();}
  }
  updateFileActions();
  $('code-editor').readOnly=Boolean(p.archived);updateSaveState();renderBuilds();
  const sync=$('source-sync-status');if(sync.dataset.projectId!==p.id||sync.dataset.version!==String(p.version)){sync.dataset.projectId=p.id;sync.dataset.version=String(p.version);syncStatus(`Saved source loaded / revision ${p.version}.`);}
}
function selectFile(path){state.selected=path;if(!state.tabs.includes(path))state.tabs.push(path);persistDrafts();renderEditor();panel('editor');}
async function closeTab(path){
  const context=workspaceContext(),draft=state.drafts.get(path);
  if(draft!==undefined&&!await confirmAction('Discard unsaved changes?',`The unsaved changes to ${path} will be lost. Saved revisions stay intact.`,'Discard'))return;
  requireContext(context,false);if(state.drafts.get(path)!==draft)throw new Error('This local draft changed. Review it before closing the tab.');
  state.drafts.delete(path);state.tabs=state.tabs.filter(item=>item!==path);if(state.selected===path)state.selected=state.tabs[0]||null;persistDrafts();renderEditor();
}
function highlight(){
  const code=$('code-editor').value,pre=$('code-highlight');pre.replaceChildren();
  if(code.length>25000){pre.textContent=code+'\n';return;}
  const pattern=/--[^\n]*|\/\/[^\n]*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\b(?:local|function|end|if|then|else|elseif|for|while|do|repeat|until|return|nil|true|false|const|let|var|export|import|from|async|await|class|new|throw|try|catch|switch|case|break)\b|\b\d+(?:\.\d+)?\b/g;
  let cursor=0;for(const match of code.matchAll(pattern)){pre.append(document.createTextNode(code.slice(cursor,match.index)));const word=match[0],type=/^(--|\/\/)/.test(word)?'comment':/^["']/.test(word)?'string':/^\d/.test(word)?'number':'keyword';pre.append(el('span',`tok-${type}`,word));cursor=match.index+word.length;}pre.append(document.createTextNode(code.slice(cursor)+'\n'));syncScroll();
}
function syncScroll(){$('code-highlight').scrollTop=$('code-editor').scrollTop;$('code-highlight').scrollLeft=$('code-editor').scrollLeft;}
function updateFileActions(){
  if(!state.project)return;const p=state.project;
  for(const id of ['new-file','rename-file','delete-file'])$(id).disabled=sourceBusy()||Boolean(p.archived)||(id!=='new-file'&&(!state.selected||!p.files.some(file=>file.path===state.selected)));
  $('project-settings').disabled=sourceBusy();
}
function updateSaveState(){
  if(!state.project)return;const modified=state.selected&&state.drafts.has(state.selected),conflict=modified&&state.drafts.conflicts(state.project,state.selected);
  $('save-file').disabled=!modified||Boolean(state.project.archived)||Boolean(conflict)||sourceBusy();updateFileActions();
  $('save-status').textContent=sourceBusy()?'Saving source revision':conflict?'Saved source changed / local draft preserved':modified?'Unsaved changes':state.selected?`Saved revision ${state.project.version}`:'No file selected';
  $('line-count').textContent=state.selected?`${$('code-editor').value.split('\n').length} lines / Ctrl+S to save`:'Ctrl+S to save';
  $('draft-notice').hidden=!conflict;
  if(conflict)$('draft-message').textContent=`${state.selected} has newer saved source in revision ${state.project.version}. Your draft from revision ${state.drafts.record(state.selected).baseVersion} is preserved. Compare before saving over it.`;
}
$('compare-draft').addEventListener('click',()=>showDraftComparison());
function showDraftComparison(){
  const path=state.selected,draft=state.drafts.record(path);if(!draft)return;
  const project=state.project;
  state.draftRecovery={context:workspaceContext(),projectId:project.id,path,version:project.version,content:draft.content};
  $('draft-title').textContent=`Recover ${path}`;
  $('draft-original-title').textContent=`Original revision ${draft.baseVersion}`;
  $('draft-original').textContent=draft.baseContent??'File was not present.';
  $('draft-saved-title').textContent=`Saved revision ${project.version}`;
  $('draft-saved').textContent=project.files.find(file=>file.path===path)?.content??'File is absent from the saved revision.';
  $('draft-local').textContent=draft.content;
  $('save-draft').disabled=Boolean(project.archived);$('draft-dialog').showModal();
}
$('save-draft').addEventListener('click',()=>task($('save-draft'),async()=>{
  const recovery=state.draftRecovery;
  if(!recovery||state.project?.id!==recovery.projectId||state.project.version!==recovery.version||state.drafts.get(recovery.path)!==recovery.content)throw new Error('Source or draft changed. Close this comparison and compare again before saving.');
  await writeDraft(recovery.path,recovery.content,recovery.version);$('draft-dialog').close();
}));
$('discard-draft').addEventListener('click',()=>task($('discard-draft'),async()=>{
  const recovery=state.draftRecovery;if(!recovery||state.project?.id!==recovery.projectId)return;
  if(!await confirmAction('Discard this local draft?',`Only the unsaved draft for ${recovery.path} will be removed. Saved revisions remain available.`,'Discard draft'))return;
  requireContext(recovery.context,false);if(state.draftRecovery!==recovery||state.drafts.get(recovery.path)!==recovery.content)throw new Error('The local draft changed. Compare it again before discarding.');
  state.drafts.delete(recovery.path);setProject(state.project,true);persistDrafts();$('draft-dialog').close();renderEditor();
}));
$('code-editor').addEventListener('input',()=>{if(!state.selected||!state.project||state.project.archived||$('code-editor').readOnly||state.draftOwnerId!==state.session?.user?.id)return;state.drafts.edit(state.project,state.selected,$('code-editor').value);persistDrafts();updateSaveState();cancelAnimationFrame(highlightFrame);highlightFrame=requestAnimationFrame(highlight);});
$('code-editor').addEventListener('scroll',syncScroll);
$('code-editor').setAttribute('aria-description','Tab indents editable code. Shift+Tab moves focus to the previous control.');
$('code-editor').addEventListener('keydown',event=>{if(event.key==='Tab'&&!event.shiftKey&&!event.target.readOnly&&!event.target.disabled){event.preventDefault();event.target.setRangeText('    ',event.target.selectionStart,event.target.selectionEnd,'end');event.target.dispatchEvent(new Event('input'));}});
async function writeDraft(path,content,version){
  const context=workspaceContext(),projectId=context.projectId,userId=context.userId,draftIdentity=state.drafts.identity(path);
  if(version!==context.version)throw new Error('Saved source changed. Compare your draft with the current revision before saving.');
  const result=await sourceWrite(context,()=>api(`/api/projects/${projectId}/files`,{method:'PUT',body:{version,path,content}}));
  if(state.project?.id!==projectId||state.session?.user?.id!==userId){
    try{
      const key=draftStorageKey(userId,projectId),raw=sessionStorage.getItem(key);
      if(raw){const recovery=new SourceDrafts(),view=recovery.restore(raw,userId,projectId);recovery.saved(result.project,path,content,draftIdentity);if(recovery.size)sessionStorage.setItem(key,recovery.serialize(userId,projectId,view.tabs,view.selected));else sessionStorage.removeItem(key);}
    }catch{error('A source save completed, but browser draft recovery could not be updated. Reopen the project and compare any recovered draft with saved source.');}
    return;
  }
  if(result.project.version<state.project.version){persistDrafts();return;}
  state.drafts.saved(result.project,path,content,draftIdentity);setProject(result.project,true);persistDrafts();renderEditor();notice('A new source revision was saved.');
}
async function saveFile(){
  if(!state.selected||!state.drafts.has(state.selected))return;
  if(state.drafts.conflicts(state.project,state.selected)){showDraftComparison();return;}
  await writeDraft(state.selected,state.drafts.get(state.selected),state.project.version);
}
$('save-file').addEventListener('click',()=>task($('save-file'),saveFile));
window.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'&&!$('editor-view').hidden){event.preventDefault();task($('save-file'),saveFile);}});
function openFileDialog(mode){
  if($('file-form').querySelector('[type=submit]').disabled)throw new Error('The previous file change is still being saved. Wait for it to finish before opening another file form.');
  const context=workspaceContext();state.fileDialog={context,mode,path:state.selected};state.fileMode=mode;
  const form=$('file-form');form.reset();formError(form,'');$('file-dialog-title').textContent=mode==='rename'?'Rename this file.':'Create a file.';
  if(mode==='rename')form.elements.path.value=state.selected;$('file-dialog').showModal();form.elements.path.focus();
}
$('new-file').addEventListener('click',()=>task($('new-file'),()=>openFileDialog('new')));$('rename-file').addEventListener('click',()=>task($('rename-file'),()=>openFileDialog('rename')));
$('file-form').addEventListener('submit',event=>{event.preventDefault();submit(event.currentTarget,async()=>{
  const descriptor=state.fileDialog;if(!descriptor)throw new Error('Reopen the file action before saving.');
  const {context,mode,path:original}=descriptor;requireContext(context);
  const path=event.currentTarget.elements.path.value.trim();
  if(mode==='rename'&&state.drafts.has(original))throw new Error('Save this file before renaming it.');
  if(mode==='new'&&(state.project.files.some(file=>file.path.toLowerCase()===path.toLowerCase())||[...state.drafts.keys()].some(item=>item.toLowerCase()===path.toLowerCase())))throw new Error('That file or local draft already exists. Open it from the explorer.');
  const body=mode==='rename'?{version:context.version,path:original,renameTo:path}:{version:context.version,path,content:''};
  const selected=state.selected,result=await sourceWrite(context,()=>api(`/api/projects/${context.projectId}/files`,{method:'PUT',body}));
  if(!contextCurrent(context))return;
  const selectResult=state.selected===selected,accepted=setProject(result.project,true);
  if(accepted&&selectResult){state.selected=path;if(!state.tabs.includes(path))state.tabs.push(path);}
  if(state.fileDialog===descriptor)$('file-dialog').close();persistDrafts();renderEditor();panel('editor');
});});
$('delete-file').addEventListener('click',()=>task($('delete-file'),async()=>{
  const context=workspaceContext(),path=state.selected,draft=state.drafts.get(path),draftIdentity=state.drafts.identity(path),draftRecord=state.drafts.record(path);if(!path)return;
  if(!await confirmAction('Delete source file?',`${path} will be removed from the next revision. You can restore a saved revision from history.${draft===undefined?'':' The unsaved draft for this file will also be discarded.'}`,'Delete file'))return;
  requireContext(context);if(state.drafts.get(path)!==draft||state.drafts.record(path)!==draftRecord)throw new Error('Your local draft changed. Review it before deleting this file.');
  const result=await sourceWrite(context,()=>api(`/api/projects/${context.projectId}/files`,{method:'PUT',body:{version:context.version,path,remove:true}}));
  if(!contextCurrent(context))return;
  if(result.project.version<state.project.version)return;
  if(state.drafts.get(path)===draft&&state.drafts.identity(path)===draftIdentity&&state.drafts.record(path)===draftRecord)state.drafts.delete(path);setProject(result.project,true);persistDrafts();renderEditor();
}));
$('project-settings').addEventListener('click',()=>task($('project-settings'),()=>openProjectDialog(true)));
$('history-button').addEventListener('click',()=>task($('history-button'),async()=>{
  const context=workspaceContext(),{revisions}=await api(`/api/projects/${context.projectId}/revisions`);if(!contextCurrent(context))return;
  $('revision-list').replaceChildren(...revisions.map(revision=>{
    const row=el('div','revision'),copy=el('div');copy.append(el('h3','',`Revision ${revision.version}`),el('p','',revision.summary),el('small','',time(revision.createdAt)));const actions=el('div','actions');
    actions.append(button('Inspect',async()=>{
      requireContext(context);const before=state.project.files,{project}=await api(`/api/projects/${context.projectId}/revisions?version=${revision.version}`);
      if(contextCurrent(context,true))showReview(before,project.files,revision.summary,null,`/api/projects/${context.projectId}/export?version=${revision.version}`);
    }),link('ZIP',`/api/projects/${context.projectId}/export?version=${revision.version}`,'secondary'));
    if(revision.version!==state.project.version&&!state.project.archived)actions.append(button('Restore',async()=>{
      requireContext(context);if(dirty())throw new Error('Save or discard your unsaved changes before restoring a revision.');
      if(!await confirmAction('Restore this revision?',`Create a new revision using the files from revision ${revision.version}. The current saved revision remains in history.`,'Restore revision'))return;
      requireContext(context);if(dirty())throw new Error('Your local source changed. Save or discard it before restoring a revision.');
      const result=await sourceWrite(context,()=>api(`/api/projects/${context.projectId}/restore`,{method:'POST',body:{version:context.version,revision:revision.version}}));
      if(!contextCurrent(context))return;setProject(result.project,true);$('history-dialog').close();renderEditor();notice('Revision restored as a new version.');
    }));row.append(copy,actions);return row;
  }));$('history-dialog').showModal();
}));
function acceptJob(job){
  const current=state.job;
  if(current?.id===job.id){
    const wasActive=['queued','running'].includes(current.status),active=['queued','running'].includes(job.status);
    if(!wasActive&&active)return;
    if(wasActive&&!active){state.job=job;return;}
    if(current.status==='applied'&&job.status!=='applied')return;
    if(current.updatedAt>job.updatedAt||current.status==='running'&&job.status==='running'&&previewVersion(job)>0&&previewVersion(job)<previewVersion(current))return;
  }
  state.job=job;
}
function renderBuilds(){
  if(!state.project)return;const allowed=state.capabilities?.tools.find(tool=>tool.id===state.project.tool_id),active=state.jobs.some(job=>['queued','running','agent'].includes(job.status));
  $('build-notice').textContent=!allowed?'This tool has no generation engine yet. You can still manage its source files.':!allowed.enabled?'The owner has not enabled this generator for your account.':!state.capabilities.workerReady?'Waiting for a configured isolated worker. Source editing and exports are available.':'Validated builds save a new project revision automatically. Conflicting output stays available for comparison and ZIP download. Runtime behavior still needs testing.';
  $('generate-button').disabled=!allowed?.enabled||!state.capabilities.workerReady||active||Boolean(state.project.archived)||state.buildSubmitting||sourceBusy()||!models.available();
  models.render(active||state.buildSubmitting);
  $('build-history').replaceChildren(...state.jobs.map(job=>{const node=button(`${job.status.toUpperCase()} / ${job.modelLabel || job.model || 'Model'} / ${new Date(job.createdAt).toLocaleTimeString()}`,()=>selectJob(job.id));node.classList.toggle('active',state.job?.id===job.id);return node;}));
  $('build-state').textContent=state.job?.status==='applied'?'Completed':state.job?.status || 'Idle';$('cancel-build').hidden=!state.job||!['queued','running'].includes(state.job.status);$('review-button').hidden=!state.job?.result?.files;$('download-build').hidden=!state.job?.result?.files;if(state.job?.result?.files)$('download-build').href=`/api/jobs/${state.job.id}/export`;
  if(!state.job){$('build-log').replaceChildren(el('p','','No build selected. Logs appear when a worker performs real steps.'));renderLivePreview();return;}
  const nodes=state.job.events.map(event=>{const p=el('p');p.append(el('strong','',`${new Date(event.createdAt).toLocaleTimeString()} [${event.stage}] `),document.createTextNode(event.message));return p;});
  if(state.job.result?.checks)for(const check of state.job.result.checks)nodes.push(el('p','',check));
  if(state.job.result?.error)nodes.push(el('p','danger',state.job.result.error));
  if(state.job.result?.diagnostic){const d=state.job.result.diagnostic;nodes.push(el('p','notice',`${d.summary} ${d.nextStep}`),el('p','fine',[d.category,d.httpStatus?`HTTP ${d.httpStatus}`:null,d.providerCode,d.requestId,d.responseId].filter(Boolean).join(' / ')));}
  if(state.job.applicationError)nodes.push(el('p','danger',`${state.job.applicationError} Finished output is preserved. Download the build ZIP or compare its files with your saved source.`));
  if(state.job.appliedVersion)nodes.push(el('p','',`Saved as project revision ${state.job.appliedVersion}. History, comparison and ZIP remain available.`));
  const unreconciled=state.job.result?.accounting?.status==='unreconciled';
  if(unreconciled){
    const reasons={'cache-write-lifetimes-unavailable':'Cache-write lifetime details were not provided.','cache-write-price-unconfigured':'A required cache-write price is not configured.'};
    const delivered=Array.isArray(state.job.result?.files)&&['applied','review'].includes(state.job.status);
    const warning=el('p','notice',`Provider accounting needs reconciliation. ${reasons[state.job.result.accounting.reason]||'Provider usage cost could not be reconciled.'}${delivered?' Validated source and its ZIP remain available.':''}`);
    warning.dataset.providerAccounting='unreconciled';nodes.push(warning);
  }
  let providerCost=`API cost estimate: ${money(state.job.costMicros)} / reservation: ${money(state.job.reservedMicros)}. Provider invoices may differ.`;
  if(unreconciled)providerCost=state.job.costMicros>state.job.reservedMicros?
    `Known API token cost is at least ${minimumMoney(state.job.costMicros)}, above the ${minimumMoney(state.job.reservedMicros)} reservation. Cache-write pricing remains unreconciled; this is not a provider invoice.`:
    `API budget reserved pending reconciliation: ${money(state.job.reservedMicros)}. The full budget reservation is not a provider invoice.`;
  nodes.push(el('p','',`Model: ${state.job.modelLabel || state.job.model || 'Original configured model'}. ${providerCost} Studio credits: ${state.job.credits?.amount ?? 0} / ${state.job.credits?.state || 'not-used'}. Pending credits are holds, not finalized charges.`));
  $('build-log').replaceChildren(...nodes);renderLivePreview();
}
const previewVersion=job=>Number.isSafeInteger(job?.previewVersion)?job.previewVersion:Number.isSafeInteger(job?.preview?.sequence)?job.preview.sequence:0;
function syncStatus(message){const node=$('source-sync-status');if(node.textContent!==message)node.textContent=message;}
function clearLivePreview(){
  state.previewFile=null;state.previewJobId=null;state.previewSignature='';
  $('view-live-preview').hidden=true;$('live-preview').hidden=true;$('live-preview-code').textContent='';$('live-preview-code').hidden=true;
  $('live-preview-file').replaceChildren(new Option('No preview files yet',''));$('live-preview-file').disabled=true;
  $('live-preview-file-state').textContent='';
}
function renderLivePreview(){
  const job=state.job;
  if(!state.project||$('editor-view').hidden||!job||job.projectId!==state.project.id||!['queued','running'].includes(job.status)||state.project.archived){clearLivePreview();return;}
  if(state.previewJobId!==job.id){state.previewFile=null;state.previewSignature='';state.previewJobId=job.id;}
  $('view-live-preview').hidden=false;$('live-preview').hidden=false;
  const preview=job.status==='running'?job.preview:null;
  const changes=Array.isArray(preview?.changes)?preview.changes.filter(change=>typeof change?.path==='string'&&(typeof change.content==='string'||change.content===null)&&typeof change.complete==='boolean'):[];
  const attempt=[1,2].includes(preview?.attempt)?`Attempt ${preview.attempt} / `:'';
  $('live-preview-state').textContent=!navigator.onLine?'Offline / last received preview':state.syncUnavailable?'Updates unavailable / last received preview':job.status==='queued'?'Queued / waiting for worker':changes.length?`${attempt}Unvalidated preview`:`${attempt}Waiting for code`;
  $('live-preview-detail').textContent=`Based on revision ${job.baseVersion}. ${job.provider==='deepseek'?'This provider returns code together. It appears here when available.':'Code appears only when the worker receives it. Preview availability depends on the worker and provider.'}`;
  const options=changes.map(change=>({value:change.path,label:change.path+(change.content===null?' / deletion proposed':'')}));
  const signature=JSON.stringify(options);
  const picker=$('live-preview-file');
  if(options.length&&!options.some(option=>option.value===state.previewFile))state.previewFile=options[0].value;
  if(signature!==state.previewSignature){
    picker.replaceChildren(...(options.length?options.map(option=>new Option(option.label,option.value)):[new Option('No preview files yet','')]));
    picker.disabled=!options.length;picker.value=options.length?state.previewFile:'';state.previewSignature=signature;refreshSelects($('live-preview'));
  }
  const selected=changes.find(change=>change.path===state.previewFile),code=$('live-preview-code');
  code.hidden=!selected;
  const content=selected?(selected.content===null?'Deletion proposed. The saved file has not been removed.':selected.content):'';
  if(code.textContent!==content)code.textContent=content;
  $('live-preview-file-state').textContent=selected?(selected.content===null?'Proposed deletion / unvalidated and not applied.':selected.complete?'File text received / validation pending.':'Partial file text / still being received, unvalidated and not saved.'):'No code has been received for this build yet.';
}
$('live-preview-file').addEventListener('change',()=>{state.previewFile=$('live-preview-file').value;renderLivePreview();});
$('view-live-preview').addEventListener('click',()=>task($('view-live-preview'),()=>{
  renderLivePreview();if($('live-preview').hidden)return;
  $('live-preview').scrollIntoView({behavior:'auto',block:'start'});
  ($('live-preview-code').hidden?$('live-preview-title'):$('live-preview-code')).focus({preventScroll:true});
}));
async function selectJob(id){
  const context=workspaceContext(),selection=++jobSelectionSequence;state.selectedJobId=id;
  try{
    const detail=++jobDetailSequence,{job}=await api(`/api/jobs/${id}`);
    if(!contextCurrent(context)||detail!==jobDetailSequence||selection!==jobSelectionSequence||job.projectId!==context.projectId)return;
    acceptJob(job);renderBuilds();
  }catch(failure){if(contextCurrent(context)&&selection===jobSelectionSequence)state.selectedJobId=state.job?.id||null;throw failure;}
}
async function loadJobs({fresh=false}={}){
  if(!state.project||$('editor-view').hidden||!state.session?.user)return;
  const context=workspaceContext(),key=`${context.userId}:${context.projectId}:${context.sequence}`;
  if(jobsLoad?.key===key){
    const pending=jobsLoad.promise;
    if(!fresh)return pending;
    try{await pending;}catch{}
    if(contextCurrent(context))return loadJobs({fresh:true});return;
  }
  const entry={key,promise:null};entry.promise=readJobs(context,fresh);jobsLoad=entry;
  try{return await entry.promise;}
  catch(failure){if(contextCurrent(context)){state.syncUnavailable=true;state.lastSyncError=failure.message;syncStatus('Updates could not be checked. Local drafts are preserved. Use Check for updates to retry.');renderLivePreview();}throw failure;}
  finally{if(jobsLoad===entry)jobsLoad=null;}
}
async function readJobs(context,checkSource=false){
  const id=context.projectId,sequence=routeSequence,request=++jobsRequestSequence,selection=jobSelectionSequence;
  const [{jobs,projectVersion,projectUpdatedAt},capabilities]=await Promise.all([api(`/api/projects/${id}/jobs`),Date.now()-state.capabilitiesAt>15000?api('/api/studio/session'):null]);
  if(!contextCurrent(context)||sequence!==routeSequence||request!==jobsRequestSequence)return;
  if(capabilities){state.capabilities=capabilities;state.capabilitiesAt=Date.now();}
  const selected=state.selectedJobId||state.job?.id, summary=jobs.find(job=>job.id===selected)||jobs[0]||null;state.jobs=jobs;
  if(!summary&&selection===jobSelectionSequence)state.job=null;
  else if(summary&&selection===jobSelectionSequence&&(!state.job||state.job.id!==summary.id||state.job.updatedAt!==summary.updatedAt||state.job.status!==summary.status||state.job.credits?.state!==summary.credits?.state||previewVersion(state.job)!==previewVersion(summary))){
    const detail=++jobDetailSequence,{job}=await api(`/api/jobs/${summary.id}`);if(!contextCurrent(context)||sequence!==routeSequence||request!==jobsRequestSequence)return;if(detail===jobDetailSequence&&selection===jobSelectionSequence&&job.projectId===id)acceptJob(job);
  }
  const appliedVersion=Math.max(0,...jobs.map(job=>job.appliedVersion||0)),sourceStamp=jobs.filter(job=>job.status==='applied'||job.applicationError).map(job=>`${job.id}:${job.updatedAt}:${job.appliedVersion||''}`).join('|');
  const remoteVersion=Math.max(appliedVersion,Number.isSafeInteger(projectVersion)?projectVersion:0);
  if(checkSource||remoteVersion>state.project.version||(sourceStamp!==state.sourceJobsAt&&jobs.some(job=>job.applicationError))){
    const previousVersion=state.project.version,{project}=await api(`/api/projects/${id}`);
    if(!contextCurrent(context)||sequence!==routeSequence||request!==jobsRequestSequence)return;
    if(project.version>=state.project.version&&project.version>=remoteVersion){
      const hadDrafts=dirty();if(project.version>state.project.version){setProject(project,true);persistDrafts();renderEditor();}
      if(project.version>previousVersion)notice(hadDrafts?'Saved source refreshed. Your unsaved drafts are preserved; changed files need comparison before saving.':'Saved source refreshed. The explorer and editor now show the latest revision.');
    }
  }
  state.sourceJobsAt=sourceStamp;state.syncUnavailable=false;
  if(state.lastSyncError&&$('error').textContent===state.lastSyncError)$('error').hidden=true;state.lastSyncError=null;
  syncStatus(Number.isSafeInteger(projectVersion)||checkSource?`Saved source synced / revision ${state.project.version}.${dirty()?' Local drafts are preserved.':''}`:`Saved source loaded / revision ${state.project.version}. Use Check for updates to reload saved files.`);
  if(projectUpdatedAt)$('source-sync-status').title=`Server update: ${projectUpdatedAt}`;
  await models.refresh();
  if(contextCurrent(context)&&request===jobsRequestSequence)renderBuilds();
}
$('sync-source').addEventListener('click',()=>task($('sync-source'),()=>loadJobs({fresh:true})));
$('build-form').addEventListener('submit',event=>{event.preventDefault();task($('generate-button'),async()=>{
  if(state.buildSubmitting)return;
  state.buildSubmitting=true;
  try {
    if(dirty())throw new Error('Save your source changes before starting a build.');
    const context=workspaceContext(),projectId=context.projectId,version=context.version,prompt=$('build-prompt').value.trim(),quote=await models.prepare();
    if(!await confirmAction('Confirm model and build cost',models.confirmation(quote),'Start build'))return;
    requireContext(context);if(dirty()||sourceBusy())throw new Error('Project changed. Save your source before generating.');
    const payload={version,prompt,applicationMode:'automatic',...quote},key=JSON.stringify({projectId,...payload});
    if(!pendingBuildRequest || pendingBuildRequest.key!==key)pendingBuildRequest={key,requestId:crypto.randomUUID()};
    const {job}=await api(`/api/projects/${projectId}/jobs`,{method:'POST',body:{...payload,requestId:pendingBuildRequest.requestId}});
    pendingBuildRequest=null;if(!contextCurrent(context))return;state.job=job;state.selectedJobId=job.id;await models.refresh(true);if(!contextCurrent(context))return;await loadJobs();notice('Build queued.');
  } finally {state.buildSubmitting=false;renderBuilds();}
});});
$('cancel-build').addEventListener('click',()=>task($('cancel-build'),async()=>{
  const context=workspaceContext(),job=state.job;if(!job)return;
  if(!await confirmAction('Cancel this build?','The worker will stop when cancellation is detected. Provider requests already accepted may still be billed.','Cancel build'))return;
  requireContext(context,false);if(state.job?.id!==job.id)throw new Error('The selected build changed. Reopen cancellation for the intended build.');
  if(!['queued','running'].includes(state.job.status)){notice('This build has already finished.');return;}
  await api(`/api/jobs/${job.id}/cancel`,{method:'POST',body:{}});if(contextCurrent(context))await loadJobs();
}));
function showReview(before,after,summary,job,href){
  state.review={before,after,job,context:workspaceContext()};$('review-title').textContent=job?.status==='applied'?'Saved build changes.':'Compare source changes.';$('export-proposal').textContent='Download build ZIP';$('review-summary').textContent=summary;$('apply-proposal').hidden=!job||job.status!=='review'||job.baseVersion!==state.project.version;$('export-proposal').href=href;
  const paths=[...new Set([...before,...after].map(file=>file.path))].filter(path=>before.find(file=>file.path===path)?.content!==after.find(file=>file.path===path)?.content);
  if(!paths.length)paths.push(...after.map(file=>file.path));$('review-file').replaceChildren(...paths.map(path=>new Option(path,path)));refreshSelects($('review-dialog'));renderDiff();$('review-dialog').showModal();
}
function renderDiff(){const path=$('review-file').value;$('diff-before').textContent=state.review?.before.find(file=>file.path===path)?.content??'File not present in this revision.';$('diff-after').textContent=state.review?.after.find(file=>file.path===path)?.content??'File removed in this proposal.';}
$('review-file').addEventListener('change',renderDiff);
$('review-button').addEventListener('click',()=>task($('review-button'),async()=>{
  const context=workspaceContext(),job=state.job;if(!job?.result?.files)return;
  const {project}=await api(`/api/projects/${context.projectId}/revisions?version=${job.baseVersion}`);
  if(contextCurrent(context,true)&&state.job?.id===job.id)showReview(project.files,job.result.files,job.result.summary,job,`/api/jobs/${job.id}/export`);
}));
$('apply-proposal').addEventListener('click',()=>task($('apply-proposal'),async()=>{
  const review=state.review;if(!review?.job)return;const {context,job}=review;requireContext(context);
  if(dirty())throw new Error('Save or discard unsaved changes before applying a proposal.');
  if(!await confirmAction('Apply these changes?','The reviewed files become a new revision only if the project still matches the build snapshot.','Apply proposal'))return;
  requireContext(context);if(state.review!==review||dirty())throw new Error('The comparison or local source changed. Review it again before applying.');
  const result=await sourceWrite(context,()=>api(`/api/jobs/${job.id}/apply`,{method:'POST',body:{version:context.version}}));
  if(!contextCurrent(context))return;setProject(result.project,true);$('review-dialog').close();renderEditor();await loadJobs();notice('Proposal applied as a new project revision.');
}));
async function admin(tab){
  if(state.route!=='#admin'||!state.session?.user)return;
  const context=workspaceContext(false),view=++adminViewSequence;
  try{
  if(!state.capabilities){const capabilities=await api('/api/studio/session');if(!contextCurrent(context)||view!==adminViewSequence)return;state.capabilities=capabilities;}
  const definitions=[['users','Users','users:read'],['projects','Projects','projects:read'],['tools','Tools','tools:manage'],['settings','Settings','settings:manage'],['models','Models & credits','settings:manage'],['audit','Audit log','audit:read']].filter(([id, ,permission])=>state.capabilities.permissions.includes(permission)&&(id!=='models'||state.capabilities.owner));
  if(!definitions.length)throw new Error('This account has no administration permissions.');
  tab=definitions.some(item=>item[0]===tab)?tab:definitions[0][0];state.adminTab=tab;
  $('admin-tabs').replaceChildren(...definitions.map(([id,label])=>{const node=button(label,()=>admin(id));node.setAttribute('role','tab');node.setAttribute('aria-selected',String(id===tab));return node;}));
  const host=$('admin-content'),root=el('div');root.dataset.adminTab=tab;host.replaceChildren(root);root.append(el('p','muted','Loading controls...'));
  const current=()=>contextCurrent(context)&&view===adminViewSequence&&state.adminTab===tab&&root.parentElement===host;
  if(tab==='models'){await models.renderAdmin(root);return;}
  if(tab==='settings'){await settingsPanel(root,current);return;}
  if(tab==='tools'){const data=await api('/api/admin/tools');if(!current())return;root.replaceChildren();const card=el('div','admin-card');card.append(el('h2','','Generator access'),el('p','','Only implemented generators can be enabled. Members mode is an owner-only release decision. A healthy worker and model configuration are still required.'));
    for(const id of Object.keys(data.tools)){const control=selectField(toolName(id),[['disabled','Disabled'],['owner','Owner testing'],['members','Members']],data.tools[id],id),row=el('div','toolbar');row.append(control.label,button('Save mode',async()=>{await api('/api/admin/tools',{method:'PATCH',body:{toolId:id,mode:control.input.value,version:data.version}});if(!current())return;notice('Tool access updated.');const capabilities=await api('/api/studio/session');if(!current())return;state.capabilities=capabilities;await admin('tools');},'primary'));card.append(row);}root.append(card);refreshSelects(root);return;}
  if(tab==='users'){const toolbar=el('div','toolbar'),search=field('Find an account','search','','query'),list=el('div');search.label.classList.add('search');const load=()=>{const query=search.input.value;return loadUsers(query,list,()=>current()&&search.input.value===query);};toolbar.append(search.label,button('Search',load));root.replaceChildren(toolbar,list);await load();return;}
  if(tab==='projects'){const {projects}=await api('/api/admin/projects');if(!current())return;const view=table(['Project','Owner','State','Actions']);root.replaceChildren(view.wrap);for(const project of projects){const row=el('tr');row.append(el('td','',project.name),el('td','',project.user_id),el('td','',project.archived?'Archived':'Active'));const actions=el('td');if(state.capabilities.permissions.includes('projects:manage'))actions.append(button(project.archived?'Unarchive':'Archive',async()=>{const reason=await reasonDialog('Moderate project',project.name);if(reason===null)return;await api(`/api/admin/projects/${project.id}`,{method:'PATCH',body:{archived:!project.archived,version:project.version,reason}});if(current())await admin('projects');}));row.append(actions);view.body.append(row);}if(!projects.length)root.append(el('p','table-empty','No projects found.'));return;}
  if(tab==='audit'){root.replaceChildren();const view=table(['Time','Action','Actor','Target','Detail']);root.append(view.wrap);let before='';const load=async()=>{const result=await api(`/api/admin/audit${before?`?before=${before}`:''}`);if(!current())return;for(const item of result.items){const row=el('tr');for(const value of [time(item.created_at),item.action,item.actor,item.target,item.detail])row.append(el('td','',value));view.body.append(row);}before=result.next;more.hidden=!before;};const more=button('Load older activity',load);root.append(more);await load();}
  }catch(failure){if(failure.status===401||contextCurrent(context)&&view===adminViewSequence)throw failure;}
}
async function loadUsers(query,root,current=()=>root.isConnected){const request=++userSearchSequence,context=workspaceContext(false),{users,next}=await api(`/api/admin/users?q=${encodeURIComponent(query)}`);if(!current()||request!==userSearchSequence||!contextCurrent(context))return;root.replaceChildren();const view=table(['Account','Status','Daily limits','Actions']);root.append(view.wrap);for(const user of users){const row=el('tr'),account=el('td','',user.display_name);account.append(el('small','',`${user.username} / ${user.discord_id}${user.owner?' / OWNER':''}`));const actions=el('td');if(state.capabilities.permissions.includes('users:manage'))actions.append(button('Manage',()=>{if(!current())return;if($('user-form').querySelector('[type=submit]').disabled)throw new Error('The previous account change is still being saved.');state.managedUser=user;state.userDialog={user,context,current};const form=$('user-form');form.reset();formError(form,'');$('user-title').textContent=user.display_name;form.elements.status.value=user.status;form.elements.dailyLimit.value=user.daily_limit;form.elements.dailyBudget.value=user.daily_budget/1000000;refreshSelects(form);$('user-dialog').showModal();}));row.append(account,el('td','',user.status),el('td','',`${user.daily_limit} builds / ${money(user.daily_budget)}`),actions);view.body.append(row);}if(!users.length)root.append(el('p','table-empty','No matching accounts.'));if(next)root.append(el('p','muted','Showing 50 accounts. Narrow your search to locate a specific account.'));}
$('user-form').addEventListener('submit',event=>{event.preventDefault();submit(event.currentTarget,async()=>{const descriptor=state.userDialog;if(!descriptor||!descriptor.current())throw new Error('Reopen account controls before saving.');requireContext(descriptor.context,false);const e=event.currentTarget.elements,user=descriptor.user;await api(`/api/admin/users/${user.id}`,{method:'PATCH',body:{status:e.status.value,dailyLimit:Number(e.dailyLimit.value),dailyBudgetMicros:Math.round(Number(e.dailyBudget.value)*1000000),version:user.version,revokeSessions:e.revoke.checked,reason:e.reason.value.trim()}});if(state.userDialog!==descriptor||!descriptor.current())return;$('user-dialog').close();notice('Account controls updated.');await admin('users');});});
async function settingsPanel(root,current=()=>root.isConnected){
  const data=await api('/api/admin/settings');if(!current())return;state.settings=data.settings;const form=el('form'),grid=el('div','settings-grid');root.replaceChildren(form);form.append(grid);
  const discord=el('section','admin-card');discord.append(el('h2','','Discord connection'),el('p','',`${data.botConfigured?'Bot token configured':'Bot token not configured'}. Credentials stay in the private server environment, never in this form.`));
  const guild=field('Discord guild ID','text',data.settings.guildId,'guildId');guild.input.maxLength=20;discord.append(guild.label,button('Test connection',async()=>{const result=await api('/api/admin/discord/test',{method:'POST',body:{}});if(!current())return;notice(`Connected as ${result.bot.username} in ${result.guild.name}.`);}));
  const provider=el('section','admin-card');provider.append(el('h2','','Legacy single-model settings'),el('p','',`${data.workerReady?'A worker is connected.':'No healthy worker is connected.'} Enter current model prices from your provider. Cost reservations are conservative estimates, not a billing guarantee.`));
  provider.append(el('p','notice','Use Models & credits to add multiple models and per-model pricing. Once that catalog is saved, these legacy model fields no longer control new builds.'));
  const controls={guildId:guild.input};for(const [name,label,type,min,max,step] of [['model','Model identifier','text'],['maxOutputTokens','Maximum output tokens','number',512,16384,1],['maxCalls','Maximum model calls per build','number',1,2,1],['budget','Maximum budget per build (USD)','number',.01,10,.01],['inputUsdPerMillion','Input USD per million tokens','number',0,1000,.000001],['outputUsdPerMillion','Output USD per million tokens','number',0,1000,.000001]]){const value=name==='budget'?data.settings.maxBudgetMicros/1000000:data.settings[name],f=field(label,type,value,name);if(min!==undefined){f.input.min=min;f.input.max=max;f.input.step=step;}controls[name]=f.input;provider.append(f.label);}grid.append(discord,provider);
  const roles=el('section','admin-card');roles.append(el('h2','','Discord role permissions'),el('p','','Only the explicit server-side Discord user-ID allowlist grants owner access. Role lookups fail closed; sensitive staff changes refresh membership before authorization.'));
  const rows=el('div');function addRole(id='',permissions=[]){const row=el('div','role-row'),f=field('Role ID','text',id,'role');f.input.maxLength=20;f.input.required=true;const permissionsGrid=el('div','permission-grid');for(const permission of data.permissions){const label=el('label','check'),input=el('input');input.type='checkbox';input.value=permission;input.checked=permissions.includes(permission);label.append(input,document.createTextNode(permission));permissionsGrid.append(label);}row.append(f.label,permissionsGrid,button('Remove mapping',()=>row.remove(),'danger'));rows.append(row);}
  for(const [id,permissions] of Object.entries(data.settings.roleMappings))addRole(id,permissions);roles.append(rows,button('+ Add role mapping',()=>{if(rows.children.length>=20)throw new Error('At most 20 mappings are supported.');addRole();}));form.append(roles);
  const message=el('p','form-error');message.hidden=true;message.setAttribute('role','alert');const save=el('button','primary','Save configuration');save.type='submit';save.disabled=!state.capabilities.owner;form.append(message,save);if(!state.capabilities.owner)form.append(el('p','muted','Only a configured owner can save these settings.'));
  form.addEventListener('submit',event=>{event.preventDefault();submit(form,async()=>{if(!current())throw new Error('Reopen settings before saving.');const roleMappings=Object.create(null);for(const row of rows.children){const id=row.querySelector('input[name=role]').value.trim();if(Object.hasOwn(roleMappings,id))throw new Error('Each Discord role can be mapped once.');roleMappings[id]=[...row.querySelectorAll('input[type=checkbox]:checked')].map(input=>input.value);}
    const body={...data.settings,guildId:controls.guildId.value.trim(),model:controls.model.value.trim(),maxOutputTokens:Number(controls.maxOutputTokens.value),maxCalls:Number(controls.maxCalls.value),maxBudgetMicros:Math.round(Number(controls.budget.value)*1000000),inputUsdPerMillion:Number(controls.inputUsdPerMillion.value),outputUsdPerMillion:Number(controls.outputUsdPerMillion.value),roleMappings};
    const updated=await api('/api/admin/settings',{method:'PATCH',body});if(!current())return;data.settings=updated.settings;state.settings=updated.settings;notice('Configuration saved. No secrets were changed.');
  });});
}
function reasonDialog(title,description){return new Promise(resolve=>{const dialog=el('dialog'),form=el('form'),f=field('Reason','text','','reason'),heading=el('h2','',title);heading.id=`studio-reason-${crypto.randomUUID()}`;dialog.setAttribute('aria-labelledby',heading.id);f.input.maxLength=300;f.input.required=true;form.append(heading,el('p','dialog-description',description),f.label);const actions=el('div','dialog-actions'),cancel=button('Cancel',()=>dialog.close()),accept=el('button','primary','Confirm');accept.type='submit';actions.append(cancel,accept);form.append(actions);let result=null;form.addEventListener('submit',event=>{event.preventDefault();result=f.input.value.trim();if(result)dialog.close();});dialog.addEventListener('close',()=>{dialog.remove();resolve(result);},{once:true});dialog.append(form);document.body.append(dialog);dialog.showModal();f.input.focus();});}
$('refresh-roles').addEventListener('click',()=>task($('refresh-roles'),async()=>{await api('/api/studio/roles/refresh',{method:'POST',body:{}});state.capabilities=await api('/api/studio/session');notice('Discord permissions refreshed.');await renderRoute();}));
async function renderRoute(){
  const sequence=++routeSequence;
  try{
  if(!state.session?.user){show('login');return;}const requested=location.hash||'#projects';
  if(requested!==state.route&&dirty()){persistDrafts();if(state.draftStorageFailed){const leave=await confirmAction('Leave unsaved source changes?','Browser recovery is unavailable. Leaving will discard the unsaved drafts in this tab. Copy important source first.','Discard and leave');if(sequence!==routeSequence)return;if(!leave){history.replaceState(null,'',state.route);return;}state.drafts.clear();persistDrafts();}else state.drafts.clear();state.project=null;}
  if(sequence!==routeSequence)return;
  if(requested!==state.route){if(state.route==='#admin')$('admin-content').replaceChildren();closeDialogs();state.projectDialog=null;state.fileDialog=null;state.review=null;state.draftRecovery=null;}
  state.route=requested;$('error').hidden=true;$('projects-nav').removeAttribute('aria-current');$('admin-nav').removeAttribute('aria-current');
  $('billing-nav').removeAttribute('aria-current');
  if(requested==='#billing'){$('route-label').textContent='PLANS & USAGE';$('billing-nav').setAttribute('aria-current','page');show('billing-view');const userId=state.session.user.id;await renderBilling({root:$('billing-view'),api,el,button,confirmAction,current:()=>sequence===routeSequence&&state.session?.user?.id===userId&&state.route==='#billing'});return;}
  if(requested==='#admin'){$('route-label').textContent='CONTROL ROOM';$('admin-nav').setAttribute('aria-current','page');show('admin-view');await admin(state.adminTab);return;}
  const match=/^#project\/([a-f0-9-]{36})$/.exec(requested);
  if(match){show('loading');const result=await api(`/api/projects/${match[1]}`);if(sequence!==routeSequence)return;setProject(result.project,state.project?.id===result.project.id);state.jobs=[];state.job=null;state.selectedJobId=null;state.sourceJobsAt='';state.capabilities=await api('/api/studio/session');if(sequence!==routeSequence)return;$('route-label').textContent='PROJECT EDITOR';show('editor-view');renderEditor();await loadJobs();return;}
  state.project=null;state.jobs=[];state.job=null;state.selectedJobId=null;$('route-label').textContent='PROJECTS';$('projects-nav').setAttribute('aria-current','page');show('dashboard');await loadDashboard();
  }catch(failure){if(sequence===routeSequence)showRouteFailure(failure);}
}
function showRouteFailure(failure){
  if(failure.status===401&&!failure.staleAuthentication||state.session&&!state.session.user){show('login');error(failure.message);return;}
  $('route-error-title').textContent=[403,404].includes(failure.status)?'Project unavailable.':'Workspace unavailable.';
  $('route-error-message').textContent=failure.message||'The workspace could not be loaded. Try again or return to your projects.';
  $('back-to-projects').hidden=(location.hash||'#projects')==='#projects';
  show('route-error');error(failure.message||'The workspace could not be loaded.');
}
async function initializeWorkspace(){
  const sequence=++routeSequence;show('loading');
  try{
    const [session,catalog]=await Promise.allSettled([api('/api/session'),api('/catalog.json')]);
    if(sequence!==routeSequence)return;
    if(session.status==='fulfilled')state.session=session.value;
    if(catalog.status==='fulfilled')state.catalog=catalog.value;
    if(session.status==='rejected')throw session.reason;
    if(catalog.status==='rejected')throw catalog.reason;
    refreshSelects();
    if(state.session.user){
      await models.refresh(true);if(sequence!==routeSequence)return;
      const capabilities=await api('/api/studio/session');if(sequence!==routeSequence)return;state.capabilities=capabilities;
      $('profile-link').textContent=state.session.user.displayName;$('new-project').disabled=false;$('admin-nav').hidden=!state.capabilities.permissions.length;
      document.body.classList.toggle('compact',state.session.user.density==='compact');
    }
    state.initialized=true;await renderRoute();
  }catch(failure){if(sequence===routeSequence)showRouteFailure(failure);}
}
$('retry-workspace').addEventListener('click',()=>task($('retry-workspace'),()=>state.initialized?renderRoute():initializeWorkspace()));
document.querySelector('.skip').addEventListener('click',event=>{event.preventDefault();$('content').focus();});
window.addEventListener('hashchange',()=>task(null,renderRoute));window.addEventListener('beforeunload',event=>{if(dirty()){persistDrafts();event.preventDefault();event.returnValue='';}});
window.addEventListener('pagehide',persistDrafts);
window.addEventListener('online',()=>task(null,()=>!$('loading').hidden||!$('route-error').hidden?(state.initialized?renderRoute():initializeWorkspace()):loadJobs()));
document.addEventListener('visibilitychange',()=>{if(!document.hidden)task(null,()=>loadJobs());});
$('new-project').addEventListener('click',()=>task($('new-project'),()=>openProjectDialog()));
$('project-search').addEventListener('input',renderProjects);$('project-filter').addEventListener('change',renderProjects);$('project-sort').addEventListener('change',renderProjects);
for(const node of document.querySelectorAll('[data-close]'))node.addEventListener('click',()=>node.closest('dialog').close());
for(const node of document.querySelectorAll('button[data-panel]'))node.addEventListener('click',()=>panel(node.dataset.panel));
setInterval(async()=>{
  if(document.hidden||state.pollBusy||!state.project||$('editor-view').hidden||!state.session?.user||!navigator.onLine)return;
  const active=state.jobs.some(job=>['queued','running','agent'].includes(job.status));idlePollTick=active?false:!idlePollTick;if(!active&&idlePollTick)return;
  state.pollBusy=true;try{await loadJobs();}catch(failure){error(failure.message);}finally{state.pollBusy=false;}
},2000);
window.addEventListener('offline',()=>{syncStatus('Offline. Showing the last saved source and local drafts.');renderLivePreview();});
await initializeWorkspace();
