import {refreshSelects,confirmAction as confirmDialog} from './controls.js';
const $=id=>document.getElementById(id),ended=new Set(['completed','conflict','failed','cancelled']);
const state={session:null,bootstrap:null,project:null,policy:null,chats:[],chat:null,tasks:[],task:null,files:[],selected:null,drafts:new Map(),scope:0,chatScope:0,polling:false,messageRevision:0,pendingTask:null,pendingMessage:null,viewKey:'',editorKey:'',planKey:'',tabId:crypto.randomUUID(),dialogScope:null,busy:new Set(),taskScope:0,composerDrafts:new Map()};
const money=value=>`$${(Number(value)/1000000).toFixed(4)}`;
const element=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
const requestId=()=>crypto.randomUUID();
async function confirmAction(...args){const accepted=await confirmDialog(...args);$('content').focus({preventScroll:true});return accepted;}
function showError(message){$('error').textContent=message;$('error').hidden=false;}
function announce(message){$('notice').textContent=message;$('notice').hidden=false;}
function setPanel(name){$('workbench').dataset.panel=name;document.querySelectorAll('.mobile-tabs [data-panel]').forEach(button=>button.setAttribute('aria-selected',String(button.dataset.panel===name)));if(name==='code')showTool('files');if(name==='plan')showTool('progress');document.dispatchEvent(new Event('studio:workbench-view'));}
async function api(path,{method='GET',body}={}){
  const session=state.session;
  const headers=body===undefined?{}:{'content-type':'application/json','x-csrf-token':session?.csrf||''};
  const response=await fetch(path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),credentials:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(20000)});
  let result;try{result=await response.json();}catch{throw new Error('Studio returned an unexpected response. Your local draft has not been removed.');}
  if(!response.ok){if(response.status===401&&state.session===session){$('connection').textContent='Session ended. Sign in again.';$('login').hidden=false;}throw new Error(result.error||`Request failed (${response.status}).`);}return result;
}
async function work(node,action){if(node?.disabled)return;if(node){node.disabled=true;state.busy.add(node.id);}$('error').hidden=true;try{await action();}catch(error){showError(error.message||'This operation could not complete.');}finally{if(node){state.busy.delete(node.id);node.disabled=false;}renderControls();renderEditor();}}
function formError(form,message){const node=form.querySelector('.form-error');node.textContent=message;node.hidden=!message;}
async function submit(form,fn){const button=form.querySelector('[type=submit]');if(button.disabled)return;button.disabled=true;form.inert=true;formError(form,'');try{await fn();}catch(error){formError(form,error.message);}finally{button.disabled=false;form.inert=false;}}
function options(select,items,value){select.replaceChildren(...items.map(([id,label,disabled=false])=>{const option=new Option(label,id);option.disabled=disabled;return option;}));if(items.some(item=>item[0]===value))select.value=value;refreshSelects(select.parentElement);}
function activeTask(){return state.tasks.find(task=>!ended.has(task.state))||null;}
function draftKey(){return state.session?.user&&state.project?`nd-agent-drafts:${state.session.user.id}:${state.project.id}`:null;}
function persistDrafts(){const key=draftKey();if(!key)return;try{if(state.drafts.size)sessionStorage.setItem(key,JSON.stringify([...state.drafts]));else sessionStorage.removeItem(key);}catch{announce('Browser recovery storage is unavailable. Your draft remains in this tab. Download it before closing.');}}
function restoreDrafts(){state.drafts.clear();try{const raw=sessionStorage.getItem(draftKey());if(!raw)return;const values=JSON.parse(raw);if(!Array.isArray(values)||values.length>64)return;for(const [path,value] of values){if(typeof path==='string'&&value&&typeof value.content==='string'&&value.content.length<=65536&&Number.isInteger(value.baseVersion))state.drafts.set(path,value);}}catch{announce('A local draft could not be restored. Saved server source is unchanged.');}}
function renderEditor(force=false){
  // Redesign: agent page uses tool pane for files; main source editor DOM lives in workspace.html only.
  if(!$('source-mode') || !$('code')) return;
  const staged=$('source-mode').value==='staged';const files=staged?state.files:state.project?.files||[];const paths=[...new Set([...files.map(file=>file.path),...(!staged?state.drafts.keys():[])])];
  if(!paths.includes(state.selected))state.selected=paths[0]||null;
  const key=JSON.stringify({paths,selected:state.selected,staged,drafts:[...state.drafts.keys()]});
  if(key!==state.editorKey){state.editorKey=key;$('files').replaceChildren(...paths.map(path=>{const button=element('button',path===state.selected?'active':'',`${!staged&&state.drafts.has(path)?'* ':''}${path}`);button.type='button';button.addEventListener('click',()=>{state.selected=path;renderEditor(true);});return button;}));if(!paths.length)$('files').append(element('p','fine','No source files yet.'));}
  const file=files.find(file=>file.path===state.selected),draft=!staged&&state.drafts.get(state.selected);const content=draft?.content??file?.content??'';
  if(force||$('code').value!==content){const focused=document.activeElement===$('code');const start=$('code').selectionStart,end=$('code').selectionEnd,scroll=$('code').scrollTop;$('code').value=content;if(focused&&!force){$('code').setSelectionRange(start,end);$('code').scrollTop=scroll;}}
  $('code').disabled=!state.selected;$('code').readOnly=staged||Boolean(state.project?.archived);$('file-name').textContent=state.selected||'Select a file';$('revision').textContent=state.project?`Revision ${state.project.version}`:'';
  $('save-file').disabled=!draft||staged||Boolean(state.project?.archived)||state.busy.has('save-file');$('download-draft').disabled=!state.selected;$('attach-file').disabled=!state.selected||staged;
  $('draft-status').textContent=staged?'Agent staging is not saved source.':draft?draft.baseVersion!==state.project.version?'Local draft preserved. Saved source changed; compare before saving.':'Unsaved local draft.':'Saved source. Changes appear without replacing local drafts.';
  document.dispatchEvent(new Event('studio:workbench-view'));
}
function renderControls(){
  const t=state.task,active=activeTask();const stateEl=$('task-state');if(stateEl)stateEl.textContent=t?t.state.replaceAll('_',' '):'Idle';
  const dot=$('task-state-dot');if(dot)dot.className='status-dot '+(t&&t.state==='running'?'working':'');
  $('pause')&&($('pause').disabled=!t||!['running','queued'].includes(t.state)||Boolean(t.control));
  $('resume')&&($('resume').disabled=!t||!['paused','awaiting_input'].includes(t.state)||t.unreconciled);
  $('stop')&&($('stop').disabled=!t||ended.has(t.state)||t.control==='stop');
  $('undo')&&($('undo').disabled=!t||t.state!=='completed'||!t.appliedVersion||Boolean(t.undoVersion));
  for(const id of ['pause','resume','stop','undo']){const node=$(id);if(node)node.classList.toggle('is-unavailable',node.disabled);}
  $('approve')&&($('approve').hidden=t?.state!=='awaiting_approval');
  $('edit-plan')&&($('edit-plan').hidden=t?.state!=='awaiting_approval');
  $('export')&&($('export').hidden=!t);if(t&&$('export'))$('export').href=`/api/agent/tasks/${t.id}/export`;
  if($('send')) $('send').textContent=active?'Send message':($('composer')&&$('composer').elements.mode.value==='ask'?'Review allowance & ask':'Review allowance & start planning');
  if($('send')) $('send').disabled=!state.chat||Boolean(state.project?.archived);
  if($('rename-chat')) $('rename-chat').disabled=!state.chat;
  if($('new-chat')) $('new-chat').disabled=!state.project||Boolean(state.project.archived);
  if($('project-instructions')) $('project-instructions').disabled=!state.project;
  const model=state.bootstrap?.catalog.models.find(model=>model.id===$('model-select').value);
  for(const id of state.busy)if($(id))$(id).disabled=true;
  if($('quote')) $('quote').textContent=model?`${model.label} / ${model.provider}. ${state.bootstrap.catalog.billing?.enabled?'Maximum metered allowance':'Fixed successful-task quote'}: ${state.bootstrap.catalog.creditsEnabled?model.creditsPerBuild:0} Studio credits. Provider allowance: ${money(model.maxBudgetMicros)}, including planning. ${model.workerReady?'':'Agent worker is not ready.'}`:'Enable a compatible model in Control room first.';
  if($('top-project')) $('top-project').textContent=state.project?state.project.name:'No project';
  if($('top-session')) $('top-session').textContent=state.chat?state.chat.title:'Select session';
  if($('chat-title')) $('chat-title').textContent=state.chat?state.chat.title:'Conversation';
  renderSidebar();
}
function renderPlan(){
  const t=state.task,key=JSON.stringify(t);if(key===state.planKey)return;state.planKey=key;
  const prog=$('tool-progress-content');if(prog){prog.replaceChildren();if(!t){prog.append(element('p','fine','No active task.'));return;}
    if(t.plan)prog.append(element('p','',t.plan.goal));
    for(const check of t.checks)prog.append(element('p','fine',check));
    for(const item of t.history.slice(-4)){const d=element('div','fine');d.textContent=`${item.ok===false?'BLOCKED ':''}${item.type}${item.path?` / ${item.path}`:''}`;prog.append(d);}
  }
  const planEl=$('plan');if(!planEl)return;
  planEl.replaceChildren();
  const ch=$('checks');if(ch)ch.replaceChildren();
  const ac=$('actions');if(ac)ac.replaceChildren();
  if(!t){planEl.append(element('p','muted','Start a task to inspect permitted source and propose a plan.'));return;}
  if(t.plan){planEl.append(element('h3','',t.plan.goal));const steps=element('ol');for(const step of t.plan.steps)steps.append(element('li','',step));planEl.append(steps);for(const change of t.plan.changes)planEl.append(element('p','operation',`${change.operation.toUpperCase()}  ${change.path}`));planEl.append(element('p','fine',`Approved capabilities: ${t.plan.capabilities.join(', ')||'read-only'}. Plan revision ${t.planVersion}.`));}
  else planEl.append(element('p','muted',t.phase==='ask'?'Read-only question. The agent may inspect permitted project files.':'The agent is preparing a plan. Source changes are blocked until you approve it.'));
  planEl.append(element('p','task-meta',`${t.model} / ${t.steps} of ${t.maxSteps} model calls. API ${t.unreconciled?'reservation, unreconciled':'cost estimate'}: ${money(t.spentMicros)} / ${money(t.reservedMicros)}. Studio credits: ${t.credits.amount} / ${t.credits.state}.`));
  if(t.control)planEl.append(element('p','notice',`${t.control==='pause'?'Pause':'Stop'} requested. Waiting for a safe checkpoint.`));
  if(t.appliedVersion)planEl.append(element('p','notice',`Automatically saved revision ${t.appliedVersion}. No second Apply step is needed.`));
  if(t.undoVersion)planEl.append(element('p','fine',`Undone as revision ${t.undoVersion}.`));
  if(t.unreconciled)planEl.append(element('p','notice','Provider usage needs reconciliation. Further paid steps are blocked; Stop returns Studio credits.'));
  if(t.error)planEl.append(element('p','notice',t.error));
  if(t.failure){const diagnostic=element('section','notice');diagnostic.setAttribute('aria-label','Task failure details');diagnostic.append(element('strong','',t.failure.summary),element('p','fine',t.failure.nextStep));const ids=[t.failure.category,t.failure.httpStatus?`HTTP ${t.failure.httpStatus}`:null,t.failure.providerCode,t.failure.requestId,t.failure.responseId].filter(Boolean);diagnostic.append(element('p','fine',ids.join(' / ')));planEl.append(diagnostic);}
  for(const check of t.checks){const ch=$('checks'); if(ch) ch.append(element('p','',check)); }
  for(const item of t.history){const card=element('article','action');card.append(element('strong','',`${item.ok===false?'BLOCKED / ':''}${item.type}${item.path?` / ${item.path}`:''}`),element('p','',item.message));if(item.diagnostic)card.append(element('p','fine',`${item.diagnostic.category}: ${item.diagnostic.summary} ${item.diagnostic.nextStep}`)); const ac=$('actions'); if(ac) ac.append(card);}
}

