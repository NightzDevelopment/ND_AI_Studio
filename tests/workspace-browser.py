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
USER = '22222222-2222-4222-8222-222222222222'
JOB = '33333333-3333-4333-8333-333333333333'
SOURCE = [{'path': 'client/main.lua', 'content': 'return 1'}, {'path': 'README.md', 'content': 'Original'}]


class Fixture:
    def __init__(self, files=None):
        self.lock = threading.Lock()
        self.files = copy.deepcopy(SOURCE if files is None else files)
        self.version = 1
        self.revisions = {1: copy.deepcopy(self.files)}
        self.applies = 0
        self.saves = 0
        self.user_id = USER
        self.admin = False
        self.admin_models = False
        self.models = [{'id': 'fixture-model', 'label': 'Fixture model', 'tier': 'standard', 'creditsPerBuild': 0, 'maxBudgetMicros': 500000}]
        self.admin_config = None
        self.saved_catalog = None
        self.delay_project = False
        self.delay_save = False
        self.save_requested = threading.Event()
        self.release_save = threading.Event()
        self.save_completed = threading.Event()
        self.project_requested = threading.Event()
        self.release_project = threading.Event()
        self.job = dict(id=JOB, projectId=PROJECT, baseVersion=1, status='running',
                        applicationMode='automatic', appliedVersion=None, applicationError=None,
                        events=[], result=None, createdAt='2026-01-01T00:00:00.000Z',
                        updatedAt='2026-01-01T00:00:00.000Z', costMicros=0, reservedMicros=500000,
                        model='fixture-model', modelLabel='Fixture model', credits={'amount': 0, 'state': 'not-used'})
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
                self.wfile.write(raw)

            def do_GET(self):
                parsed = urlparse(self.path)
                path = parsed.path
                if not path.startswith('/api/'):
                    return super().do_GET()
                if path == f'/api/projects/{PROJECT}' and fixture.delay_project:
                    fixture.project_requested.set()
                    fixture.release_project.wait(timeout=10)
                    fixture.delay_project = False
                with fixture.lock:
                    if path == '/api/session':
                        return self.send_json({'user': {'id': fixture.user_id, 'displayName': 'Browser tester', 'density': 'comfortable'}, 'csrf': 'fixture-csrf'})
                    if path == '/api/studio/session':
                        return self.send_json({'owner': fixture.admin, 'permissions': (['settings:manage', 'audit:read'] if fixture.admin_models else ['audit:read']) if fixture.admin else [], 'workerReady': True, 'tools': [{'id': 'ai-script-generator', 'enabled': True}]})
                    if path == '/api/studio/models':
                        return self.send_json({'models': fixture.models, 'defaultModelId': fixture.models[0]['id'], 'pricingVersion': 1, 'creditsEnabled': False, 'wallet': {'available': 0, 'reserved': 0, 'pending': 0}})
                    if path == f'/api/projects/{PROJECT}':
                        return self.send_json({'project': fixture.project()})
                    if path == f'/api/projects/{PROJECT}/jobs':
                        return self.send_json({'jobs': [fixture.job]})
                    if path == f'/api/jobs/{JOB}':
                        return self.send_json({'job': fixture.job})
                    if path == f'/api/projects/{PROJECT}/revisions':
                        query = parse_qs(parsed.query)
                        if 'version' in query:
                            version = int(query['version'][0])
                            return self.send_json({'project': fixture.project(version)})
                        return self.send_json({'revisions': [{'version': version, 'summary': 'Fixture revision', 'createdAt': '2026-01-01T00:00:00.000Z'} for version in sorted(fixture.revisions, reverse=True)]})
                    if path == '/api/admin/models':
                        return self.send_json(fixture.admin_config)
                    if path == '/api/admin/credits/pending':
                        return self.send_json({'items': []})
                    if path == '/api/admin/settings':
                        return self.send_json({'settings': {'guildId': '', 'roleMappings': {}, 'model': '', 'version': 1, 'maxBudgetMicros': 500000}, 'permissions': [], 'workerReady': True})
                    if path == '/api/admin/audit':
                        return self.send_json({'items': [], 'next': None})
                    if path == '/api/projects':
                        return self.send_json({'projects': [fixture.project()]})
                    return self.send_json({'error': 'Unexpected fixture request: ' + path}, 404)

            def do_POST(self):
                with fixture.lock:
                    fixture.applies += 1
                return self.send_json({'error': 'No browser apply call is expected.'}, 500)

            def do_PATCH(self):
                body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))))
                with fixture.lock:
                    fixture.saved_catalog = body
                    fixture.admin_config.update(body)
                return self.send_json(fixture.admin_config)

            def do_PUT(self):
                body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))))
                if fixture.delay_save:
                    fixture.save_requested.set()
                    fixture.release_save.wait(timeout=10)
                with fixture.lock:
                    if body['version'] != fixture.version:
                        return self.send_json({'error': 'Source changed.'}, 409)
                    fixture.files = [file for file in fixture.files if file['path'] != body['path']]
                    fixture.files.append({'path': body['path'], 'content': body['content']})
                    fixture.version += 1
                    fixture.saves += 1
                    fixture.revisions[fixture.version] = copy.deepcopy(fixture.files)
                    self.send_json({'project': fixture.project()})
                    fixture.save_completed.set()

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f'http://127.0.0.1:{self.server.server_port}/workspace.html#project/{PROJECT}'

    def project(self, version=None):
        version = self.version if version is None else version
        return dict(id=PROJECT, name='Browser project', tool_id='ai-script-generator', target='Standalone',
                    requirements='Fixture source', version=version, archived=False,
                    files=copy.deepcopy(self.revisions[version]), updated_at='2026-01-01T00:00:00.000Z')

    def complete(self, files):
        with self.lock:
            self.files = copy.deepcopy(files)
            self.version += 1
            self.revisions[self.version] = copy.deepcopy(files)
            self.job.update(status='applied', appliedVersion=self.version,
                            result={'files': files, 'summary': 'Validated fixture output', 'checks': ['Fixture syntax passed.']},
                            updatedAt='2026-01-01T00:00:01.000Z')

    def close(self):
        self.release_project.set()
        self.release_save.set()
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
        self.page.add_init_script('const originalInterval=window.setInterval; window.setInterval=(fn,ms,...args)=>originalInterval(fn,ms===4000?80:ms,...args);')
        self.errors = []
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))

    def tearDown(self):
        self.context.close()
        self.fixture.close()
        self.assertEqual(self.errors, [])

    def open(self):
        self.page.goto(self.fixture.url)
        expect(self.page.locator('#editor-view')).to_be_visible()

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
