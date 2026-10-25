import { refreshSelects, confirmAction } from './controls.js';
import { createModelControls } from './models.js';
const $=id=>document.getElementById(id);
const state={ session:null, capabilities:null, catalog:null, projects:[], project:null, selected:null, tabs:[], drafts:new Map(), jobs:[], job:null, briefList:[], editingProject:false, fileMode:'new', managedUser:null, adminTab:null, settings:null, review:null, route:location.hash || '#projects', pollBusy:false, capabilitiesAt:0, buildSubmitting:false };
let toastTimer, routeSequence=0, highlightFrame=0;
let pendingBuildRequest=null;
const models=createModelControls({api,el,button,field,selectField,table,notice,confirmAction,reasonDialog,onChange:renderBuilds});
function el(tag,className,text) { const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node; }
function button(label,action,className='') { const node=el('button',className,label);node.type='button';node.addEventListener('click',()=>task(node,action));return node; }
function link(label,href,className='') { const node=el('a',className,label);node.href=href;return node; }
function notice(message) { $('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,5500); }
function error(message) { $('error').textContent=message;$('error').hidden=false; }
async function task(node,action) { if(node?.disabled)return; if(node)node.disabled=true;try{await action();}catch(failure){error(failure.message || 'This action could not be completed.');}finally{if(node)node.disabled=false;updateSaveState();if(node===$('generate-button'))renderBuilds();} }
async function api(path,{method='GET',body}={}) {
  const headers={};if(body!==undefined){headers['content-type']='application/json';headers['x-csrf-token']=state.session?.csrf || '';}
  const response=await fetch(path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',credentials:'same-origin',redirect:'error',signal:AbortSignal.timeout(20000)});
  let data;try{data=await response.json();}catch{throw new Error('The server returned an unexpected response. Check the Studio deployment.');}
  if(!response.ok){if(response.status===401&&state.session){state.session.user=null;state.capabilities=null;show('login');}throw new Error(data.error || `Request failed (${response.status}).`);}return data;
}
const money=value=>`$${(value/1000000).toFixed(4)}`;
const time=value=>new Date(value).toLocaleString();
function dirty(){return state.drafts.size>0;}
function panel(name){$('workbench').dataset.panel=name;document.querySelectorAll('[data-panel]').forEach(node=>{if(node.tagName==='BUTTON')node.setAttribute('aria-pressed',String(node.dataset.panel===name));});}
function show(name){for(const id of ['loading','login','dashboard','editor-view','admin-view'])$(id).hidden=id!==name;}
function toolName(id){return state.catalog?.tools.find(tool=>tool.id===id)?.name || id;}
function formError(form,message){const target=form.querySelector('.form-error');target.textContent=message;target.hidden=!message;}
async function submit(form,action){const node=form.querySelector('[type=submit]');if(node.disabled)return;node.disabled=true;formError(form,'');try{await action();}catch(failure){formError(form,failure.message);}finally{node.disabled=false;}}
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
async function loadDashboard(){const result=await api('/api/projects');state.projects=result.projects;workerStatus();renderProjects();}
async function openProjectDialog(edit=false){
  state.editingProject=edit;const form=$('project-form');form.reset();formError(form,'');$('project-flags').hidden=!edit;$('brief-import-label').hidden=edit;$('project-dialog-title').textContent=edit?'Project details.':'Start a new project.';
  $('project-tool').replaceChildren(...state.catalog.tools.filter(tool=>tool.category!=='browse').map(tool=>{const option=el('option','',tool.name);option.value=tool.id;return option;}));
  if(edit){const p=state.project;form.elements.name.value=p.name;form.elements.requirements.value=p.requirements;form.elements.toolId.value=p.tool_id;form.elements.target.value=p.target;form.elements.favorite.checked=Boolean(p.favorite);form.elements.archived.checked=Boolean(p.archived);}
  else {state.briefList=(await api('/api/briefs')).briefs;$('brief-import').replaceChildren(new Option('Start from scratch',''),...state.briefList.map(brief=>new Option(brief.name,brief.id)));form.elements.target.value=state.session.user.preferredFramework || 'Standalone';}
  form.elements.toolId.disabled=edit;form.elements.target.disabled=edit;refreshSelects(form);$('project-dialog').showModal();form.elements.name.focus();
}
$('brief-import').addEventListener('change',()=>{const brief=state.briefList.find(brief=>brief.id===$('brief-import').value);if(!brief)return;const form=$('project-form');for(const key of ['name','requirements','toolId','target'])form.elements[key].value=brief[key];refreshSelects(form);});
$('project-form').addEventListener('submit',event=>{event.preventDefault();submit(event.currentTarget,async()=>{
  const form=event.currentTarget,e=form.elements;
  const body=state.editingProject?{version:state.project.version,name:e.name.value.trim(),requirements:e.requirements.value.trim(),favorite:e.favorite.checked,archived:e.archived.checked}:{name:e.name.value.trim(),requirements:e.requirements.value.trim(),toolId:e.toolId.value,target:e.target.value};
  const result=await api(state.editingProject?`/api/projects/${state.project.id}`:'/api/projects',{method:state.editingProject?'PATCH':'POST',body});
  $('project-dialog').close();if(state.editingProject){setProject(result.project,true);renderEditor();}else{location.hash=`project/${result.project.id}`;}notice('Project saved.');
});});
function setProject(project,preserve=false){state.project=project;if(!preserve){state.drafts.clear();state.tabs=[];state.selected=null;}const paths=new Set(project.files.map(file=>file.path));state.tabs=state.tabs.filter(path=>paths.has(path));for(const path of state.drafts.keys())if(!paths.has(path))state.drafts.delete(path);if(!paths.has(state.selected))state.selected=state.tabs[0]||project.files[0]?.path||null;if(state.selected&&!state.tabs.includes(state.selected))state.tabs.push(state.selected);}
function renderEditor(){
  const p=state.project;$('project-name').textContent=p.name;$('project-meta').textContent=`${toolName(p.tool_id)} / ${p.target} / revision ${p.version}${p.archived?' / archived':''}`;$('export-project').href=`/api/projects/${p.id}/export`;
  $('file-list').replaceChildren(...p.files.map(file=>{const node=button(`${state.drafts.has(file.path)?'* ':''}${file.path}`,()=>selectFile(file.path));node.classList.toggle('active',state.selected===file.path);return node;}));
  if(!p.files.length)$('file-list').append(el('p','panel-note','No source files yet.'));
  $('file-tabs').replaceChildren(...state.tabs.map(path=>{const tab=el('div','file-tab'),select=button(`${state.drafts.has(path)?'* ':''}${path}`,()=>selectFile(path));select.setAttribute('role','tab');select.setAttribute('aria-selected',String(path===state.selected));const close=button('×',()=>closeTab(path),'close-tab');close.setAttribute('aria-label',`Close ${path}`);tab.append(select,close);return tab;}));
  $('code-empty').hidden=Boolean(state.selected);$('code-wrap').hidden=!state.selected;$('file-label').textContent=state.selected || 'Choose a file';
  if(state.selected){$('code-editor').value=state.drafts.get(state.selected)??p.files.find(file=>file.path===state.selected).content;highlight();}
  for(const id of ['new-file','rename-file','delete-file'])$(id).disabled=Boolean(p.archived)||(id!=='new-file'&&!state.selected);
  $('code-editor').readOnly=Boolean(p.archived);updateSaveState();renderBuilds();
}
function selectFile(path){state.selected=path;if(!state.tabs.includes(path))state.tabs.push(path);renderEditor();panel('editor');}
async function closeTab(path){if(state.drafts.has(path)&&!await confirmAction('Discard unsaved changes?',`The unsaved changes to ${path} will be lost. Saved revisions stay intact.`,'Discard'))return;state.drafts.delete(path);state.tabs=state.tabs.filter(item=>item!==path);if(state.selected===path)state.selected=state.tabs[0]||null;renderEditor();}
function highlight(){
  const code=$('code-editor').value,pre=$('code-highlight');pre.replaceChildren();
  if(code.length>25000){pre.textContent=code+'\n';return;}
  const pattern=/--[^\n]*|\/\/[^\n]*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\b(?:local|function|end|if|then|else|elseif|for|while|do|repeat|until|return|nil|true|false|const|let|var|export|import|from|async|await|class|new|throw|try|catch|switch|case|break)\b|\b\d+(?:\.\d+)?\b/g;
  let cursor=0;for(const match of code.matchAll(pattern)){pre.append(document.createTextNode(code.slice(cursor,match.index)));const word=match[0],type=/^(--|\/\/)/.test(word)?'comment':/^["']/.test(word)?'string':/^\d/.test(word)?'number':'keyword';pre.append(el('span',`tok-${type}`,word));cursor=match.index+word.length;}pre.append(document.createTextNode(code.slice(cursor)+'\n'));syncScroll();
}
function syncScroll(){$('code-highlight').scrollTop=$('code-editor').scrollTop;$('code-highlight').scrollLeft=$('code-editor').scrollLeft;}
function updateSaveState(){if(!state.project)return;const modified=state.selected&&state.drafts.has(state.selected);$('save-file').disabled=!modified||Boolean(state.project.archived);$('save-status').textContent=modified?'Unsaved changes':state.selected?`Saved revision ${state.project.version}`:'No file selected';$('line-count').textContent=state.selected?`${$('code-editor').value.split('\n').length} lines / Ctrl+S to save`:'Ctrl+S to save';}
$('code-editor').addEventListener('input',()=>{if(!state.selected)return;const value=$('code-editor').value,saved=state.project.files.find(file=>file.path===state.selected)?.content;if(value===saved)state.drafts.delete(state.selected);else state.drafts.set(state.selected,value);updateSaveState();cancelAnimationFrame(highlightFrame);highlightFrame=requestAnimationFrame(highlight);});
$('code-editor').addEventListener('scroll',syncScroll);
$('code-editor').addEventListener('keydown',event=>{if(event.key==='Tab'&&!event.shiftKey){event.preventDefault();event.target.setRangeText('    ',event.target.selectionStart,event.target.selectionEnd,'end');event.target.dispatchEvent(new Event('input'));}});
async function saveFile(){if(!state.selected||!state.drafts.has(state.selected))return;const path=state.selected,content=state.drafts.get(path),result=await api(`/api/projects/${state.project.id}/files`,{method:'PUT',body:{version:state.project.version,path,content}});if(state.drafts.get(path)===content)state.drafts.delete(path);setProject(result.project,true);renderEditor();notice('A new source revision was saved.');}
$('save-file').addEventListener('click',()=>task($('save-file'),saveFile));
window.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'&&!$('editor-view').hidden){event.preventDefault();task($('save-file'),saveFile);}});
function openFileDialog(mode){state.fileMode=mode;const form=$('file-form');form.reset();formError(form,'');$('file-dialog-title').textContent=mode==='rename'?'Rename this file.':'Create a file.';if(mode==='rename')form.elements.path.value=state.selected;$('file-dialog').showModal();form.elements.path.focus();}
$('new-file').addEventListener('click',()=>openFileDialog('new'));$('rename-file').addEventListener('click',()=>openFileDialog('rename'));
$('file-form').addEventListener('submit',event=>{event.preventDefault();submit(event.currentTarget,async()=>{const path=event.currentTarget.elements.path.value.trim();if(state.fileMode==='rename'&&state.drafts.has(state.selected))throw new Error('Save this file before renaming it.');const body=state.fileMode==='rename'?{version:state.project.version,path:state.selected,renameTo:path}:{version:state.project.version,path,content:''};if(state.fileMode==='new'&&state.project.files.some(file=>file.path.toLowerCase()===path.toLowerCase()))throw new Error('That file already exists.');const result=await api(`/api/projects/${state.project.id}/files`,{method:'PUT',body});setProject(result.project,true);state.selected=path;if(!state.tabs.includes(path))state.tabs.push(path);$('file-dialog').close();renderEditor();panel('editor');});});
$('delete-file').addEventListener('click',()=>task($('delete-file'),async()=>{const path=state.selected;if(!path||!await confirmAction('Delete source file?',`${path} will be removed from the next revision. You can restore a saved revision from history.`,'Delete file'))return;const result=await api(`/api/projects/${state.project.id}/files`,{method:'PUT',body:{version:state.project.version,path,remove:true}});state.drafts.delete(path);setProject(result.project,true);renderEditor();}));
$('project-settings').addEventListener('click',()=>task($('project-settings'),()=>openProjectDialog(true)));
$('history-button').addEventListener('click',()=>task($('history-button'),async()=>{
  const {revisions}=await api(`/api/projects/${state.project.id}/revisions`);$('revision-list').replaceChildren(...revisions.map(revision=>{
    const row=el('div','revision'),copy=el('div');copy.append(el('h3','',`Revision ${revision.version}`),el('p','',revision.summary),el('small','',time(revision.createdAt)));const actions=el('div','actions');
    actions.append(button('Inspect',async()=>{const {project}=await api(`/api/projects/${state.project.id}/revisions?version=${revision.version}`);showReview(state.project.files,project.files,revision.summary,null,`/api/projects/${project.id}/export?version=${revision.version}`);}),link('ZIP',`/api/projects/${state.project.id}/export?version=${revision.version}`,'secondary'));
    if(revision.version!==state.project.version&&!state.project.archived)actions.append(button('Restore',async()=>{if(dirty())throw new Error('Save or discard your unsaved changes before restoring a revision.');if(!await confirmAction('Restore this revision?',`Create a new revision using the files from revision ${revision.version}. The current saved revision remains in history.`,'Restore revision'))return;const result=await api(`/api/projects/${state.project.id}/restore`,{method:'POST',body:{version:state.project.version,revision:revision.version}});setProject(result.project,true);$('history-dialog').close();renderEditor();notice('Revision restored as a new version.');}));row.append(copy,actions);return row;
  }));$('history-dialog').showModal();
}));
function renderBuilds(){
  if(!state.project)return;const allowed=state.capabilities?.tools.find(tool=>tool.id===state.project.tool_id),active=state.jobs.some(job=>['queued','running'].includes(job.status));
  $('build-notice').textContent=!allowed?'This tool has no generation engine yet. You can still manage its source files.':!allowed.enabled?'The owner has not enabled this generator for your account.':!state.capabilities.workerReady?'Waiting for a configured isolated worker. Source editing and exports are available.':'Generates a proposal, checks syntax, and stops for your review. Runtime behavior still needs testing.';
  $('generate-button').disabled=!allowed?.enabled||!state.capabilities.workerReady||active||Boolean(state.project.archived)||state.buildSubmitting||!models.available();
  models.render(active||state.buildSubmitting);
  $('build-history').replaceChildren(...state.jobs.map(job=>{const node=button(`${job.status.toUpperCase()} / ${job.modelLabel || job.model || 'Model'} / ${new Date(job.createdAt).toLocaleTimeString()}`,async()=>{state.job=(await api(`/api/jobs/${job.id}`)).job;renderBuilds();});node.classList.toggle('active',state.job?.id===job.id);return node;}));
  $('build-state').textContent=state.job?.status || 'Idle';$('cancel-build').hidden=!state.job||!['queued','running'].includes(state.job.status);$('review-button').hidden=!state.job?.result?.files;
  if(!state.job){$('build-log').replaceChildren(el('p','','No build selected. Logs appear when a worker performs real steps.'));return;}
  const nodes=state.job.events.map(event=>{const p=el('p');p.append(el('strong','',`${new Date(event.createdAt).toLocaleTimeString()} [${event.stage}] `),document.createTextNode(event.message));return p;});
  if(state.job.result?.checks)for(const check of state.job.result.checks)nodes.push(el('p','',check));
  if(state.job.result?.error)nodes.push(el('p','danger',state.job.result.error));
  nodes.push(el('p','',`Model: ${state.job.modelLabel || state.job.model || 'Original configured model'}. API cost estimate: ${money(state.job.costMicros)} / reservation: ${money(state.job.reservedMicros)}. Provider invoices may differ. Studio credits: ${state.job.credits?.amount ?? 0} / ${state.job.credits?.state || 'not-used'}. Pending credits are holds, not finalized charges.`));
  $('build-log').replaceChildren(...nodes);
}
async function loadJobs(){
  if(!state.project)return;
  const id=state.project.id;
  const [{jobs},capabilities]=await Promise.all([api(`/api/projects/${id}/jobs`),Date.now()-state.capabilitiesAt>15000?api('/api/studio/session'):null]);
  if(state.project?.id!==id)return;
  if(capabilities){state.capabilities=capabilities;state.capabilitiesAt=Date.now();}
  const selected=state.job?.id, summary=jobs.find(job=>job.id===selected)||jobs[0]||null;state.jobs=jobs;
  if(!summary)state.job=null;
  else if(!state.job||state.job.id!==summary.id||state.job.updatedAt!==summary.updatedAt||state.job.status!==summary.status||state.job.credits?.state!==summary.credits?.state){
    const {job}=await api(`/api/jobs/${summary.id}`);if(state.project?.id!==id)return;state.job=job;
  }
  await models.refresh();
  renderBuilds();
}
$('build-form').addEventListener('submit',event=>{event.preventDefault();task($('generate-button'),async()=>{
  if(state.buildSubmitting)return;
  state.buildSubmitting=true;
  try {
    if(dirty())throw new Error('Save your source changes before starting a build.');
    const projectId=state.project.id,version=state.project.version,prompt=$('build-prompt').value.trim(),quote=await models.prepare();
    if(!await confirmAction('Confirm model and build cost',models.confirmation(quote),'Start build'))return;
    if(state.project?.id!==projectId || state.project.version!==version || dirty())throw new Error('Project changed. Review it before generating.');
    const payload={version,prompt,...quote},key=JSON.stringify({projectId,...payload});
    if(!pendingBuildRequest || pendingBuildRequest.key!==key)pendingBuildRequest={key,requestId:crypto.randomUUID()};
    const {job}=await api(`/api/projects/${projectId}/jobs`,{method:'POST',body:{...payload,requestId:pendingBuildRequest.requestId}});
    pendingBuildRequest=null;state.job=job;await models.refresh(true);await loadJobs();notice('Build queued.');
  } finally {state.buildSubmitting=false;renderBuilds();}
});});
$('cancel-build').addEventListener('click',()=>task($('cancel-build'),async()=>{if(!await confirmAction('Cancel this build?','The worker will stop when cancellation is detected. Provider requests already accepted may still be billed.','Cancel build'))return;await api(`/api/jobs/${state.job.id}/cancel`,{method:'POST',body:{}});await loadJobs();}));
function showReview(before,after,summary,job,href){
  state.review={before,after,job};$('review-summary').textContent=summary;$('apply-proposal').hidden=!job||job.status!=='review';$('export-proposal').href=href;
  const paths=[...new Set([...before,...after].map(file=>file.path))].filter(path=>before.find(file=>file.path===path)?.content!==after.find(file=>file.path===path)?.content);
  if(!paths.length)paths.push(...after.map(file=>file.path));$('review-file').replaceChildren(...paths.map(path=>new Option(path,path)));refreshSelects($('review-dialog'));renderDiff();$('review-dialog').showModal();
}
function renderDiff(){const path=$('review-file').value;$('diff-before').textContent=state.review?.before.find(file=>file.path===path)?.content??'File not present in this revision.';$('diff-after').textContent=state.review?.after.find(file=>file.path===path)?.content??'File removed in this proposal.';}
$('review-file').addEventListener('change',renderDiff);
$('review-button').addEventListener('click',()=>task($('review-button'),async()=>{const job=state.job,{project}=await api(`/api/projects/${state.project.id}/revisions?version=${job.baseVersion}`);showReview(project.files,job.result.files,job.result.summary,job,`/api/jobs/${job.id}/export`);}));
$('apply-proposal').addEventListener('click',()=>task($('apply-proposal'),async()=>{if(dirty())throw new Error('Save or discard unsaved changes before applying a proposal.');if(!await confirmAction('Apply these changes?','The reviewed files become a new revision only if the project still matches the build snapshot.','Apply proposal'))return;const result=await api(`/api/jobs/${state.review.job.id}/apply`,{method:'POST',body:{version:state.project.version}});setProject(result.project,true);$('review-dialog').close();renderEditor();await loadJobs();notice('Proposal applied as a new project revision.');}));
async function admin(tab){
  const definitions=[['users','Users','users:read'],['projects','Projects','projects:read'],['tools','Tools','tools:manage'],['settings','Settings','settings:manage'],['models','Models & credits','settings:manage'],['audit','Audit log','audit:read']].filter(([id, ,permission])=>state.capabilities.permissions.includes(permission)&&(id!=='models'||state.capabilities.owner));
  if(!definitions.length)throw new Error('This account has no administration permissions.');
  tab=definitions.some(item=>item[0]===tab)?tab:definitions[0][0];state.adminTab=tab;
  $('admin-tabs').replaceChildren(...definitions.map(([id,label])=>{const node=button(label,()=>admin(id));node.setAttribute('role','tab');node.setAttribute('aria-selected',String(id===tab));return node;}));
  const root=$('admin-content');root.replaceChildren(el('p','muted','Loading controls...'));
  if(tab==='models'){await models.renderAdmin(root);return;}
  if(tab==='settings'){await settingsPanel(root);return;}
  if(tab==='tools'){const data=await api('/api/admin/tools');root.replaceChildren();const card=el('div','admin-card');card.append(el('h2','','Generator access'),el('p','','Only implemented generators can be enabled. Members mode is an owner-only release decision. A healthy worker and model configuration are still required.'));
    for(const id of Object.keys(data.tools)){const control=selectField(toolName(id),[['disabled','Disabled'],['owner','Owner testing'],['members','Members']],data.tools[id],id),row=el('div','toolbar');row.append(control.label,button('Save mode',async()=>{await api('/api/admin/tools',{method:'PATCH',body:{toolId:id,mode:control.input.value,version:data.version}});notice('Tool access updated.');state.capabilities=await api('/api/studio/session');await admin('tools');},'primary'));card.append(row);}root.append(card);refreshSelects(root);return;}
  if(tab==='users'){const toolbar=el('div','toolbar'),search=field('Find an account','search','','query'),list=el('div');search.label.classList.add('search');toolbar.append(search.label,button('Search',()=>loadUsers(search.input.value,list)));root.replaceChildren(toolbar,list);await loadUsers('',list);return;}
  if(tab==='projects'){const {projects}=await api('/api/admin/projects'),view=table(['Project','Owner','State','Actions']);root.replaceChildren(view.wrap);for(const project of projects){const row=el('tr');row.append(el('td','',project.name),el('td','',project.user_id),el('td','',project.archived?'Archived':'Active'));const actions=el('td');if(state.capabilities.permissions.includes('projects:manage'))actions.append(button(project.archived?'Unarchive':'Archive',async()=>{const reason=await reasonDialog('Moderate project',project.name);if(reason===null)return;await api(`/api/admin/projects/${project.id}`,{method:'PATCH',body:{archived:!project.archived,version:project.version,reason}});await admin('projects');}));row.append(actions);view.body.append(row);}if(!projects.length)root.append(el('p','table-empty','No projects found.'));return;}
  if(tab==='audit'){root.replaceChildren();const view=table(['Time','Action','Actor','Target','Detail']);root.append(view.wrap);let before='';const load=async()=>{const result=await api(`/api/admin/audit${before?`?before=${before}`:''}`);for(const item of result.items){const row=el('tr');for(const value of [time(item.created_at),item.action,item.actor,item.target,item.detail])row.append(el('td','',value));view.body.append(row);}before=result.next;more.hidden=!before;};const more=button('Load older activity',load);root.append(more);await load();}
}
async function loadUsers(query,root){const {users,next}=await api(`/api/admin/users?q=${encodeURIComponent(query)}`);root.replaceChildren();const view=table(['Account','Status','Daily limits','Actions']);root.append(view.wrap);for(const user of users){const row=el('tr'),account=el('td','',user.display_name);account.append(el('small','',`${user.username} / ${user.discord_id}${user.owner?' / OWNER':''}`));const actions=el('td');if(state.capabilities.permissions.includes('users:manage'))actions.append(button('Manage',()=>{state.managedUser=user;const form=$('user-form');form.reset();formError(form,'');$('user-title').textContent=user.display_name;form.elements.status.value=user.status;form.elements.dailyLimit.value=user.daily_limit;form.elements.dailyBudget.value=user.daily_budget/1000000;refreshSelects(form);$('user-dialog').showModal();}));row.append(account,el('td','',user.status),el('td','',`${user.daily_limit} builds / ${money(user.daily_budget)}`),actions);view.body.append(row);}if(!users.length)root.append(el('p','table-empty','No matching accounts.'));if(next)root.append(el('p','muted','Showing 50 accounts. Narrow your search to locate a specific account.'));}
$('user-form').addEventListener('submit',event=>{event.preventDefault();submit(event.currentTarget,async()=>{const e=event.currentTarget.elements;await api(`/api/admin/users/${state.managedUser.id}`,{method:'PATCH',body:{status:e.status.value,dailyLimit:Number(e.dailyLimit.value),dailyBudgetMicros:Math.round(Number(e.dailyBudget.value)*1000000),version:state.managedUser.version,revokeSessions:e.revoke.checked,reason:e.reason.value.trim()}});$('user-dialog').close();notice('Account controls updated.');await admin('users');});});
async function settingsPanel(root){
  const data=await api('/api/admin/settings');state.settings=data.settings;const form=el('form'),grid=el('div','settings-grid');root.replaceChildren(form);form.append(grid);
  const discord=el('section','admin-card');discord.append(el('h2','','Discord connection'),el('p','',`${data.botConfigured?'Bot token configured':'Bot token not configured'}. Credentials stay in the private server environment, never in this form.`));
  const guild=field('Discord guild ID','text',data.settings.guildId,'guildId');guild.input.maxLength=20;discord.append(guild.label,button('Test connection',async()=>{const result=await api('/api/admin/discord/test',{method:'POST',body:{}});notice(`Connected as ${result.bot.username} in ${result.guild.name}.`);}));
  const provider=el('section','admin-card');provider.append(el('h2','','Legacy single-model settings'),el('p','',`${data.workerReady?'A worker is connected.':'No healthy worker is connected.'} Enter current model prices from your provider. Cost reservations are conservative estimates, not a billing guarantee.`));
  provider.append(el('p','notice','Use Models & credits to add multiple models and per-model pricing. Once that catalog is saved, these legacy model fields no longer control new builds.'));
  const controls={guildId:guild.input};for(const [name,label,type,min,max,step] of [['model','Model identifier','text'],['maxOutputTokens','Maximum output tokens','number',512,16384,1],['maxCalls','Maximum model calls per build','number',1,2,1],['budget','Maximum budget per build (USD)','number',.01,10,.01],['inputUsdPerMillion','Input USD per million tokens','number',0,1000,.000001],['outputUsdPerMillion','Output USD per million tokens','number',0,1000,.000001]]){const value=name==='budget'?data.settings.maxBudgetMicros/1000000:data.settings[name],f=field(label,type,value,name);if(min!==undefined){f.input.min=min;f.input.max=max;f.input.step=step;}controls[name]=f.input;provider.append(f.label);}grid.append(discord,provider);
  const roles=el('section','admin-card');roles.append(el('h2','','Discord role permissions'),el('p','','Only the explicit server-side Discord user-ID allowlist grants owner access. Role lookups fail closed; sensitive staff changes refresh membership before authorization.'));
  const rows=el('div');function addRole(id='',permissions=[]){const row=el('div','role-row'),f=field('Role ID','text',id,'role');f.input.maxLength=20;f.input.required=true;const permissionsGrid=el('div','permission-grid');for(const permission of data.permissions){const label=el('label','check'),input=el('input');input.type='checkbox';input.value=permission;input.checked=permissions.includes(permission);label.append(input,document.createTextNode(permission));permissionsGrid.append(label);}row.append(f.label,permissionsGrid,button('Remove mapping',()=>row.remove(),'danger'));rows.append(row);}
  for(const [id,permissions] of Object.entries(data.settings.roleMappings))addRole(id,permissions);roles.append(rows,button('+ Add role mapping',()=>{if(rows.children.length>=20)throw new Error('At most 20 mappings are supported.');addRole();}));form.append(roles);
  const message=el('p','form-error');message.hidden=true;message.setAttribute('role','alert');const save=el('button','primary','Save configuration');save.type='submit';save.disabled=!state.capabilities.owner;form.append(message,save);if(!state.capabilities.owner)form.append(el('p','muted','Only a configured owner can save these settings.'));
  form.addEventListener('submit',event=>{event.preventDefault();submit(form,async()=>{const roleMappings={};for(const row of rows.children){const id=row.querySelector('input[name=role]').value.trim();if(Object.hasOwn(roleMappings,id))throw new Error('Each Discord role can be mapped once.');roleMappings[id]=[...row.querySelectorAll('input[type=checkbox]:checked')].map(input=>input.value);}
    const body={...data.settings,guildId:controls.guildId.value.trim(),model:controls.model.value.trim(),maxOutputTokens:Number(controls.maxOutputTokens.value),maxCalls:Number(controls.maxCalls.value),maxBudgetMicros:Math.round(Number(controls.budget.value)*1000000),inputUsdPerMillion:Number(controls.inputUsdPerMillion.value),outputUsdPerMillion:Number(controls.outputUsdPerMillion.value),roleMappings};
    await api('/api/admin/settings',{method:'PATCH',body});notice('Configuration saved. No secrets were changed.');await admin('settings');
  });});
}
function reasonDialog(title,description){return new Promise(resolve=>{const dialog=el('dialog'),form=el('form'),f=field('Reason','text','','reason');f.input.maxLength=300;f.input.required=true;form.append(el('h2','',title),el('p','dialog-description',description),f.label);const actions=el('div','dialog-actions'),cancel=button('Cancel',()=>dialog.close()),accept=el('button','primary','Confirm');accept.type='submit';actions.append(cancel,accept);form.append(actions);let result=null;form.addEventListener('submit',event=>{event.preventDefault();result=f.input.value.trim();if(result)dialog.close();});dialog.addEventListener('close',()=>{dialog.remove();resolve(result);},{once:true});dialog.append(form);document.body.append(dialog);dialog.showModal();f.input.focus();});}
$('refresh-roles').addEventListener('click',()=>task($('refresh-roles'),async()=>{await api('/api/studio/roles/refresh',{method:'POST',body:{}});state.capabilities=await api('/api/studio/session');notice('Discord permissions refreshed.');await renderRoute();}));
async function renderRoute(){
  if(!state.session?.user){show('login');return;}const requested=location.hash||'#projects';
  if(requested!==state.route&&dirty()){if(!await confirmAction('Leave unsaved source changes?','Your unsaved changes exist only in this browser tab. Saved revisions are not affected.','Discard changes')){history.replaceState(null,'',state.route);return;}state.drafts.clear();}
  const sequence=++routeSequence;state.route=requested;$('error').hidden=true;$('projects-nav').removeAttribute('aria-current');$('admin-nav').removeAttribute('aria-current');
  if(requested==='#admin'){$('route-label').textContent='CONTROL ROOM';$('admin-nav').setAttribute('aria-current','page');show('admin-view');await admin(state.adminTab);return;}
  const match=/^#project\/([a-f0-9-]{36})$/.exec(requested);
  if(match){show('loading');const result=await api(`/api/projects/${match[1]}`);if(sequence!==routeSequence)return;setProject(result.project);state.jobs=[];state.job=null;state.capabilities=await api('/api/studio/session');if(sequence!==routeSequence)return;$('route-label').textContent='PROJECT EDITOR';show('editor-view');renderEditor();await loadJobs();return;}
  state.project=null;state.jobs=[];state.job=null;$('route-label').textContent='PROJECTS';$('projects-nav').setAttribute('aria-current','page');show('dashboard');await loadDashboard();
}
document.querySelector('.skip').addEventListener('click',event=>{event.preventDefault();$('content').focus();});
window.addEventListener('hashchange',()=>task(null,renderRoute));window.addEventListener('beforeunload',event=>{if(dirty()){event.preventDefault();event.returnValue='';}});
$('new-project').addEventListener('click',()=>task($('new-project'),()=>openProjectDialog()));
$('project-search').addEventListener('input',renderProjects);$('project-filter').addEventListener('change',renderProjects);$('project-sort').addEventListener('change',renderProjects);
for(const node of document.querySelectorAll('[data-close]'))node.addEventListener('click',()=>node.closest('dialog').close());
for(const node of document.querySelectorAll('button[data-panel]'))node.addEventListener('click',()=>panel(node.dataset.panel));
setInterval(async()=>{if(document.hidden||state.pollBusy||!state.project||$('editor-view').hidden)return;state.pollBusy=true;try{await loadJobs();}catch(failure){error(failure.message);}finally{state.pollBusy=false;}},4000);
try{
  [state.session,state.catalog]=await Promise.all([api('/api/session'),api('/catalog.json')]);
  refreshSelects();
  if(state.session.user){await models.refresh(true);state.capabilities=await api('/api/studio/session');$('profile-link').textContent=state.session.user.displayName;$('new-project').disabled=false;$('admin-nav').hidden=!state.capabilities.permissions.length;document.body.classList.toggle('compact',state.session.user.density==='compact');}
  await renderRoute();
}catch(failure){show('login');error(failure.message);}
