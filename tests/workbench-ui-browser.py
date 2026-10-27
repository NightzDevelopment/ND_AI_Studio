"""Offline display/interaction fixtures for the workbench UI.

Injects the real HTML, CSS, controls, agent client and display module in Chromium.
API responses, identity and browser storage are explicit in-memory doubles. The
source-page controller is not executed; its existing DOM state is a fixture.
No provider, payment, generated-project execution or production call is made.
This is not browser-network, CSP, account or full application acceptance.
"""
import base64
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
from playwright.sync_api import sync_playwright, expect
ROOT=Path(__file__).resolve().parents[1]
OUT=Path(os.environ.get('ND_QA_ARTIFACTS',os.environ.get('ND_WORKBENCH_EVIDENCE',str(Path(tempfile.gettempdir())/'nd-ai-workbench-ui'))))
OUT.mkdir(parents=True,exist_ok=True)
PID='11111111-1111-4111-8111-111111111111'
CHAT='22222222-2222-4222-8222-222222222222'
TASK='33333333-3333-4333-8333-333333333333'
SOURCE="""local lastCommandUse = nil

local function notify(message)
    BeginTextCommandThefeedPost('STRING')
    AddTextComponentSubstringPlayerName(message)
    EndTextCommandThefeedPostTicker(false, false)
end

RegisterCommand(Config.Command, function()
    local now = GetGameTimer()
    local cooldown = Config.CooldownSeconds * 1000

    if lastCommandUse and now - lastCommandUse < cooldown then
        local remaining = math.ceil((cooldown - (now - lastCommandUse)) / 1000)
        notify(('Please wait %d seconds.'):format(remaining))
        return
    end

    lastCommandUse = now
    notify(Config.Message)
end, false)
"""
FILES=[{'path':'client/main.lua','content':SOURCE},{'path':'config.lua','content':"Config = { Command = 'ndhello', CooldownSeconds = 5, Message = 'ND AI Studio is working.' }\n"},{'path':'fxmanifest.lua','content':"fx_version 'cerulean'\ngame 'gta5'\nshared_script 'config.lua'\nclient_script 'client/main.lua'\n"},{'path':'README.md','content':'# ND_AITest\n\nTest /ndhello on a development FiveM server.\n'}]
checks=[]
def passed(name):
    checks.append(name);print('PASS:',name,flush=True)