function renderSidebar(){
  const list=$('session-list');if(!list||!state.chats)return;
  list.replaceChildren();
  if(!state.chats.length){list.append(element('p','fine','No conversations yet.'));return;}
  state.chats.forEach(chat=>{
    const active=state.chat&&state.chat.id===chat.id;
    const row=element('div','sess'+(active?' active':''));
    row.tabIndex=0;row.setAttribute('role','button');row.setAttribute('aria-current',active?'true':'false');
    row.append(element('span','t',chat.title),element('span','ts',new Date(chat.updatedAt||Date.now()).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})));
    const open=()=>work(null,()=>openChat(chat.id));
    row.addEventListener('click',open);
    row.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();open();}});
    list.append(row);
  });
}
function renderChat(view){
  const key=JSON.stringify({messages:view.messages,actions:state.task?.history,working:state.task?.working});if(key!==state.viewKey){state.viewKey=key;const list=$('messages'),follow=list.scrollHeight-list.scrollTop-list.clientHeight<80;list.replaceChildren(...view.messages.map(message=>{const role=message.role.startsWith('user')?'user':message.role;const bubble=element('article',`bubble ${role}`);bubble.append(element('strong','',message.role.replaceAll('-',' ')),element('p','',message.text));return bubble;}));if(!view.messages.length)list.append(element('p','muted','Tell the agent what you want to build. It will inspect the project and propose a plan before changing source.'));if(state.task){for(const action of state.task.history.slice(-6)){const card=element('details','bubble action-card'),summary=element('summary','',`${action.ok===false?'Blocked: ':''}${action.type.replaceAll('_',' ')}${action.path?` / ${action.path}`:''}`);card.append(summary,element('p','',`${action.message}${action.error?`\n${action.error}`:''}`));if(action.diagnostic)card.append(element('p','fine',`${action.diagnostic.category}: ${action.diagnostic.summary} ${action.diagnostic.nextStep}`));list.append(card);}if(state.task.working&&state.task.state==='running')list.append(element('p','fine','The approved model is choosing its next action.'));}if(follow)list.scrollTop=list.scrollHeight;}
  const taskItems=state.tasks.map(t=>[t.id,`${t.state.replaceAll('_',' ')} / ${new Date(t.createdAt).toLocaleTimeString()}`]);if(!taskItems.length)taskItems.push(['','No tasks yet']);
  const ts=$('task-select'); if(ts) options(ts,taskItems,state.task?.id);
  renderPlan();renderControls();
}
async function presence(){if(!state.project||!state.session?.user)return;await api(`/api/agent/projects/${state.project.id}/presence`,{method:'POST',body:{tabId:state.tabId}});}
async function refresh(){
  if(!state.project||state.polling)return;state.polling=true;
  const scope=state.scope,chatScope=state.chatScope,taskScope=state.taskScope,projectId=state.project.id,chatId=state.chat?.id;
  try{
    const projectData=await api(`/api/agent/projects/${projectId}`);if(scope!==state.scope)return;
    state.project=projectData.project;state.chats=projectData.chats;state.policy=projectData.policy;renderEditor();
    if(chatId){const view=await api(`/api/agent/chats/${chatId}`);if(scope!==state.scope||chatScope!==state.chatScope)return;state.tasks=view.tasks;const selected=state.tasks.find(task=>task.id===state.task?.id)||state.tasks[0];const loaded=selected?(await api(`/api/agent/tasks/${selected.id}`)).task:null;if(scope!==state.scope||chatScope!==state.chatScope||taskScope!==state.taskScope)return;if(!loaded||loaded.id!==state.task?.id||loaded.version>=state.task.version)state.task=loaded;if(state.task)state.files=(await api(`/api/agent/tasks/${state.task.id}/files`)).files;else state.files=[];if(scope!==state.scope||chatScope!==state.chatScope)return;renderChat(view);renderEditor();if(state.pendingTask&&state.tasks.some(task=>task.requestId===state.pendingTask.requestId))state.pendingTask=null;}
    $('connection').textContent='Project synchronized';
  }finally{state.polling=false;}
}
function keepComposer(){if(state.project&&state.chat)state.composerDrafts.set(`${state.project.id}:${state.chat.id}`,$('message').value);}
async function openChat(id){keepComposer();const scope=state.scope,chatScope=++state.chatScope,taskScope=++state.taskScope;state.chat=state.chats.find(chat=>chat.id===id)||null;const chatSelect=$('chat-select');if(chatSelect&&id&&[...chatSelect.options].some(option=>option.value===id)&&chatSelect.value!==id){chatSelect.value=id;refreshSelects(chatSelect.parentElement);}if($('message')) $('message').value=state.composerDrafts.get(`${state.project?.id}:${id}`)||'';state.messageRevision++;state.pendingTask=null;state.pendingMessage=null;state.task=null;state.tasks=[];state.files=[];state.viewKey='';state.planKey='';if(!state.chat){if($('messages')) $('messages').replaceChildren(element('p','muted','Create a named conversation for this project.'));renderPlan();renderControls();return;}const view=await api(`/api/agent/chats/${id}`);if(scope!==state.scope||chatScope!==state.chatScope)return;state.tasks=view.tasks;const selected=state.tasks[0];const loaded=selected?(await api(`/api/agent/tasks/${selected.id}`)).task:null;if(scope!==state.scope||chatScope!==state.chatScope||taskScope!==state.taskScope)return;if(!loaded||loaded.id!==state.task?.id||loaded.version>=state.task.version)state.task=loaded;renderChat(view);renderSidebar();}
async function openProject(id){persistDrafts();keepComposer();const scope=++state.scope;state.chatScope++;state.project=null;state.chat=null;state.task=null;state.tasks=[];state.files=[];state.selected=null;state.drafts.clear();state.pendingTask=null;state.pendingMessage=null;renderEditor(true);renderControls();const data=await api(`/api/agent/projects/${id}`);if(scope!==state.scope)return;state.project=data.project;state.policy=data.policy;state.chats=data.chats;restoreDrafts();const cs=$('chat-select');if(cs)options(cs,state.chats.length?state.chats.map(chat=>[chat.id,chat.title]):[['','Create a conversation']]);$('history').href=`/workspace.html#project/${id}`;history.replaceState(null,'',`#project/${id}`);if($('agent-project-title')) $('agent-project-title').textContent=state.project.name;if($('agent-project-context')) $('agent-project-context').textContent=`${state.project.target} / Private project / Plan approval before source changes`;document.dispatchEvent(new Event('studio:workbench-view'));$('composer')&&($('composer').elements.continuation.value=data.policy.continuation);refreshSelects($('composer'));renderEditor(true);await presence();const firstChatId=cs?cs.value:(state.chats[0]?state.chats[0].id:null);if(firstChatId)await openChat(firstChatId);if(scope===state.scope)$('connection').textContent='Project synchronized';renderSidebar();if($('tool-files')&&!$('tool-files').hidden)renderEditor(true);}
const ps=$('project-select'); if(ps) ps.addEventListener('change',()=>work(null,()=>openProject(ps.value)));
const cs2=$('chat-select'); if(cs2) cs2.addEventListener('change',()=>work(null,()=>openChat(cs2.value)));
const ts2=$('task-select'); if(ts2) ts2.addEventListener('change',()=>work(null,async()=>{const scope=state.scope,chatScope=state.chatScope;state.taskScope++;const data=await api(`/api/agent/tasks/${ts2.value}`);if(scope!==state.scope||chatScope!==state.chatScope)return;state.task=data.task;state.files=(await api(`/api/agent/tasks/${data.task.id}/files`)).files;if(scope!==state.scope||chatScope!==state.chatScope)return;renderPlan();renderControls();renderEditor();}));
const sm=$('source-mode'); if(sm) sm.addEventListener('change',()=>renderEditor(true));
$('model-select').addEventListener('change',renderControls);$('composer').elements.mode.addEventListener('change',renderControls);
$('message').addEventListener('input',()=>state.messageRevision++);
$('composer').addEventListener('submit',event=>{event.preventDefault();work($('send'),async()=>{
  if(!state.chat)throw new Error('Create a conversation first.');const scope=state.scope,chatScope=state.chatScope,chatId=state.chat.id,form=event.currentTarget,e=form.elements,text=e.message.value.trim(),revision=state.messageRevision;if(!text)throw new Error('Enter a request.');
  const current=activeTask();
  if(current){const body={text,mode:e.messageMode.value};if(!state.pendingMessage||JSON.stringify(state.pendingMessage.body)!==JSON.stringify(body))state.pendingMessage={body,requestId:requestId()};await api(`/api/agent/chats/${chatId}/messages`,{method:'POST',body:{...body,requestId:state.pendingMessage.requestId}});if(scope!==state.scope||chatScope!==state.chatScope)return;state.pendingMessage=null;announce(body.mode==='queue'?'Message saved for later. It does not authorize another paid task.':'Message saved. Resume explicitly after the task pauses; a redirect requires a revised plan.');}
  else{
    const catalog=state.bootstrap.catalog,model=catalog.models.find(model=>model.id===e.modelId.value);if(!model||!model.workerReady)throw new Error('Choose an enabled model with a connected agent worker.');
    const body={message:text,mode:e.mode.value,modelId:model.id,pricingVersion:catalog.pricingVersion,quotedCredits:catalog.creditsEnabled?model.creditsPerBuild:0,maxSteps:Number(e.maxSteps.value),continuation:e.continuation.value,projectVersion:state.project.version};
    if(!await confirmAction(body.mode==='ask'?'Authorize a read-only question?':'Authorize paid planning?',`Use ${model.label} only, with a maximum provider allowance of ${money(model.maxBudgetMicros)} and ${catalog.billing?.enabled?`a maximum metered allowance of ${body.quotedCredits} Studio credits, settling only recorded priced usage on delivery`:`a fixed successful-task quote of ${body.quotedCredits} Studio credits`}. Planning, coding and checks share this allowance and ${body.maxSteps} model calls. Failed or stopped tasks return all Studio credits in this owner preview. Planning can read permitted project files and conversation context, but source changes still require plan approval.`,body.mode==='ask'?'Ask with allowance':'Start read-only planning'))return;
    if(scope!==state.scope||chatScope!==state.chatScope)throw new Error('Project changed. Review a new allowance.');
    if(!state.pendingTask||JSON.stringify(state.pendingTask.body)!==JSON.stringify(body))state.pendingTask={body,requestId:requestId()};
    const created=await api(`/api/agent/chats/${chatId}/tasks`,{method:'POST',body:{...body,requestId:state.pendingTask.requestId}});if(scope!==state.scope||chatScope!==state.chatScope)return;state.task=created.task;state.pendingTask=null;
  }
  if(state.messageRevision===revision){e.message.value='';state.messageRevision++;}await refresh();
});});
async function control(action){if(!state.task)return;const task=state.task,scope=state.scope;if(['stop','undo'].includes(action)&&!await confirmAction(action==='undo'?'Undo this task?':'Stop this task?',action==='undo'?'Create a new revision using the source before this task. Newer manual revisions block undo. This does not refund a completed task.':'Stop at a safe checkpoint, preserve staged work and return task Studio credits. Provider usage already incurred remains recorded.',action==='undo'?'Undo task':'Stop task'))return;const {task:result}=await api(`/api/agent/tasks/${task.id}/control`,{method:'POST',body:{action,version:task.version,requestId:requestId()}});if(scope!==state.scope)return;state.taskScope++;state.task=result;await presence();await refresh();}
for(const action of ['pause','resume','stop','undo'])$(action).addEventListener('click',()=>work($(action),()=>control(action)));
$('approve').addEventListener('click',()=>work($('approve'),async()=>{const task=state.task,scope=state.scope;if(!task)return;if(!await confirmAction('Approve this exact plan?',`${task.plan.goal}\n\nAuthorize the listed file operations and capabilities using ${task.model}, within the existing ${money(task.reservedMicros)} allowance. Validated source saves automatically when no newer saved revision exists.`,'Approve and build'))return;const result=await api(`/api/agent/tasks/${task.id}/approve`,{method:'POST',body:{version:task.version,planVersion:task.planVersion,planHash:task.planHash,requestId:requestId()}});if(scope!==state.scope)return;state.taskScope++;state.task=result.task;await presence();await refresh();}));
function chatDialog(rename){state.dialogScope={projectId:state.project.id,chatId:rename?state.chat.id:null,chatVersion:state.chat?.version,requestId:requestId(),scope:state.scope};$('chat-form').reset();$('chat-form').elements.title.value=rename?state.chat.title:'';$('chat-dialog-title').textContent=rename?'Rename conversation':'Name your conversation';formError($('chat-form'),'');$('chat-dialog').showModal();}
const nc=$('new-chat'); if(nc) nc.addEventListener('click',()=>chatDialog(false));
const rc=$('rename-chat'); if(rc) rc.addEventListener('click',()=>chatDialog(true));
$('chat-form').addEventListener('submit',event=>{event.preventDefault();submit(event.currentTarget,async()=>{const scope=state.dialogScope,form=event.currentTarget,title=form.elements.title.value.trim();const result=await api(scope.chatId?`/api/agent/chats/${scope.chatId}`:`/api/agent/projects/${scope.projectId}/chats`,{method:scope.chatId?'PATCH':'POST',body:scope.chatId?{title,version:scope.chatVersion}:{title,requestId:scope.requestId}});$('chat-dialog').close();if(scope.scope!==state.scope)return;const data=await api(`/api/agent/projects/${scope.projectId}`);if(scope.scope!==state.scope)return;state.chats=data.chats;options($('chat-select'),state.chats.map(chat=>[chat.id,chat.title]),result.chat.id);await openChat(result.chat.id);});});
const codeEl=$('code'); if(codeEl) codeEl.addEventListener('input',()=>{if(!state.project||!state.selected||($('source-mode')&&$('source-mode').value!=='saved'))return;const existing=state.drafts.get(state.selected),saved=state.project.files.find(file=>file.path===state.selected);if(codeEl.value===saved?.content)state.drafts.delete(state.selected);else state.drafts.set(state.selected,{content:codeEl.value,baseVersion:existing?.baseVersion??state.project.version});persistDrafts();renderEditor();});
const sf2=$('save-file'); if(sf2) sf2.addEventListener('click',()=>work(sf2,async()=>{const scope=state.scope,projectId=state.project.id,path=state.selected,draft=state.drafts.get(path);if(!draft)return;const text=draft.content;let baseVersion=draft.baseVersion;if(baseVersion!==state.project.version){const latest=state.project.files.find(file=>file.path===path)?.content??'(File removed from saved source)';const dialog=document.createElement('dialog');dialog.className='draft-comparison';const heading=element('h2','','Compare before saving'),copy=element('p','fine',`Saved revision ${state.project.version} differs from this draft base. Saving creates a new revision only if that saved version remains current.`),grid=element('div','two-columns');for(const [label,value] of [['Current saved source',latest],['Your local draft',text]]){const section=element('section');section.append(element('h3','',label),element('pre','',value));grid.append(section);}const actions=element('div','dialog-actions'),cancel=element('button','','Keep draft'),save=element('button','primary','Save reviewed draft');let accepted=false;cancel.type=save.type='button';cancel.addEventListener('click',()=>dialog.close());save.addEventListener('click',()=>{accepted=true;dialog.close();});actions.append(cancel,save);dialog.append(heading,copy,grid,actions);document.body.append(dialog);const expected=state.project.version;await new Promise(resolve=>{dialog.addEventListener('close',()=>{dialog.remove();resolve();},{once:true});dialog.showModal();cancel.focus();});if(!accepted)return;if(scope!==state.scope||state.drafts.get(path)?.content!==text)throw new Error('Your draft changed. Compare it again before saving.');baseVersion=expected;}const result=await api(`/api/projects/${projectId}/files`,{method:'PUT',body:{path,content:text,version:baseVersion}});if(scope!==state.scope)return;if(state.drafts.get(path)?.content===text)state.drafts.delete(path);state.project=result.project;persistDrafts();renderEditor();announce('Saved as a new source revision. Any active agent result will preserve a source conflict instead of overwriting it.');}));
const dd=$('download-draft'); if(dd) dd.addEventListener('click',()=>{if(!state.selected)return;const c=$('code'); const val=c?c.value:'';const blob=new Blob([val],{type:'text/plain;charset=utf-8'}),url=URL.createObjectURL(blob),link=element('a');link.href=url;link.download=state.selected.split('/').at(-1);link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
const af=$('attach-file'); if(af) af.addEventListener('click',()=>{if(!state.selected)return;$('message').value+=`${$('message').value?'\n':''}@${state.selected} (saved project source)`;state.messageRevision++;$('message').focus();setPanel('chat');});
$('project-instructions').addEventListener('click',()=>{const form=$('policy-form'),p=state.policy;state.dialogScope={scope:state.scope,projectId:state.project.id,version:p.version};form.elements.instructions.value=p.instructions;form.elements.preset.value=p.preset;form.elements.protectedPaths.value=p.protectedPaths.join('\n');form.elements.continuation.value=p.continuation;form.elements.disconnectSeconds.value=p.disconnectSeconds;$('permission-fields').replaceChildren();for(const name of ['create','edit','delete','dependencies','migrations']){const label=element('label','',name[0].toUpperCase()+name.slice(1)),select=element('select');select.name=name;select.append(new Option('Automatic','automatic'),new Option('Ask in plan','ask'),new Option('Prohibited','prohibited'));select.value=p.permissions[name];label.append(select);$('permission-fields').append(label);}formError(form,'');refreshSelects(form);$('policy-dialog').showModal();});
$('policy-form').addEventListener('submit',event=>{event.preventDefault();submit(event.currentTarget,async()=>{const scope=state.dialogScope,e=event.currentTarget.elements,permissions={};for(const name of ['create','edit','delete','dependencies','migrations'])permissions[name]=e[name].value;const data=await api(`/api/agent/projects/${scope.projectId}/policy`,{method:'PATCH',body:{version:scope.version,instructions:e.instructions.value,preset:e.preset.value,permissions,protectedPaths:e.protectedPaths.value.split('\n').map(x=>x.trim()).filter(Boolean),continuation:e.continuation.value,disconnectSeconds:Number(e.disconnectSeconds.value)}});$('policy-dialog').close();if(scope.scope!==state.scope)return;state.policy=data.policy;announce('Project instructions saved. Existing tasks must use their original permissions or be stopped and replanned.');});});
$('edit-plan').addEventListener('click',()=>{const task=state.task;if(!task?.plan)return;state.dialogScope={scope:state.scope,taskId:task.id,version:task.version,capabilities:task.plan.capabilities};const form=$('plan-form');form.elements.goal.value=task.plan.goal;form.elements.steps.value=task.plan.steps.join('\n');form.elements.changes.value=task.plan.changes.map(change=>`${change.operation} ${change.path}`).join('\n');formError(form,'');$('plan-dialog').showModal();});
$('plan-form').addEventListener('submit',event=>{event.preventDefault();submit(event.currentTarget,async()=>{const scope=state.dialogScope,e=event.currentTarget.elements;const changes=e.changes.value.split('\n').map(x=>x.trim()).filter(Boolean).map(line=>{const match=/^(create|edit|delete)\s+(.+)$/.exec(line);if(!match)throw new Error('Use an operation followed by a path on each line.');return {operation:match[1],path:match[2]};});const data=await api(`/api/agent/tasks/${scope.taskId}/plan`,{method:'PATCH',body:{version:scope.version,plan:{goal:e.goal.value,steps:e.steps.value.split('\n').map(x=>x.trim()).filter(Boolean),changes,capabilities:scope.capabilities}}});$('plan-dialog').close();if(scope.scope!==state.scope)return;state.task=data.task;renderPlan();renderControls();});});
$('refresh').addEventListener('click',()=>work($('refresh'),async()=>{const bootstrap=await api('/api/agent/bootstrap');state.bootstrap=bootstrap;const selected=$('model-select').value;options($('model-select'),bootstrap.catalog.models.map(model=>[model.id,`${model.label} / ${model.provider}`,!model.workerReady]),selected);await refresh();}));
for(const button of document.querySelectorAll('[data-close]'))button.addEventListener('click',()=>button.closest('dialog').close());
for(const button of document.querySelectorAll('.mobile-tabs [data-panel]'))button.addEventListener('click',()=>setPanel(button.dataset.panel));
window.addEventListener('keydown',event=>{const c=$('code'); if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'&&document.activeElement===c){event.preventDefault();const sv=$('save-file'); if(sv&&!sv.disabled)sv.click();}});
window.addEventListener('beforeunload',event=>{persistDrafts();if(state.drafts.size){event.preventDefault();event.returnValue='';}});
window.addEventListener('online',()=>work(null,async()=>{await presence();await refresh();}));
document.addEventListener('visibilitychange',()=>{presence().catch(()=>{});});
setInterval(()=>presence().catch(()=>{$('connection').textContent='Presence not confirmed; tasks pause safely.';}),15000);
setInterval(()=>{if(state.project)refresh().catch(error=>{$('connection').textContent='Reconnect to refresh';if(!document.hidden)showError(error.message);});},4000);

// New desktop workbench wiring for 3-col IDE layout
function showTool(name){
  document.querySelectorAll('.tool-pane').forEach(p=>p.hidden=true);
  const empty=$('tools-empty'); if(empty) empty.hidden=true;
  const pane=$('tool-'+name); if(pane){pane.hidden=false;return;}
  if(empty) empty.hidden=false;
}
function setupTools(){
  document.querySelectorAll('.tool-item,[data-tool]').forEach(btn=>{
    btn.addEventListener('click',()=>{const t=btn.dataset.tool||btn.getAttribute('data-tool');showTool(t); if(t==='files') renderToolFiles();});
  });
  const close=$('tools-close'); if(close) close.addEventListener('click',()=>{document.querySelectorAll('.tool-pane').forEach(p=>p.hidden=true); const e=$('tools-empty');if(e)e.hidden=false;});
  const fclose=$('tool-files-close'); if(fclose) fclose.addEventListener('click',()=>showTool(null));
}
function renderToolFiles(){
  const fl=$('tool-file-list'); if(!fl) return;
  fl.replaceChildren();
  const files=state.files.length?state.files:(state.project?state.project.files||[]:[]);
  files.slice(0,12).forEach(f=>{
    const b=element('button','',f.path); b.style.fontSize='10px';b.style.display='block';b.style.width='100%';b.style.textAlign='left';
    b.addEventListener('click',()=>{state.selected=f.path; renderToolEditor();});
    fl.append(b);
  });
  renderToolEditor();
}
function renderToolEditor(){
  const ta=$('tool-code'); const nm=$('tool-file-name'); const sv=$('tool-save-file');
  if(!ta) return;
  const f=state.selected? (state.files.find(x=>x.path===state.selected) || (state.project&&state.project.files.find(x=>x.path===state.selected)) ) : null;
  nm.textContent=state.selected||'Select file';
  const draft=state.drafts.get(state.selected);
  ta.value = draft ? draft.content : (f ? f.content : '');
  ta.oninput=()=>{
    if(!state.selected || !state.project) return;
    const existing=state.drafts.get(state.selected);
    const saved = state.project.files.find(ff=>ff.path===state.selected);
    if(ta.value === (saved?saved.content:'')) {
      state.drafts.delete(state.selected);
    } else {
      state.drafts.set(state.selected, {content:ta.value, baseVersion: existing?existing.baseVersion : state.project.version });
    }
    persistDrafts();
  };
  if(sv){
    sv.disabled=!state.selected || !state.project || Boolean(state.project.archived) || state.busy.has('save-file');
    sv.onclick=()=>work(sv,async()=>{
      if(!state.selected || !ta.value || !state.project) return;
      const projectId=state.project.id; const path=state.selected;
      let baseVersion = (state.drafts.get(path) || {}).baseVersion || state.project.version;
      if(baseVersion !== state.project.version){
        // simple compare like main, but for tool keep short
        const latest = state.project.files.find(ff=>ff.path===path)?.content || '';
        if(!await confirmAction('Compare before save?', `Saved differs from draft base. Save anyway?`, 'Save')) return;
        baseVersion = state.project.version;
      }
      const result=await api(`/api/projects/${projectId}/files`,{method:'PUT',body:{path,content:ta.value,version:baseVersion}});
      if(state.drafts.get(path)?.content===ta.value) state.drafts.delete(path);
      state.project = result.project;
      persistDrafts();
      announce('Saved via tools pane.');
      renderToolFiles();
    });
  }
}
setupTools();
const nsb=$('new-session-btn'); if(nsb) nsb.addEventListener('click',()=> chatDialog(false));
const ns=$('new-session'); if(ns) ns.addEventListener('click',()=> chatDialog(false));
const ss=$('side-settings'); if(ss) ss.addEventListener('click',()=>{$('project-instructions')&&$('project-instructions').click();});
if($('composer')) $('composer').addEventListener('submit',event=>{ /* existing listener already attached */ });

try{state.session=await api('/api/session');if(!state.session.user){$('login').hidden=false;}else{state.bootstrap=await api('/api/agent/bootstrap');const ws=$('workspace');if(ws)ws.hidden=false;const acc=$('account-name');if(acc&&state.session.user)acc.textContent=state.session.user.displayName||'Owner';const avatar=$('account-avatar');if(avatar&&state.session.user)avatar.textContent=(state.session.user.displayName||'ND').trim().slice(0,1).toUpperCase()||'N';const projects=state.bootstrap.projects;const ps=$('project-select');if(ps){options(ps,projects.length?projects.map(p=>[p.id,p.name]):[['','Create a project first']]);}const models=state.bootstrap.catalog.models;options($('model-select'),models.length?models.map(m=>[m.id,`${m.label} / ${m.provider}`,!m.workerReady]):[['','No enabled coding models']],state.bootstrap.catalog.defaultModelId);refreshSelects();const selected=/^#project\/([a-f0-9-]{36})$/.exec(location.hash)?.[1];if(projects.length){const id=projects.some(p=>p.id===selected)?selected:projects[0].id;if(ps)ps.value=id;refreshSelects();await openProject(id);}else {renderControls();renderSidebar();}} if(state.chats&&state.chats.length)renderSidebar();}
catch(error){showError(error.message);if($('connection'))$('connection').textContent='Not connected';$('login').hidden=false;}
