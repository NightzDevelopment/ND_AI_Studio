"""Real built account UI against local deterministic HTTP fixtures. No live accounts or paid calls.
Run after npm run build using the browser interpreter from docs/BROWSER_TESTS.md.
"""
import copy
import json
import os
from pathlib import Path
import shutil
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import unittest
from datetime import datetime, timezone
from uuid import uuid4
from urllib.parse import urlparse
try:
    from playwright.sync_api import sync_playwright, expect
except ModuleNotFoundError as failure:
    if failure.name not in ('playwright', 'playwright.sync_api'):
        raise
    raise SystemExit(
        'Account browser checks require Python Playwright in the interpreter running this file.\n'
        'Install tests/browser-requirements.txt in an isolated environment, then run this file with that Python.\n'
        'Setup commands: docs/BROWSER_TESTS.md. This is a development test dependency, not an API or worker dependency.'
    ) from None

ROOT = Path(__file__).resolve().parents[1]
USER = dict(id='account-browser-user', username='tester', discordId='123456789012345678',
            displayName='Original creator', bio='Original biography', preferredFramework='Standalone',
            density='comfortable', version=1, createdAt='2026-01-01T00:00:00.000Z')


class Fixture:
    def __init__(self):
        self.lock = threading.Lock()
        self.user = copy.deepcopy(USER)
        self.signed_in = True
        self.csrf = 'fixture-csrf'
        self.session_failure = False
        self.save_failure = None
        self.invalid_save_response = False
        self.invalid_save_status = 502
        self.unconfirmed_save_response = False
        self.delay_save = False
        self.save_requested = threading.Event()
        self.release_save = threading.Event()
        self.save_calls = []
        self.briefs = []
        self.export_calls = 0
        self.export_failure = None
        self.delay_export = False
        self.export_requested = threading.Event()
        self.release_export = threading.Event()
        self.brief_create_calls = []
        self.brief_requests = {}
        self.delay_brief = False
        self.brief_requested = threading.Event()
        self.release_brief = threading.Event()
        self.lose_brief_response_once = False
        self.delayed_delete = None
        self.delete_requested = threading.Event()
        self.release_delete = threading.Event()
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
                path = urlparse(self.path).path
                if not path.startswith('/api/'):
                    return super().do_GET()
                if path == '/api/account/export' and fixture.delay_export:
                    status = fixture.export_failure or 401
                    fixture.export_requested.set()
                    fixture.release_export.wait(timeout=10)
                    return self.send_json({'error': 'The old export session expired.'}, status)
                with fixture.lock:
                    if path == '/api/session':
                        if fixture.session_failure:
                            return self.send_json({'error': 'Temporarily unavailable.'}, 503)
                        return self.send_json({'user': fixture.user if fixture.signed_in else None,
                                               'csrf': fixture.csrf if fixture.signed_in else None,
                                               'configured': True})
                    if path == '/api/briefs':
                        if not fixture.signed_in:
                            return self.send_json({'error': 'Sign in again.'}, 401)
                        return self.send_json({'briefs': fixture.briefs})
                    if path == '/api/account/export':
                        if fixture.export_failure:
                            return self.send_json({'error': 'Sign in again.'}, fixture.export_failure)
                        fixture.export_calls += 1
                        return self.send_json({'user': fixture.user, 'briefs': fixture.briefs})
                return self.send_json({'error': 'Unexpected fixture route.'}, 404)

            def do_POST(self):
                path = urlparse(self.path).path
                body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))))
                if path != '/api/briefs':
                    return self.send_json({'error': 'Unexpected fixture mutation.'}, 404)
                with fixture.lock:
                    fixture.brief_create_calls.append(body)
                    fixture.brief_requested.set()
                if fixture.delay_brief:
                    fixture.release_brief.wait(timeout=10)
                with fixture.lock:
                    if not fixture.signed_in:
                        return self.send_json({'error': 'Sign in again.'}, 401)
                    request_id = body.get('requestId')
                    value = {key: value for key, value in body.items() if key != 'requestId'}
                    previous = fixture.brief_requests.get(request_id)
                    if previous and previous['body'] != value:
                        return self.send_json({'error': 'Request identifier was already used.'}, 409)
                    if not previous:
                        brief_id = str(uuid4())
                        fixture.briefs.insert(0, {**value, 'id': brief_id, 'version': 1,
                                                 'updatedAt': datetime.now(timezone.utc).isoformat()})
                        if request_id:
                            fixture.brief_requests[request_id] = {'body': value, 'briefId': brief_id}
                    if fixture.lose_brief_response_once:
                        fixture.lose_brief_response_once = False
                        raw = b'<html>Response acknowledgement lost</html>'
                        self.send_response(502)
                        self.send_header('Content-Type', 'text/html')
                        self.send_header('Content-Length', str(len(raw)))
                        self.end_headers()
                        self.wfile.write(raw)
                        return
                    metadata = {}
                    if request_id:
                        receipt = fixture.brief_requests[request_id]
                        metadata = dict(requestId=request_id, briefId=receipt['briefId'], replayed=bool(previous),
                                        deleted=not any(item['id'] == receipt['briefId'] for item in fixture.briefs))
                    return self.send_json({'briefs': fixture.briefs, **metadata}, 200 if previous else 201)

            def do_DELETE(self):
                path = urlparse(self.path).path
                body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))))
                brief_id = path.rsplit('/', 1)[-1]
                with fixture.lock:
                    brief = next((item for item in fixture.briefs if item['id'] == brief_id), None)
                    if not brief or body.get('version') != brief['version']:
                        return self.send_json({'error': 'The brief changed.'}, 409)
                    fixture.briefs = [item for item in fixture.briefs if item['id'] != brief_id]
                    snapshot = copy.deepcopy(fixture.briefs)
                if brief_id == fixture.delayed_delete:
                    fixture.delete_requested.set()
                    fixture.release_delete.wait(timeout=10)
                return self.send_json({'briefs': snapshot})

            def do_PATCH(self):
                body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))))
                with fixture.lock:
                    fixture.save_calls.append(body)
                    fixture.save_requested.set()
                if fixture.delay_save:
                    fixture.release_save.wait(timeout=10)
                with fixture.lock:
                    if fixture.save_failure:
                        return self.send_json({'error': 'Fixture save was rejected.'}, fixture.save_failure)
                    if fixture.invalid_save_response:
                        raw = b'<html>Proxy unavailable</html>'
                        self.send_response(fixture.invalid_save_status)
                        self.send_header('Content-Type', 'text/html')
                        self.send_header('Content-Length', str(len(raw)))
                        self.end_headers()
                        self.wfile.write(raw)
                        return
                    if fixture.unconfirmed_save_response:
                        return self.send_json({'user': fixture.user})
                    if body['version'] != fixture.user['version']:
                        return self.send_json({'error': 'The profile changed. Reload before saving.'}, 409)
                    fixture.user.update({key: value.strip() if isinstance(value, str) else value
                                         for key, value in body.items() if key != 'version'})
                    fixture.user['version'] += 1
                    return self.send_json({'user': fixture.user})

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f'http://127.0.0.1:{self.server.server_port}/#account'

    def close(self):
        self.release_save.set()
        self.release_brief.set()
        self.release_delete.set()
        self.release_export.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)


class AccountBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        executable = os.environ.get('CHROMIUM_PATH') or shutil.which('chromium') or shutil.which('chromium-browser')
        cls.browser = cls.playwright.chromium.launch(headless=True, **({'executable_path': executable} if executable else {}))

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.fixture = Fixture()
        self.context = self.browser.new_context()
        self.page = self.context.new_page()
        self.page.on('dialog', lambda dialog: dialog.accept())
        self.errors = []
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))

    def tearDown(self):
        self.context.close()
        self.fixture.close()
        self.assertEqual(self.errors, [])

    def open(self):
        self.page.goto(self.fixture.url)
        expect(self.page.locator('#profile-form')).to_be_visible()
        expect(self.page.locator('#profile-form [name=displayName]')).to_have_value(USER['displayName'])

    def submit(self):
        self.page.locator('#profile-form button[type=submit]').click()

    def test_edits_typed_during_save_survive_and_use_new_revision(self):
        self.fixture.delay_save = True
        self.open()
        name = self.page.locator('#profile-form [name=displayName]')
        name.fill('First submitted change')
        self.submit()
        self.assertTrue(self.fixture.save_requested.wait(timeout=3))
        name.fill('Newer unsaved change')
        self.fixture.release_save.set()
        expect(self.page.locator('#profile-form button[type=submit]')).to_be_enabled()
        expect(name).to_have_value('Newer unsaved change')
        expect(self.page.locator('#profile-state')).to_contain_text('newer edits are still unsaved')
        self.assertEqual(self.fixture.user['displayName'], 'First submitted change')
        self.fixture.delay_save = False
        self.submit()
        expect(self.page.locator('#profile-name')).to_have_text('Newer unsaved change')
        self.assertEqual([item['version'] for item in self.fixture.save_calls], [1, 2])
        self.page.reload()
        expect(name).to_have_value('Newer unsaved change')

    def test_repeated_submit_only_sends_one_save(self):
        self.fixture.delay_save = True
        self.open()
        self.page.locator('#profile-form [name=bio]').fill('Saved once')
        self.page.locator('#profile-form').evaluate("form => { form.dispatchEvent(new Event('submit', {bubbles:true,cancelable:true})); form.dispatchEvent(new Event('submit', {bubbles:true,cancelable:true})); }")
        self.assertTrue(self.fixture.save_requested.wait(timeout=3))
        expect(self.page.locator('#profile-form')).to_have_attribute('aria-busy', 'true')
        self.fixture.release_save.set()
        expect(self.page.locator('#profile-state')).to_contain_text('saved')
        self.assertEqual(len(self.fixture.save_calls), 1)

    def test_whitespace_name_is_rejected_without_a_request(self):
        self.open()
        self.page.locator('#profile-form [name=displayName]').fill('   ')
        self.submit()
        expect(self.page.locator('#profile-error')).to_contain_text('not only spaces')
        self.assertEqual(self.fixture.save_calls, [])
        expect(self.page.locator('#profile-form [name=displayName]')).to_be_focused()

    def test_stale_profile_loads_latest_only_after_confirming(self):
        self.open()
        self.fixture.user['displayName'] = 'Changed in another tab'
        self.fixture.user['version'] = 2
        name = self.page.locator('#profile-form [name=displayName]')
        name.fill('My unsaved profile')
        self.submit()
        expect(self.page.locator('#profile-error')).to_contain_text('changed')
        self.page.locator('#profile-reload').click()
        self.page.get_by_role('button', name='Cancel', exact=True).click()
        expect(name).to_have_value('My unsaved profile')
        self.page.locator('#profile-reload').click()
        self.page.get_by_role('button', name='Load saved profile', exact=True).last.click()
        expect(name).to_have_value('Changed in another tab')
        expect(self.page.locator('#profile-error')).to_be_hidden()

    def test_session_expiry_keeps_form_text_for_same_user_reconnection(self):
        self.open()
        name = self.page.locator('#profile-form [name=displayName]')
        name.fill('Recover this profile text')
        self.fixture.save_failure = 401
        self.fixture.signed_in = False
        self.submit()
        expect(self.page.locator('#account-guest')).to_be_visible()
        self.fixture.save_failure = None
        self.fixture.signed_in = True
        self.page.locator('#account-retry').click()
        expect(name).to_be_visible()
        expect(name).to_have_value('Recover this profile text')
        self.submit()
        expect(self.page.locator('#profile-name')).to_have_text('Recover this profile text')

    def test_a_delayed_unauthorized_export_never_clears_a_reconnected_same_user_session(self):
        self.open()
        self.fixture.delay_export = True
        self.fixture.export_failure = 401
        self.page.locator('#account-export').click()
        self.assertTrue(self.fixture.export_requested.wait(timeout=3))
        name = self.page.locator('#profile-form [name=displayName]')
        name.fill('Keep this recovered profile')
        self.fixture.save_failure = 401
        self.submit()
        expect(self.page.locator('#account-guest')).to_be_visible()
        self.fixture.save_failure = None
        self.fixture.csrf = 'new-session-csrf'
        self.page.locator('#account-retry').click()
        expect(self.page.locator('#profile-form')).to_be_visible()
        expect(name).to_have_value('Keep this recovered profile')
        self.fixture.release_export.set()
        expect(self.page.locator('#account-export')).to_be_enabled()
        expect(self.page.locator('#toast')).to_contain_text('current session')
        expect(self.page.locator('#profile-form')).to_be_visible()
        expect(self.page.locator('#account-guest')).not_to_be_visible()
        expect(name).to_have_value('Keep this recovered profile')
        self.submit()
        expect(self.page.locator('#profile-name')).to_have_text('Keep this recovered profile')

    def test_html_unauthorized_response_still_expires_the_session_and_preserves_text(self):
        self.fixture.invalid_save_response = True
        self.fixture.invalid_save_status = 401
        self.open()
        self.page.locator('#profile-form [name=displayName]').fill('Keep after proxy expiry')
        self.submit()
        expect(self.page.locator('#account-guest')).to_be_visible()
        expect(self.page.locator('#profile-form [name=displayName]')).to_have_value('Keep after proxy expiry')
        self.fixture.invalid_save_response = False
        self.page.locator('#account-retry').click()
        expect(self.page.locator('#profile-form [name=displayName]')).to_have_value('Keep after proxy expiry')

    def test_reconnection_never_rebases_a_stale_profile_draft_silently(self):
        self.open()
        name = self.page.locator('#profile-form [name=displayName]')
        name.fill('Keep this disconnected draft')
        self.fixture.save_failure = 401
        self.submit()
        expect(self.page.locator('#account-guest')).to_be_visible()
        self.fixture.save_failure = None
        self.fixture.user['displayName'] = 'Saved in a different tab'
        self.fixture.user['version'] = 2
        self.page.locator('#account-retry').click()
        expect(name).to_have_value('Keep this disconnected draft')
        expect(self.page.locator('#profile-error')).to_contain_text('changed while you were disconnected')
        self.submit()
        self.assertEqual(len(self.fixture.save_calls), 1)
        self.page.locator('#profile-reload').click()
        self.page.get_by_role('button', name='Load saved profile', exact=True).last.click()
        expect(name).to_have_value('Saved in a different tab')

    def test_a_profile_conflict_survives_another_expiry_and_reconnection(self):
        self.open()
        name = self.page.locator('#profile-form [name=displayName]')
        name.fill('Preserve the original draft')
        self.fixture.save_failure = 401
        self.submit()
        expect(self.page.locator('#account-guest')).to_be_visible()
        self.fixture.save_failure = None
        self.fixture.user['displayName'] = 'Newer saved profile'
        self.fixture.user['version'] = 2
        self.page.locator('#account-retry').click()
        expect(self.page.locator('#profile-error')).to_contain_text('changed while you were disconnected')
        self.fixture.export_failure = 401
        self.page.locator('#account-export').click()
        expect(self.page.locator('#account-guest')).to_be_visible()
        self.fixture.export_failure = None
        self.page.locator('#account-retry').click()
        expect(self.page.locator('#profile-error')).to_contain_text('changed while you were disconnected')
        expect(name).to_have_value('Preserve the original draft')
        self.submit()
        self.assertEqual(len(self.fixture.save_calls), 1)
        self.assertEqual(self.fixture.user['displayName'], 'Newer saved profile')

    def test_a_success_status_without_a_new_profile_revision_is_not_reported_saved(self):
        self.fixture.unconfirmed_save_response = True
        self.open()
        name = self.page.locator('#profile-form [name=displayName]')
        name.fill('Unconfirmed profile edit')
        self.submit()
        expect(self.page.locator('#profile-error')).to_contain_text('did not confirm')
        expect(name).to_have_value('Unconfirmed profile edit')
        expect(self.page.locator('#profile-name')).to_have_text(USER['displayName'])
        expect(self.page.locator('#profile-reload')).to_be_visible()

    def test_different_account_never_shows_previous_profile_draft(self):
        self.open()
        name = self.page.locator('#profile-form [name=displayName]')
        name.fill('Private previous account text')
        self.fixture.save_failure = 401
        self.submit()
        expect(self.page.locator('#account-guest')).to_be_visible()
        self.fixture.save_failure = None
        self.fixture.user = {**USER, 'id': 'other-account', 'displayName': 'Different creator'}
        self.page.locator('#account-retry').click()
        expect(name).to_have_value('Different creator')
        expect(self.page.locator('#profile-state')).not_to_contain_text('unsaved')

    def test_normal_guest_startup_does_not_show_a_connection_toast(self):
        self.fixture.signed_in = False
        self.page.goto(self.fixture.url.split('#')[0] + '#overview')
        expect(self.page.locator('#result-count')).to_have_text('2 of 2 coding workflows')
        expect(self.page.locator('#account-service-state')).to_have_text('Account service connected')
        expect(self.page.locator('#toast')).not_to_be_visible()

    def test_initial_session_failure_has_an_in_place_retry(self):
        self.fixture.session_failure = True
        self.page.goto(self.fixture.url)
        expect(self.page.locator('#account-connection')).to_contain_text('not connected')
        self.fixture.session_failure = False
        self.page.locator('#account-retry').click()
        expect(self.page.locator('#profile-form')).to_be_visible()
        expect(self.page.locator('#profile-name')).to_have_text(USER['displayName'])

    def test_unexpected_mutation_response_keeps_edits_without_claiming_no_write(self):
        self.fixture.invalid_save_response = True
        self.open()
        self.page.locator('#profile-form [name=bio]').fill('Keep my biography')
        self.submit()
        expect(self.page.locator('#profile-error')).to_contain_text('unexpected response')
        expect(self.page.locator('#profile-error')).not_to_contain_text('has not been changed')
        expect(self.page.locator('#profile-form [name=bio]')).to_have_value('Keep my biography')
        expect(self.page.locator('#profile-form button[type=submit]')).to_be_enabled()

    def open_brief(self, name='Reliable brief'):
        self.page.locator('#new-brief').click()
        self.page.locator('#brief-form [name=name]').fill(name)
        self.page.locator('#brief-form [name=requirements]').fill('Preserve the specified account storage and saved requirements.')

    def test_connection_retry_switches_briefs_to_account_storage(self):
        self.fixture.session_failure = True
        self.page.goto(self.fixture.url)
        expect(self.page.locator('#account-retry')).to_be_visible()
        self.fixture.session_failure = False
        self.page.locator('#account-retry').click()
        expect(self.page.locator('#profile-form')).to_be_visible()
        self.page.goto(self.fixture.url.split('#')[0] + '#projects')
        expect(self.page.locator('#project-count')).to_contain_text('saved to your account')
        self.open_brief()
        self.page.locator('#brief-form button[type=submit]').click()
        expect(self.page.locator('#brief-dialog')).not_to_be_visible()
        expect(self.page.locator('#project-count')).to_contain_text('1 saved to your account')
        self.assertEqual(len(self.fixture.brief_create_calls), 1)
        self.assertTrue(self.fixture.brief_create_calls[0].get('requestId'))
        self.assertIsNone(self.page.evaluate("localStorage.getItem('nd-ai-studio.briefs.v1')"))

    def test_changed_destination_blocks_an_open_local_brief_without_discarding_text(self):
        self.fixture.session_failure = True
        self.page.goto(self.fixture.url)
        expect(self.page.locator('#account-retry')).to_be_visible()
        self.open_brief('Local form text')
        self.fixture.session_failure = False
        self.page.evaluate("document.querySelector('#account-retry').click()")
        expect(self.page.locator('#form-error')).to_contain_text('storage destination changed')
        self.page.locator('#brief-form button[type=submit]').click()
        expect(self.page.locator('#brief-form [name=name]')).to_have_value('Local form text')
        self.assertEqual(self.fixture.brief_create_calls, [])
        self.assertIsNone(self.page.evaluate("localStorage.getItem('nd-ai-studio.briefs.v1')"))

    def test_brief_save_freezes_form_and_guards_repeated_submissions(self):
        self.fixture.delay_brief = True
        self.open()
        self.open_brief()
        self.page.locator('#brief-form').evaluate("form => { form.dispatchEvent(new Event('submit', {bubbles:true,cancelable:true})); form.dispatchEvent(new Event('submit', {bubbles:true,cancelable:true})); }")
        self.assertTrue(self.fixture.brief_requested.wait(timeout=3))
        expect(self.page.locator('#brief-form [name=requirements]')).to_be_disabled()
        expect(self.page.locator('#brief-form')).to_have_attribute('aria-busy', 'true')
        self.page.keyboard.press('Escape')
        expect(self.page.locator('#brief-dialog')).to_be_visible()
        self.fixture.release_brief.set()
        expect(self.page.locator('#brief-dialog')).not_to_be_visible()
        self.assertEqual(len(self.fixture.brief_create_calls), 1)
        self.assertEqual(len(self.fixture.briefs), 1)

    def test_lost_brief_acknowledgement_reuses_request_id_without_a_duplicate(self):
        self.fixture.lose_brief_response_once = True
        self.open()
        self.open_brief('Confirmed once')
        self.page.locator('#brief-form button[type=submit]').click()
        expect(self.page.locator('#form-error')).to_contain_text('unexpected response')
        expect(self.page.locator('#brief-form [name=name]')).to_have_value('Confirmed once')
        self.assertEqual(len(self.fixture.briefs), 1)
        self.page.locator('#brief-form button[type=submit]').click()
        expect(self.page.locator('#brief-dialog')).not_to_be_visible()
        self.assertEqual(len(self.fixture.brief_create_calls), 2)
        self.assertEqual(self.fixture.brief_create_calls[0]['requestId'], self.fixture.brief_create_calls[1]['requestId'])
        expect(self.page.locator('#toast')).to_contain_text('already saved')
        self.assertEqual(len(self.fixture.briefs), 1)

    def test_deleted_receipt_is_not_reported_saved_and_needs_an_explicit_new_attempt(self):
        self.fixture.lose_brief_response_once = True
        self.open()
        self.open_brief('Deleted after acknowledgement loss')
        self.page.locator('#brief-form button[type=submit]').click()
        expect(self.page.locator('#form-error')).to_contain_text('unexpected response')
        original_id = self.fixture.briefs[0]['id']
        self.fixture.briefs = []
        self.page.locator('#brief-form button[type=submit]').click()
        expect(self.page.locator('#form-error')).to_contain_text('earlier saved brief was deleted')
        expect(self.page.locator('#brief-dialog')).to_be_visible()
        expect(self.page.locator('#brief-form [name=name]')).to_have_value('Deleted after acknowledgement loss')
        self.assertEqual(self.fixture.briefs, [])
        self.assertEqual(self.fixture.brief_create_calls[0]['requestId'], self.fixture.brief_create_calls[1]['requestId'])
        self.page.locator('#brief-form button[type=submit]').click()
        expect(self.page.locator('#brief-dialog')).not_to_be_visible()
        self.assertEqual(len(self.fixture.briefs), 1)
        self.assertNotEqual(original_id, self.fixture.briefs[0]['id'])
        self.assertNotEqual(self.fixture.brief_create_calls[1]['requestId'], self.fixture.brief_create_calls[2]['requestId'])

    def test_editing_a_failed_brief_creates_a_new_request_identifier(self):
        self.fixture.lose_brief_response_once = True
        self.open()
        self.open_brief('Original attempt')
        self.page.locator('#brief-form button[type=submit]').click()
        expect(self.page.locator('#form-error')).to_contain_text('unexpected response')
        self.page.locator('#brief-form [name=name]').fill('Different request')
        self.page.locator('#brief-form button[type=submit]').click()
        expect(self.page.locator('#brief-dialog')).not_to_be_visible()
        self.assertNotEqual(self.fixture.brief_create_calls[0]['requestId'], self.fixture.brief_create_calls[1]['requestId'])
        self.assertEqual(len(self.fixture.briefs), 2)

    def test_unsaved_brief_warns_before_leaving_but_pristine_and_closed_forms_do_not(self):
        self.open()
        self.page.locator('#new-brief').click()
        check = "window.dispatchEvent(new Event('beforeunload', {cancelable:true}))"
        self.assertTrue(self.page.evaluate(check))
        self.page.locator('#brief-form [name=name]').fill('Unsaved brief text')
        self.assertFalse(self.page.evaluate(check))
        self.page.locator('#brief-dialog').get_by_role('button', name='Cancel', exact=True).click()
        self.assertTrue(self.page.evaluate(check))

    def test_out_of_order_delete_responses_never_resurrect_a_deleted_brief(self):
        first, second = str(uuid4()), str(uuid4())
        base = dict(toolId='ai-script-generator', target='Standalone', requirements='Fixture requirements',
                    version=1, updatedAt='2026-01-01T00:00:00.000Z')
        self.fixture.briefs = [{**base, 'id': first, 'name': 'Delete first'},
                               {**base, 'id': second, 'name': 'Delete second'}]
        self.fixture.delayed_delete = first
        self.open()
        self.page.goto(self.fixture.url.split('#')[0] + '#projects')
        self.page.get_by_role('button', name='Delete: Delete first', exact=True).click()
        self.page.locator('dialog[open]').get_by_role('button', name='Delete', exact=True).click()
        self.assertTrue(self.fixture.delete_requested.wait(timeout=3))
        self.page.get_by_role('button', name='Delete: Delete second', exact=True).click()
        self.page.locator('dialog[open]').get_by_role('button', name='Delete', exact=True).click()
        expect(self.page.get_by_role('button', name='Delete: Delete second', exact=True)).not_to_be_visible()
        self.fixture.release_delete.set()
        expect(self.page.locator('#project-count')).to_have_text('0 saved to your account')
        expect(self.page.locator('#project-list .project-card')).to_have_count(0)
        self.assertEqual(self.fixture.briefs, [])

    def test_escape_closes_only_the_active_account_menu_before_the_mobile_navigation(self):
        self.page.set_viewport_size({'width': 390, 'height': 844})
        self.open()
        navigation = self.page.locator('[data-navigation-toggle]')
        navigation.click()
        self.page.locator('#account-button').focus()
        self.page.keyboard.press('Enter')
        expect(self.page.locator('#account-button')).to_have_attribute('aria-expanded', 'true')
        expect(navigation).to_have_attribute('aria-expanded', 'true')
        self.page.keyboard.press('Escape')
        expect(self.page.locator('#account-menu')).not_to_be_visible()
        expect(self.page.locator('#account-button')).to_be_focused()
        expect(navigation).to_have_attribute('aria-expanded', 'true')
        self.page.keyboard.press('Escape')
        expect(navigation).to_have_attribute('aria-expanded', 'false')
        expect(navigation).to_be_focused()

    def test_profile_and_custom_controls_fit_mobile_tablet_and_desktop(self):
        self.open()
        for width in [320, 390, 768, 1024, 1440]:
            with self.subTest(width=width):
                self.page.set_viewport_size({'width': width, 'height': 900})
                self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), width)
                self.page.get_by_role('combobox', name='Default framework', exact=True).click()
                self.page.keyboard.press('End')
                self.page.keyboard.press('Enter')
                expect(self.page.locator('#profile-form [name=preferredFramework]')).to_have_value('Custom')
                self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), width)


if __name__ == '__main__':
    unittest.main()
