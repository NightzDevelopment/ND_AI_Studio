"""Exercise built model controls in Chromium with deferred API fixtures. No live services or paid calls."""
import json
import os
from pathlib import Path
import shutil
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import unittest
try:
    from playwright.sync_api import sync_playwright, expect
except ModuleNotFoundError as failure:
    if failure.name not in ('playwright', 'playwright.sync_api'):
        raise
    raise SystemExit(
        'Browser checks require Python Playwright in the interpreter running this file.\n'
        'Install tests/browser-requirements.txt in an isolated virtual environment, then use its Python.\n'
        'See docs/BROWSER_TESTS.md for setup and Chromium prerequisites.'
    ) from None

ROOT = Path(__file__).resolve().parents[1]
A = '100000000000000001'
B = '100000000000000002'
MODEL = dict(id='fixture-openai', label='First model', provider='openai', tier='standard', enabled=True,
             compatible=True, inputUsdPerMillion=1, cachedInputUsdPerMillion=.25, outputUsdPerMillion=2,
             maxOutputTokens=1024, maxCalls=2, maxBudgetMicros=100000, timeoutSeconds=180, creditsPerBuild=5)
OTHER = {**MODEL, 'id': 'fixture-deepseek', 'label': 'Second model', 'provider': 'deepseek', 'creditsPerBuild': 20}

HTML = """<!doctype html><html><head><title>Model controls fixture</title></head><body>
<form id="build-form"></form><div id="admin-root"></div>
<script type="module">
import {createModelControls} from '/models.js';
import {renderBilling} from '/billing.js';
const clone=value=>structuredClone(value);
window.fixture={identity:'owner-a',ready:false,calls:[],errors:[],notices:[],gates:[],confirmations:[],holds:[],
 billing:BILLING,catalog:CATALOG,publicData:PUBLIC,
 wallets:{WALLETS}};
window.arm=(path,method='GET')=>{const gate={path,method,entered:false};gate.promise=new Promise(resolve=>gate.release=resolve);fixture.gates.push(gate);return fixture.gates.length-1;};
window.release=index=>fixture.gates[index].release();
async function api(path,{method='GET',body}={}){
 fixture.calls.push({path,method,body:clone(body)});let result;
 if(method==='GET'&&fixture.failReads?.includes(path))throw new Error('Fixture balance refresh unavailable.');
 if(path==='/api/studio/models')result=clone(fixture.publicData);
 else if(path==='/api/studio/billing')result=clone(fixture.billing);
 else if(path==='/api/studio/billing/cancel'){fixture.billing.subscription.cancelAtEnd=body.cancelAtEnd;result=clone(fixture.billing);}
 else if(path==='/api/studio/billing/checkout')result={url:'https://checkout.stripe.com/c/pay/fixture'};
 else if(path==='/api/studio/credits')result={wallet:clone(fixture.publicData.wallet),items:[]};
 else if(path==='/api/admin/models'){
  if(method==='PATCH')fixture.catalog={...clone(body),version:fixture.catalog.version+1};
  result=clone(fixture.catalog);
 } else if(path==='/api/admin/credits/pending')result={items:clone(fixture.holds)};
 else if(path.startsWith('/api/admin/credits?'))result=clone(fixture.wallets[new URL(path,location.origin).searchParams.get('discordId')]);
 else if(path==='/api/admin/credits'){
  const wallet=fixture.wallets[body.discordId];wallet.wallet.available+=body.amount;wallet.wallet.version++;
  wallet.items.unshift({kind:'adjustment',amount:body.amount,delta:body.amount,detail:body.reason});result=clone(wallet);
 } else if(path==='/api/admin/credits/resolve')result={ok:true};
 else throw new Error('Unexpected fixture API '+path);
 const gate=fixture.gates.find(value=>!value.entered&&value.path===path&&value.method===method);
 if(gate){gate.entered=true;await gate.promise;}
 return result;
}
function el(tag,className='',text){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;}
function button(text,action,className=''){const node=el('button',className,text);node.type='button';node.onclick=async()=>{if(node.disabled)return;node.disabled=true;try{await action();}catch(error){fixture.errors.push(error.message);}finally{node.disabled=false;}};return node;}
function field(text,type,value,name){const label=el('label','',text),input=el('input');input.type=type;input.value=value;input.name=name;label.append(input);return {label,input};}
function selectField(text,options,value,name){const label=el('label','',text),input=el('select');input.name=name;for(const [id,text]of options)input.add(new Option(text,id));input.value=value;label.append(input);return {label,input};}
function table(headers){const wrap=el('div'),table=el('table'),body=el('tbody');table.append(body);wrap.append(table);return {wrap,body};}
async function confirmAction(...args){fixture.confirmations.push(args);if(fixture.deferConfirmation)return await new Promise(resolve=>fixture.approve=resolve);return true;}
async function reasonDialog(){if(fixture.deferReason)return await new Promise(resolve=>fixture.resolveReason=resolve);return 'Fixture reconciliation';}
window.controls=createModelControls({api,el,button,field,selectField,table,notice:value=>fixture.notices.push(value),confirmAction,reasonDialog,onChange:()=>{},getUserId:()=>fixture.identity});
window.renderAdmin=()=>controls.renderAdmin(document.getElementById('admin-root'));
window.showBilling=()=>renderBilling({root:document.getElementById('billing-view') || document.getElementById('admin-root'),api,el,button,confirmAction,current:()=>fixture.identity==='owner-a'});
await controls.refresh(true);fixture.ready=true;
</script></body></html>"""


