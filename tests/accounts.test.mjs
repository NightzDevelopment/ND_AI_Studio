import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { createApp, hash } from '../server/app.mjs';
import { readConfig } from '../server/config.mjs';
import { discordIdentity } from '../server/discord.mjs';
const catalog = JSON.parse(readFileSync(new URL('../config/tools.json', import.meta.url), 'utf8'));
const brief = { name: 'ND_Garage', requirements: 'Use oxmysql and preserve vehicle state.', toolId: 'ai-script-generator', target: 'ND_Framework' };

async function fixture(t) {
  const store = new Store(':memory:');
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
  t.after(async () => { app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); store.close(); });
  return { request, login, store, config, calls: () => calls };
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
