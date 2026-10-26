"""Offline DOM/interaction checks with a bridge to the real local fixture API.

No browser network-policy changes are made. HTML and modules are injected into
about:blank; fetch is replaced ONLY in this test by a loopback Python bridge.
Identity, provider, validator and opaque-origin session storage are test doubles.
Use agent-browser.py for normal browser-network/storage acceptance elsewhere.
"""
import base64
import http.client
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
ROOT=Path(__file__).resolve().parents[1]
OUT=Path(os.environ.get('ND_AGENT_BRIDGE_EVIDENCE','/mnt/data/nd-ai-agent-bridge'))
OUT.mkdir(parents=True,exist_ok=True)
log=tempfile.TemporaryFile(mode='w+')
process=subprocess.Popen(['node','tests/fixtures/agent-http.mjs'],cwd=ROOT,stdout=subprocess.PIPE,stderr=log,text=True)
checks=[]
def passed(name):
    checks.append(name)
    print('PASS:',name,flush=True)
try:
    info=json.loads(process.stdout.readline());parsed=urlparse(info['origin']);cookie=''
    def local(path,method='GET',headers=None,body=None):
        assert path.startswith('/') and not path.startswith('//')
        connection=http.client.HTTPConnection('127.0.0.1',parsed.port,timeout=10)
        try:
            request_headers={**(headers or {}),'origin':info['origin']}
            if cookie: request_headers['cookie']=cookie
            connection.request(method,path,body=body,headers=request_headers)
            response=connection.getresponse();raw=response.read()
            return {'status':response.status,'text':raw.decode(),'headers':dict(response.getheaders())}
        finally:connection.close()
    login=local('/__fixture/login');cookie=login['headers']['set-cookie'].split(';')[0]
    def bridge(source,request):
        return local(request['path'],request.get('method','GET'),request.get('headers'),request.get('body'))
    html=(ROOT/'web/agent.html').read_text()
    html=re.sub(r'<link\b[^>]*>', '',html)
    html=re.sub(r'<script\b[^>]*>[\s\S]*?</script>','',html)
    logo=ROOT/'tests/fixtures/nd-logo.png'
    if logo.exists():html=html.replace('/nd-logo.webp','data:image/png;base64,'+base64.b64encode(logo.read_bytes()).decode())
    controls=(ROOT/'web/controls.js').read_text().replace('export function ','function ')
    client=(ROOT/'web/agent.js').read_text().replace("import {refreshSelects,confirmAction as confirmDialog} from './controls.js';",'const {refreshSelects,confirmAction:confirmDialog}=window.fixtureControls;')
    setup="""() => {
      const storage = new Map();
      Object.defineProperty(window, 'sessionStorage', {value:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,String(v)),removeItem:k=>storage.delete(k)}});
      if(!crypto.randomUUID)crypto.randomUUID=()=> '10000000-1000-4000-8000-100000000000'.replace(/[018]/g,c=>(c^crypto.getRandomValues(new Uint8Array(1))[0]&15>>c/4).toString(16));
      window.fetch=async(path,options={})=>{if(options.signal?.aborted)throw new DOMException('Aborted','AbortError');const result=await window.fixtureHttp({path,method:options.method||'GET',headers:options.headers||{},body:options.body||null});return new Response(result.text,{status:result.status,headers:result.headers});};
    }"""
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True,args=['--no-sandbox'])
        context=browser.new_context(viewport={'width':1440,'height':1000});context.expose_binding('fixtureHttp',bridge)
        page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
        page.set_content(html);page.add_style_tag(content=(ROOT/'web/agent.css').read_text());page.evaluate(setup)
        page.add_script_tag(content='(()=>{'+controls+';window.fixtureControls={refreshSelects,confirmAction};})();')
        page.add_script_tag(content='(async()=>{'+client+'})();')
        expect(page.locator('#workspace')).to_be_visible()
        expect(page.locator('#project-select')).to_have_value(info['projectId'])
        passed('Injected owner workbench loads and reads actual local API project data')
        page.locator('#new-chat').click();page.locator('#chat-form input[name=title]').fill('Build my notification')
        page.get_by_role('button',name='Save conversation',exact=True).click()
        expect(page.locator('#chat-dialog')).not_to_be_visible();expect(page.locator('#send')).to_be_enabled()
        passed('Named chat persists through the HTTP bridge and SQLite')
        page.locator('#message').fill('Create /ndhello and preserve the existing structure.')
        page.locator('#send').click();expect(page.get_by_role('heading',name='Authorize paid planning?')).to_be_visible()
        page.get_by_role('button',name='Start read-only planning',exact=True).click()
        expect(page.locator('#task-state')).to_have_text('awaiting approval',timeout=15000)
        expect(page.locator('#revision')).to_have_text('Revision 2');expect(page.locator('#plan')).to_contain_text('client/main.lua')
        passed('Paid-planning allowance and plan approval are separate; planning cannot save source')
        page.screenshot(path=str(OUT/'agent-plan-desktop.png'),full_page=True)
        page.locator('#approve').click();page.get_by_role('button',name='Approve and build',exact=True).click()
        expect(page.locator('#task-state')).to_have_text('completed',timeout=15000)
        expect(page.locator('#revision')).to_have_text('Revision 3');expect(page.locator('#plan')).to_contain_text('Automatically saved revision 3')
        assert 'RegisterCommand' in page.locator('#code').input_value()
        passed('Real local agent flow saves a validated revision and populates the editor')
        page.screenshot(path=str(OUT/'agent-built-desktop.png'),full_page=True)
        page.locator('#code').fill("print('preserved local draft')\n")
        session=local('/api/session');csrf=json.loads(session['text'])['csrf']
        response=local('/api/projects/'+info['projectId']+'/files','PUT',{'content-type':'application/json','x-csrf-token':csrf},json.dumps({'path':'client/main.lua','content':'-- Changed in another tab\n','version':3}))
        assert response['status']==200
        expect(page.locator('#revision')).to_have_text('Revision 4',timeout=10000)
        assert page.locator('#code').input_value()=="print('preserved local draft')\n"
        page.locator('#save-file').click();expect(page.get_by_role('heading',name='Compare before saving')).to_be_visible()
        expect(page.locator('.draft-comparison')).to_contain_text('-- Changed in another tab')
        page.get_by_role('button',name='Save reviewed draft',exact=True).click()
        expect(page.locator('#revision')).to_have_text('Revision 5')
        passed('Concurrent source change preserves typing and requires explicit comparison before saving')
        page.locator('#project-instructions').click();page.locator('#policy-form textarea[name=instructions]').fill('Preserve ND conventions.')
        page.locator('#policy-form textarea[name=protectedPaths]').fill('private/**')
        page.get_by_role('button',name='Save instructions',exact=True).click();expect(page.locator('#policy-dialog')).not_to_be_visible()
        page.locator('#project-instructions').click();expect(page.locator('#policy-form textarea[name=protectedPaths]')).to_have_value('private/**')
        page.locator('#policy-dialog [data-close]').click();passed('Instructions and protected paths save and reopen')
        page.set_viewport_size({'width':390,'height':844})
        for panel in ['chat','code','plan']:
            page.locator(f'button[data-panel={panel}]').click()
            assert page.locator('#workbench').get_attribute('data-panel')==panel
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.screenshot(path=str(OUT/f'agent-{panel}-mobile.png'),full_page=True)
        passed('Mobile Chat/Code/Plan controls work without horizontal overflow at 390px')
        assert not errors,errors;passed('No uncaught client exceptions in the bridge journeys')
        browser.close()
finally:
    process.terminate()
    try:process.wait(timeout=5)
    except subprocess.TimeoutExpired:process.kill();process.wait()
    log.seek(0);(OUT/'fixture.log').write_text(log.read());log.close()
    (OUT/'results.json').write_text(json.dumps({'passed':checks,'count':len(checks),'scope':'Injected HTML/JS/CSS with fetch and storage test bridge. Real local API/SQLite/agent lifecycle; fixture identity, provider and validator. Not normal browser-network or browser-storage acceptance.'},indent=2))