class ModelControlsBrowser(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assets = Path(os.environ.get('ND_MODELS_ASSETS', ROOT / 'dist'))
        if not (assets / 'models.js').is_file():
            raise RuntimeError('Build the frontend with npm run build before running models-browser.py.')
        catalog = dict(version=1, creditsEnabled=False, defaultModelId=MODEL['id'], models=[MODEL, OTHER])
        public = dict(pricingVersion='catalog:1', creditsEnabled=True, defaultModelId=MODEL['id'],
                      models=[MODEL, OTHER], wallet=dict(available=50, reserved=0, pending=0))
        wallets = {A: dict(user=dict(discordId=A, displayName='Alice'), wallet=dict(available=50, reserved=0, pending=0, version=1), items=[]),
                   B: dict(user=dict(discordId=B, displayName='Bob'), wallet=dict(available=500, reserved=0, pending=0, version=1), items=[])}
        billing = dict(enabled=True, version='fixture-v1', hasCustomer=False, subscription=None, wallet=dict(available=369, reserved=0, pending=0), limits=dict(dailyBuilds=5, dailyBudgetMicros=1000000), plans=[dict(id=key, name=name, priceCents=price, credits=credits, available=True) for key, name, price, credits in [('starter', 'Starter', 1999, 369), ('pro', 'Pro', 2999, 1329), ('max', 'Max', 4999, 3249)]])
        html = HTML.replace('BILLING', json.dumps(billing)).replace('CATALOG', json.dumps(catalog)).replace('PUBLIC', json.dumps(public)).replace('WALLETS', json.dumps(wallets)[1:-1]).encode()

        class Handler(SimpleHTTPRequestHandler):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, directory=str(assets), **kwargs)

            def log_message(self, *_args):
                pass

            def do_GET(self):
                if self.path == '/fixture':
                    self.send_response(200)
                    self.send_header('Content-Type', 'text/html')
                    self.send_header('Content-Length', str(len(html)))
                    self.end_headers()
                    self.wfile.write(html)
                else:
                    super().do_GET()

        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.playwright = sync_playwright().start()
        executable = os.environ.get('CHROMIUM_PATH') or shutil.which('chromium') or shutil.which('chromium-browser')
        cls.browser = cls.playwright.chromium.launch(executable_path=executable, headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        self.page = self.browser.new_page()
        self.errors = []
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.goto(f'http://127.0.0.1:{self.server.server_port}/fixture')
        self.page.wait_for_function('window.fixture?.ready===true')

    def tearDown(self):
        self.assertEqual(self.errors, [])
        self.assertEqual(self.page.evaluate('fixture.errors'), [])
        self.page.close()

    def arm(self, path, method='GET'):
        return self.page.evaluate('([path,method])=>arm(path,method)', [path, method])

    def wait_gate(self, gate):
        self.page.wait_for_function('index=>fixture.gates[index].entered', arg=gate)

    def release(self, gate):
        self.page.evaluate('index=>release(index)', gate)

    def admin(self):
        self.page.evaluate('renderAdmin()')

    def wallet(self, user):
        self.page.locator('input[name=discordId]').fill(user)
        self.page.get_by_role('button', name='Load account', exact=True).click()
        expect(self.page.get_by_role('heading', name='Alice' if user == A else 'Bob', exact=True)).to_be_visible()

    def test_billing_prices_and_acknowledgment_precede_checkout(self):
        self.page.evaluate('showBilling()')
        expect(self.page.get_by_role('heading', name='Plans & usage')).to_be_visible()
        for price in ['$19.99 / month', '$29.99 / month', '$49.99 / month']:
            expect(self.page.get_by_text(price, exact=True)).to_be_visible()
        checkout = self.page.get_by_role('button', name='Choose Starter', exact=True)
        expect(checkout).to_be_disabled()
        self.page.get_by_role('checkbox').first.check()
        expect(checkout).to_be_enabled()
        gate = self.arm('/api/studio/billing/checkout', 'POST')
        checkout.click()
        self.wait_gate(gate)
        body = self.page.evaluate("fixture.calls.find(call=>call.path==='/api/studio/billing/checkout').body")
        self.assertEqual(body, dict(planId='starter', acceptedTerms=True, pricingVersion='fixture-v1'))
        self.page.route('https://checkout.stripe.com/**', lambda route: route.fulfill(status=200, body='Fixture checkout'))
        self.release(gate)
        self.page.wait_for_url('https://checkout.stripe.com/**')
        # The fixture's state is on its original document; return before shared teardown.
        self.page.go_back()
        self.page.wait_for_function('window.fixture?.ready===true')

    def test_billing_cancel_preserves_paid_period_and_allows_resuming(self):
        self.page.evaluate("fixture.billing.subscription={plan:'starter',priceCents:1999,cancelAtEnd:false,renewsAt:'2030-01-01T00:00:00Z'};showBilling()")
        self.page.get_by_role('button', name='Cancel next renewal', exact=True).click()
        expect(self.page.get_by_role('button', name='Keep subscription renewing')).to_be_visible()
        expect(self.page.get_by_text('369 credits available', exact=False)).to_be_visible()
        self.assertTrue(self.page.evaluate('fixture.billing.subscription.cancelAtEnd'))
        self.page.get_by_role('button', name='Keep subscription renewing', exact=True).click()
        expect(self.page.get_by_role('button', name='Cancel next renewal')).to_be_visible()
        self.assertFalse(self.page.evaluate('fixture.billing.subscription.cancelAtEnd'))

    def test_disabled_subscriptions_have_no_purchase_controls(self):
        self.page.evaluate('fixture.billing.enabled=false;showBilling()')
        expect(self.page.get_by_text('Subscriptions are not open yet.', exact=False)).to_be_visible()
        expect(self.page.get_by_role('checkbox')).to_have_count(0)
        self.assertFalse(self.page.evaluate("fixture.calls.some(call=>call.path.endsWith('/checkout'))"))

    def test_delayed_billing_read_cannot_replace_a_different_accounts_view(self):
        gate = self.arm('/api/studio/billing')
        self.page.evaluate('window.oldBilling=showBilling();null')
        self.wait_gate(gate)
        self.page.evaluate("fixture.identity='owner-b';document.getElementById('admin-root').textContent='Other account view'")
        self.release(gate)
        self.page.evaluate('oldBilling')
        expect(self.page.locator('#admin-root')).to_have_text('Other account view')

    def test_catalog_save_preserves_newer_edits_and_advances_the_next_version(self):
        self.admin()
        label = self.page.locator('input[name=label]').first
        self.page.locator('.model-card').first.evaluate('(node)=>node.open=true')
        label.fill('Submitted label')
        gate = self.arm('/api/admin/models', 'PATCH')
        self.page.get_by_role('button', name='Save model catalog', exact=True).click()
        self.wait_gate(gate)
        label.fill('Newer unsaved label')
        self.release(gate)
        expect(self.page.get_by_role('button', name='Save model catalog', exact=True)).to_be_enabled()
        expect(label).to_have_value('Newer unsaved label')
        self.page.get_by_role('button', name='Save model catalog', exact=True).click()
        self.page.wait_for_function("fixture.calls.filter(call=>call.path==='/api/admin/models'&&call.method==='PATCH').length===2")
        bodies = self.page.evaluate("fixture.calls.filter(call=>call.path==='/api/admin/models'&&call.method==='PATCH').map(call=>call.body)")
        self.assertEqual([body['version'] for body in bodies], [1, 2])
        self.assertEqual([body['models'][0]['label'] for body in bodies], ['Submitted label', 'Newer unsaved label'])

    def test_confirmed_catalog_save_remains_saved_when_secondary_balance_refresh_fails(self):
        self.admin()
        self.page.evaluate("fixture.failReads=['/api/studio/models']")
        self.page.get_by_role('button', name='Save model catalog', exact=True).click()
        expect(self.page.get_by_role('button', name='Save model catalog', exact=True)).to_be_enabled()
        self.page.wait_for_function("fixture.notices.some(value=>value.includes('Reload model balances'))")
        expect(self.page.locator('.model-catalog-form .form-error')).to_be_hidden()
        self.assertEqual(self.page.evaluate('fixture.catalog.version'), 2)

    def test_late_admin_read_does_not_replace_a_new_tab(self):
        gate = self.arm('/api/admin/models')
        self.page.evaluate('window.oldAdmin=renderAdmin(); null')
        self.wait_gate(gate)
        self.page.evaluate("document.getElementById('admin-root').remove();const root=document.createElement('div');root.id='admin-root';root.textContent='Current tools tab';document.body.append(root)")
        self.release(gate)
        self.page.evaluate('oldAdmin')
        expect(self.page.locator('#admin-root')).to_have_text('Current tools tab')

    def test_wallet_search_response_is_ignored_after_query_changes(self):
        self.admin()
        self.page.locator('input[name=discordId]').fill(A)
        gate = self.arm('/api/admin/credits?discordId=' + A)
        self.page.get_by_role('button', name='Load account', exact=True).click()
        self.wait_gate(gate)
        self.page.locator('input[name=discordId]').fill(B)
        self.release(gate)
        expect(self.page.get_by_role('button', name='Load account', exact=True)).to_be_enabled()
        expect(self.page.get_by_role('heading', name='Alice', exact=True)).to_have_count(0)
        self.wallet(B)

    def test_editing_wallet_search_explicitly_disables_stale_adjustments_until_reload(self):
        self.admin()
        self.wallet(A)
        self.page.locator('input[name=amount]').fill('10')
        self.page.locator('input[name=reason]').fill('Kept adjustment draft')
        self.page.locator('input[name=discordId]').fill(B)
        expect(self.page.get_by_role('button', name='Apply credit adjustment', exact=True)).to_be_disabled()
        expect(self.page.locator('[data-wallet-context]')).to_have_text('Load this account before adjusting credits.')
        expect(self.page.locator('input[name=reason]')).to_have_value('Kept adjustment draft')
        self.page.locator('input[name=discordId]').fill(A)
        expect(self.page.get_by_role('button', name='Apply credit adjustment', exact=True)).to_be_disabled()
        self.wallet(A)
        expect(self.page.get_by_role('button', name='Apply credit adjustment', exact=True)).to_be_enabled()

    def test_late_alice_adjustment_cannot_replace_bob_wallet(self):
        self.admin()
        self.wallet(A)
        self.page.locator('input[name=amount]').fill('10')
        self.page.locator('input[name=reason]').fill('Alice test grant')
        gate = self.arm('/api/admin/credits', 'POST')
        self.page.get_by_role('button', name='Apply credit adjustment', exact=True).click()
        self.wait_gate(gate)
        self.wallet(B)
        self.release(gate)
        self.page.wait_for_function("fixture.notices.some(value=>value.includes('recorded'))")
        expect(self.page.get_by_role('heading', name='Bob', exact=True)).to_be_visible()
        expect(self.page.get_by_role('heading', name='Alice', exact=True)).to_have_count(0)
        self.assertEqual(self.page.evaluate("fixture.calls.filter(call=>call.method==='POST'&&call.path==='/api/admin/credits').map(call=>call.body.discordId)"), [A])

    def test_adjustment_response_preserves_newer_inputs_and_updates_wallet_revision(self):
        self.admin()
        self.wallet(A)
        self.page.locator('input[name=amount]').fill('10')
        self.page.locator('input[name=reason]').fill('Earlier grant')
        gate = self.arm('/api/admin/credits', 'POST')
        self.page.get_by_role('button', name='Apply credit adjustment', exact=True).click()
        self.wait_gate(gate)
        self.page.locator('input[name=amount]').fill('20')
        self.page.locator('input[name=reason]').fill('Newer grant draft')
        self.release(gate)
        expect(self.page.get_by_role('button', name='Apply credit adjustment', exact=True)).to_be_enabled()
        expect(self.page.locator('input[name=amount]')).to_have_value('20')
        expect(self.page.locator('input[name=reason]')).to_have_value('Newer grant draft')
        self.page.get_by_role('button', name='Apply credit adjustment', exact=True).click()
        self.page.wait_for_function("fixture.calls.filter(call=>call.path==='/api/admin/credits'&&call.method==='POST').length===2")
        self.assertEqual(self.page.evaluate("fixture.calls.filter(call=>call.path==='/api/admin/credits'&&call.method==='POST').map(call=>[call.body.version,call.body.amount])"), [[1, 10], [2, 20]])

    def test_quote_confirmation_uses_its_original_model_and_credit_snapshot(self):
        self.page.evaluate('async()=>{window.quote=await controls.prepare()}')
        self.page.locator('select[name=modelId]').select_option(OTHER['id'], force=True)
        text = self.page.evaluate('controls.confirmation(quote)')
        self.assertIn('OpenAI / First model (fixture-openai)', text)
        self.assertIn('5 Studio credits', text)
        self.assertNotIn('Second model', text)
        self.assertEqual(self.page.evaluate('Object.keys(quote).sort()'), ['modelId', 'pricingVersion', 'quotedCredits'])

    def test_old_account_refresh_cannot_overwrite_new_account_balance(self):
        self.page.evaluate('fixture.publicData.wallet.available=111')
        gate = self.arm('/api/studio/models')
        self.page.evaluate('window.oldRefresh=controls.refresh(true); null')
        self.wait_gate(gate)
        self.page.evaluate("fixture.identity='owner-b';fixture.publicData.wallet.available=222;window.newRefresh=controls.refresh(true);null")
        self.release(gate)
        self.page.evaluate('newRefresh')
        self.page.evaluate('oldRefresh')
        expect(self.page.locator('.model-wallet')).to_contain_text('222 credits available')
        expect(self.page.locator('.model-wallet')).not_to_contain_text('111')

    def test_detached_wallet_confirmation_cannot_dispatch_a_credit_adjustment(self):
        self.admin()
        self.wallet(A)
        self.page.locator('input[name=amount]').fill('10')
        self.page.locator('input[name=reason]').fill('Must not dispatch')
        self.page.evaluate('fixture.deferConfirmation=true')
        self.page.get_by_role('button', name='Apply credit adjustment', exact=True).click()
        self.page.wait_for_function("typeof fixture.approve==='function'")
        self.page.evaluate("document.getElementById('admin-root').remove();fixture.approve(true)")
        self.page.wait_for_timeout(25)
        self.assertEqual(self.page.evaluate("fixture.calls.filter(call=>call.path==='/api/admin/credits'&&call.method==='POST').length"), 0)

    def test_pending_history_does_not_open_for_a_different_account(self):
        gate = self.arm('/api/studio/credits')
        self.page.get_by_role('button', name='Credit history', exact=True).click()
        self.wait_gate(gate)
        self.page.evaluate("fixture.identity='owner-b';controls.render()")
        self.release(gate)
        expect(self.page.get_by_role('button', name='Credit history', exact=True)).to_be_enabled()
        expect(self.page.locator('dialog')).to_have_count(0)

    def test_pending_hold_cannot_dispatch_the_opposite_resolution_while_saving(self):
        self.page.evaluate("fixture.holds=[{jobId:'fixture-job',displayName:'Alice',projectName:'Test resource',amount:5,status:'failed',providerCostMicros:100}]")
        self.admin()
        gate = self.arm('/api/admin/credits/resolve', 'POST')
        self.page.get_by_role('button', name='Release hold', exact=True).click()
        self.wait_gate(gate)
        self.page.get_by_role('button', name='Finalize charge', exact=True).click()
        self.release(gate)
        expect(self.page.get_by_role('button', name='Release hold', exact=True)).to_have_count(0)
        self.assertEqual(self.page.evaluate("fixture.calls.filter(call=>call.path==='/api/admin/credits/resolve').map(call=>call.body.action)"), ['released'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
