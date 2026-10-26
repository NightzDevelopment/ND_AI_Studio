import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { createApp, hash } from '../server/app.mjs';
import { readConfig } from '../server/config.mjs';
import { discordIdentity } from '../server/discord.mjs';
const catalog = JSON.parse(readFileSync(new URL('../config/tools.json', import.meta.url), 'utf8'));
const brief = { name: 'ND_Garage', requirements: 'Use oxmysql and preserve vehicle state.', toolId: 'ai-script-generator', target: 'ND_Framework' };

async function fixture(t, database = ':memory:') {
  const store = new Store(database);
  const config = readConfig({ APP_ORIGIN: 'https://ai.nightz.dev', DISCORD_CLIENT_ID: '123456789012345678', DISCORD_CLIENT_SECRET: 'unit-test-only-secret' });
  let calls = 0;
  const app = createApp({ config, store, catalog, logger: { error() {} }, identity: async (_, code) => {
    calls++; if (code === 'fail') throw new Error('Provider unavailable');
    return { id: code === 'other' ? '223456789012345678' : '123456789012345678', username: 'creator', displayName: 'Creator', avatar: null };
  } });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  const url = `http://127.0.0.1:${app.address().port}`;
  async function request(path, { cookie = '', method = 'GET', body, csrf, origin = config.origin, headers = {} } = {}) {
    return fetch(url + path, { method, redirect: 'manual', headers: {
      cookie, ...(method !== 'GET' ? { origin, 'content-type': 'application/json' } : {}),
      ...(csrf ? { 'x-csrf-token': csrf } : {}), ...headers,
    }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  }
  async function login(code = 'ok') {
    const start = await request('/auth/discord');
    const location = new URL(start.headers.get('location'));
    const state = location.searchParams.get('state');
    const flow = start.headers.getSetCookie()[0].split(';')[0];
    const result = await request(`/auth/discord/callback?state=${state}&code=${code}&iss=https%3A%2F%2Fdiscord.com`, { cookie: flow });
    const cookie = result.headers.getSetCookie().find(item => item.startsWith(config.sessionCookie + '='))?.split(';')[0];
    const session = cookie ? await (await request('/api/session', { cookie })).json() : null;
    return { cookie, csrf: session?.csrf, user: session?.user, state, flow, result, location };
  }
  let closed = false;
  const close = async () => { if (closed) return; closed = true; app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); store.close(); };
  t.after(close);
  return { request, login, store, config, url, app, close, calls: () => calls };
}

async function streamingMutation(f, login, path, method, body, afterAuthentication) {
  const encoded = JSON.stringify(body), original = f.store.session.bind(f.store);
  return new Promise((resolve, reject) => {
    let authenticated = false;
    const restore = () => { f.store.session = original; };
    const request = httpRequest(new URL(path, f.url), { method, headers: {
      cookie: login.cookie, origin: f.config.origin, 'x-csrf-token': login.csrf,
      'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded),
    } }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => { restore(); resolve({ status: response.statusCode, data: JSON.parse(text) }); });
      response.on('error', reject);
    });
    request.on('error', error => { restore(); reject(error); });
    request.setTimeout(3000, () => request.destroy(new Error('Streaming account fixture timed out.')));
    f.store.session = (...args) => {
      const current = original(...args);
      if (current && !authenticated) {
        authenticated = true;
        queueMicrotask(async () => {
          restore();
          try { await afterAuthentication(); request.end(encoded.slice(1)); }
          catch (error) { request.destroy(error); }
        });
      }
      return current;
    };
    request.write(encoded.slice(0, 1));
  });
}

