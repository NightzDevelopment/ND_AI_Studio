import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { deploymentProbes, requestLocal, validateProbe, waitForProbes } from '../deploy/verify-accounts.mjs';

const health = { kind: 'health', label: 'HTTPS /api/health', url: 'https://ai.nightz.dev/api/health', version: '0.2.0' };
const json = data => ({ status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: Buffer.from(JSON.stringify(data)) });
const ready = () => json({ ok: true, version: '0.2.0' });
const hash = value => createHash('sha256').update(value).digest('hex');

async function listening(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return server.address().port;
}

test('backend startup retries a refused connection rather than rejecting the deployment immediately', async () => {
  let attempts = 0;
  await waitForProbes([health], { timeoutMs: 500, intervalMs: 1, request: async () => {
    if (++attempts === 1) throw new Error('Connection failed (ECONNREFUSED).');
    return ready();
  } });
  assert.equal(attempts, 2);
});

test('Nginx reload readiness retries old-worker 404 and temporary 502 responses', async () => {
  let attempts = 0;
  await waitForProbes([health], { timeoutMs: 500, intervalMs: 1, request: async () => {
    const status = [404, 502, 200][attempts++];
    return status === 200 ? ready() : { status, headers: {}, body: Buffer.from('old worker') };
  } });
  assert.equal(attempts, 3);
});

test('permanent 404 fails with the affected route and never prints the response body', async () => {
  await assert.rejects(waitForProbes([health], { timeoutMs: 25, intervalMs: 1,
    request: async () => ({ status: 404, headers: {}, body: Buffer.from('private-response-content') })
  }), error => {
    assert.match(error.message, /deadline.*HTTPS \/api\/health: HTTP 404/);
    assert.doesNotMatch(error.message, /private-response-content/);
    return true;
  });
});

test('health readiness rejects HTML fallbacks, redirects, invalid JSON and wrong app versions', () => {
  for (const response of [
    { ...ready(), status: 302 },
    { ...ready(), headers: { 'content-type': 'text/html' } },
    { ...ready(), body: Buffer.from('{') },
    json(null), json([]), json({ ok: false, version: '0.2.0' }), json({ ok: true, version: '0.1.0' })
  ]) assert.throws(() => validateProbe(response, health));
  assert.doesNotThrow(() => validateProbe(ready(), health));
});

test('session readiness requires configured OAuth credentials and an anonymous response', () => {
  const probe = { kind: 'session' };
  for (const data of [{ configured: false, user: null, csrf: null }, { configured: true },
    { configured: true, user: { id: 'unexpected' }, csrf: 'unexpected' }]) {
    assert.throws(() => validateProbe(json(data), probe));
  }
  assert.doesNotThrow(() => validateProbe(json({ configured: true, user: null, csrf: null }), probe));
});

test('callback readiness validates the missing-state handler without starting a Discord login', () => {
  const probe = { kind: 'callback' };
  const response = { status: 303, headers: { location: '/?auth=expired#account' }, body: Buffer.alloc(0) };
  assert.doesNotThrow(() => validateProbe(response, probe));
  assert.throws(() => validateProbe({ ...response, status: 200 }, probe));
  assert.throws(() => validateProbe({ ...response, headers: { location: 'https://discord.com/' } }, probe));
});

test('published assets must match the build bytes, not merely return HTTP 200', async () => {
  const body = Buffer.from('export const release = 2;');
  const probe = { kind: 'asset', label: 'HTTPS /account.js', url: 'https://ai.nightz.dev/account.js', digest: hash(body) };
  let attempts = 0;
  await waitForProbes([probe], { timeoutMs: 500, intervalMs: 1, request: async () => ({ status: 200, headers: {},
    body: ++attempts === 1 ? Buffer.from('<html>wrong site</html>') : body }) });
  assert.equal(attempts, 2);
});

test('probe batches cannot pass when a later route is still broken', async () => {
  const session = { kind: 'session', label: 'HTTPS /api/session', url: 'https://ai.nightz.dev/api/session' };
  let attempts = 0;
  await waitForProbes([health, session], { timeoutMs: 500, intervalMs: 1, request: async url => {
    if (url === health.url) return ready();
    return ++attempts === 1 ? { status: 404, headers: {}, body: Buffer.alloc(0) } : json({ configured: true, user: null, csrf: null });
  } });
  assert.equal(attempts, 2);
});