def mount(browser,kind,width=1440,height=1000,storage_broken=False):
    ctx=browser.new_context(viewport={'width':width,'height':height},reduced_motion='reduce')
    page=ctx.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    html=(ROOT/f'web/{"agent" if kind=="agent" else "workspace"}.html').read_text()
    html=re.sub(r'<link\b[^>]*>','',html);html=re.sub(r'<script\b[^>]*>[\s\S]*?</script>','',html)
    logo=ROOT/'web/nd-logo.webp'
    if not logo.exists():logo=ROOT/'tests/fixtures/nd-logo.png'
    if logo.exists():
        url='data:image/'+('webp' if logo.suffix=='.webp' else 'png')+';base64,'+base64.b64encode(logo.read_bytes()).decode()
        html=html.replace('/nd-logo.webp',url).replace('<b>N<span>D</span></b>',f'<img class="nd-brand-logo" width="48" height="48" src="{url}" alt="Nightz Development">')
    page.set_content(html)
    for asset in [f'{"agent" if kind=="agent" else "workspace"}.css','workbench-ui.css']+(['branding.css'] if kind=='source' else []):page.add_style_tag(content=(ROOT/'web'/asset).read_text())
    page.evaluate('''({pid,broken})=>{
      const memory=new Map(); window.fixtureStorage=memory;
      const storage={getItem:k=>{if(broken)throw Error('Storage unavailable');return memory.get(k)??null;},setItem:(k,v)=>{if(broken)throw Error('Storage unavailable');memory.set(k,String(v));},removeItem:k=>memory.delete(k)};
      Object.defineProperty(window,'localStorage',{value:storage});Object.defineProperty(window,'sessionStorage',{value:storage});
      if(!crypto.randomUUID)crypto.randomUUID=()=> '10000000-1000-4000-8000-100000000000'.replace(/[018]/g,c=>(c^crypto.getRandomValues(new Uint8Array(1))[0]&15>>c/4).toString(16));
      location.hash='#project/'+pid;
    }''',{'pid':PID,'broken':storage_broken})
    controls=(ROOT/'web/controls.js').read_text().replace('export function ','function ')
    page.add_script_tag(content='(()=>{'+controls+';window.fixtureControls={refreshSelects,confirmAction};})();')
    if kind=='source':
        page.evaluate('''({files,pid})=>{
          const $=id=>document.getElementById(id);$('loading').hidden=true;$('editor-view').hidden=false;$('admin-nav').hidden=false;
          $('project-name').textContent='ND_AITest';$('project-meta').textContent='AI Script Generator / Standalone / revision 5';$('route-label').textContent='PROJECT WORKBENCH';$('profile-link').textContent='Jake';
          $('code-empty').hidden=true;$('code-wrap').hidden=false;$('code-editor').value=files[0].content;$('code-highlight').textContent=files[0].content;
          $('file-label').textContent=files[0].path;$('save-status').textContent='Saved revision 5';$('line-count').textContent=files[0].content.split('\\n').length+' lines / Ctrl+S to save';
          const tab=document.createElement('button');tab.textContent=files[0].path;tab.setAttribute('role','tab');tab.setAttribute('aria-selected','true');const wrap=document.createElement('div');wrap.className='file-tab';wrap.append(tab);$('file-tabs').append(wrap);
          for(const file of files){const b=document.createElement('button');b.textContent=file.path;b.type='button';if(file===files[0])b.className='active';$('file-list').append(b);}
          for(const label of ['APPLIED / Owner test model / 9:32 PM','FAILED / Owner test model / 9:31 PM']){const b=document.createElement('button');b.textContent=label;$('build-history').append(b);}
          const label=document.createElement('label');label.textContent='Coding model';const select=document.createElement('select');select.setAttribute('aria-label','Coding model');select.append(new Option('Owner test model / Standard','fixture-model'));label.append(select);$('build-form').prepend(label);
          const quote=document.createElement('p');quote.textContent='Studio credits off. API estimate cap: $0.50 per build.';label.after(quote);
          $('generate-button').disabled=false;$('build-state').textContent='applied';$('build-notice').textContent='Validated builds save automatically. Runtime behavior still needs testing.';
          $('build-log').textContent='[fixture] Saved revision 5. Validation and provider responses are test data.';$('download-build').hidden=false;$('review-button').hidden=false;
          for(const button of document.querySelectorAll('.mobile-panels [data-panel]'))button.addEventListener('click',()=>{$('workbench').dataset.panel=button.dataset.panel;for(const b of document.querySelectorAll('.mobile-panels [data-panel]'))b.setAttribute('aria-pressed',String(b===button));});
          $('code-editor').addEventListener('input',()=>{$('code-highlight').textContent=$('code-editor').value;});
          $('code-editor').addEventListener('scroll',()=>{$('code-highlight').scrollTop=$('code-editor').scrollTop;$('code-highlight').scrollLeft=$('code-editor').scrollLeft;});
          window.fixtureControls.refreshSelects();
        }''',{'files':FILES,'pid':PID})
    else:
        page.evaluate('''({files,pid,chatId,taskId})=>{
          const model={id:'fixture-model',label:'Owner test model',provider:'openai',workerReady:true,creditsPerBuild:10,maxBudgetMicros:500000};
          const task={id:taskId,state:'awaiting_approval',phase:'build',version:3,planVersion:1,planHash:'fixture',model:model.label,steps:3,maxSteps:16,spentMicros:6200,reservedMicros:500000,credits:{amount:10,state:'reserved'},checks:[],history:[{type:'list_files',ok:true,message:'Inspected the project file list.'},{type:'read_file',ok:true,path:'client/main.lua',message:'Read the existing client command.'}],createdAt:'2026-10-26T20:00:00.000Z',plan:{goal:'Add a configurable cooldown while preserving the existing command.',steps:['Read the command and configuration.','Apply the approved cooldown changes.','Validate the resource and save a new revision.'],changes:[{path:'client/main.lua',operation:'edit'},{path:'config.lua',operation:'edit'}],capabilities:['edit']}};
          const project={id:pid,name:'ND_AITest',target:'Standalone',version:5,files:structuredClone(files),archived:0};
          const chats=[{id:chatId,title:'Improve the notification command',version:1}];
          const policy={instructions:'Keep source changes focused. Use ND conventions.',preset:'balanced',protectedPaths:[],permissions:{create:'automatic',edit:'automatic',delete:'ask',dependencies:'ask',migrations:'ask'},continuation:'pause',disconnectSeconds:60,version:1};
          const messages=[{role:'user',text:'Add a configurable cooldown to /ndhello. Keep the command and existing behavior.'},{role:'assistant',text:'I inspected the client command and configuration. The plan below changes only those two files. Approve it before I edit the source.'}];
          window.fixtureState={task,project,chats,policy,messages,writes:[]};
          window.fetch=async(path,options={})=>{
            const s=window.fixtureState;let data,status=200;const body=options.body?JSON.parse(options.body):{};
            if((options.method||'GET')!=='GET')s.writes.push({path,body});
            if(path==='/api/session')data={user:{id:'fixture-user',displayName:'Jake'},csrf:'fixture-csrf'};
            else if(path==='/api/agent/bootstrap')data={projects:[{id:pid,name:project.name}],catalog:{models:[model],defaultModelId:model.id,creditsEnabled:true,pricingVersion:'fixture:1'},owner:true};
            else if(path===`/api/agent/projects/${pid}`)data={project:s.project,policy:s.policy,chats:s.chats};
            else if(path.endsWith('/presence'))data={ok:true};
            else if(path===`/api/agent/chats/${chatId}`)data={messages:s.messages,tasks:[s.task]};
            else if(path===`/api/agent/tasks/${taskId}`)data={task:s.task};
            else if(path===`/api/agent/tasks/${taskId}/files`)data={files:s.project.files};
            else if(path===`/api/agent/tasks/${taskId}/approve`){s.task.state='running';s.task.version++;data={task:s.task};}
            else if(path===`/api/projects/${pid}/files`){if(body.version!==s.project.version){status=409;data={error:'Project changed.'};}else{s.project.files=s.project.files.map(f=>f.path===body.path?{...f,content:body.content}:f);s.project.version++;data={project:s.project};}}
            else{status=404;data={error:'Unexpected UI fixture route '+path};}
            return new Response(JSON.stringify(structuredClone(data)),{status,headers:{'content-type':'application/json'}});
          };
        }''',{'files':FILES,'pid':PID,'chatId':CHAT,'taskId':TASK})
        client=(ROOT/'web/agent.js').read_text().replace("import {refreshSelects,confirmAction as confirmDialog} from './controls.js';",'const {refreshSelects,confirmAction:confirmDialog}=window.fixtureControls;')
        page.add_script_tag(content='(async()=>{'+client+'})();')
        expect(page.locator('#agent-project-title')).to_have_text('ND_AITest')
        expect(page.locator('#task-state')).to_have_text('awaiting approval')
    ui=(ROOT/'web/workbench-ui.js').read_text().replace('export function ','function ')
    page.add_script_tag(content='(()=>{'+ui+';window.fixtureWorkbench={initializeWorkbench};})();')
    expect(page.locator('body')).to_have_attribute('data-workbench-enhanced','true')
    return ctx,page,errors