test('configuration rejects unsafe origins and incomplete OAuth settings', () => {
  assert.throws(() => readConfig({ APP_ORIGIN: 'http://ai.nightz.dev' }));
  assert.throws(() => readConfig({ APP_ORIGIN: 'https://ai.nightz.dev/path' }));
  assert.throws(() => readConfig({ DISCORD_CLIENT_ID: '123456789012345678' }));
  assert.equal(readConfig({ NODE_ENV: 'development', APP_ORIGIN: 'http://127.0.0.1:8080' }).secure, false);
});
test('OAuth uses identify, PKCE and secure cookies; sessions are hashed', async t => {
  const f = await fixture(t), login = await f.login();
  assert.equal(login.location.searchParams.get('scope'), 'identify');
  assert.equal(login.location.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(login.location.searchParams.get('code_challenge').length, 43);
  assert.equal(login.result.status, 303);
  assert.equal(login.user.displayName, 'Creator');
  const header = login.result.headers.getSetCookie().find(item => item.startsWith(f.config.sessionCookie + '='));
  for (const text of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) assert.ok(header.includes(text));
  const row = f.store.db.prepare('SELECT * FROM sessions').get();
  assert.equal(row.hash, hash(login.cookie.split('=')[1]));
  assert.ok(!JSON.stringify(login.user).includes(row.hash));
});
test('OAuth state is browser-bound, expires and cannot be replayed', async t => {
  const f = await fixture(t), start = await f.request('/auth/discord');
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const flow = start.headers.getSetCookie()[0].split(';')[0];
  const path = `/auth/discord/callback?state=${state}&code=ok`;
  assert.match((await f.request(path)).headers.get('location'), /expired/);
  assert.equal(f.calls(), 0);
  const ok = await f.request(path, { cookie: flow }); assert.equal(ok.headers.get('location'), '/#account');
  assert.match((await f.request(path, { cookie: flow })).headers.get('location'), /expired/);
  assert.equal(f.calls(), 1);
  const next = await f.request('/auth/discord');
  f.store.db.prepare('UPDATE oauth_flows SET expires_at=0').run();
  const nextState = new URL(next.headers.get('location')).searchParams.get('state');
  assert.match((await f.request(`/auth/discord/callback?state=${nextState}&code=ok`, { cookie: next.headers.getSetCookie()[0].split(';')[0] })).headers.get('location'), /expired/);
});
test('Discord denial and provider failure never create sessions', async t => {
  const f = await fixture(t);
  assert.match((await f.login('fail')).result.headers.get('location'), /failed/);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM sessions').get().n, 0);
});
test('all mutations require authentication, exact origin and CSRF', async t => {
  const f = await fixture(t), login = await f.login();
  assert.equal((await f.request('/api/briefs', { method: 'POST', body: brief })).status, 401);
  assert.equal((await f.request('/api/briefs', { method: 'POST', body: brief, cookie: login.cookie })).status, 403);
  assert.equal((await f.request('/api/briefs', { ...login, method: 'POST', body: brief, origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.request('/api/briefs', { ...login, method: 'POST', body: brief })).status, 201);
});
test('profile saves persist, reject mass assignment and detect stale revisions', async t => {
  const f = await fixture(t), login = await f.login();
  const profile = { displayName: 'Nightz Creator', bio: '<script>not executable</script>', preferredFramework: 'ND_Framework', density: 'compact', version: 1 };
  const saved = await (await f.request('/api/account', { ...login, method: 'PATCH', body: profile })).json();
  assert.equal(saved.user.displayName, 'Nightz Creator'); assert.equal(saved.user.version, 2);
  assert.equal((await f.request('/api/account', { ...login, method: 'PATCH', body: profile })).status, 409);
  assert.equal((await f.request('/api/account', { ...login, method: 'PATCH', body: { ...profile, role: 'owner' } })).status, 400);
  const again = await f.login(); assert.equal(again.user.displayName, 'Nightz Creator');
});
test('brief ownership, revisions, validation and deletion are enforced', async t => {
  const f = await fixture(t), a = await f.login(), b = await f.login('other');
  const created = await (await f.request('/api/briefs', { ...a, method: 'POST', body: brief })).json();
  const id = created.briefs[0].id;
  assert.deepEqual((await (await f.request('/api/briefs', b)).json()).briefs, []);
  assert.equal((await f.request(`/api/briefs/${id}`, { ...b, method: 'PATCH', body: { ...brief, version: 1 } })).status, 404);
  assert.equal((await f.request(`/api/briefs/${id}`, { ...a, method: 'PATCH', body: { ...brief, name: 'Revised', version: 1 } })).status, 200);
  assert.equal((await f.request(`/api/briefs/${id}`, { ...a, method: 'DELETE', body: { version: 1 } })).status, 409);
  assert.equal((await f.request('/api/briefs', { ...a, method: 'POST', body: { ...brief, toolId: 'free-scripts' } })).status, 400);
  assert.equal((await f.request('/api/briefs', { ...a, method: 'POST', body: { ...brief, target: 'ox_lib' } })).status, 400);
  assert.equal((await f.request(`/api/briefs/${id}`, { ...a, method: 'DELETE', body: { version: 2 } })).status, 200);
});
test('imports are transactional and repeat imports do not duplicate records', async t => {
  const f = await fixture(t), login = await f.login();
  const data = { briefs: [{ ...brief, sourceId: 'local-1' }, { ...brief, sourceId: 'local-2' }] };
  assert.equal((await (await f.request('/api/briefs/import', { ...login, method: 'POST', body: data })).json()).imported, 2);
  assert.equal((await (await f.request('/api/briefs/import', { ...login, method: 'POST', body: data })).json()).imported, 0);
  const bad = { briefs: [{ ...brief, sourceId: 'local-3' }, { ...brief, sourceId: '../bad' }] };
  assert.equal((await f.request('/api/briefs/import', { ...login, method: 'POST', body: bad })).status, 400);
  assert.equal(f.store.count(login.user.id), 2);
  for (let i = 0; i < 97; i++) f.store.create(login.user.id, brief);
  const full = { briefs: [{ ...brief, sourceId: 'local-3' }, { ...brief, sourceId: 'local-4' }] };
  assert.equal((await f.request('/api/briefs/import', { ...login, method: 'POST', body: full })).status, 409);
  assert.equal(f.store.count(login.user.id), 99);
});
test('logout-all revokes all account sessions and expired sessions are denied', async t => {
  const f = await fixture(t), a = await f.login(), b = await f.login();
  assert.equal((await f.request('/api/logout-all', { ...a, method: 'POST', body: {} })).status, 200);
  assert.equal((await f.request('/api/briefs', b)).status, 401);
  const c = await f.login(); f.store.db.prepare('UPDATE sessions SET expires_at=0').run();
  assert.equal((await f.request('/api/briefs', c)).status, 401);
});
test('oversized data and unsupported content types fail safely', async t => {
  const f = await fixture(t), login = await f.login();
  assert.equal((await f.request('/api/briefs', { ...login, method: 'POST', body: { ...brief, requirements: 'x'.repeat(70000) } })).status, 413);
  assert.equal((await f.request('/api/briefs', { ...login, method: 'POST', body: brief, headers: { 'content-type': 'text/plain' } })).status, 415);
});
test('database migration is repeatable and stored profiles survive restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ndai-')), path = join(dir, 'test.sqlite');
  try {
    const store = new Store(path); const user = store.login({ id: '123456789012345678', username: 'creator', displayName: 'Creator', avatar: null });
    store.create(user.id, brief); store.close();
    const reopened = new Store(path); assert.equal(reopened.count(user.id), 1); assert.equal(reopened.user(user.id).discord_id, '123456789012345678'); reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('provider exchange includes the exact callback and PKCE verifier without retaining tokens', async () => {
  const config = readConfig({ DISCORD_CLIENT_ID: '123456789012345678', DISCORD_CLIENT_SECRET: 'unit-test-only-secret' });
  const calls = [];
  const user = await discordIdentity(config, 'authorization-code', 'verifier', async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(calls.length === 1 ? { access_token: 'test-token', token_type: 'Bearer' } : { id: '123456789012345678', username: 'Creator', avatar: null }), { status: 200 });
  });
  assert.equal(calls[0].options.body.get('redirect_uri'), 'https://ai.nightz.dev/auth/discord/callback');
  assert.equal(calls[0].options.body.get('code_verifier'), 'verifier');
  assert.equal(calls[1].options.headers.authorization, 'Bearer test-token');
  assert.ok(!JSON.stringify(user).includes('test-token'));
});

test('OAuth cancellation and invalid issuers are rejected without contacting the provider', async t => {
  const f = await fixture(t);
  for (const suffix of ['&error=access_denied', '&code=ok&iss=https%3A%2F%2Fevil.example']) {
    const start = await f.request('/auth/discord');
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const cookie = start.headers.getSetCookie()[0].split(';')[0];
    const response = await f.request(`/auth/discord/callback?state=${state}${suffix}`, { cookie });
    assert.match(response.headers.get('location'), /cancelled|failed/);
  }
  assert.equal(f.calls(), 0);
});
test('duplicate session cookies cannot select an authenticated session', async t => {
  const f = await fixture(t), login = await f.login();
  assert.equal((await f.request('/api/briefs', { cookie: `${login.cookie}; ${login.cookie}` })).status, 401);
});
test('logout revokes the current session but keeps another device signed in', async t => {
  const f = await fixture(t), a = await f.login(), b = await f.login();
  assert.equal((await f.request('/api/logout', { ...a, method: 'POST', body: {} })).status, 200);
  assert.equal((await f.request('/api/briefs', a)).status, 401);
  assert.equal((await f.request('/api/briefs', b)).status, 200);
});
test('account export only includes the signed-in user and never session secrets', async t => {
  const f = await fixture(t), login = await f.login();
  await f.request('/api/briefs', { ...login, method: 'POST', body: brief });
  const response = await f.request('/api/account/export', login);
  const data = await response.json();
  assert.equal(data.user.id, login.user.id); assert.equal(data.briefs.length, 1);
  assert.ok(!JSON.stringify(data).includes(login.csrf));
  assert.ok(!JSON.stringify(data).includes(login.cookie.split('=')[1]));
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

for (const endpoint of ['profile', 'create', 'import', 'update', 'delete']) {
  for (const invalidation of ['logout-all', 'expired', 'suspended', 'csrf-rotated']) {
    test(`${endpoint} mutation rejects ${invalidation} authentication while its request body is streaming`, async t => {
      const f = await fixture(t), login = await f.login();
      const id = f.store.create(login.user.id, brief);
      const operations = {
        profile: ['/api/account', 'PATCH', { displayName: 'Must not save', bio: '', preferredFramework: 'Standalone', density: 'compact', version: 1 }],
        create: ['/api/briefs', 'POST', { ...brief, name: 'Must not create' }],
        import: ['/api/briefs/import', 'POST', { briefs: [{ ...brief, sourceId: 'streaming-import' }] }],
        update: [`/api/briefs/${id}`, 'PATCH', { ...brief, name: 'Must not update', version: 1 }],
        delete: [`/api/briefs/${id}`, 'DELETE', { version: 1 }],
      };
      const result = await streamingMutation(f, login, ...operations[endpoint], async () => {
        if (invalidation === 'logout-all') {
          const logout = await f.request('/api/logout-all', { ...login, method: 'POST', body: {} });
          assert.equal(logout.status, 200);
        } else if (invalidation === 'expired') {
          f.store.db.prepare('UPDATE sessions SET expires_at=0 WHERE user_id=?').run(login.user.id);
        } else if (invalidation === 'suspended') {
          f.store.db.prepare('INSERT INTO studio_controls(user_id,status) VALUES(?,?)').run(login.user.id, 'suspended');
        } else {
          f.store.db.prepare('UPDATE sessions SET csrf=? WHERE user_id=?').run('x'.repeat(43), login.user.id);
        }
      });
      assert.equal(result.status, invalidation === 'csrf-rotated' ? 403 : 401, JSON.stringify(result.data));
      assert.equal(f.store.user(login.user.id).display_name, 'Creator');
      assert.equal(f.store.user(login.user.id).version, 1);
      assert.deepEqual(f.store.list(login.user.id).map(item => ({ id: item.id, name: item.name, version: item.version })), [{ id, name: brief.name, version: 1 }]);
    });
  }
}

test('a streaming mutation cannot change its original authenticated account binding', async t => {
  const f = await fixture(t), login = await f.login(), other = await f.login('other');
  const result = await streamingMutation(f, login, '/api/briefs', 'POST', brief, async () => {
    f.store.db.prepare('UPDATE sessions SET user_id=? WHERE hash=?').run(other.user.id, hash(login.cookie.split('=')[1]));
  });
  assert.equal(result.status, 401);
  assert.equal(f.store.count(login.user.id), 0); assert.equal(f.store.count(other.user.id), 0);
});

test('commit-time authentication checks do not consume the write-rate allowance twice', async t => {
  const f = await fixture(t), login = await f.login();
  for (let revision = 1; revision <= 90; revision++) {
    const response = await f.request('/api/account', { ...login, method: 'PATCH', body: {
      displayName: 'Creator', bio: '', preferredFramework: 'Standalone', density: 'comfortable', version: revision,
    } });
    assert.equal(response.status, 200, `Profile write ${revision} should remain within the rate limit.`);
  }
  const response = await f.request('/api/account', { ...login, method: 'PATCH', body: {
    displayName: 'Creator', bio: '', preferredFramework: 'Standalone', density: 'comfortable', version: 91,
  } });
  assert.equal(response.status, 429); assert.equal(f.store.user(login.user.id).version, 91);
});

test('a committed brief creation with a lost HTTP acknowledgement replays without another row', async t => {
  const f = await fixture(t), login = await f.login(), body = { ...brief, requestId: randomUUID() };
  const loseAcknowledgement = (request, response) => {
    if (request.method === 'POST' && request.url === '/api/briefs') {
      f.app.off('request', loseAcknowledgement);
      response.end = () => { response.destroy(); return response; };
    }
  };
  f.app.on('request', loseAcknowledgement);
  await assert.rejects(f.request('/api/briefs', { ...login, method: 'POST', body }));
  assert.equal(f.store.count(login.user.id), 1);
  const id = f.store.list(login.user.id)[0].id;
  const retry = await f.request('/api/briefs', { ...login, method: 'POST', body });
  assert.equal(retry.status, 200);
  const data = await retry.json();
  assert.equal(data.briefId, id); assert.equal(data.requestId, body.requestId);
  assert.equal(data.replayed, true); assert.equal(data.deleted, false);
  assert.equal(data.briefs.length, 1); assert.equal(f.store.count(login.user.id), 1);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM brief_create_requests').get().n, 1);
});

test('brief creation receipts compare normalized content and reject request ID reuse for different content', async t => {
  const f = await fixture(t), login = await f.login(), body = { ...brief, requestId: randomUUID() };
  const first = await f.request('/api/briefs', { ...login, method: 'POST', body });
  assert.equal(first.status, 201); const created = await first.json();
  assert.equal(created.replayed, false); assert.equal(created.deleted, false);
  const repeated = await f.request('/api/briefs', { ...login, method: 'POST', body: { ...body, name: `  ${brief.name} `, requirements: ` ${brief.requirements} `, requestId: body.requestId.toUpperCase() } });
  assert.equal(repeated.status, 200); assert.equal((await repeated.json()).briefId, created.briefId);
  for (const change of [{ name: 'Different' }, { requirements: 'Different' }, { toolId: 'discord-bot-generator' }, { target: 'Standalone' }]) {
    assert.equal((await f.request('/api/briefs', { ...login, method: 'POST', body: { ...body, ...change } })).status, 409);
  }
  assert.equal(f.store.count(login.user.id), 1);
});

test('concurrent brief creation retries create one row while request IDs remain account scoped', async t => {
  const f = await fixture(t), a = await f.login(), b = await f.login('other'), body = { ...brief, requestId: randomUUID() };
  const responses = await Promise.all([1, 2, 3].map(() => f.request('/api/briefs', { ...a, method: 'POST', body })));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 200, 201]);
  const replies = await Promise.all(responses.map(response => response.json()));
  assert.ok(replies.every(data => data.briefId === replies[0].briefId));
  assert.equal(f.store.count(a.user.id), 1);
  const other = await f.request('/api/briefs', { ...b, method: 'POST', body });
  assert.equal(other.status, 201); const separate = await other.json();
  assert.notEqual(separate.briefId, replies[0].briefId);
  assert.equal(separate.briefs.length, 1); assert.equal(f.store.count(b.user.id), 1);
});

test('brief replay does not overwrite subsequent edits or resurrect a later deleted brief', async t => {
  const f = await fixture(t), login = await f.login(), body = { ...brief, requestId: randomUUID() };
  const created = await (await f.request('/api/briefs', { ...login, method: 'POST', body })).json();
  const path = `/api/briefs/${created.briefId}`;
  assert.equal((await f.request(path, { ...login, method: 'PATCH', body: { ...brief, name: 'Newer saved name', version: 1 } })).status, 200);
  const replay = await (await f.request('/api/briefs', { ...login, method: 'POST', body })).json();
  assert.equal(replay.briefId, created.briefId); assert.equal(replay.briefs[0].name, 'Newer saved name');
  assert.equal(replay.briefs[0].version, 2);
  assert.equal((await f.request(path, { ...login, method: 'DELETE', body: { version: 2 } })).status, 200);
  const deleted = await f.request('/api/briefs', { ...login, method: 'POST', body });
  assert.equal(deleted.status, 200); const result = await deleted.json();
  assert.equal(result.deleted, true); assert.equal(result.replayed, true); assert.equal(result.briefId, created.briefId);
  assert.deepEqual(result.briefs, []); assert.equal(f.store.count(login.user.id), 0);
  assert.equal((await f.request('/api/briefs', { ...login, method: 'POST', body: { ...body, name: 'Changed tombstone request' } })).status, 409);
  const fresh = await f.request('/api/briefs', { ...login, method: 'POST', body: { ...body, requestId: randomUUID() } });
  assert.equal(fresh.status, 201); assert.notEqual((await fresh.json()).briefId, created.briefId);
});

test('brief creation receipts survive API/database restart and replay at the account brief limit', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'ndai-brief-receipt-')), database = join(directory, 'studio.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = await fixture(t, database), login = await first.login(), body = { ...brief, requestId: randomUUID() };
  const created = await (await first.request('/api/briefs', { ...login, method: 'POST', body })).json();
  for (let i = 0; i < 99; i++) first.store.create(login.user.id, { ...brief, name: `Other ${i}` });
  await first.close();
  const next = await fixture(t, database), again = await next.login();
  const replay = await next.request('/api/briefs', { ...again, method: 'POST', body });
  assert.equal(replay.status, 200); const data = await replay.json();
  assert.equal(data.briefId, created.briefId); assert.equal(data.briefs.length, 100);
  assert.equal(next.store.db.prepare('PRAGMA user_version').get().user_version, 1);
  assert.equal(next.store.db.prepare('SELECT count(*) n FROM brief_create_requests').get().n, 1);
  assert.equal((await next.request('/api/briefs', { ...again, method: 'POST', body: { ...body, requestId: randomUUID() } })).status, 409);
});

