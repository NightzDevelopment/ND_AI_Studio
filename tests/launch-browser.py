"""Real local HTTP/SQLite user journeys; external OAuth/provider/validator are fixtures.
Run after npm run build with the Python environment in docs/BROWSER_TESTS.md.
"""
import json
import os
from pathlib import Path
import select
import shutil
import subprocess
import time
import unittest
from urllib.parse import parse_qs, urlencode, urlparse

try:
    from playwright.sync_api import sync_playwright, expect
except ModuleNotFoundError as failure:
    if failure.name not in ('playwright', 'playwright.sync_api'):
        raise
    raise SystemExit('Browser checks require Python Playwright in this interpreter. Install tests/browser-requirements.txt in an isolated environment and run with its Python. See docs/BROWSER_TESTS.md.') from None

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = Path(os.environ.get('ND_QA_ARTIFACTS', '/tmp/nd-studio-launch-artifacts'))


class LaunchJourneys(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        ARTIFACTS.mkdir(parents=True, exist_ok=True)
        cls.playwright = sync_playwright().start()
        executable = os.environ.get('CHROMIUM_PATH') or shutil.which('chromium') or shutil.which('chromium-browser')
        cls.browser = cls.playwright.chromium.launch(**({'executable_path': executable} if executable else {}), headless=True)
        cls.evidence = []

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        (ARTIFACTS / 'journeys.json').write_text(json.dumps(cls.evidence, indent=2))

    def setUp(self):
        # Each journey has its own SQLite database, sessions and rate-limit budget.
        # Keep the real application's limits instead of weakening them for a fast suite.
        self.stderr = (ARTIFACTS / (self._testMethodName + '-server.log')).open('w+')
        self.server = subprocess.Popen(
            ['node', 'tests/fixtures/launch-app.mjs'], cwd=ROOT,
            env={**os.environ, 'ND_QA_PORT': '0'}, stdout=subprocess.PIPE,
            stderr=self.stderr, text=True,
        )
        self.metadata = None
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if self.server.poll() is not None:
                break
            ready, _, _ = select.select([self.server.stdout], [], [], .2)
            if ready:
                line = self.server.stdout.readline()
                if line.startswith('ND_QA_READY '):
                    self.metadata = json.loads(line.removeprefix('ND_QA_READY '))
                    break
        if self.metadata is None:
            self.stop_server()
            self.stderr.seek(0)
            raise RuntimeError('Local QA app did not start: ' + self.stderr.read())
        self.origin = self.metadata['origin']
        self.context = self.browser.new_context(viewport={'width': 1440, 'height': 1000}, accept_downloads=True)
        self.page = self.context.new_page()
        self.page.set_default_timeout(12000)
        self.page_errors = []
        self.console_errors = []
        self.failed_requests = []
        self.failed_responses = []
        self.expected_http_errors = set()
        self.verified_downloads = set()
        self.page.on('pageerror', lambda error: self.page_errors.append(str(error)))
        self.page.on('console', lambda message: self.console_errors.append(message.text) if message.type == 'error' else None)
        self.page.on('requestfailed', lambda request: self.failed_requests.append({'url': request.url, 'failure': request.failure}))
        self.page.on('response', lambda response: self.failed_responses.append({'path': urlparse(response.url).path, 'status': response.status}) if response.status >= 400 else None)

    def tearDown(self):
        requests = [json.loads(line) for line in Path(self.metadata['log']).read_text().splitlines()]
        self.evidence.append({'journey': self.id(), 'pageErrors': self.page_errors,
                              'consoleErrors': self.console_errors, 'failedRequests': self.failed_requests,
                              'httpErrors': self.failed_responses, 'serverRequests': requests})
        self.context.close()
        self.stop_server()
        self.stderr.close()
        self.assertEqual(self.page_errors, [])
        self.assertEqual([response for response in self.failed_responses
                          if (response['path'], response['status']) not in self.expected_http_errors], [])
        # Chromium reports a navigation handed to its download manager as ERR_ABORTED.
        # Allow it only after this test has actually read and verified that download.
        self.assertEqual([request for request in self.failed_requests
                          if not (request['failure'] == 'net::ERR_ABORTED' and urlparse(request['url']).path in self.verified_downloads)], [])
        self.assertEqual([error for error in self.console_errors
                          if not (self.expected_http_errors and error.startswith('Failed to load resource: the server responded with a status of '))], [])
        self.assertEqual([request for request in requests if request['status'] >= 500], [])

    def stop_server(self):
        self.server.terminate()
        try:
            self.server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.server.kill()
            self.server.wait(timeout=5)
        self.server.stdout.close()

    def login(self, identity='owner', context=None, page=None):
        context, page = context or self.context, page or self.page
        flow = context.request.get(self.origin + '/auth/discord', max_redirects=0)
        self.assertEqual(flow.status, 303)
        state = parse_qs(urlparse(flow.headers['location']).query)['state'][0]
        page.goto(self.origin + '/auth/discord/callback?' + urlencode({'state': state, 'code': identity, 'iss': 'https://discord.com'}))
        expect(page.locator('#profile-form')).to_be_visible()

    def api(self, path, method='GET', body=None, page=None):
        return (page or self.page).evaluate('''async ({path,method,body}) => {
          const session=await (await fetch('/api/session')).json();
          const response=await fetch(path,{method,headers:body===null?{}:{'content-type':'application/json','x-csrf-token':session.csrf},body:body===null?undefined:JSON.stringify(body)});
          const data=await response.json();return {status:response.status,data};
        }''', {'path': path, 'method': method, 'body': body})

    def project(self, label, identity='owner'):
        self.login(identity)
        self.page.goto(self.origin + '/workspace.html#projects')
        expect(self.page.locator('#dashboard')).to_be_visible()
        self.page.locator('#new-project').click()
        dialog = self.page.locator('#project-dialog')
        dialog.locator('[name=name]').fill(label)
        dialog.locator('[name=requirements]').fill('A synthetic local QA resource with a README and command.')
        dialog.locator('[type=submit]').click()
        expect(self.page.locator('#editor-view')).to_be_visible()
        return self.page.url.split('#project/')[1]

    def new_file(self, path='client/manual.lua', content='print("original")'):
        self.page.locator('#new-file').click()
        self.page.locator('#file-form [name=path]').fill(path)
        self.page.locator('#file-form [type=submit]').click()
        expect(self.page.locator('#file-dialog')).to_be_hidden()
        expect(self.page.locator('#file-label')).to_have_text(path)
        self.page.locator('#code-editor').fill(content)
        self.page.locator('#save-file').click()
        expect(self.page.locator('#save-status')).to_contain_text('Saved revision')

    def build(self, prompt='Create the QA fixture resource.'):
        self.page.locator('#build-prompt').fill(prompt)
        self.page.locator('#generate-button').click()
        self.page.get_by_role('dialog').filter(has_text='Confirm model and build cost').get_by_role('button', name='Start build', exact=True).click()
        expect(self.page.locator('#build-state')).not_to_have_text('Idle')

    def screenshot(self, name):
        self.page.evaluate('window.scrollTo(0, 0)')
        self.page.screenshot(path=str(ARTIFACTS / name), full_page=True)

    def test_01_profile_persists_and_exports_through_real_api(self):
        self.login('member')
        form = self.page.locator('#profile-form')
        form.locator('[name=displayName]').fill('QA Member Updated')
        form.locator('[name=bio]').fill('Local browser QA profile; synthetic data.')
        form.locator('[type=submit]').click()
        expect(self.page.locator('#profile-name')).to_have_text('QA Member Updated')
        self.page.reload()
        expect(self.page.locator('#profile-form [name=bio]')).to_have_value('Local browser QA profile; synthetic data.')
        with self.page.expect_download() as download:
            self.page.locator('#account-export').click()
        data = json.loads(Path(download.value.path()).read_text())
        self.assertIn('QA Member Updated', json.dumps(data))
        self.assertNotIn('csrf', json.dumps(data).lower())
        self.screenshot('account-desktop.png')

    def test_02_editor_revision_restore_and_zip_use_real_sqlite(self):
        project = self.project('QA revision workflow')
        self.new_file()
        saved = self.api(f'/api/projects/{project}')['data']['project']
        self.assertEqual(saved['files'][0]['content'], 'print("original")')
        self.page.locator('#code-editor').fill('print("updated")')
        self.page.locator('#save-file').click()
        expect(self.page.locator('#save-status')).to_contain_text('Saved revision')
        self.page.reload()
        expect(self.page.locator('#code-editor')).to_have_value('print("updated")')
        self.page.locator('#history-button').click()
        revisions = self.page.locator('#revision-list .revision')
        revisions.filter(has_text='Revision ' + str(saved['version'])).get_by_role('button', name='Restore', exact=True).click()
        self.page.get_by_role('dialog').filter(has_text='Restore this revision?').get_by_role('button', name='Restore revision', exact=True).click()
        expect(self.page.locator('#code-editor')).to_have_value('print("original")')
        with self.page.expect_download() as download:
            self.page.locator('#export-project').click()
        self.assertEqual(Path(download.value.path()).read_bytes()[:4], b'PK\x03\x04')
        self.verified_downloads.add(f'/api/projects/{project}/export')
        self.screenshot('editor-desktop.png')

    def test_03_build_auto_saves_once_and_charges_once(self):
        project = self.project('QA automatic build')
        before = self.api('/api/studio/credits')['data']['wallet']['balance']
        self.build()
        expect(self.page.locator('#build-state')).to_have_text('Completed', timeout=20000)
        expect(self.page.locator('#file-list')).to_contain_text('client/main.lua')
        result = self.api(f'/api/projects/{project}')['data']['project']
        self.assertEqual(result['version'], 2)
        self.assertEqual(self.api('/api/studio/credits')['data']['wallet']['balance'], before - 5)
        self.page.reload()
        expect(self.page.locator('#build-state')).to_have_text('Completed')
        self.assertEqual(self.api(f'/api/projects/{project}')['data']['project']['version'], 2)
        with self.page.expect_download() as download:
            self.page.locator('#download-build').click()
        self.assertIn(b'client/main.lua', Path(download.value.path()).read_bytes())
        self.verified_downloads.add(urlparse(download.value.url).path)
        self.screenshot('completed-build-desktop.png')

    def test_04_failed_build_retains_source_and_releases_known_zero_usage(self):
        project = self.project('QA failed provider')
        self.new_file()
        before = self.api('/api/studio/credits')['data']['wallet']
        self.build('[fail] Simulate a provider fixture failure.')
        expect(self.page.locator('#build-state')).to_have_text('failed', timeout=20000)
        expect(self.page.locator('#build-log')).to_contain_text('QA provider fixture failure')
        self.assertEqual(self.api(f'/api/projects/{project}')['data']['project']['files'][0]['content'], 'print("original")')
        self.assertEqual(self.api('/api/studio/credits')['data']['wallet']['available'], before['available'])
        expect(self.page.locator('#generate-button')).to_be_enabled()

    def test_05_build_conflict_keeps_newer_source_and_finished_zip(self):
        project = self.project('QA build conflict')
        self.new_file()
        self.build('[slow] Generate while a newer manual revision is saved.')
        self.page.locator('#code-editor').fill('print("newer manual source")')
        self.page.locator('#save-file').click()
        expect(self.page.locator('#save-status')).to_contain_text('Saved revision')
        expect(self.page.locator('#build-log')).to_contain_text('Finished output is preserved', timeout=20000)
        self.assertEqual(self.api(f'/api/projects/{project}')['data']['project']['files'][0]['content'], 'print("newer manual source")')
        with self.page.expect_download() as download:
            self.page.locator('#download-build').click()
        self.assertIn(b'client/main.lua', Path(download.value.path()).read_bytes())
        self.verified_downloads.add(urlparse(download.value.url).path)

    def test_06_private_project_has_recoverable_permission_error(self):
        project = self.project('QA private owner project')
        self.context.clear_cookies()
        self.login('other')
        self.expected_http_errors.add((f'/api/projects/{project}', 404))
        self.page.goto(self.origin + '/workspace.html#project/' + project)
        expect(self.page.locator('#error')).to_contain_text('Project not found')
        expect(self.page.locator('#login')).to_be_hidden()
        self.page.get_by_role('link', name='Back to projects', exact=True).click()
        expect(self.page.locator('#dashboard')).to_be_visible()

    def test_07_expired_session_preserves_drafts_for_same_account(self):
        project = self.project('QA session recovery')
        self.new_file()
        self.page.locator('#code-editor').fill('print("recover this unsaved source")')
        other = self.browser.new_context()
        other_page = other.new_page()
        try:
            self.login('owner', other, other_page)
            self.assertEqual(self.api('/api/logout-all', 'POST', {}, other_page)['status'], 200)
            self.expected_http_errors.add((f'/api/projects/{project}/files', 401))
            self.page.locator('#save-file').click()
            expect(self.page.locator('#login')).to_be_visible()
            self.login('owner')
            self.page.goto(self.origin + '/workspace.html#project/' + project)
            expect(self.page.locator('#code-editor')).to_have_value('print("recover this unsaved source")')
        finally:
            other.close()

    def test_08_responsive_pages_keep_actions_and_dialogs_inside_viewport(self):
        self.project('QA responsive source')
        self.new_file()
        for width, height in [(1440, 1000), (834, 1112), (390, 844), (320, 740)]:
            self.page.set_viewport_size({'width': width, 'height': height})
            self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), width)
            if self.page.locator('button[data-panel=files]').is_visible():
                self.page.locator('button[data-panel=files]').click()
            self.page.locator('#new-file').click()
            dialog = self.page.locator('#file-dialog')
            box = dialog.bounding_box()
            self.assertGreaterEqual(box['x'], -1)
            self.assertLessEqual(box['x'] + box['width'], width + 1)
            self.assertLessEqual(box['height'], height + 1)
            self.page.keyboard.press('Escape')
            if self.page.locator('button[data-panel=editor]').is_visible():
                self.page.locator('button[data-panel=editor]').click()
            self.screenshot(f'editor-{width}.png')

    def test_09_mobile_navigation_and_catalog_recover_from_empty_search(self):
        self.login('member')
        self.page.set_viewport_size({'width': 390, 'height': 844})
        self.page.goto(self.origin + '/')
        expect(self.page.locator('#tool-grid .tool-card')).to_have_count(2)
        menu = self.page.locator('[data-navigation-toggle]')
        menu.click()
        expect(menu).to_have_attribute('aria-expanded', 'true')
        self.page.keyboard.press('Escape')
        expect(menu).to_be_focused()
        expect(menu).to_have_attribute('aria-expanded', 'false')
        menu.click()
        self.page.locator('#account-button').focus()
        self.page.keyboard.press('Enter')
        expect(self.page.locator('#account-button')).to_have_attribute('aria-expanded', 'true')
        expect(menu).to_have_attribute('aria-expanded', 'true')
        self.page.keyboard.press('Escape')
        expect(self.page.locator('#account-button')).to_be_focused()
        expect(self.page.locator('#account-button')).to_have_attribute('aria-expanded', 'false')
        expect(menu).to_have_attribute('aria-expanded', 'true')
        self.page.keyboard.press('Escape')
        expect(menu).to_be_focused()
        expect(menu).to_have_attribute('aria-expanded', 'false')
        menu.click()
        self.page.locator('#navigation a[href="#tools"]').click()
        expect(menu).to_have_attribute('aria-expanded', 'false')
        expect(self.page.locator('main')).to_be_focused()
        expect(self.page.locator('#tool-grid .tool-card')).to_have_count(24)
        self.page.locator('#search').fill('no matching synthetic tool')
        expect(self.page.locator('#no-tools')).to_be_visible()
        self.page.locator('#search').fill('')
        expect(self.page.locator('#tool-grid .tool-card')).to_have_count(24)
        self.page.screenshot(path=str(ARTIFACTS / 'catalog-mobile.png'), full_page=True)
        menu.click()
        self.page.set_viewport_size({'width': 1440, 'height': 1000})
        expect(menu).to_be_hidden()
        expect(self.page.locator('#navigation')).to_be_visible()
        self.page.set_viewport_size({'width': 390, 'height': 844})
        expect(menu).to_have_attribute('aria-expanded', 'false')

    def test_10_owner_controls_and_member_denial_use_real_permissions(self):
        self.login('owner')
        self.page.goto(self.origin + '/workspace.html#admin')
        expect(self.page.locator('#admin-content')).to_contain_text('QA Member')
        self.page.get_by_role('tab', name='Models & credits', exact=True).click()
        expect(self.page.locator('#admin-content')).to_contain_text('QA coding fixture')
        self.page.get_by_role('tab', name='Audit log', exact=True).click()
        expect(self.page.locator('#admin-content table')).to_be_visible()
        for width in [1440, 834, 390, 320]:
            self.page.set_viewport_size({'width': width, 'height': 900})
            self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), width)
        self.screenshot('admin-mobile.png')
        self.context.clear_cookies()
        self.login('member')
        self.page.goto(self.origin + '/workspace.html#admin')
        expect(self.page.locator('#admin-nav')).to_be_hidden()
        expect(self.page.locator('#route-error')).to_contain_text('no administration permissions')
        self.expected_http_errors.add(('/api/admin/users', 403))
        self.assertEqual(self.api('/api/admin/users')['status'], 403)
        self.page.locator('#back-to-projects').click()
        expect(self.page.locator('#dashboard')).to_be_visible()

    def test_11_project_loading_and_transient_failure_have_retry(self):
        self.login('other')
        self.page.route('**/api/projects', lambda route: route.fulfill(status=503, content_type='application/json', body='{"error":"QA temporary outage."}'))
        self.expected_http_errors.add(('/api/projects', 503))
        self.page.goto(self.origin + '/workspace.html#projects')
        expect(self.page.locator('#route-error')).to_contain_text('QA temporary outage')
        expect(self.page.locator('#login')).to_be_hidden()
        self.page.unroute('**/api/projects')
        self.page.locator('#retry-workspace').click()
        expect(self.page.locator('#dashboard')).to_be_visible()
        expect(self.page.locator('#project-grid')).to_contain_text('Your next build starts here')
        self.page.set_viewport_size({'width': 390, 'height': 844})
        self.screenshot('empty-projects-mobile.png')

    def test_12_brief_crud_replay_export_and_account_isolation_use_real_sqlite(self):
        self.login('member')
        self.page.goto(self.origin + '/#projects')
        submitted = []
        self.page.on('request', lambda request: submitted.append(json.loads(request.post_data))
                     if request.method == 'POST' and urlparse(request.url).path == '/api/briefs' else None)
        self.page.locator('#new-brief').click()
        self.page.locator('#brief-form [name=name]').fill('QA persistent brief')
        self.page.locator('#brief-form [name=requirements]').fill('Synthetic requirements for persistence and safe replay.')
        self.page.locator('#brief-form [type=submit]').click()
        expect(self.page.locator('#brief-dialog')).not_to_be_visible()
        expect(self.page.locator('#project-count')).to_have_text('1 saved to your account')
        original = self.api('/api/briefs')['data']['briefs'][0]
        create_body = submitted[0]
        self.assertTrue(create_body.get('requestId'))
        self.page.reload()
        self.page.get_by_role('button', name='Edit: QA persistent brief', exact=True).click()
        self.page.locator('#brief-form [name=name]').fill('QA edited brief')
        self.page.locator('#brief-form [type=submit]').click()
        expect(self.page.get_by_role('button', name='Edit: QA edited brief', exact=True)).to_be_visible()
        replay = self.api('/api/briefs', 'POST', create_body)
        self.assertEqual(replay['status'], 200)
        self.assertTrue(replay['data']['replayed'])
        self.assertFalse(replay['data']['deleted'])
        self.assertEqual(replay['data']['briefId'], original['id'])
        self.assertEqual(replay['data']['briefs'][0]['name'], 'QA edited brief')
        self.assertEqual(len(replay['data']['briefs']), 1)
        self.expected_http_errors.add(('/api/briefs', 409))
        self.assertEqual(self.api('/api/briefs', 'POST', {**create_body, 'name': 'Changed replay'})['status'], 409)
        with self.page.expect_download() as download:
            self.page.get_by_role('button', name='Export JSON: QA edited brief', exact=True).click()
        exported = json.loads(Path(download.value.path()).read_text())
        self.assertEqual(exported['brief']['id'], original['id'])
        self.assertEqual(exported['brief']['name'], 'QA edited brief')
        other = self.browser.new_context()
        other_page = other.new_page()
        try:
            self.login('other', other, other_page)
            other_page.goto(self.origin + '/#projects')
            expect(other_page.locator('#project-count')).to_have_text('0 saved to your account')
            self.assertEqual(self.api('/api/briefs/' + original['id'], 'DELETE', {'version': 2}, other_page)['status'], 404)
            independent = self.api('/api/briefs', 'POST', create_body, other_page)
            self.assertEqual(independent['status'], 201)
            self.assertNotEqual(independent['data']['briefId'], original['id'])
        finally:
            other.close()
        self.page.get_by_role('button', name='Delete: QA edited brief', exact=True).click()
        self.page.locator('dialog[open]').get_by_role('button', name='Delete', exact=True).click()
        expect(self.page.locator('#project-count')).to_have_text('0 saved to your account')
        deleted = self.api('/api/briefs', 'POST', create_body)
        self.assertEqual(deleted['status'], 200)
        self.assertTrue(deleted['data']['replayed'])
        self.assertTrue(deleted['data']['deleted'])
        self.assertEqual(deleted['data']['briefId'], original['id'])
        self.assertEqual(deleted['data']['briefs'], [])
        self.page.reload()
        expect(self.page.locator('#project-count')).to_have_text('0 saved to your account')

    def test_13_lost_brief_acknowledgement_and_deleted_receipt_have_safe_browser_recovery(self):
        self.login('member')
        self.page.goto(self.origin + '/#projects')
        submitted = []
        self.page.on('request', lambda request: submitted.append(json.loads(request.post_data))
                     if request.method == 'POST' and urlparse(request.url).path == '/api/briefs' else None)
        lose_next = {'value': True}
        self.expected_http_errors.add(('/api/briefs', 502))

        def lose_acknowledgement(route):
            if route.request.method != 'POST':
                return route.continue_()
            response = route.fetch()
            if lose_next['value']:
                lose_next['value'] = False
                return route.fulfill(status=502, content_type='text/html',
                                     body='<html>QA acknowledgement loss after the actual SQLite commit.</html>')
            return route.fulfill(response=response)

        self.page.route('**/api/briefs', lose_acknowledgement)
        self.page.locator('#new-brief').click()
        self.page.locator('#brief-form [name=name]').fill('QA lost acknowledgement')
        self.page.locator('#brief-form [name=requirements]').fill('Confirm one real brief after losing the successful response.')
        self.page.locator('#brief-form [type=submit]').click()
        expect(self.page.locator('#form-error')).to_contain_text('unexpected response')
        self.assertEqual(len(self.api('/api/briefs')['data']['briefs']), 1)
        self.page.locator('#brief-form [type=submit]').click()
        expect(self.page.locator('#brief-dialog')).not_to_be_visible()
        self.assertEqual(submitted[0]['requestId'], submitted[1]['requestId'])
        self.assertEqual(len(self.api('/api/briefs')['data']['briefs']), 1)
        lose_next['value'] = True
        self.page.locator('#new-brief').click()
        self.page.locator('#brief-form [name=name]').fill('QA deleted after acknowledgement loss')
        self.page.locator('#brief-form [name=requirements]').fill('Keep this form and identify a previously deleted result without recreating it automatically.')
        self.page.locator('#brief-form [type=submit]').click()
        expect(self.page.locator('#form-error')).to_contain_text('unexpected response')
        rows = self.api('/api/briefs')['data']['briefs']
        original = next(row for row in rows if row['name'] == 'QA deleted after acknowledgement loss')
        self.assertEqual(self.api('/api/briefs/' + original['id'], 'DELETE', {'version': original['version']})['status'], 200)
        self.page.locator('#brief-form [type=submit]').click()
        expect(self.page.locator('#form-error')).to_contain_text('earlier saved brief was deleted')
        expect(self.page.locator('#brief-dialog')).to_be_visible()
        expect(self.page.locator('#brief-form [name=name]')).to_have_value('QA deleted after acknowledgement loss')
        self.assertEqual(submitted[2]['requestId'], submitted[3]['requestId'])
        self.assertEqual(len(self.api('/api/briefs')['data']['briefs']), 1)
        self.page.locator('#brief-form [type=submit]').click()
        expect(self.page.locator('#brief-dialog')).not_to_be_visible()
        self.assertNotEqual(submitted[3]['requestId'], submitted[4]['requestId'])
        final_rows = self.api('/api/briefs')['data']['briefs']
        self.assertEqual(len(final_rows), 2)
        replacement = next(row for row in final_rows if row['name'] == original['name'])
        self.assertNotEqual(replacement['id'], original['id'])
        self.page.reload()
        expect(self.page.locator('#project-count')).to_have_text('2 saved to your account')


    def test_14_running_cancellation_preserves_source_and_owner_can_release_hold(self):
        project = self.project('QA cancelled build')
        self.new_file()
        before = self.api('/api/studio/credits')['data']['wallet']
        self.build('[cancel] Hold the synthetic provider request until cancellation.')
        expect(self.page.locator('#build-state')).to_have_text('running', timeout=15000)
        self.page.locator('#cancel-build').click()
        self.page.get_by_role('dialog').filter(has_text='Cancel this build?').get_by_role('button', name='Cancel build', exact=True).click()
        expect(self.page.locator('#build-state')).to_have_text('cancelled')
        expect(self.page.locator('#generate-button')).to_be_enabled()
        wallet = self.api('/api/studio/credits')['data']['wallet']
        self.assertEqual(wallet['pending'], 5)
        self.assertEqual(wallet['balance'], before['balance'])
        self.assertEqual(self.api(f'/api/projects/{project}')['data']['project']['files'][0]['content'], 'print("original")')
        self.page.goto(self.origin + '/workspace.html#admin')
        self.page.get_by_role('tab', name='Models & credits', exact=True).click()
        hold = self.page.locator('.credit-hold').filter(has_text='QA cancelled build')
        expect(hold).to_contain_text('5 credits held')
        hold.get_by_role('button', name='Release hold', exact=True).click()
        dialog = self.page.get_by_role('dialog').filter(has_text='Release hold')
        dialog.locator('[name=reason]').fill('Synthetic QA cancellation reviewed; no external spending occurred.')
        dialog.get_by_role('button', name='Confirm', exact=True).click()
        expect(hold).to_have_count(0)
        released = self.api('/api/studio/credits')['data']['wallet']
        self.assertEqual(released['pending'], 0)
        self.assertEqual(released['available'], before['available'])
        self.page.reload()
        self.page.get_by_role('tab', name='Models & credits', exact=True).click()
        expect(self.page.locator('#admin-content')).to_contain_text('No credits are awaiting review')


    def test_15_static_preview_allows_discord_avatar_images_under_its_csp(self):
        # The identity/session flow remains real. Only avatar data and its CDN
        # image are synthetic, so this test never sends a request to Discord.
        image_url = 'https://cdn.discordapp.com/avatars/100000000000000002/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png?size=128'
        self.page.route('https://cdn.discordapp.com/**', lambda route: route.fulfill(
            status=200, content_type='image/svg+xml',
            body='<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#b81732"/></svg>'))

        def avatar_session(route):
            response = route.fetch()
            data = response.json()
            if data.get('user'):
                data['user']['avatarUrl'] = image_url
            route.fulfill(response=response, json=data)

        self.page.route('**/api/session', avatar_session)
        self.login('member')
        expect(self.page.locator('#profile-avatar img')).to_be_visible()
        self.page.wait_for_function('document.querySelector("#profile-avatar img")?.naturalWidth > 0')
        self.assertEqual(self.page.locator('#profile-avatar img').get_attribute('src'), image_url)


    def test_16_delayed_real_rename_never_replaces_another_projects_unsaved_source(self):
        project_a=self.project('Real race project A')
        self.new_file('client/manual.lua','print("project A")')
        result=self.api('/api/projects','POST',{'name':'Real race project B','requirements':'Second private source project','toolId':'ai-script-generator','target':'Standalone'})
        self.assertEqual(result['status'],201)
        project_b=result['data']['project']['id']
        seeded=self.api(f'/api/projects/{project_b}/files','PUT',{'version':1,'path':'client/manual.lua','content':'print("project B")'})
        self.assertEqual(seeded['status'],200)
        held=[]
        def hold_rename(route):
            if route.request.method=='PUT' and 'renameTo' in route.request.post_data_json:
                response=route.fetch()
                self.assertEqual(response.status,200)
                held.append((route,response))
                self.page.evaluate('window.__qaRenameHeld = true')
            else:
                route.continue_()
        self.page.route(f'**/api/projects/{project_a}/files',hold_rename)
        self.page.locator('#rename-file').click()
        self.page.locator('#file-form [name=path]').fill('client/renamed.lua')
        self.page.locator('#file-form [type=submit]').click()
        self.page.wait_for_function('window.__qaRenameHeld === true')
        self.assertEqual(len(held),1)
        self.page.locator('#file-dialog [data-close]').first.click()
        self.page.evaluate('(id)=>location.hash="project/"+id',project_b)
        expect(self.page.locator('#project-name')).to_have_text('Real race project B')
        self.page.locator('#code-editor').fill('print("unsaved B remains private")')
        with self.page.expect_response(lambda response: response.request.method == 'PUT' and urlparse(response.url).path == f'/api/projects/{project_a}/files') as acknowledgement:
            held[0][0].fulfill(response=held[0][1])
        self.assertEqual(acknowledgement.value.json()['project']['files'][0]['path'], 'client/renamed.lua')
        self.page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
        expect(self.page.locator('#project-name')).to_have_text('Real race project B')
        expect(self.page.locator('#code-editor')).to_have_value('print("unsaved B remains private")')
        self.assertEqual(self.api(f'/api/projects/{project_a}')['data']['project']['files'][0]['path'],'client/renamed.lua')
        self.assertEqual(self.api(f'/api/projects/{project_b}')['data']['project']['files'][0]['content'],'print("project B")')

    def test_17_real_revision_conflict_refreshes_saved_source_and_keeps_explicit_draft_recovery(self):
        project=self.project('Real revision conflict recovery')
        self.new_file()
        current=self.api(f'/api/projects/{project}')['data']['project']
        self.page.locator('#code-editor').fill('print("my unsaved draft")')
        changed=self.api(f'/api/projects/{project}/files','PUT',{'version':current['version'],'path':'client/manual.lua','content':'print("external saved revision")'})
        self.assertEqual(changed['status'],200)
        self.expected_http_errors.add((f'/api/projects/{project}/files',409))
        self.page.locator('#save-file').click()
        expect(self.page.locator('#draft-notice')).to_be_visible()
        expect(self.page.locator('#code-editor')).to_have_value('print("my unsaved draft")')
        expect(self.page.locator('#save-file')).to_be_disabled()
        self.page.locator('#compare-draft').click()
        expect(self.page.locator('#draft-saved')).to_have_text('print("external saved revision")')
        expect(self.page.locator('#draft-local')).to_have_text('print("my unsaved draft")')
        self.page.locator('#save-draft').click()
        expect(self.page.locator('#draft-dialog')).to_be_hidden()
        expect(self.page.locator('#error')).to_be_hidden()
        result=self.api(f'/api/projects/{project}')['data']['project']
        self.assertEqual(result['version'],current['version']+2)
        self.assertEqual(result['files'][0]['content'],'print("my unsaved draft")')
        old=self.api(f'/api/projects/{project}/revisions?version={current["version"]+1}')['data']['project']
        self.assertEqual(old['files'][0]['content'],'print("external saved revision")')

    def test_18_real_session_revocation_still_exports_unpersistable_local_source(self):
        self.page.add_init_script("Storage.prototype.setItem=()=>{throw new DOMException('Full','QuotaExceededError');};")
        project=self.project('Real session recovery without storage')
        self.new_file()
        self.page.locator('#code-editor').fill('print("source survives expired session and full storage")')
        expect(self.page.locator('#draft-storage-warning')).to_be_visible()
        other=self.browser.new_context()
        other_page=other.new_page()
        try:
            self.login('owner',other,other_page)
            self.assertEqual(self.api('/api/logout-all','POST',{},other_page)['status'],200)
            self.expected_http_errors.add((f'/api/projects/{project}/files',401))
            self.page.locator('#save-file').click()
            expect(self.page.locator('#login')).to_be_visible()
            with self.page.expect_download() as pending:
                self.page.locator('#recover-expired-drafts').click()
            data=json.loads(Path(pending.value.path()).read_text())
            self.assertEqual(data['files'][0]['content'],'print("source survives expired session and full storage")')
            self.assertEqual(set(data),{'projectId','files'})
            self.assertEqual(data['projectId'],project)
            self.login('owner',other,other_page)
            self.assertEqual(self.api(f'/api/projects/{project}',page=other_page)['data']['project']['files'][0]['content'],'print("original")')
        finally:
            other.close()


    def test_19_model_catalog_and_internal_credit_adjustment_persist(self):
        self.login('owner')
        self.page.goto(self.origin + '/workspace.html#admin')
        self.page.get_by_role('tab', name='Models & credits', exact=True).click()
        self.page.locator('.model-card summary').click()
        self.page.locator('.model-card [name=label]').fill('QA revised coding model')
        self.page.locator('.model-card [name=creditsPerBuild]').fill('7')
        self.page.get_by_role('button', name='Save model catalog', exact=True).click()
        expect(self.page.locator('#toast')).to_contain_text('Model catalog saved')
        self.page.reload()
        self.page.get_by_role('tab', name='Models & credits', exact=True).click()
        expect(self.page.locator('.model-card summary')).to_have_text('QA revised coding model')
        self.page.locator('.model-card summary').click()
        expect(self.page.locator('.model-card [name=creditsPerBuild]')).to_have_value('7')
        self.page.locator('[name=discordId]').fill('100000000000000002')
        self.page.get_by_role('button', name='Load account', exact=True).click()
        expect(self.page.locator('#admin-content')).to_contain_text('QA Member')
        self.page.locator('[name=amount]').fill('9')
        self.page.locator('#admin-content [name=reason]').fill('Synthetic QA internal allowance; no purchase or external payment.')
        self.page.get_by_role('button', name='Apply credit adjustment', exact=True).click()
        self.page.get_by_role('dialog').filter(has_text='Adjust this credit balance?').get_by_role('button', name='Apply adjustment', exact=True).click()
        expect(self.page.locator('#toast')).to_contain_text('Credit adjustment recorded')
        wallet = self.api('/api/admin/credits?discordId=100000000000000002')['data']
        self.assertEqual(wallet['wallet']['balance'], 109)
        self.assertEqual(len([item for item in wallet['items'] if item['kind'] == 'adjustment' and item['delta'] == 9]), 1)
        self.page.reload()
        self.page.get_by_role('tab', name='Models & credits', exact=True).click()
        self.page.locator('[name=discordId]').fill('100000000000000002')
        self.page.get_by_role('button', name='Load account', exact=True).click()
        expect(self.page.locator('#admin-content')).to_contain_text('109 available')
        self.page.set_viewport_size({'width': 390, 'height': 844})
        self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), 390)
        self.screenshot('models-and-credits-mobile.png')

    def test_20_changed_build_price_requires_a_new_confirmation_before_spending(self):
        project = self.project('QA current price confirmation')
        before = self.api('/api/studio/credits')['data']['wallet']['balance']
        self.page.locator('#build-prompt').fill('Generate a synthetic fixture after reconfirming the price.')
        self.page.locator('#generate-button').click()
        confirmation = self.page.get_by_role('dialog').filter(has_text='Confirm model and build cost')
        expect(confirmation).to_contain_text('5 Studio credits')
        config = self.api('/api/admin/models')['data']
        updated_models = [{**model, 'creditsPerBuild': 7} for model in config['models']]
        changed = self.api('/api/admin/models', 'PATCH', {'version': config['version'], 'models': updated_models,
                         'defaultModelId': config['defaultModelId'], 'creditsEnabled': config['creditsEnabled']})
        self.assertEqual(changed['status'], 200)
        self.expected_http_errors.add((f'/api/projects/{project}/jobs', 409))
        confirmation.get_by_role('button', name='Start build', exact=True).click()
        expect(self.page.locator('#error')).to_contain_text('Model pricing changed')
        expect(self.page.locator('#generate-button')).to_be_enabled()
        self.assertEqual(self.api(f'/api/projects/{project}/jobs')['data']['jobs'], [])
        self.assertEqual(self.api('/api/studio/credits')['data']['wallet']['available'], before)
        self.page.locator('#generate-button').click()
        confirmation = self.page.get_by_role('dialog').filter(has_text='Confirm model and build cost')
        expect(confirmation).to_contain_text('7 Studio credits')
        confirmation.get_by_role('button', name='Start build', exact=True).click()
        expect(self.page.locator('#build-state')).to_have_text('Completed', timeout=20000)
        self.assertEqual(self.api('/api/studio/credits')['data']['wallet']['balance'], before - 7)
        self.assertEqual(len(self.api(f'/api/projects/{project}/jobs')['data']['jobs']), 1)
        expect(self.page.locator('#error')).to_be_hidden()

    def test_21_invalid_source_path_keeps_form_open_for_a_safe_retry(self):
        project = self.project('QA invalid path recovery')
        self.page.locator('#new-file').click()
        self.page.locator('#file-form [name=path]').fill('../private.env')
        self.expected_http_errors.add((f'/api/projects/{project}/files', 400))
        self.page.locator('#file-form [type=submit]').click()
        expect(self.page.locator('#file-form .form-error')).to_be_visible()
        expect(self.page.locator('#file-dialog')).to_be_visible()
        self.assertEqual(self.api(f'/api/projects/{project}')['data']['project']['files'], [])
        self.page.locator('#file-form [name=path]').fill('client/safe.lua')
        self.page.locator('#file-form [type=submit]').click()
        expect(self.page.locator('#file-dialog')).to_be_hidden()
        expect(self.page.locator('#file-list')).to_contain_text('client/safe.lua')
        self.page.reload()
        expect(self.page.locator('#file-list')).to_contain_text('client/safe.lua')


    def test_22_invalid_role_mapping_reaches_server_validation_without_silent_omission(self):
        self.login('owner')
        self.page.goto(self.origin + '/workspace.html#admin')
        self.page.get_by_role('tab', name='Settings', exact=True).click()
        before = self.api('/api/admin/settings')['data']['settings']
        self.page.get_by_role('button', name='+ Add role mapping', exact=True).click()
        self.page.locator('.role-row [name=role]').fill('__proto__')
        self.expected_http_errors.add(('/api/admin/settings', 400))
        with self.page.expect_response(lambda response: response.request.method == 'PATCH' and urlparse(response.url).path == '/api/admin/settings') as rejected:
            self.page.get_by_role('button', name='Save configuration', exact=True).click()
        self.assertEqual(rejected.value.status, 400)
        expect(self.page.locator('#admin-content .form-error')).to_contain_text('Invalid Discord role permissions')
        self.assertEqual(self.api('/api/admin/settings')['data']['settings']['version'], before['version'])
        self.page.locator('.role-row [name=role]').fill('100000000000000004')
        self.page.locator('.role-row input[value="users:read"]').check()
        self.page.get_by_role('button', name='Save configuration', exact=True).click()
        expect(self.page.locator('#toast')).to_contain_text('Configuration saved')
        self.page.reload()
        self.page.get_by_role('tab', name='Settings', exact=True).click()
        expect(self.page.locator('.role-row [name=role]')).to_have_value('100000000000000004')
        expect(self.page.locator('.role-row input[value="users:read"]')).to_be_checked()

    def test_23_streamed_preview_changes_before_source_save_and_final_charge_happens_once(self):
        project = self.project('QA live source preview')
        before = self.api('/api/studio/credits')['data']['wallet']['balance']
        self.build('[live] Stream the disclosed synthetic source fixture before final validation.')
        preview = self.page.locator('#live-preview-code')
        expect(preview).to_contain_text('RegisterCommand("nd_qatest"', timeout=15000)
        first = preview.text_content()
        self.assertEqual(preview.evaluate('node => node.tagName'), 'PRE')
        self.assertFalse(preview.evaluate('node => node.isContentEditable'))
        expect(self.page.locator('#live-preview-file')).to_have_value('client/main.lua')
        expect(self.page.locator('#live-preview-state')).to_be_visible()
        pending = self.api(f'/api/projects/{project}')['data']['project']
        self.assertEqual(pending['version'], 1)
        self.assertEqual(pending['files'], [])
        self.assertEqual(self.api('/api/studio/credits')['data']['wallet']['balance'], before)
        expect(preview).not_to_have_text(first, timeout=12000)
        expect(preview).to_contain_text('print("QA fixture")', timeout=12000)
        self.assertEqual(self.api(f'/api/projects/{project}')['data']['project']['version'], 1)
        self.screenshot('live-preview-desktop.png')
        expect(self.page.locator('#build-state')).to_have_text('Completed', timeout=25000)
        saved = self.api(f'/api/projects/{project}')['data']['project']
        self.assertEqual(saved['version'], 2)
        self.assertEqual({file['path'] for file in saved['files']}, {'README.md', 'fxmanifest.lua', 'client/main.lua'})
        self.assertIn('end, false)', next(file['content'] for file in saved['files'] if file['path'] == 'client/main.lua'))
        jobs = self.api(f'/api/projects/{project}/jobs')['data']
        self.assertEqual(jobs['projectVersion'], 2)
        self.assertEqual(len(jobs['jobs']), 1)
        self.assertEqual(jobs['jobs'][0]['previewVersion'], 0)
        self.assertIsNone(self.api('/api/jobs/' + jobs['jobs'][0]['id'])['data']['job']['preview'])
        expect(preview).to_have_text('')
        self.assertEqual(self.api('/api/studio/credits')['data']['wallet']['balance'], before - 5)
        self.page.reload()
        expect(self.page.locator('#build-state')).to_have_text('Completed')
        self.assertEqual(self.api(f'/api/projects/{project}')['data']['project']['version'], 2)
        self.assertEqual(self.api('/api/studio/credits')['data']['wallet']['balance'], before - 5)

    def test_24_live_preview_and_finished_build_preserve_unsaved_editor_drafts(self):
        project = self.project('QA preview keeps a local source draft')
        self.new_file()
        base = self.api(f'/api/projects/{project}')['data']['project']
        self.build('[live] Preview another file without replacing the selected manual source draft.')
        draft = 'print("private unsaved draft during generation")'
        self.page.locator('#code-editor').fill(draft)
        expect(self.page.locator('#live-preview-code')).to_contain_text('RegisterCommand("nd_qatest"', timeout=15000)
        expect(self.page.locator('#code-editor')).to_have_value(draft)
        during = self.api(f'/api/projects/{project}')['data']['project']
        self.assertEqual(during['version'], base['version'])
        self.assertEqual(during['files'], base['files'])
        expect(self.page.locator('#build-state')).to_have_text('Completed', timeout=25000)
        expect(self.page.locator('#code-editor')).to_have_value(draft)
        expect(self.page.locator('#draft-notice')).to_be_visible()
        expect(self.page.locator('#save-file')).to_be_disabled()
        saved = self.api(f'/api/projects/{project}')['data']['project']
        self.assertEqual(saved['version'], base['version'] + 1)
        self.assertNotIn(draft, '\n'.join(file['content'] for file in saved['files']))
        expect(self.page.locator('#live-preview-code')).to_have_text('')
        self.screenshot('live-preview-preserved-draft.png')

    def test_25_saved_edits_sync_between_tabs_without_resetting_an_unchanged_editor(self):
        project = self.project('QA saved source synchronizes between tabs')
        stable_source = '\n'.join(f'print("unchanged line {index}")' for index in range(120)) + '\n'
        self.new_file('client/unchanged.lua', stable_source)
        self.new_file('README.md', 'Original saved notes.')
        self.page.locator('#file-list').get_by_role('button', name='client/unchanged.lua', exact=True).click()
        editor = self.page.locator('#code-editor')
        expect(editor).to_have_value(stable_source)
        editor.evaluate('node => { node.focus(); node.setSelectionRange(180, 180); node.scrollTop = 180; }')
        before = editor.evaluate('node => ({start:node.selectionStart,end:node.selectionEnd,scroll:node.scrollTop})')
        other = self.browser.new_context()
        other_page = other.new_page()
        try:
            self.login('owner', other, other_page)
            other_page.goto(self.origin + '/workspace.html#project/' + project)
            expect(other_page.locator('#editor-view')).to_be_visible()
            other_page.locator('#file-list').get_by_role('button', name='README.md', exact=True).click()
            other_page.locator('#code-editor').fill('Saved notes changed in the second browser tab.')
            other_page.locator('#save-file').click()
            expect(other_page.locator('#save-status')).to_contain_text('Saved revision')
            remote = self.api(f'/api/projects/{project}', page=other_page)['data']['project']
            expect(self.page.locator('#project-meta')).to_contain_text('revision ' + str(remote['version']), timeout=15000)
            expect(editor).to_have_value(stable_source)
            self.assertEqual(editor.evaluate('node => ({start:node.selectionStart,end:node.selectionEnd,scroll:node.scrollTop})'), before)
            self.assertEqual(self.api(f'/api/projects/{project}/jobs')['data']['jobs'], [])
            self.page.locator('#sync-source').click()
            expect(self.page.locator('#source-sync-status')).to_be_visible()
            expect(editor).to_have_value(stable_source)
            draft = 'print("keep the unsaved local tab draft")'
            editor.fill(draft)
            other_page.locator('#file-list').get_by_role('button', name='client/unchanged.lua', exact=True).click()
            other_page.locator('#code-editor').fill('print("new saved content from the second tab")')
            other_page.locator('#save-file').click()
            expect(other_page.locator('#save-status')).to_contain_text('Saved revision')
            remote = self.api(f'/api/projects/{project}', page=other_page)['data']['project']
            expect(self.page.locator('#project-meta')).to_contain_text('revision ' + str(remote['version']), timeout=15000)
            expect(editor).to_have_value(draft)
            expect(self.page.locator('#draft-notice')).to_be_visible()
            expect(self.page.locator('#save-file')).to_be_disabled()
            self.assertNotIn(draft, '\n'.join(file['content'] for file in remote['files']))
            self.screenshot('saved-source-sync-keeps-draft.png')
        finally:
            other.close()

    def test_26_mobile_live_preview_cancellation_and_navigation_never_save_partial_source(self):
        project = self.project('QA mobile preview cancellation')
        before = self.api('/api/studio/credits')['data']['wallet']['balance']
        self.page.set_viewport_size({'width': 390, 'height': 844})
        self.page.locator('button[data-panel=build]').click()
        self.build('[live] Exercise a local synthetic streaming preview before cancelling it.')
        preview = self.page.locator('#live-preview-code')
        expect(preview).to_contain_text('RegisterCommand("nd_qatest"', timeout=15000)
        route = self.page.url
        self.page.locator('#view-live-preview').click()
        expect(preview).to_be_focused()
        self.assertEqual(self.page.url, route)
        self.assertGreater(self.page.evaluate('window.scrollY'), 0)
        self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), 390)
        box = self.page.locator('#live-preview').bounding_box()
        self.assertGreaterEqual(box['x'], -1)
        self.assertLessEqual(box['x'] + box['width'], 391)
        self.screenshot('live-preview-mobile.png')
        self.page.locator('#cancel-build').click()
        self.page.get_by_role('dialog').filter(has_text='Cancel this build?').get_by_role('button', name='Cancel build', exact=True).click()
        expect(self.page.locator('#build-state')).to_have_text('cancelled')
        expect(preview).to_have_text('')
        jobs = self.api(f'/api/projects/{project}/jobs')['data']['jobs']
        self.assertEqual(len(jobs), 1)
        self.assertIsNone(self.api('/api/jobs/' + jobs[0]['id'])['data']['job']['preview'])
        self.page.goto(self.origin + '/workspace.html#projects')
        expect(self.page.locator('#dashboard')).to_be_visible()
        self.page.locator('#new-project').click()
        self.page.locator('#project-form [name=name]').fill('QA destination after cancelled preview')
        self.page.locator('#project-form [name=requirements]').fill('A different private source project with no generated files.')
        self.page.locator('#project-form [type=submit]').click()
        expect(self.page.locator('#editor-view')).to_be_visible()
        destination = self.page.url.split('#project/')[1]
        self.assertNotEqual(destination, project)
        expect(self.page.locator('#live-preview-code')).to_have_text('')
        expect(self.page.locator('#build-state')).to_have_text('Idle')
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            records = [json.loads(line) for line in Path(self.metadata['log']).read_text().splitlines()]
            if any(record['path'] == '/api/worker/complete' for record in records):
                break
            time.sleep(.2)
        else:
            self.fail('The cancelled fixture worker did not finish within its bounded streaming delay.')
        self.assertEqual(self.api(f'/api/projects/{project}')['data']['project']['version'], 1)
        self.assertEqual(self.api(f'/api/projects/{project}')['data']['project']['files'], [])
        self.assertEqual(self.api(f'/api/projects/{destination}')['data']['project']['version'], 1)
        self.assertEqual(self.api(f'/api/projects/{destination}')['data']['project']['files'], [])
        expect(self.page.locator('#live-preview-code')).to_have_text('')
        self.assertEqual(self.api('/api/studio/credits')['data']['wallet']['balance'], before)


if __name__ == '__main__':
    unittest.main(verbosity=2)