def no_overflow(page):
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'),page.evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth})')

with sync_playwright() as p:
    executable=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium') or shutil.which('chromium-browser')
    launch={'headless':True,'args':['--no-sandbox']}
    if executable:launch['executable_path']=executable
    browser=p.chromium.launch(**launch)
    for kind in ['source','agent']:
        ctx,page,errors=mount(browser,kind)
        source=page.locator('#code-editor' if kind=='source' else '#code')
        expect(page.locator('.source-gutter pre')).to_have_text('\n'.join(str(i+1) for i in range(len(SOURCE.split('\n')))))
        assert source.input_value()==SOURCE
        link=page.locator('[data-agent-link]').first if kind=='source' else page.locator('#workbench-source-link')
        assert link.get_attribute('href').endswith('#project/'+PID)
        passed(kind+': project-aware navigation and real source line counts')
        page.locator('#workbench-file-search').fill('CONFIG')
        expect(page.locator('#workbench-file-count')).to_have_text('1 of 4 files')
        assert source.input_value()==SOURCE
        page.locator('#workbench-file-search').fill('not-a-file')
        expect(page.locator('#workbench-file-empty')).to_be_visible()
        page.locator('#workbench-file-search').press('Escape')
        expect(page.locator('#workbench-file-count')).to_have_text('4 files')
        passed(kind+': file search, empty state and Escape keep the open source intact')
        source.fill(SOURCE+'\n-- Unsaved manual change\n')
        source.evaluate('(el)=>{el.focus();el.setSelectionRange(12,20)}')
        original=source.input_value()
        page.locator('[data-workbench-layout="focus"]').click()
        expect(page.locator('body')).to_have_attribute('data-workbench-layout','focus')
        assert source.input_value()==original
        assert source.evaluate('el=>[el.selectionStart,el.selectionEnd]')==[12,20]
        for i in range(8):
            button=page.locator('[data-font-size="increase"]')
            if button.is_enabled():button.click()
        expect(page.locator('#workbench-font-size')).to_have_text('20 px')
        expect(page.locator('[data-font-size="increase"]')).to_be_disabled()
        assert source.evaluate('el=>getComputedStyle(el).fontSize')=='20px'
        assert source.input_value()==original
        for i in range(6):page.locator('[data-font-size="decrease"]').click()
        page.locator('[data-workbench-layout="balanced"]').click()
        source.evaluate('el=>{el.scrollTop=130;el.dispatchEvent(new Event("scroll"));}')
        assert page.locator('.source-gutter').evaluate('el=>el.scrollTop')==source.evaluate('el=>el.scrollTop')
        assert page.locator('body').get_attribute('aria-pressed') is None
        passed(kind+': focus and bounded font controls preserve unsaved text, selection and gutter scrolling')
        if kind=='source':
            expect(page.locator('#build-log-disclosure')).not_to_have_attribute('open','')
            page.locator('#workbench-show-log').click();expect(page.locator('#build-log')).to_be_visible()
            page.locator('#build-log-disclosure>summary').click()
            page.evaluate("document.getElementById('build-state').textContent='failed'")
            expect(page.locator('#workbench-build-status')).to_have_text('Failed')
            expect(page.locator('#build-log')).to_be_visible()
            page.locator('#build-log-disclosure>summary').click()
            page.evaluate("document.dispatchEvent(new Event('studio:workbench-view'))")
            expect(page.locator('#build-log')).not_to_be_visible()
            passed('source: logs start collapsed, show on failure and respect manual collapse')
            page.evaluate("document.getElementById('build-state').textContent='applied'")
            page.evaluate("document.getElementById('code-editor').value="+json.dumps(SOURCE)+";document.getElementById('code-highlight').textContent="+json.dumps(SOURCE)+";document.dispatchEvent(new Event('studio:workbench-view'))")
        else:
            expect(page.locator('.agent-options')).not_to_have_attribute('open','')
            page.locator('.agent-options>summary').click()
            expect(page.locator('input[name="maxSteps"]')).to_be_visible()
            page.locator('.agent-options>summary').click()
            page.locator('#approve').click()
            expect(page.get_by_role('heading',name='Approve this exact plan?')).to_be_visible()
            page.get_by_role('button',name='Cancel',exact=True).last.click()
            assert not any('/approve' in entry['path'] for entry in page.evaluate('fixtureState.writes'))
            passed('agent: task options remain usable and plan approval is never bypassed')
            page.locator('#attach-file').click()
            assert '@client/main.lua' in page.locator('#message').input_value()
            assert source.input_value()==original
            page.locator('#save-file').click()
            expect(page.locator('#revision')).to_have_text('Revision 6')
            assert source.input_value()==original
            assert len([e for e in page.evaluate('fixtureState.writes') if e['path'].endswith('/files')])==1
            passed('agent: file reference and explicit Save use the existing client with no duplicate write')
        no_overflow(page)
        for width in [1920,1280,1180,1024,834,768,720,700,390,320]:
            page.set_viewport_size({'width':width,'height':900 if width>700 else 844})
            no_overflow(page)
            if kind=='agent' and width<=1180:
                for panel in ['chat','code','plan']:
                    page.locator(f'.mobile-tabs button[data-panel="{panel}"]').click()
                    expect(page.locator('.'+{'chat':'chat-panel','code':'code-panel','plan':'plan-panel'}[panel])).to_be_visible()
                    for other,selector in [('chat','.chat-panel'),('code','.code-panel'),('plan','.plan-panel')]:
                        if other!=panel:expect(page.locator(selector)).not_to_be_visible()
                    no_overflow(page)
                page.locator('.mobile-tabs button[data-panel="chat"]').click()
            elif kind=='source' and width<=700:
                for panel in ['files','editor','build']:
                    page.locator(f'.mobile-panels button[data-panel="{panel}"]').click();no_overflow(page)
                    for other,selector in [('files','.file-panel'),('editor','.editor-panel'),('build','.build-panel')]:
                        if other!=panel:expect(page.locator(selector)).not_to_be_visible()
                page.locator('.mobile-panels button[data-panel="editor"]').click()

        passed(kind+': 10 desktop/tablet/mobile widths and panel switching have no horizontal overflow')
        if kind=='agent':
            page.locator('.mobile-tabs button[data-panel="chat"]').focus()
            page.keyboard.press('ArrowRight')
            expect(page.locator('#workbench')).to_have_attribute('data-panel','code')
            passed('agent: keyboard panel navigation follows the real agent tab handlers')
        assert not errors,errors
        passed(kind+': no uncaught client exceptions')
        ctx.close()
    ctx,page,errors=mount(browser,'source',storage_broken=True)
    page.locator('[data-font-size="increase"]').click()
    expect(page.locator('#workbench-font-size')).to_have_text('15 px')
    page.locator('[data-workbench-layout="focus"]').click()
    assert not errors,errors
    passed('unavailable browser preference storage does not block editor controls')
    ctx.close()
    # Fresh presentation snapshots do not include intentionally dirty test edits.
    for kind in ['source','agent']:
        for label,width,height in [('desktop',1440,1000),('mobile',390,844)]:
            ctx,page,errors=mount(browser,kind,width,height)
            if kind=='agent' and width<1181:page.locator('.mobile-tabs button[data-panel="chat"]').click()
            page.evaluate('document.activeElement?.blur();window.scrollTo(0,0);const messages=document.getElementById("messages");if(messages)messages.scrollTop=0;')
            page.wait_for_timeout(100)
            no_overflow(page);page.screenshot(path=str(OUT/f'{kind}-{label}.png'),full_page=True)
            assert not errors,errors
            ctx.close()
    browser.close()
(OUT/'results.json').write_text(json.dumps({'checks':checks,'passed':len(checks),'scope':__doc__},indent=2))
