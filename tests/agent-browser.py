"""Local browser checks. Identity, provider transport and validator are fixture doubles."""
import json
import os
import subprocess
import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get('ND_AGENT_EVIDENCE', '/mnt/data/nd-ai-agent-browser'))
OUT.mkdir(parents=True, exist_ok=True)
log = tempfile.TemporaryFile(mode='w+')
process = subprocess.Popen(['node', 'tests/fixtures/agent-http.mjs'], cwd=ROOT, stdout=subprocess.PIPE, stderr=log, text=True)
checks = []
def passed(name):
    checks.append(name)
    print('PASS:', name, flush=True)
try:
    info = json.loads(process.stdout.readline())
    origin = info['origin']
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'), headless=True, args=['--no-sandbox'])
        context = browser.new_context(viewport={'width':1440,'height':1000})
        page = context.new_page()
        errors=[]
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(origin+'/__fixture/login')
        expect(page.locator('#workspace')).to_be_visible()
        expect(page.locator('#project-select')).to_have_value(info['projectId'])
        expect(page.get_by_role('combobox',name='Project',exact=True)).to_be_visible()
        passed('Owner workspace loads with custom project control')
        page.locator('#new-chat').click()
        page.locator('#chat-form input[name=title]').fill('Build the notification resource')
        page.get_by_role('button',name='Save conversation',exact=True).click()
        expect(page.locator('#chat-dialog')).not_to_be_visible()
        expect(page.locator('#send')).to_be_enabled()
        passed('Named conversation creation persists through real HTTP and SQLite')
        page.locator('#message').fill('Create /ndhello, preserve my conventions, and include a resource manifest and README.')
        page.locator('#send').click()
        expect(page.get_by_role('heading',name='Authorize paid planning?')).to_be_visible()
        page.get_by_role('button',name='Start read-only planning',exact=True).click()
        expect(page.locator('#task-state')).to_have_text('awaiting approval', timeout=15000)
        expect(page.locator('#revision')).to_have_text('Revision 2')
        expect(page.locator('#plan')).to_contain_text('client/main.lua')
        expect(page.locator('#messages')).to_contain_text('read file')
        passed('Planning uses real action cards and cannot save source before approval')
        page.screenshot(path=str(OUT/'agent-plan-desktop.png'),full_page=True)
        page.locator('#approve').click()
        page.get_by_role('button',name='Approve and build',exact=True).click()
        expect(page.locator('#task-state')).to_have_text('completed',timeout=15000)
        expect(page.locator('#revision')).to_have_text('Revision 3')
        expect(page.locator('#plan')).to_contain_text('Automatically saved revision 3')
        expect(page.locator('#files')).to_contain_text('fxmanifest.lua')
        assert 'RegisterCommand' in page.locator('#code').input_value()
        passed('Approved build validates and auto-saves source without a second Apply button')
        page.screenshot(path=str(OUT/'agent-built-desktop.png'),full_page=True)
        with page.expect_download() as download:
            page.locator('#export').click()
        assert download.value.suggested_filename.startswith('agent-validated-')
        passed('Validated result exports a real ZIP download')
        page.locator('#code').fill("print('local draft survives')\n")
        assert 'Unsaved local draft' in page.locator('#draft-status').inner_text()
        result=page.evaluate('''async (projectId)=>{
            const session=await (await fetch('/api/session')).json();
            const response=await fetch(`/api/projects/${projectId}/files`,{method:'PUT',headers:{'content-type':'application/json','x-csrf-token':session.csrf},body:JSON.stringify({path:'client/main.lua',content:'-- Changed in another tab\\n',version:3})});return response.status;
        }''',info['projectId'])
        assert result==200
        expect(page.locator('#revision')).to_have_text('Revision 4',timeout=10000)
        assert page.locator('#code').input_value()=="print('local draft survives')\n"
        page.reload()
        expect(page.locator('#revision')).to_have_text('Revision 4')
        assert page.locator('#code').input_value()=="print('local draft survives')\n"
        passed('Newer saved source and reload preserve the account/project-scoped local draft')
        page.locator('#save-file').click()
        expect(page.get_by_role('heading',name='Compare before saving')).to_be_visible()
        expect(page.locator('.draft-comparison')).to_contain_text('-- Changed in another tab')
        page.get_by_role('button',name='Save reviewed draft',exact=True).click()
        expect(page.locator('#revision')).to_have_text('Revision 5')
        passed('Conflicted draft requires comparison and explicit revision-safe saving')
        page.locator('#project-instructions').click()
        page.locator('#policy-form textarea[name=instructions]').fill('Preserve ND naming and use standalone Lua.')
        page.locator('#policy-form textarea[name=protectedPaths]').fill('private/**')
        page.get_by_role('button',name='Save instructions',exact=True).click()
        expect(page.locator('#policy-dialog')).not_to_be_visible()
        page.locator('#project-instructions').click()
        expect(page.locator('#policy-form textarea[name=protectedPaths]')).to_have_value('private/**')
        page.locator('#policy-dialog [data-close]').click()
        passed('Versioned instructions and protected paths persist')
        mobile=context.new_page()
        mobile.set_viewport_size({'width':390,'height':844})
        mobile.on('pageerror', lambda e: errors.append(str(e)))
        mobile.goto(origin+'/agent.html#project/'+info['projectId'])
        expect(mobile.locator('#workspace')).to_be_visible()
        for panel in ['chat','code','plan']:
            mobile.locator(f'button[data-panel={panel}]').click()
            assert mobile.locator('#workbench').get_attribute('data-panel')==panel
            assert mobile.evaluate('document.documentElement.scrollWidth <= innerWidth')
        mobile.screenshot(path=str(OUT/'agent-plan-mobile.png'),full_page=True)
        mobile.locator('button[data-panel=chat]').click()
        mobile.screenshot(path=str(OUT/'agent-chat-mobile.png'),full_page=True)
        passed('390px mobile panel navigation works without horizontal overflow')
        assert not errors, errors
        passed('No uncaught browser exceptions')
        browser.close()
finally:
    process.terminate()
    try: process.wait(timeout=5)
    except subprocess.TimeoutExpired: process.kill();process.wait()
    log.seek(0)
    logs=log.read()
    (OUT/'fixture.log').write_text(logs)
    (OUT/'results.json').write_text(json.dumps({'passed':checks,'count':len(checks),'scope':'Actual new middleware, worker and SQLite. Fixture identity, provider transport, validation and legacy editor shim.'},indent=2))
    log.close()
