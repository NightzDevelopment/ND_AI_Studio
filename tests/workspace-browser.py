"""Exercise the real workspace in Chromium against deterministic HTTP fixtures.
Run after npm run build: python3 tests/workspace-browser.py
See docs/BROWSER_TESTS.md for isolated Playwright/Chromium setup.
No live login or provider calls.
"""
import copy
import json
import os
from pathlib import Path
import shutil
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import unittest
from urllib.parse import urlparse, parse_qs

try:
    from playwright.sync_api import sync_playwright, expect
except ModuleNotFoundError as failure:
    if failure.name not in ('playwright', 'playwright.sync_api'):
        raise
    raise SystemExit(
        'Browser checks require Python Playwright in the interpreter running this file.\n'
        'Create a virtual environment and install tests/browser-requirements.txt there,\n'
        'then run this file with that environment\'s Python.\n'
        'Setup commands: docs/BROWSER_TESTS.md\n'
        'This test-tool dependency is separate from the running API and worker.'
    ) from None

ROOT = Path(__file__).resolve().parents[1]
PROJECT = '11111111-1111-4111-8111-111111111111'
OTHER_PROJECT = '44444444-4444-4444-8444-444444444444'
USER = '22222222-2222-4222-8222-222222222222'
JOB = '33333333-3333-4333-8333-333333333333'
SOURCE = [{'path': 'client/main.lua', 'content': 'return 1'}, {'path': 'README.md', 'content': 'Original'}]


class Fixture:
    def __init__(self, files=None):
        self.lock = threading.Lock()
        self.files = copy.deepcopy(SOURCE if files is None else files)
        self.version = 1
        self.archived = False
        self.revisions = {1: copy.deepcopy(self.files)}
        self.applies = 0
        self.saves = 0
        self.user_id = USER
        self.csrf = 'fixture-csrf'
        self.admin = False
        self.admin_models = False
        self.admin_tools = False
        self.admin_users = False
        self.delayed_reads = {}
        self.settings = {'guildId':'','roleMappings':{},'model':'fixture-model','version':1,'maxOutputTokens':1024,'maxCalls':2,'maxBudgetMicros':100000,'inputUsdPerMillion':1,'outputUsdPerMillion':2}
        self.settings_requests = []
        self.project_creations = []
        self.delay_create = False
        self.create_requested = threading.Event()
        self.release_create = threading.Event()
        self.models = [{'id': 'fixture-model', 'label': 'Fixture model', 'tier': 'standard', 'creditsPerBuild': 0, 'maxBudgetMicros': 500000}]
        self.admin_config = None
        self.saved_catalog = None
        self.mutation_requests = []
        self.other_project = dict(id=OTHER_PROJECT, name='Other project', tool_id='ai-script-generator', target='Standalone', requirements='Other source', version=1, archived=False, files=[{'path':'client/main.lua','content':'return 900'}], updated_at='2026-01-01T00:00:00.000Z')
        self.expired = False
        self.fail_reads = {}
        self.unauthorized_once = set()
        self.include_jobs = True
        self.delay_job_detail = False
        self.detail_requested = threading.Event()
        self.release_detail = threading.Event()
        self.detail_reads = 0
        self.jobs_reads_active = 0
        self.max_jobs_reads_active = 0
        self.delay_project = False
        self.delay_save = False
        self.delay_save_reply = False
        self.save_requested = threading.Event()
        self.release_save = threading.Event()
        self.save_completed = threading.Event()
        self.project_requested = threading.Event()
        self.release_project = threading.Event()
        self.job = dict(id=JOB, projectId=PROJECT, baseVersion=1, status='running',
                        applicationMode='automatic', appliedVersion=None, applicationError=None,
                        events=[], result=None, createdAt='2026-01-01T00:00:00.000Z',
                        updatedAt='2026-01-01T00:00:00.000Z', costMicros=0, reservedMicros=500000,
                        model='fixture-model', modelLabel='Fixture model', credits={'amount': 0, 'state': 'not-used'}, preview=None, previewVersion=0)
        fixture = self

        class Handler(SimpleHTTPRequestHandler):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, directory=str(ROOT / 'dist'), **kwargs)

            def log_message(self, *_args):
                pass

            def send_json(self, value, status=200):
                raw = json.dumps(value).encode()
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                try:
                    self.wfile.write(raw)
                finally:
                    if getattr(self,'counted_jobs',False):
                        fixture.jobs_reads_active-=1;self.counted_jobs=False

            def do_GET(self):
                parsed = urlparse(self.path)
                path = parsed.path
                self.counted_jobs=False
                if path.endswith('/jobs'):
                    fixture.jobs_reads_active+=1;self.counted_jobs=True
                    fixture.max_jobs_reads_active=max(fixture.max_jobs_reads_active,fixture.jobs_reads_active)
                if path in fixture.unauthorized_once:
                    fixture.unauthorized_once.remove(path)
                    pending=fixture.delayed_reads.pop(path,None)
                    if pending:
                        pending[0].set();pending[1].wait(timeout=10)
                    return self.send_json({'error':'An earlier session expired.'},401)
                if path == f'/api/jobs/{JOB}':
                    fixture.detail_reads+=1
                    if fixture.delay_job_detail:
                        fixture.delay_job_detail=False
                        with fixture.lock:
                            saved_detail=copy.deepcopy(fixture.job)
                        fixture.detail_requested.set();fixture.release_detail.wait(timeout=10)
                        return self.send_json({'job':saved_detail})
                pending_read=fixture.delayed_reads.pop(path,None)
                if pending_read:
                    pending_read[0].set()
                    pending_read[1].wait(timeout=10)
                if path in fixture.fail_reads:
                    return self.send_json({'error':'Project not found.' if fixture.fail_reads[path] == 404 else 'Temporary fixture read failure.'},fixture.fail_reads[path])
                if not path.startswith('/api/'):
                    return super().do_GET()
                if path == f'/api/projects/{PROJECT}' and fixture.delay_project:
                    fixture.project_requested.set()
                    fixture.release_project.wait(timeout=10)
                    fixture.delay_project = False
                with fixture.lock:
                    if fixture.expired:
                        return self.send_json({'error':'Your session ended. Sign in again.'}, 401)
                    if path == f'/api/projects/{OTHER_PROJECT}':
                        return self.send_json({'project':fixture.other_project})
                    if path == f'/api/projects/{OTHER_PROJECT}/jobs':
                        return self.send_json({'jobs':[],'projectVersion':fixture.other_project['version'],'projectUpdatedAt':fixture.other_project['updated_at']})
                    if path == '/api/briefs':
                        return self.send_json({'briefs':[]})
                    if path == '/api/session':
                        return self.send_json({'user': {'id': fixture.user_id, 'displayName': 'Browser tester', 'density': 'comfortable'}, 'csrf': fixture.csrf})
                    if path == '/api/studio/session':
                        return self.send_json({'owner': fixture.admin, 'permissions': ((['settings:manage', 'audit:read'] if fixture.admin_models else ['audit:read'])+(['tools:manage'] if fixture.admin_tools else [])+(['users:read','users:manage'] if fixture.admin_users else [])) if fixture.admin else [], 'workerReady': True, 'tools': [{'id': 'ai-script-generator', 'enabled': True}]})
                    if path == '/api/studio/models':
                        return self.send_json({'models': fixture.models, 'defaultModelId': fixture.models[0]['id'], 'pricingVersion': 1, 'creditsEnabled': False, 'wallet': {'available': 0, 'reserved': 0, 'pending': 0}})
                    if path == f'/api/projects/{PROJECT}':
                        return self.send_json({'project': fixture.project()})
                    if path == f'/api/projects/{PROJECT}/jobs':
                        return self.send_json({'jobs': [fixture.job] if fixture.include_jobs else [],'projectVersion':fixture.version,'projectUpdatedAt':fixture.project()['updated_at']})
                    if path == f'/api/jobs/{JOB}':
                        return self.send_json({'job': fixture.job})
                    if path == f'/api/projects/{PROJECT}/revisions':
                        query = parse_qs(parsed.query)
                        if 'version' in query:
                            version = int(query['version'][0])
                            return self.send_json({'project': fixture.project(version)})
                        return self.send_json({'revisions': [{'version': version, 'summary': 'Fixture revision', 'createdAt': '2026-01-01T00:00:00.000Z'} for version in sorted(fixture.revisions, reverse=True)]})
                    if path == '/api/admin/tools':
                        return self.send_json({'tools':{'ai-script-generator':'owner','discord-bot-generator':'disabled'},'version':1,'workerReady':True})
                    if path == '/api/admin/users':
                        users=[{'id':'user-alice','display_name':'Alice','username':'alice','discord_id':'100000000000000001','status':'active','daily_limit':5,'daily_budget':1000000,'version':1},{'id':'user-bob','display_name':'Bob','username':'bob','discord_id':'100000000000000002','status':'active','daily_limit':5,'daily_budget':1000000,'version':1}]
                        query=parse_qs(parsed.query).get('q',[''])[0].lower()
                        return self.send_json({'users':[user for user in users if query in user['display_name'].lower()],'next':None})
                    if path == '/api/admin/models':
                        return self.send_json(fixture.admin_config)
                    if path == '/api/admin/credits/pending':
                        return self.send_json({'items': []})
                    if path == '/api/admin/settings':
                        return self.send_json({'settings':fixture.settings,'permissions':[],'workerReady':True})
                    if path == '/api/admin/audit':
                        return self.send_json({'items': [], 'next': None})
                    if path == '/api/projects':
                        return self.send_json({'projects': [fixture.project()]})
                    return self.send_json({'error': 'Unexpected fixture request: ' + path}, 404)

            def do_POST(self):
                if urlparse(self.path).path == '/api/projects':
                    body=json.loads(self.rfile.read(int(self.headers.get('Content-Length',0))))
                    fixture.project_creations.append(copy.deepcopy(body))
                    if fixture.delay_create:
                        fixture.create_requested.set();fixture.release_create.wait(timeout=10)
                    with fixture.lock:
                        fixture.other_project=dict(fixture.other_project,name=body['name'],requirements=body['requirements'],files=[],version=1)
                        return self.send_json({'project':fixture.other_project},201)
                with fixture.lock:
                    fixture.applies += 1
                return self.send_json({'error': 'No browser apply call is expected.'}, 500)

            def do_PATCH(self):
                body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))))
                if urlparse(self.path).path == '/api/admin/settings':
                    fixture.settings_requests.append(copy.deepcopy(body))
                    pending=fixture.delayed_reads.pop('PATCH /api/admin/settings',None)
                    if pending:
                        pending[0].set();pending[1].wait(timeout=10)
                    with fixture.lock:
                        fixture.settings=dict(body,version=body['version']+1)
                        return self.send_json({'settings':fixture.settings})
                with fixture.lock:
                    fixture.saved_catalog = body
                    fixture.admin_config.update(body)
                    fixture.admin_config['version']=body['version']+1
                return self.send_json(fixture.admin_config)

            def do_PUT(self):
                body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))))
                with fixture.lock:
                    fixture.mutation_requests.append({'path':self.path,'body':copy.deepcopy(body)})
                if fixture.delay_save:
                    fixture.save_requested.set()
                    fixture.release_save.wait(timeout=10)
                with fixture.lock:
                    other = self.path == f'/api/projects/{OTHER_PROJECT}/files'
                    current = fixture.other_project if other else fixture.project()
                    if body['version'] != current['version']:
                        return self.send_json({'error': 'Source changed.'}, 409)
                    files = [file for file in current['files'] if file['path'] != body['path']]
                    if not body.get('remove'):
                        content = next((file['content'] for file in current['files'] if file['path'] == body['path']), '') if 'renameTo' in body else body['content']
                        files.append({'path':body.get('renameTo', body['path']), 'content':content})
                    fixture.saves += 1
                    if other:
                        fixture.other_project = dict(current, files=files, version=current['version']+1)
                        response = fixture.other_project
                    else:
                        fixture.files = files
                        fixture.version += 1
                        fixture.revisions[fixture.version] = copy.deepcopy(fixture.files)
                        response = fixture.project()
                    response=copy.deepcopy(response)
                    hold_reply=fixture.delay_save_reply
                    fixture.delay_save_reply=False
                if hold_reply:
                    fixture.save_requested.set()
                    fixture.release_save.wait(timeout=10)
                self.send_json({'project': response})
                fixture.save_completed.set()

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f'http://127.0.0.1:{self.server.server_port}/workspace.html#project/{PROJECT}'

    def project(self, version=None):
        version = self.version if version is None else version
        return dict(id=PROJECT, name='Browser project', tool_id='ai-script-generator', target='Standalone',
                    requirements='Fixture source', version=version, archived=self.archived,
                    files=copy.deepcopy(self.revisions[version]), updated_at='2026-01-01T00:00:00.000Z')

    def publish_preview(self,sequence,changes,attempt=1):
        with self.lock:
            self.job.update(previewVersion=sequence,preview={'sequence':sequence,'attempt':attempt,'changes':copy.deepcopy(changes)})

    def complete(self, files):
        with self.lock:
            self.files = copy.deepcopy(files)
            self.version += 1
            self.revisions[self.version] = copy.deepcopy(files)
            self.job.update(status='applied', appliedVersion=self.version, preview=None, previewVersion=0,
                            result={'files': files, 'summary': 'Validated fixture output', 'checks': ['Fixture syntax passed.']},
                            updatedAt='2026-01-01T00:00:01.000Z')

    def close(self):
        self.release_project.set()
        self.release_save.set()
        self.release_create.set()
        self.release_detail.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)


class WorkspaceBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        executable = (os.environ.get('CHROMIUM_PATH') or shutil.which('chromium')
                      or shutil.which('chromium-browser'))
        launch = {'headless': True}
        if executable:
            launch['executable_path'] = executable
        try:
            # With no system executable, Playwright selects its installed browser.
            cls.browser = cls.playwright.chromium.launch(**launch)
        except Exception:
            cls.playwright.stop()
            print('Browser startup failed. Install Chromium and its Linux dependencies; '
                  'see docs/BROWSER_TESTS.md. CHROMIUM_PATH can select an existing browser.',
                  file=sys.stderr)
            raise

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.fixture = Fixture()
        self.context = self.browser.new_context()
        self.page = self.context.new_page()
        self.page.add_init_script('const originalInterval=window.setInterval; window.setInterval=(fn,ms,...args)=>originalInterval(fn,(ms===4000||ms===2000)?80:ms,...args);')
        self.errors = []
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))

    def tearDown(self):
        self.context.close()
        self.fixture.close()
        self.assertEqual(self.errors, [])

    def open(self):
        self.page.goto(self.fixture.url)
        expect(self.page.locator('#editor-view')).to_be_visible()

    def prepare_accounting_result(self,reason,status='applied'):
        accounting={'status':'unreconciled','reason':reason}
        if status=='applied':
            self.fixture.complete([{'path':'client/main.lua','content':'return 448 -- validated delivered source'}])
            self.fixture.job['result']['accounting']=accounting
            self.fixture.job['credits']={'amount':7,'state':'charged'}
        else:
            self.fixture.job.update(status='failed',result={'error':'Provider response did not produce a usable build.','accounting':accounting},
                                    credits={'amount':7,'state':'pending'},updatedAt='2026-01-01T00:00:02.000Z')
        self.fixture.job['costMicros']=self.fixture.job['reservedMicros']

    def test_applied_unreconciled_cache_lifetimes_show_reserved_budget_and_keep_output_usable(self):
        self.prepare_accounting_result('cache-write-lifetimes-unavailable')
        self.open()
        warning=self.page.locator('[data-provider-accounting=unreconciled]')
        expect(warning).to_be_visible()
        expect(warning).to_contain_text('Cache-write lifetime details were not provided')
        expect(warning).to_contain_text('Validated source and its ZIP remain available')
        expect(self.page.locator('#build-log')).to_contain_text('API budget reserved pending reconciliation: $0.5000')
        expect(self.page.locator('#build-log')).to_contain_text('not a provider invoice')
        expect(self.page.locator('#build-log')).not_to_contain_text('API cost estimate:')
        expect(self.page.locator('#build-log')).to_contain_text('Studio credits: 7 / charged')
        expect(self.page.locator('#build-state')).to_have_text('Completed')
        expect(self.page.locator('#code-editor')).to_have_value('return 448 -- validated delivered source')
        expect(self.page.locator('#download-build')).to_be_visible()
        expect(self.page.locator('#download-build')).to_have_attribute('href',f'/api/jobs/{JOB}/export')
        self.page.reload()
        expect(warning).to_be_visible()
        expect(warning).to_contain_text('Cache-write lifetime details were not provided')
        expect(self.page.locator('#build-log')).to_contain_text('Studio credits: 7 / charged')
        self.assertEqual(self.fixture.mutation_requests,[])
        self.assertEqual(self.fixture.applies,0)

    def test_applied_unreconciled_cache_price_does_not_turn_delivered_source_into_a_failure(self):
        self.prepare_accounting_result('cache-write-price-unconfigured')
        self.open()
        expect(self.page.locator('[data-provider-accounting=unreconciled]')).to_contain_text('A required cache-write price is not configured')
        expect(self.page.locator('#build-state')).to_have_text('Completed')
        expect(self.page.locator('#download-build')).to_be_visible()
        expect(self.page.locator('#code-editor')).to_have_value('return 448 -- validated delivered source')
        expect(self.page.locator('#build-log')).to_contain_text('Studio credits: 7 / charged')
        expect(self.page.locator('#build-log')).not_to_contain_text('API cost estimate:')
        self.assertEqual(self.fixture.mutation_requests,[])

    def test_failed_unreconciled_cache_lifetimes_keep_pending_studio_hold_separate(self):
        self.prepare_accounting_result('cache-write-lifetimes-unavailable','failed')
        self.open()
        expect(self.page.locator('[data-provider-accounting=unreconciled]')).to_contain_text('Cache-write lifetime details were not provided')
        expect(self.page.locator('#build-log')).to_contain_text('API budget reserved pending reconciliation: $0.5000')
        expect(self.page.locator('#build-log')).to_contain_text('Studio credits: 7 / pending')
        expect(self.page.locator('#build-log')).to_contain_text('Pending credits are holds, not finalized charges')
        expect(self.page.locator('#build-log')).not_to_contain_text('Validated source and its ZIP remain available')
        expect(self.page.locator('#build-state')).to_have_text('failed')
        expect(self.page.locator('#download-build')).to_be_hidden()
        expect(self.page.locator('#code-editor')).to_have_value('return 1')
        self.page.reload()
        expect(self.page.locator('[data-provider-accounting=unreconciled]')).to_be_visible()
        expect(self.page.locator('#build-log')).to_contain_text('Studio credits: 7 / pending')
        self.assertEqual(self.fixture.mutation_requests,[])

    def test_failed_unreconciled_cache_price_remains_visible_without_claiming_a_normal_cost(self):
        self.prepare_accounting_result('cache-write-price-unconfigured','failed')
        self.open()
        expect(self.page.locator('[data-provider-accounting=unreconciled]')).to_contain_text('A required cache-write price is not configured')
        expect(self.page.locator('#build-log')).to_contain_text('not a provider invoice')
        expect(self.page.locator('#build-log')).not_to_contain_text('API cost estimate:')
        expect(self.page.locator('#build-state')).to_have_text('failed')
        expect(self.page.locator('#code-editor')).to_have_value('return 1')
        self.assertEqual(self.fixture.mutation_requests,[])

    def test_failed_unreconciled_known_minimum_above_reservation_is_not_presented_as_an_exact_cost(self):
        self.prepare_accounting_result('cache-write-lifetimes-unavailable','failed')
        # One micro-dollar over the cap must not round back to the same amount.
        self.fixture.job['costMicros']=500001
        self.fixture.job['result']['error']='Known token costs exceeded the budget. No generated source was saved.'
        self.open()
        expected='Known API token cost is at least $0.500001, above the $0.5000 reservation.'
        expect(self.page.locator('#build-log')).to_contain_text(expected)
        expect(self.page.locator('#build-log')).to_contain_text('Cache-write pricing remains unreconciled; this is not a provider invoice')
        expect(self.page.locator('#build-log')).to_contain_text('Known token costs exceeded the budget')
        expect(self.page.locator('#build-log')).not_to_contain_text('API cost estimate:')
        expect(self.page.locator('#build-log')).not_to_contain_text('API budget reserved pending reconciliation:')
        expect(self.page.locator('#build-log')).to_contain_text('Studio credits: 7 / pending')
        expect(self.page.locator('#build-state')).to_have_text('failed')
        expect(self.page.locator('#download-build')).to_be_hidden()
        expect(self.page.locator('#code-editor')).to_have_value('return 1')
        self.page.reload()
        expect(self.page.locator('#build-log')).to_contain_text(expected)
        expect(self.page.locator('#download-build')).to_be_hidden()
        expect(self.page.locator('#code-editor')).to_have_value('return 1')
        self.assertEqual(self.fixture.mutation_requests,[])

    def test_ordinary_delivered_job_keeps_normal_cost_estimate_and_credit_display(self):
        self.fixture.complete([{'path':'client/main.lua','content':'return 449 -- normal delivered source'}])
        self.fixture.job.update(costMicros=12345,credits={'amount':7,'state':'charged'})
        self.open()
        expect(self.page.locator('[data-provider-accounting=unreconciled]')).to_have_count(0)
        expect(self.page.locator('#build-log')).to_contain_text('API cost estimate: $0.0123 / reservation: $0.5000')
        expect(self.page.locator('#build-log')).not_to_contain_text('reserved pending reconciliation')
        expect(self.page.locator('#build-log')).to_contain_text('Studio credits: 7 / charged')
        expect(self.page.locator('#build-state')).to_have_text('Completed')
        expect(self.page.locator('#download-build')).to_be_visible()
        self.assertEqual(self.fixture.mutation_requests,[])

    def test_current_session_expiry_clears_ephemeral_preview_and_preserves_source_drafts(self):
        self.open()
        self.page.locator('#code-editor').fill('return 991 -- keep local source after expiry')
        self.fixture.publish_preview(1,[{'path':'client/main.lua','content':'ephemeral unvalidated candidate','complete':False}])
        expect(self.page.locator('#live-preview-code')).to_have_text('ephemeral unvalidated candidate')
        self.fixture.expired=True
        self.page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
        expect(self.page.locator('#login')).to_be_visible()
        expect(self.page.locator('#live-preview')).to_be_hidden()
        expect(self.page.locator('#live-preview-code')).to_have_text('')
        raw=self.page.evaluate("sessionStorage.getItem('ndai:source-drafts:"+USER+':'+PROJECT+"')")
        self.assertIn('return 991 -- keep local source after expiry',raw)
        expect(self.page.locator('#recover-expired-drafts')).to_be_visible()

    def test_stale_earlier_account_unauthorized_response_does_not_clear_current_preview(self):
        requested,released=threading.Event(),threading.Event()
        self.fixture.delayed_reads['/api/studio/models']=(requested,released)
        self.fixture.unauthorized_once.add('/api/studio/models')
        self.fixture.publish_preview(1,[{'path':'client/main.lua','content':'preview in the recovered account','complete':False}])
        self.page.goto(self.fixture.url)
        self.assertTrue(requested.wait(timeout=5))
        self.fixture.user_id='55555555-5555-4555-8555-555555555555'
        self.fixture.csrf='recovered-account-csrf'
        self.page.evaluate("window.dispatchEvent(new Event('online'))")
        expect(self.page.locator('#editor-view')).to_be_visible()
        expect(self.page.locator('#live-preview-code')).to_have_text('preview in the recovered account')
        released.set()
        self.page.wait_for_timeout(100)
        expect(self.page.locator('#login')).to_be_hidden()
        expect(self.page.locator('#live-preview-code')).to_have_text('preview in the recovered account')
        expect(self.page.locator('#error')).to_be_hidden()

    def test_live_chunks_refresh_on_preview_version_without_changing_saved_source_or_drafts(self):
        self.open()
        self.page.locator('#code-editor').fill('return 777 -- private browser draft')
        initial_stamp=self.fixture.job['updatedAt']
        self.fixture.publish_preview(1,[{'path':'client/main.lua','content':'local command = "','complete':False}])
        expect(self.page.locator('#live-preview-code')).to_have_text('local command = "')
        expect(self.page.locator('#live-preview-state')).to_contain_text('Attempt 1')
        expect(self.page.locator('#live-preview-detail')).to_contain_text('Based on revision 1')
        expect(self.page.locator('#code-editor')).to_have_value('return 777 -- private browser draft')
        self.assertEqual(self.fixture.version,1)
        self.assertEqual(self.fixture.saves,0)
        self.fixture.publish_preview(2,[{'path':'client/main.lua','content':'local command = "hello"\nprint(command)','complete':True}])
        expect(self.page.locator('#live-preview-code')).to_have_text('local command = "hello"\nprint(command)')
        expect(self.page.locator('#live-preview-file-state')).to_contain_text('validation pending')
        self.assertEqual(self.fixture.job['updatedAt'],initial_stamp)
        self.assertEqual(self.fixture.saves,0)
        self.assertEqual(self.fixture.applies,0)

    def test_preview_file_selection_survives_added_files_and_attempt_replacement_clears_old_source(self):
        self.open()
        self.fixture.publish_preview(1,[{'path':'client/main.lua','content':'first preview','complete':False}])
        expect(self.page.locator('#live-preview-code')).to_have_text('first preview')
        self.fixture.publish_preview(2,[{'path':'README.md','content':'new file first in ordering','complete':True},{'path':'client/main.lua','content':'same selected path updated','complete':True}])
        expect(self.page.locator('#live-preview-code')).to_have_text('same selected path updated')
        expect(self.page.locator('#live-preview-file')).to_have_value('client/main.lua')
        self.fixture.publish_preview(3,[{'path':'server/repaired.lua','content':'repair attempt source','complete':False}],attempt=2)
        expect(self.page.locator('#live-preview-code')).to_have_text('repair attempt source')
        expect(self.page.locator('#live-preview-state')).to_contain_text('Attempt 2')
        self.assertNotIn('client/main.lua',self.page.locator('#live-preview-file').evaluate('(node)=>[...node.options].map(option=>option.value)'))

    def test_preview_uses_text_nodes_and_marks_proposed_deletions_without_touching_editor(self):
        self.open()
        payload='<script>window.previewExecuted=true</script>\nlocal sample = "<b>plain text</b>"'
        self.fixture.publish_preview(1,[{'path':'client/main.lua','content':payload,'complete':False}])
        expect(self.page.locator('#live-preview-code')).to_have_text(payload)
        self.assertEqual(self.page.locator('#live-preview-code script').count(),0)
        self.assertIsNone(self.page.evaluate('window.previewExecuted'))
        self.fixture.publish_preview(2,[{'path':'client/main.lua','content':None,'complete':True}])
        expect(self.page.locator('#live-preview-code')).to_contain_text('Deletion proposed')
        expect(self.page.locator('#live-preview-file-state')).to_contain_text('not applied')
        expect(self.page.locator('#code-editor')).to_have_value('return 1')
        self.assertEqual(self.fixture.files[0]['path'],'client/main.lua')

    def test_new_authoritative_mask_clears_running_preview_and_old_zero_response_cannot_erase_new_code(self):
        self.open()
        self.fixture.delay_job_detail=True
        self.page.locator('#build-history button').first.click()
        self.assertTrue(self.fixture.detail_requested.wait(timeout=5))
        self.fixture.publish_preview(2,[{'path':'client/main.lua','content':'newer code after old zero response','complete':False}])
        expect(self.page.locator('#live-preview-code')).to_have_text('newer code after old zero response')
        self.fixture.release_detail.set()
        self.page.wait_for_timeout(100)
        expect(self.page.locator('#live-preview-code')).to_have_text('newer code after old zero response')
        with self.fixture.lock:
            self.fixture.job.update(preview=None,previewVersion=0)
        expect(self.page.locator('#live-preview-code')).to_be_hidden()
        expect(self.page.locator('#live-preview-code')).to_have_text('')
        expect(self.page.locator('#live-preview-state')).to_contain_text('Waiting for code')

    def test_older_positive_detail_response_cannot_regress_preview_or_terminal_clear(self):
        self.open()
        self.fixture.publish_preview(1,[{'path':'client/main.lua','content':'older snapshot','complete':False}])
        expect(self.page.locator('#live-preview-code')).to_have_text('older snapshot')
        self.fixture.delay_job_detail=True
        self.page.locator('#build-history button').first.click()
        self.assertTrue(self.fixture.detail_requested.wait(timeout=5))
        self.fixture.publish_preview(3,[{'path':'client/main.lua','content':'newest snapshot','complete':False}])
        expect(self.page.locator('#live-preview-code')).to_have_text('newest snapshot')
        self.fixture.release_detail.set()
        self.page.wait_for_timeout(100)
        expect(self.page.locator('#live-preview-code')).to_have_text('newest snapshot')
        self.fixture.complete([{'path':'client/main.lua','content':'validated saved source'}])
        expect(self.page.locator('#live-preview')).to_be_hidden()
        expect(self.page.locator('#live-preview-code')).to_have_text('')
        expect(self.page.locator('#code-editor')).to_have_value('validated saved source')

    def test_deepseek_waiting_state_does_not_claim_incremental_streaming(self):
        self.fixture.job['provider']='deepseek'
        self.open()
        expect(self.page.locator('#live-preview-state')).to_contain_text('Waiting for code')
        expect(self.page.locator('#live-preview-detail')).to_contain_text('This provider returns code together')
        expect(self.page.locator('#live-preview-code')).to_be_hidden()
        expect(self.page.locator('#code-editor')).to_have_value('return 1')

    def test_saved_manual_changes_sync_without_jobs_and_without_local_writes(self):
        self.fixture.include_jobs=False
        self.open()
        with self.fixture.lock:
            self.fixture.version=2
            self.fixture.files=[{'path':'client/main.lua','content':'return 222 -- saved in another tab'}]
            self.fixture.revisions[2]=copy.deepcopy(self.fixture.files)
        expect(self.page.locator('#code-editor')).to_have_value('return 222 -- saved in another tab')
        expect(self.page.locator('#source-sync-status')).to_contain_text('Saved source synced / revision 2')
        self.assertEqual(self.fixture.saves,0)
        self.assertEqual(self.fixture.mutation_requests,[])
        self.assertEqual(self.fixture.detail_reads,0)

    def test_saved_source_sync_preserves_unchanged_draft_caret_selection_scroll_and_original_base(self):
        content=''.join(f'local value_{index} = "'+('x'*100)+'"\n' for index in range(100))
        self.fixture.files=[{'path':'client/main.lua','content':content},{'path':'README.md','content':'original readme'}]
        self.fixture.revisions[1]=copy.deepcopy(self.fixture.files)
        self.fixture.include_jobs=False
        self.open()
        editor=self.page.locator('#code-editor')
        draft=content+'-- unsaved local tail'
        editor.fill(draft)
        editor.focus()
        editor.evaluate("node=>{node.setSelectionRange(180,200,'backward');node.scrollTop=180;node.scrollLeft=30;}")
        before=editor.evaluate('node=>({start:node.selectionStart,end:node.selectionEnd,direction:node.selectionDirection,top:node.scrollTop,left:node.scrollLeft})')
        with self.fixture.lock:
            self.fixture.version=2
            self.fixture.files[1]['content']='updated saved readme'
            self.fixture.revisions[2]=copy.deepcopy(self.fixture.files)
        expect(self.page.locator('#project-meta')).to_contain_text('revision 2')
        expect(editor).to_have_value(draft)
        self.assertEqual(editor.evaluate('node=>({start:node.selectionStart,end:node.selectionEnd,direction:node.selectionDirection,top:node.scrollTop,left:node.scrollLeft})'),before)
        expect(self.page.locator('#draft-notice')).to_be_hidden()
        with self.fixture.lock:
            self.fixture.version=3
            self.fixture.files[0]['content']='remote replacement of selected source'
            self.fixture.revisions[3]=copy.deepcopy(self.fixture.files)
        expect(self.page.locator('#draft-notice')).to_be_visible()
        expect(editor).to_have_value(draft)
        self.assertEqual(editor.evaluate('node=>({start:node.selectionStart,end:node.selectionEnd,direction:node.selectionDirection,top:node.scrollTop,left:node.scrollLeft})'),before)
        raw=self.page.evaluate("sessionStorage.getItem('ndai:source-drafts:"+USER+':'+PROJECT+"')")
        record=dict(json.loads(raw)['entries'])['client/main.lua']
        self.assertEqual(record['baseVersion'],1)
        self.assertEqual(record['baseContent'],content)

    def test_preview_is_cleared_on_cancel_and_navigation_without_leaking_into_another_project(self):
        self.open()
        self.page.locator('#code-editor').fill('return 223 -- private draft remains')
        self.fixture.publish_preview(1,[{'path':'client/main.lua','content':'unvalidated partial text','complete':False}])
        expect(self.page.locator('#live-preview-code')).to_have_text('unvalidated partial text')
        with self.fixture.lock:
            self.fixture.job.update(status='cancelled',preview=None,previewVersion=0,updatedAt='2026-01-01T00:00:02.000Z')
        expect(self.page.locator('#live-preview')).to_be_hidden()
        expect(self.page.locator('#live-preview-code')).to_have_text('')
        expect(self.page.locator('#code-editor')).to_have_value('return 223 -- private draft remains')
        self.page.evaluate("location.hash='project/"+OTHER_PROJECT+"'")
        expect(self.page.locator('#project-name')).to_have_text('Other project')
        expect(self.page.locator('#live-preview')).to_be_hidden()
        expect(self.page.locator('#live-preview-code')).to_have_text('')
        expect(self.page.locator('#code-editor')).to_have_value('return 900')

    def test_view_live_code_is_explicit_mobile_navigation_without_changing_route(self):
        self.page.set_viewport_size({'width':390,'height':844})
        self.open()
        self.page.locator('button[data-panel=build]').click()
        self.fixture.publish_preview(1,[{'path':'client/main.lua','content':'partial code to inspect','complete':False}])
        expect(self.page.locator('#live-preview-code')).to_have_text('partial code to inspect')
        old_hash=self.page.evaluate('location.hash')
        self.page.locator('#view-live-preview').click()
        expect(self.page.locator('#live-preview-code')).to_be_focused()
        self.assertEqual(self.page.evaluate('location.hash'),old_hash)
        top=self.page.locator('#live-preview').bounding_box()['y']
        self.assertGreaterEqual(top,-2)
        self.assertLess(top,200)
        with self.fixture.lock:
            self.fixture.job.update(status='cancelled',preview=None,previewVersion=0,updatedAt='2026-01-01T00:00:03.000Z')
        expect(self.page.locator('#view-live-preview')).to_be_hidden()

    def test_mobile_live_preview_long_lines_stay_inside_viewport(self):
        self.page.set_viewport_size({'width':390,'height':844})
        self.open()
        self.fixture.publish_preview(1,[{'path':'client/main.lua','content':'local text = "'+('x'*10000)+'"','complete':False}])
        expect(self.page.locator('#live-preview-code')).to_be_visible()
        self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'),390)
        self.assertGreater(self.page.locator('#live-preview-code').evaluate('node=>node.scrollWidth'),self.page.locator('#live-preview-code').evaluate('node=>node.clientWidth'))
        expect(self.page.locator('#live-preview .live-preview-picker [role=combobox]')).to_have_accessible_name('Preview file')

    def test_manual_check_and_poll_share_inflight_reads_and_recover_after_read_failure(self):
        self.open()
        requested,released=threading.Event(),threading.Event()
        self.fixture.delayed_reads[f'/api/projects/{PROJECT}/jobs']=(requested,released)
        self.assertTrue(requested.wait(timeout=5))
        self.page.locator('#sync-source').click()
        self.page.evaluate("window.dispatchEvent(new Event('online'))")
        self.page.wait_for_timeout(100)
        self.assertEqual(self.fixture.max_jobs_reads_active,1)
        released.set()
        expect(self.page.locator('#sync-source')).to_be_enabled()
        self.fixture.fail_reads[f'/api/projects/{PROJECT}/jobs']=503
        self.page.locator('#sync-source').click()
        expect(self.page.locator('#source-sync-status')).to_contain_text('could not be checked')
        self.fixture.fail_reads.clear()
        self.page.locator('#sync-source').click()
        expect(self.page.locator('#source-sync-status')).to_contain_text('Saved source synced')
        expect(self.page.locator('#error')).to_be_hidden()
        self.assertEqual(self.fixture.max_jobs_reads_active,1)
        self.assertEqual(self.fixture.mutation_requests,[])

    def test_late_unauthorized_response_does_not_expire_a_recovered_same_user_session(self):
        requested,released=threading.Event(),threading.Event()
        self.fixture.delayed_reads['/api/studio/models']=(requested,released)
        self.fixture.fail_reads['/api/studio/models']=401
        self.page.goto(self.fixture.url)
        self.assertTrue(requested.wait(timeout=5))
        self.fixture.csrf='fixture-renewed-csrf'
        with self.page.expect_response(lambda response: '/api/session' in response.url):
            self.page.evaluate("window.dispatchEvent(new Event('online'))")
        self.page.wait_for_timeout(100)
        released.set()
        expect(self.page.locator('#route-error')).to_be_visible()
        expect(self.page.locator('#login')).to_be_hidden()
        self.fixture.fail_reads.clear()
        self.page.locator('#retry-workspace').click()
        expect(self.page.locator('#editor-view')).to_be_visible()
        expect(self.page.locator('#profile-link')).to_have_text('Browser tester')

    def test_successful_explicit_draft_recovery_clears_the_earlier_conflict_error(self):
        self.open()
        self.page.locator('#code-editor').fill('return 444 -- my recovered source')
        # Capture the version-1 write before the server's concurrent revision.
        # Polling may then discover revision 2 without racing the Save click.
        self.fixture.delay_save=True
        self.page.locator('#save-file').click()
        self.assertTrue(self.fixture.save_requested.wait(timeout=5))
        self.assertEqual(self.fixture.mutation_requests[0]['body']['version'],1)
        with self.fixture.lock:
            self.fixture.version=2
            self.fixture.files=[{'path':'client/main.lua','content':'return 445 -- external source'}]
            self.fixture.revisions[2]=copy.deepcopy(self.fixture.files)
        self.fixture.delay_save=False
        self.fixture.release_save.set()
        expect(self.page.locator('#error')).to_contain_text('Source changed')
        expect(self.page.locator('#draft-notice')).to_be_visible()
        self.page.locator('#compare-draft').click()
        self.page.locator('#save-draft').click()
        expect(self.page.locator('#save-status')).to_have_text('Saved revision 3')
        expect(self.page.locator('#error')).to_be_hidden()
        self.assertEqual(self.fixture.mutation_requests[1]['body']['version'],2)
        self.assertEqual(self.fixture.mutation_requests[1]['body']['content'],'return 444 -- my recovered source')

    def test_pending_rename_freezes_its_inputs_but_keeps_close_available(self):
        self.open()
        self.page.locator('#rename-file').click()
        path=self.page.locator('#file-form input[name=path]')
        path.fill('client/renamed.lua')
        self.fixture.delay_save=True
        self.page.locator('#file-form [type=submit]').click()
        self.assertTrue(self.fixture.save_requested.wait(timeout=5))
        expect(path).to_be_disabled()
        expect(self.page.locator('#file-dialog [data-close]').first).to_be_enabled()
        self.fixture.release_save.set()
        expect(self.page.locator('#file-dialog')).to_be_hidden()
        self.page.locator('#rename-file').click()
        expect(path).to_be_enabled()
        expect(path).to_have_value('client/renamed.lua')
        self.assertEqual(len(self.fixture.mutation_requests),1)

    def test_pending_new_project_locks_fields_and_ignores_repeated_submission(self):
        self.open()
        self.page.locator('#new-project').click()
        form=self.page.locator('#project-form')
        form.locator('[name=name]').fill('Exactly one pending project')
        form.locator('[name=requirements]').fill('Preserve the submitted form while the server commits.')
        self.fixture.delay_create=True
        form.locator('[type=submit]').click()
        self.assertTrue(self.fixture.create_requested.wait(timeout=5))
        expect(form.locator('[name=name]')).to_be_disabled()
        expect(form.get_by_role('combobox',name='Tool',exact=True)).to_be_disabled()
        expect(form.get_by_role('combobox',name='Framework',exact=True)).to_be_disabled()
        expect(form.locator('[data-close]').first).to_be_enabled()
        form.evaluate("node=>node.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))")
        self.fixture.release_create.set()
        expect(self.page.locator('#project-name')).to_have_text('Exactly one pending project')
        self.assertEqual(len(self.fixture.project_creations),1)

    def prepare_recreated_draft_before_an_old_acknowledgement(self):
        self.open()
        self.page.locator('#code-editor').fill('return 222 -- old submitted text')
        self.fixture.delay_save_reply = True
        self.page.locator('#save-file').click()
        self.assertTrue(self.fixture.save_requested.wait(timeout=5))
        changed=self.context.request.put(self.fixture.url.split('/workspace.html')[0]+f'/api/projects/{PROJECT}/files',data={'version':2,'path':'client/main.lua','content':'return 333 -- newer saved source'})
        self.assertEqual(changed.status,200)
        self.page.locator('#projects-nav').click()
        expect(self.page.locator('#dashboard')).to_be_visible()
        self.page.get_by_role('link',name='Open project',exact=True).click()
        expect(self.page.locator('#project-meta')).to_contain_text('revision 3')
        self.page.locator('#code-editor').fill('return 333 -- newer saved source')
        self.page.locator('#code-editor').fill('return 222 -- old submitted text')

    def test_typing_during_deletion_retains_the_new_draft_even_if_text_returns_to_its_old_value(self):
        self.open()
        text='return 888 -- retain new typing during deletion'
        self.page.locator('#code-editor').fill(text)
        self.fixture.delay_save_reply=True
        self.page.locator('#delete-file').click()
        self.page.locator('dialog[open]').get_by_role('button',name='Delete file',exact=True).click()
        self.assertTrue(self.fixture.save_requested.wait(timeout=5))
        self.page.locator('#code-editor').fill('return 889 -- a newer edit')
        self.page.locator('#code-editor').fill(text)
        self.fixture.release_save.set()
        expect(self.page.locator('#save-status')).to_have_text('Saved source changed / local draft preserved')
        expect(self.page.locator('#draft-notice')).to_be_visible()
        expect(self.page.locator('#code-editor')).to_have_value(text)
        expect(self.page.locator('#file-list')).to_contain_text('client/main.lua (local draft)')

    def test_old_save_acknowledgement_cannot_clear_a_newly_recreated_same_text_draft(self):
        self.prepare_recreated_draft_before_an_old_acknowledgement()
        self.fixture.release_save.set()
        self.assertTrue(self.fixture.save_completed.wait(timeout=5))
        expect(self.page.locator('#save-status')).to_have_text('Unsaved changes')
        expect(self.page.locator('#code-editor')).to_have_value('return 222 -- old submitted text')
        raw=self.page.evaluate("sessionStorage.getItem('ndai:source-drafts:" + USER + ':' + PROJECT + "')")
        recovered=dict(json.loads(raw)['entries'])['client/main.lua']
        self.assertEqual(recovered['baseVersion'],3)
        self.assertEqual(recovered['baseContent'],'return 333 -- newer saved source')

    def test_old_off_project_acknowledgement_keeps_newer_recovery_on_disk(self):
        self.prepare_recreated_draft_before_an_old_acknowledgement()
        self.page.locator('#projects-nav').click()
        expect(self.page.locator('#dashboard')).to_be_visible()
        self.fixture.release_save.set()
        self.assertTrue(self.fixture.save_completed.wait(timeout=5))
        self.page.wait_for_timeout(100)
        self.page.get_by_role('link',name='Open project',exact=True).click()
        expect(self.page.locator('#code-editor')).to_have_value('return 222 -- old submitted text')
        expect(self.page.locator('#save-status')).to_have_text('Unsaved changes')

    def test_delayed_admin_tab_cannot_overwrite_the_later_selected_pane(self):
        self.fixture.admin = self.fixture.admin_models = self.fixture.admin_tools = True
        requested,released=threading.Event(),threading.Event()
        self.fixture.delayed_reads['/api/admin/tools']=(requested,released)
        self.open()
        self.page.locator('#admin-nav').click()
        self.assertTrue(requested.wait(timeout=5))
        self.page.get_by_role('tab',name='Settings',exact=True).click()
        expect(self.page.locator('#admin-content')).to_contain_text('Discord connection')
        released.set()
        self.page.wait_for_timeout(100)
        expect(self.page.get_by_role('tab',name='Settings',exact=True)).to_have_attribute('aria-selected','true')
        expect(self.page.locator('#admin-content')).to_contain_text('Discord connection')
        expect(self.page.locator('#admin-content')).not_to_contain_text('Generator access')

    def test_failed_old_admin_read_does_not_replace_the_current_panes_error_state(self):
        self.fixture.admin = self.fixture.admin_models = self.fixture.admin_tools = True
        requested,released=threading.Event(),threading.Event()
        self.fixture.delayed_reads['/api/admin/tools']=(requested,released)
        self.fixture.fail_reads['/api/admin/tools']=503
        self.open()
        self.page.locator('#admin-nav').click()
        self.assertTrue(requested.wait(timeout=5))
        self.page.get_by_role('tab',name='Settings',exact=True).click()
        expect(self.page.locator('#admin-content')).to_contain_text('Discord connection')
        released.set()
        self.page.wait_for_timeout(100)
        expect(self.page.locator('#error')).to_be_hidden()
        expect(self.page.locator('#admin-content')).to_contain_text('Discord connection')

    def test_late_initial_user_search_does_not_replace_a_newer_search(self):
        self.fixture.admin = self.fixture.admin_users = True
        requested,released=threading.Event(),threading.Event()
        self.fixture.delayed_reads['/api/admin/users']=(requested,released)
        self.open()
        self.page.locator('#admin-nav').click()
        self.assertTrue(requested.wait(timeout=5))
        self.page.get_by_label('Find an account',exact=True).fill('Alice')
        self.page.get_by_role('button',name='Search',exact=True).click()
        expect(self.page.locator('#admin-content table')).to_contain_text('Alice')
        released.set()
        self.page.wait_for_timeout(100)
        expect(self.page.locator('#admin-content table')).to_contain_text('Alice')
        expect(self.page.locator('#admin-content table')).not_to_contain_text('Bob')

    def test_settings_edits_typed_during_save_survive_the_acknowledgement(self):
        self.fixture.admin = self.fixture.admin_models = True
        self.open()
        self.page.locator('#admin-nav').click()
        expect(self.page.locator('#admin-content')).to_contain_text('Discord connection')
        guild=self.page.get_by_label('Discord guild ID',exact=True)
        guild.fill('100000000000000001')
        requested,released=threading.Event(),threading.Event()
        self.fixture.delayed_reads['PATCH /api/admin/settings']=(requested,released)
        self.page.get_by_role('button',name='Save configuration',exact=True).click()
        self.assertTrue(requested.wait(timeout=5))
        guild.fill('100000000000000002')
        released.set()
        expect(self.page.locator('#toast')).to_contain_text('Configuration saved')
        expect(guild).to_have_value('100000000000000002')
        with self.page.expect_response(lambda response: '/api/admin/settings' in response.url and response.request.method == 'PATCH'):
            self.page.get_by_role('button',name='Save configuration',exact=True).click()
        self.assertEqual(self.fixture.settings_requests[-1]['version'],2)
        self.assertEqual(self.fixture.settings_requests[-1]['guildId'],'100000000000000002')

    def test_archived_source_tab_moves_focus_without_inserting_a_draft(self):
        self.fixture.archived = True
        self.open()
        editor = self.page.locator('#code-editor')
        expect(editor).to_have_attribute('readonly', '')
        editor.focus()
        self.page.keyboard.press('Tab')
        expect(editor).not_to_be_focused()
        expect(editor).to_have_value('return 1')
        expect(self.page.locator('#save-status')).to_have_text('Saved revision 1')
        self.assertIsNone(self.page.evaluate("sessionStorage.getItem('ndai:source-drafts:" + USER + ':' + PROJECT + "')"))
        self.assertEqual(self.fixture.mutation_requests,[])

    def test_editable_source_tab_indents_and_shift_tab_escapes_the_editor(self):
        self.open()
        editor = self.page.locator('#code-editor')
        editor.focus()
        editor.evaluate('(node)=>node.setSelectionRange(0,0)')
        self.page.keyboard.press('Tab')
        expect(editor).to_be_focused()
        expect(editor).to_have_value('    return 1')
        expect(self.page.locator('#save-file')).to_be_enabled()
        self.page.keyboard.press('Shift+Tab')
        expect(editor).not_to_be_focused()
        self.assertEqual(self.fixture.mutation_requests,[])

    def test_project_read_failure_offers_retry_without_a_false_sign_in(self):
        path = f'/api/projects/{PROJECT}'
        self.fixture.fail_reads[path] = 503
        self.page.goto(self.fixture.url)
        expect(self.page.locator('#route-error')).to_be_visible()
        expect(self.page.locator('#route-error-message')).to_contain_text('Temporary fixture read failure')
        expect(self.page.locator('#login')).to_be_hidden()
        self.fixture.fail_reads.clear()
        self.page.locator('#retry-workspace').click()
        expect(self.page.locator('#editor-view')).to_be_visible()
        expect(self.page.locator('#code-editor')).to_have_value('return 1')
        self.assertEqual(self.fixture.mutation_requests,[])

    def test_catalog_bootstrap_failure_retains_known_authentication_and_retries(self):
        self.fixture.fail_reads['/catalog.json'] = 503
        self.page.goto(self.fixture.url)
        expect(self.page.locator('#route-error')).to_be_visible()
        expect(self.page.locator('#login')).to_be_hidden()
        self.fixture.fail_reads.clear()
        self.page.locator('#retry-workspace').click()
        expect(self.page.locator('#editor-view')).to_be_visible()
        expect(self.page.locator('#profile-link')).to_have_text('Browser tester')
        self.assertEqual(self.fixture.mutation_requests,[])

    def test_private_project_error_returns_to_projects_without_exposing_source(self):
        self.fixture.fail_reads[f'/api/projects/{PROJECT}'] = 404
        self.page.goto(self.fixture.url)
        expect(self.page.locator('#route-error-title')).to_have_text('Project unavailable.')
        expect(self.page.locator('#route-error-message')).to_have_text('Project not found.')
        expect(self.page.locator('#login')).to_be_hidden()
        self.page.locator('#back-to-projects').click()
        expect(self.page.locator('#dashboard')).to_be_visible()
        self.assertEqual(self.fixture.mutation_requests,[])

    def test_corrupt_recovery_is_never_removed_by_selection_or_overwritten_by_typing(self):
        raw = 'unreadable recovery text: return 987'
        key = f'ndai:source-drafts:{USER}:{PROJECT}'
        self.page.add_init_script('sessionStorage.setItem(' + json.dumps(key) + ',' + json.dumps(raw) + ')')
        self.open()
        expect(self.page.locator('#draft-storage-warning')).to_be_visible()
        self.page.locator('#file-list').get_by_role('button',name='README.md',exact=True).click()
        self.page.locator('#code-editor').fill('New in-memory source retained separately')
        self.assertEqual(self.page.evaluate('(key)=>sessionStorage.getItem(key)',key),raw)
        expect(self.page.locator('#draft-storage-warning')).to_be_visible()
        expect(self.page.locator('#code-editor')).to_have_value('New in-memory source retained separately')

    def test_expired_session_can_download_source_when_browser_storage_is_unavailable(self):
        self.page.add_init_script("Storage.prototype.setItem=()=>{throw new DOMException('Full','QuotaExceededError');};")
        self.open()
        self.page.locator('#code-editor').fill('return 654 -- rescue without browser storage')
        self.fixture.expired = True
        self.page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
        expect(self.page.locator('#login')).to_be_visible()
        with self.page.expect_download() as pending:
            self.page.locator('#recover-expired-drafts').click()
        exported = json.loads(Path(pending.value.path()).read_text())
        self.assertEqual(exported['files'][0]['content'],'return 654 -- rescue without browser storage')
        self.assertEqual(exported['files'][0]['path'],'client/main.lua')
        self.assertNotIn('csrf',exported)
        self.assertNotIn('session',exported)
        self.assertEqual(self.fixture.mutation_requests,[])

    def test_delete_confirmation_cannot_target_a_project_opened_after_the_prompt(self):
        self.open()
        self.page.locator('#delete-file').click()
        expect(self.page.locator('dialog[open]')).to_contain_text('Delete source file?')
        self.page.evaluate("location.hash='project/" + OTHER_PROJECT + "'")
        expect(self.page.locator('#project-name')).to_have_text('Other project')
        dialog = self.page.locator('dialog[open]')
        if dialog.count():
            dialog.get_by_role('button',name='Delete file',exact=True).click()
        self.page.wait_for_timeout(150)
        self.assertEqual(self.fixture.mutation_requests, [])
        self.assertEqual(self.fixture.other_project['files'][0]['content'],'return 900')

    def test_delayed_rename_response_keeps_the_current_projects_unsaved_source(self):
        self.open()
        self.page.locator('#rename-file').click()
        self.page.locator('#file-form input[name=path]').fill('client/renamed.lua')
        self.fixture.delay_save = True
        self.page.locator('#file-form button[type=submit]').click()
        self.assertTrue(self.fixture.save_requested.wait(timeout=5))
        self.page.locator('#file-dialog button[data-close]').first.click()
        self.page.evaluate("location.hash='project/" + OTHER_PROJECT + "'")
        expect(self.page.locator('#project-name')).to_have_text('Other project')
        self.page.locator('#code-editor').fill('return 901 -- preserve other project draft')
        self.fixture.release_save.set()
        self.assertTrue(self.fixture.save_completed.wait(timeout=5))
        self.page.wait_for_timeout(150)
        expect(self.page.locator('#project-name')).to_have_text('Other project')
        expect(self.page.locator('#code-editor')).to_have_value('return 901 -- preserve other project draft')
        self.assertEqual(self.fixture.mutation_requests[0]['path'],f'/api/projects/{PROJECT}/files')

    def test_save_stays_locked_when_source_input_changes_during_the_request(self):
        self.open()
        self.page.locator('#code-editor').fill('return 321 -- first save')
        self.fixture.delay_save = True
        self.page.locator('#save-file').click()
        self.assertTrue(self.fixture.save_requested.wait(timeout=5))
        self.page.locator('#code-editor').fill('return 322 -- typed while saving')
        expect(self.page.locator('#save-file')).to_be_disabled()
        self.page.keyboard.press('Control+s')
        self.fixture.release_save.set()
        self.assertTrue(self.fixture.save_completed.wait(timeout=5))
        expect(self.page.locator('#code-editor')).to_have_value('return 322 -- typed while saving')
        expect(self.page.locator('#save-file')).to_be_enabled()
        self.assertEqual(len(self.fixture.mutation_requests),1)

    def test_expired_session_preserves_drafts_and_closes_source_dialogs(self):
        self.open()
        self.page.locator('#code-editor').fill('return 323 -- recover after sign in')
        self.page.locator('#rename-file').click()
        self.fixture.expired = True
        self.page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
        expect(self.page.locator('#login')).to_be_visible()
        expect(self.page.locator('dialog[open]')).to_have_count(0)
        stored = self.page.evaluate("sessionStorage.getItem('ndai:source-drafts:" + USER + ':' + PROJECT + "')")
        self.assertIn('return 323 -- recover after sign in',stored)
        self.assertEqual(self.fixture.mutation_requests,[])

    def test_provider_disclosure_names_deepseek_without_a_paid_request(self):
        self.fixture.job['status'] = 'failed'
        self.fixture.models[0].update(provider='deepseek', workerReady=True)
        self.open()
        expect(self.page.locator('.model-quote')).to_contain_text('DeepSeek')
        self.page.locator('#build-prompt').fill('Fixture build request')
        self.page.locator('#generate-button').click()
        expect(self.page.locator('dialog[open]')).to_contain_text('sent to DeepSeek')
        expect(self.page.locator('dialog[open]')).not_to_contain_text('sent to OpenAI')
        self.assertEqual(self.fixture.applies, 0)
        self.page.locator('dialog[open]').get_by_role('button', name='Cancel', exact=True).click()

    def test_unavailable_provider_blocks_generation_and_dropdown_keyboard_skips_it(self):
        self.fixture.job['status'] = 'failed'
        self.fixture.models.append(dict(self.fixture.models[0], id='unavailable-model', label='Unavailable provider model', provider='deepseek', workerReady=False))
        self.fixture.models.append(dict(self.fixture.models[0], id='available-model', label='Available provider model', provider='openai', workerReady=True))
        self.open()
        combo = self.page.get_by_role('combobox', name='Coding model', exact=True)
        combo.click()
        unavailable = self.page.get_by_role('option', name='DeepSeek / Unavailable provider model / standard / worker unavailable', exact=True)
        expect(unavailable).to_have_attribute('aria-disabled', 'true')
        unavailable.click()
        expect(self.page.locator('select[name=modelId]')).to_have_value('fixture-model')
        combo.press('ArrowDown')
        combo.press('Enter')
        expect(self.page.locator('select[name=modelId]')).to_have_value('available-model')
        self.fixture.models[0]['workerReady'] = False
        self.page.reload()
        expect(self.page.locator('#generate-button')).to_be_disabled()
        expect(self.page.locator('.model-quote')).to_contain_text('not ready on the worker')

    def test_reviewed_preset_import_is_disabled_editable_and_preserves_existing_catalog(self):
        self.fixture.admin = True
        self.fixture.admin_models = True
        base = dict(id='fixture-model', label='Existing model', provider='openai', tier='standard', enabled=True,
                    compatible=True, inputUsdPerMillion=1, cachedInputUsdPerMillion=.1, outputUsdPerMillion=2,
                    creditsPerBuild=7, maxOutputTokens=8192, maxCalls=2, maxBudgetMicros=500000, timeoutSeconds=180)
        preset = dict(base, id='fixture-deepseek', label='Reviewed DeepSeek fixture', provider='deepseek',
                      enabled=False, compatible=False, creditsPerBuild=12,
                      cacheWritePolicy='provider-default', cacheWrite30mUsdPerMillion=None,
                      cacheWrite12hUsdPerMillion=None, longContextThreshold=None,
                      longContextInputMultiplier=1, longContextOutputMultiplier=1,
                      verification={'checkedAt': '2026-10-25', 'sources': ['https://api-docs.deepseek.com/'],
                                    'notes': 'Fixture verification notes shown before import.'})
        openai_preset = dict(preset, id='fixture-openai-premium', label='Reviewed OpenAI fixture', provider='openai', cacheWritePolicy='disabled', longContextThreshold=272000, longContextInputMultiplier=2, longContextOutputMultiplier=1.5)
        self.fixture.admin_config = dict(version=1, models=[base], presets=[preset, openai_preset], defaultModelId='fixture-model', creditsEnabled=False)
        self.open()
        self.page.locator('#admin-nav').click()
        self.page.get_by_role('tab', name='Models & credits', exact=True).click()
        self.page.get_by_role('combobox', name='Verified coding preset', exact=True).click()
        self.page.get_by_role('option', name='DeepSeek / Reviewed DeepSeek fixture', exact=True).click()
        expect(self.page.locator('.preset-evidence')).to_contain_text('2026-10-25')
        expect(self.page.locator('.preset-evidence')).to_contain_text('Fixture verification notes shown before import.')
        expect(self.page.locator('.preset-evidence a')).to_have_attribute('href', 'https://api-docs.deepseek.com/')
        self.page.get_by_role('button', name='Add disabled preset', exact=True).click()
        cards = self.page.locator('.model-card')
        expect(cards).to_have_count(2)
        imported = cards.nth(1)
        expect(imported.get_by_label('Available in the model selector', exact=True)).not_to_be_checked()
        expect(imported.get_by_label('I verified this provider adapter, structured output and account access', exact=True)).not_to_be_checked()
        imported.locator('input[name=creditsPerBuild]').fill('18')
        self.page.get_by_role('combobox', name='Verified coding preset', exact=True).click()
        self.page.get_by_role('option', name='OpenAI / Reviewed OpenAI fixture', exact=True).click()
        self.page.get_by_role('button', name='Add disabled preset', exact=True).click()
        expect(cards).to_have_count(3)
        self.page.get_by_role('button', name='Save model catalog', exact=True).click()
        self.page.wait_for_function("document.getElementById('toast').textContent.includes('Model catalog saved')")
        saved = self.fixture.saved_catalog
        self.assertEqual(saved['defaultModelId'], 'fixture-model')
        self.assertEqual(saved['creditsEnabled'], False)
        self.assertEqual(saved['models'][0]['id'], 'fixture-model')
        self.assertEqual(saved['models'][0]['creditsPerBuild'], 7)
        self.assertEqual(saved['models'][1]['provider'], 'deepseek')
        self.assertEqual(saved['models'][1]['creditsPerBuild'], 18)
        self.assertEqual(saved['models'][1]['enabled'], False)
        self.assertEqual(saved['models'][1]['compatible'], False)
        self.assertIsNone(saved['models'][1]['cacheWrite30mUsdPerMillion'])
        self.assertIsNone(saved['models'][1]['longContextThreshold'])
        self.assertNotIn('verification', saved['models'][1])
        self.assertEqual(saved['models'][2]['provider'], 'openai')
        self.assertEqual(saved['models'][2]['cacheWritePolicy'], 'disabled')
        self.assertEqual(saved['models'][2]['longContextThreshold'], 272000)
        self.assertEqual(saved['models'][2]['longContextInputMultiplier'], 2)
        self.assertEqual(saved['models'][2]['longContextOutputMultiplier'], 1.5)
        self.assertEqual(saved['models'][2]['enabled'], False)
        self.assertNotIn('verification', saved['models'][2])
        self.assertEqual(self.fixture.applies, 0)

    def test_empty_project_populates_without_apply_and_keeps_optional_history(self):
        with self.fixture.lock:
            self.fixture.files = []
            self.fixture.revisions[1] = []
        self.open()
        expect(self.page.locator('#code-empty')).to_be_visible()
        self.fixture.complete([{'path': 'client/main.lua', 'content': 'return 42'}])
        expect(self.page.locator('#code-editor')).to_have_value('return 42')
        expect(self.page.locator('#file-list')).to_contain_text('client/main.lua')
        expect(self.page.locator('#build-state')).to_have_text('Completed')
        expect(self.page.locator('#download-build')).to_have_attribute('href', f'/api/jobs/{JOB}/export')
        expect(self.page.locator('#apply-proposal')).to_be_hidden()
        self.page.locator('#history-button').click()
        expect(self.page.locator('#revision-list')).to_contain_text('Revision 2')
        self.assertEqual(self.fixture.applies, 0)
        self.assertEqual(self.fixture.saves, 0)

    def test_deleted_file_draft_survives_completion_reload_and_explicit_recovery(self):
        self.open()
        self.page.locator('#code-editor').fill('return 77 -- local unsaved source')
        self.fixture.complete([{'path': 'README.md', 'content': 'Generated without main.lua'}])
        expect(self.page.locator('#draft-notice')).to_be_visible()
        expect(self.page.locator('#code-editor')).to_have_value('return 77 -- local unsaved source')
        expect(self.page.locator('#file-list')).to_contain_text('client/main.lua (local draft)')
        expect(self.page.locator('#save-file')).to_be_disabled()
        self.page.reload()
        expect(self.page.locator('#code-editor')).to_have_value('return 77 -- local unsaved source')
        expect(self.page.locator('#draft-notice')).to_be_visible()
        self.page.locator('#compare-draft').click()
        expect(self.page.locator('#draft-original')).to_have_text('return 1')
        expect(self.page.locator('#draft-saved')).to_contain_text('absent')
        expect(self.page.locator('#draft-local')).to_have_text('return 77 -- local unsaved source')
        self.page.locator('#save-draft').click()
        expect(self.page.locator('#draft-dialog')).to_be_hidden()
        expect(self.page.locator('#save-status')).to_have_text('Saved revision 3')
        self.assertEqual(self.fixture.saves, 1)
        self.assertEqual(self.fixture.applies, 0)
        self.assertEqual(self.fixture.files[-1]['content'], 'return 77 -- local unsaved source')

    def test_typing_while_completion_refresh_waits_remains_local(self):
        self.open()
        self.fixture.delay_project = True
        self.fixture.complete([{'path': 'client/main.lua', 'content': 'return 5'}])
        self.assertTrue(self.fixture.project_requested.wait(timeout=5))
        self.page.locator('#code-editor').fill('return 99 -- typed during refresh')
        self.fixture.release_project.set()
        expect(self.page.locator('#project-meta')).to_contain_text('revision 2')
        expect(self.page.locator('#code-editor')).to_have_value('return 99 -- typed during refresh')
        expect(self.page.locator('#draft-notice')).to_be_visible()
        self.assertEqual(self.fixture.saves, 0)

    def test_storage_failure_warns_without_losing_in_memory_source(self):
        self.page.add_init_script("Storage.prototype.setItem=()=>{throw new DOMException('Full','QuotaExceededError');};")
        self.open()
        self.page.locator('#code-editor').fill('return 88 -- retain despite storage failure')
        expect(self.page.locator('#draft-storage-warning')).to_be_visible()
        self.fixture.complete([{'path': 'client/main.lua', 'content': 'return 9'}])
        expect(self.page.locator('#draft-notice')).to_be_visible()
        expect(self.page.locator('#code-editor')).to_have_value('return 88 -- retain despite storage failure')
        self.assertEqual(self.fixture.saves, 0)

    def test_project_navigation_retains_recoverable_drafts(self):
        self.open()
        self.page.locator('#code-editor').fill('return 123 -- kept while browsing')
        self.page.locator('#projects-nav').click()
        expect(self.page.locator('#dashboard')).to_be_visible()
        self.page.get_by_role('link', name='Open project').click()
        expect(self.page.locator('#code-editor')).to_have_value('return 123 -- kept while browsing')
        self.assertEqual(self.fixture.saves, 0)

    def test_admin_roundtrip_restores_the_same_projects_unsaved_draft(self):
        self.fixture.admin = True
        self.open()
        self.page.locator('#code-editor').fill('return 456 -- kept during admin visit')
        self.page.locator('#admin-nav').click()
        expect(self.page.locator('#admin-view')).to_be_visible()
        self.page.evaluate("location.hash='project/" + PROJECT + "'")
        expect(self.page.locator('#code-editor')).to_have_value('return 456 -- kept during admin visit')
        self.assertEqual(self.fixture.saves, 0)

    def test_oversized_recovery_warns_before_reloading_without_truncating_source(self):
        self.open()
        source = 'a' * 131073
        self.page.locator('#code-editor').fill(source)
        expect(self.page.locator('#draft-storage-warning')).to_be_visible()
        expect(self.page.locator('#code-editor')).to_have_value(source)
        self.assertEqual(self.fixture.saves, 0)

    def test_conflicted_output_refreshes_newer_saved_source_without_apply(self):
        self.open()
        with self.fixture.lock:
            self.fixture.version = 2
            self.fixture.files = [{'path': 'client/main.lua', 'content': 'return 333 -- newer manual save'}]
            self.fixture.revisions[2] = copy.deepcopy(self.fixture.files)
            self.fixture.job.update(status='review', applicationError='Project changed. Automatic saving was skipped.',
                                    result={'files': [{'path': 'client/main.lua', 'content': 'return 555 -- generated output'}], 'summary': 'Conflicting output', 'checks': []},
                                    updatedAt='2026-01-01T00:00:01.000Z')
        expect(self.page.locator('#code-editor')).to_have_value('return 333 -- newer manual save')
        expect(self.page.locator('#build-log')).to_contain_text('Finished output is preserved')
        expect(self.page.locator('#download-build')).to_be_visible()
        self.assertEqual(self.fixture.applies, 0)
        self.assertEqual(self.fixture.saves, 0)

    def test_account_scoped_recovery_does_not_show_another_accounts_draft(self):
        self.open()
        self.page.locator('#code-editor').fill('return 234 -- private account draft')
        self.fixture.user_id = 'other-account'
        self.page.reload()
        expect(self.page.locator('#code-editor')).to_have_value('return 1')
        self.fixture.user_id = USER
        self.page.reload()
        expect(self.page.locator('#code-editor')).to_have_value('return 234 -- private account draft')

    def test_save_acknowledged_after_navigation_clears_its_old_recovery_record(self):
        self.open()
        self.page.locator('#code-editor').fill('return 567 -- saved while navigating')
        self.fixture.delay_save = True
        self.page.locator('#save-file').click()
        self.assertTrue(self.fixture.save_requested.wait(timeout=5))
        self.page.locator('#projects-nav').click()
        expect(self.page.locator('#dashboard')).to_be_visible()
        self.fixture.release_save.set()
        self.assertTrue(self.fixture.save_completed.wait(timeout=5))
        self.page.wait_for_function("!sessionStorage.getItem('ndai:source-drafts:" + USER + ':' + PROJECT + "')")
        self.page.get_by_role('link', name='Open project').click()
        expect(self.page.locator('#editor-view')).to_be_visible()
        saved_file=self.page.locator('#file-list').get_by_role('button',name='client/main.lua',exact=True)
        expect(saved_file).to_be_visible()
        saved_file.click()
        expect(self.page.locator('#file-list')).not_to_contain_text('* ')
        expect(self.page.locator('#code-editor')).to_have_value('return 567 -- saved while navigating')
        expect(self.page.locator('#save-status')).to_have_text('Saved revision 2')
        self.assertEqual(self.fixture.saves, 1)

    def test_navigation_during_completion_refresh_ignores_the_stale_response(self):
        self.open()
        self.fixture.delay_project = True
        self.fixture.complete([{'path': 'client/main.lua', 'content': 'return 345'}])
        self.assertTrue(self.fixture.project_requested.wait(timeout=5))
        self.page.locator('#projects-nav').click()
        expect(self.page.locator('#dashboard')).to_be_visible()
        self.fixture.release_project.set()
        expect(self.page.locator('#editor-view')).to_be_hidden()
        expect(self.page.locator('#route-label')).to_have_text('PROJECTS')

    def test_closed_tab_completion_loads_saved_files_on_reopen(self):
        self.open()
        self.page.close()
        self.fixture.complete([{'path': 'client/main.lua', 'content': 'return 101'}])
        self.page = self.context.new_page()
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.open()
        expect(self.page.locator('#code-editor')).to_have_value('return 101')
        expect(self.page.locator('#build-state')).to_have_text('Completed')
        self.assertEqual(self.fixture.applies, 0)


if __name__ == '__main__':
    unittest.main(verbosity=2)