test('brief creation and its receipt roll back together, preserving safe retries', async t => {
  const f = await fixture(t), login = await f.login(), body = { ...brief, requestId: randomUUID() };
  f.store.db.exec("CREATE TRIGGER fail_brief_receipt BEFORE INSERT ON brief_create_requests BEGIN SELECT RAISE(ABORT,'fixture receipt failure'); END");
  assert.equal((await f.request('/api/briefs', { ...login, method: 'POST', body })).status, 500);
  assert.equal(f.store.count(login.user.id), 0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM brief_create_requests').get().n, 0);
  f.store.db.exec('DROP TRIGGER fail_brief_receipt');
  assert.equal((await f.request('/api/briefs', { ...login, method: 'POST', body })).status, 201);
  assert.equal(f.store.count(login.user.id), 1);
});

test('brief creation request IDs are optional, validated and separate from imported source IDs', async t => {
  const f = await fixture(t), login = await f.login(), requestId = randomUUID();
  for (const invalid of [null, 42, '', 'not-a-uuid', '../request']) {
    assert.equal((await f.request('/api/briefs', { ...login, method: 'POST', body: { ...brief, requestId: invalid } })).status, 400);
  }
  const legacy = await f.request('/api/briefs', { ...login, method: 'POST', body: brief });
  assert.equal(legacy.status, 201); assert.deepEqual(Object.keys(await legacy.json()), ['briefs']);
  assert.equal((await f.request('/api/briefs/import', { ...login, method: 'POST', body: { briefs: [{ ...brief, sourceId: requestId }] } })).status, 200);
  const fresh = await f.request('/api/briefs', { ...login, method: 'POST', body: { ...brief, requestId } });
  assert.equal(fresh.status, 201); assert.equal(f.store.count(login.user.id), 3);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM brief_create_requests').get().n, 1);
  const unauthorized = await f.request('/api/briefs', { ...login, csrf: '', method: 'POST', body: { ...brief, requestId } });
  assert.equal(unauthorized.status, 403); assert.equal(f.store.count(login.user.id), 3);
});

test('adding the brief creation ledger preserves existing databases and import identities', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ndai-brief-migration-')), database = join(directory, 'studio.sqlite');
  try {
    let store = new Store(database);
    const user = store.login({ id: '123456789012345678', username: 'creator', displayName: 'Creator', avatar: null });
    const id = store.create(user.id, brief, 'existing-import');
    store.db.exec('DROP TABLE brief_create_requests'); store.close();
    store = new Store(database);
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(store.list(user.id)[0].id, id);
    assert.equal(store.db.prepare('SELECT source_id FROM briefs WHERE id=?').get(id).source_id, 'existing-import');
    assert.equal(store.db.prepare('SELECT count(*) n FROM brief_create_requests').get().n, 0); store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