test('HTTP probes connect only to loopback and preserve the intended Host header', async t => {
  let seen;
  const port = await listening(t, (req, res) => {
    seen = { host: req.headers.host, connection: req.headers.connection };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const response = await requestLocal(`http://not-a-real-public-host.invalid:${port}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(seen, { host: `not-a-real-public-host.invalid:${port}`, connection: 'close' });
});

test('HTTP probes enforce a request deadline', async t => {
  const port = await listening(t, () => {});
  await assert.rejects(requestLocal(`http://127.0.0.1:${port}/api/health`, 20), /ETIMEDOUT/);
});

test('HTTP probes reject oversized responses', async t => {
  const port = await listening(t, (req, res) => res.end(Buffer.alloc(2 * 1024 * 1024 + 1)));
  await assert.rejects(requestLocal(`http://127.0.0.1:${port}/api/health`));
});

test('deployment phases derive the version and verify every approved published asset', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nd-ready-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = pathToFileURL(`${directory}/`);
  await writeFile(join(directory, 'package.json'), '{"version":"test-version"}');
  await mkdir(join(directory, 'dist'));
  const names = ['index.html', 'styles.css', 'app.js', 'data.js', 'catalog.json', 'account.js', 'account.css', 'controls.js', 'workspace.html', 'workspace.css', 'workspace.js', 'models.js', 'models.css', 'branding.css', 'legal.css', 'nd-logo.webp', 'favicon.png', 'favicon.ico', 'policies.html', 'terms.html', 'privacy.html', 'acceptable-use.html'];
  for (const file of names) await writeFile(join(directory, 'dist', file), file);
  const backend = await deploymentProbes('backend', root);
  assert.equal(backend[0].url, 'http://127.0.0.1:3081/api/health');
  assert.equal(backend[0].version, 'test-version');
  const proxy = await deploymentProbes('proxy', root);
  assert.deepEqual(proxy.map(probe => probe.kind), ['health', 'session', 'callback']);
  const assets = await deploymentProbes('frontend', root);
  assert.equal(assets.length, 22);
  assert.equal(assets[5].digest, hash('account.js'));
  await assert.rejects(deploymentProbes('invalid', root), /Usage:/);
});

const script = await readFile(new URL('../deploy/setup-accounts.sh', import.meta.url), 'utf8');
const functionText = name => script.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))[0];

test('installer validates proxy readiness before publishing and then verifies frontend bytes', () => {
  assert.equal(spawnSync('bash', ['-n'], { input: script }).status, 0);
  const backend = script.indexOf('node deploy/verify-accounts.mjs backend');
  const proxy = script.indexOf('node deploy/verify-accounts.mjs proxy');
  const publish = script.indexOf('bash deploy/publish.sh');
  const frontend = script.indexOf('node deploy/verify-accounts.mjs frontend');
  assert.ok(backend > 0 && proxy > backend && publish > proxy && frontend > publish);
});

test('Nginx preflight rejects Studio duplicates but does not treat unrelated cloud warnings as Studio failures', () => {
  for (const [domain, expected] of [['ai.nightz.dev', 1], ['cloud.nightz.dev', 0]]) {
    const result = spawnSync('bash', ['-c', `${functionText('check_nginx')}\nnginx() { printf '%s\\n' '[warn] conflicting server name "${domain}" on 0.0.0.0:443, ignored' >&2; }; check_nginx`]);
    assert.equal(result.status, expected);
  }
});

test('first-install rollback does not stop an already removed service a second time', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nd-rollback-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'backup'));
  await mkdir(join(directory, 'backend'));
  await writeFile(join(directory, 'backup', 'site'), 'old-site');
  await writeFile(join(directory, 'site'), 'new-site');
  await writeFile(join(directory, 'unit'), 'new-unit');
  const result = spawnSync('bash', ['-c', `
    set +e
    backup_dir="$TEST_ROOT/backup"; site="$TEST_ROOT/site"; unit="$TEST_ROOT/unit"
    snippet="$TEST_ROOT/snippet"; base="$TEST_ROOT/backend"; old_backend=''; old_frontend=''; active_before=0; phase='test'
    systemctl() { printf '%s\\n' "$*" >> "$TEST_ROOT/calls"; }
    ss() { :; }; nginx() { :; }
    ${functionText('rollback')}
    false
    rollback
  `], { env: { ...process.env, TEST_ROOT: directory } });
  assert.equal(result.status, 1);
  const calls = await readFile(join(directory, 'calls'), 'utf8');
  assert.match(calls, /disable --now nd-ai-studio.service/);
  assert.doesNotMatch(calls, /^stop nd-ai-studio.service$/m);
  assert.equal(await readFile(join(directory, 'site'), 'utf8'), 'old-site');
  assert.equal(await readFile(join(directory, 'backup', 'failed-site'), 'utf8'), 'new-site');
});
