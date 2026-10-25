import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const root = new URL('../', import.meta.url);
const origin = 'https://ai.nightz.dev';
const assets = ['index.html', 'styles.css', 'app.js', 'data.js', 'catalog.json', 'account.js', 'account.css', 'controls.js', 'workspace.html', 'workspace.css', 'workspace.js', 'workspace-drafts.js', 'models.js', 'models.css', 'branding.css', 'legal.css', 'nd-logo.webp', 'favicon.png', 'favicon.ico', 'policies.html', 'terms.html', 'privacy.html', 'acceptable-use.html'];
const digest = value => createHash('sha256').update(value).digest('hex');

// Every request uses loopback, a fresh connection and normal TLS verification.
// Host and TLS SNI still identify ai.nightz.dev. Never follow redirects.
export function requestLocal(address, timeoutMs = 3000) {
  const url = new URL(address);
  const secure = url.protocol === 'https:';
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported probe protocol.');
  return new Promise((resolve, reject) => {
    let timer;
    const request = (secure ? https : http).request({
      hostname: '127.0.0.1', port: url.port || (secure ? 443 : 80),
      servername: secure ? url.hostname : undefined,
      path: `${url.pathname}${url.search}`, method: 'GET', agent: false,
      headers: { host: url.host, connection: 'close', 'accept-encoding': 'identity' }
    }, response => {
      const parts = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) {
          request.destroy(new Error('Probe response exceeded the size limit.'));
          return;
        }
        parts.push(chunk);
      });
      response.on('end', () => {
        clearTimeout(timer);
        resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(parts) });
      });
      response.on('error', () => {
        clearTimeout(timer);
        reject(new Error('Probe response was interrupted.'));
      });
    });
    request.on('error', error => {
      clearTimeout(timer);
      reject(new Error(`Connection failed (${error.code || 'request error'}).`));
    });
    timer = setTimeout(() => request.destroy(Object.assign(new Error('Probe timed out.'), { code: 'ETIMEDOUT' })), timeoutMs);
    request.end();
  });
}

export function validateProbe(response, probe) {
  const expectedStatus = probe.kind === 'callback' ? 303 : 200;
  if (response.status !== expectedStatus) throw new Error(`HTTP ${response.status}; expected ${expectedStatus}.`);
  if (probe.kind === 'asset') {
    if (digest(response.body) !== probe.digest) throw new Error('Served asset does not match this build.');
    return;
  }
  if (probe.kind === 'callback') {
    if (response.headers.location !== '/?auth=expired#account') throw new Error('Auth callback reached an unexpected handler.');
    return;
  }
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers['content-type'] || '')) {
    throw new Error('Expected a JSON API response, not an HTML fallback.');
  }
  let data;
  try { data = JSON.parse(response.body.toString('utf8')); }
  catch { throw new Error('API returned invalid JSON.'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Unexpected API response.');
  if (probe.kind === 'health' && (data.ok !== true || data.version !== probe.version)) {
    throw new Error('Health response does not match the expected application version.');
  }
  if (probe.kind === 'session' && (data.configured !== true || data.user !== null || data.csrf !== null)) {
    throw new Error('Anonymous session check failed or Discord OAuth credentials are not configured.');
  }
}

export async function waitForProbes(probes, { timeoutMs = 30000, intervalMs = 500, request = requestLocal } = {}) {
  const deadline = performance.now() + timeoutMs;
  let lastError = new Error('No readiness probes completed.');
  while (performance.now() < deadline) {
    let ready = true;
    for (const probe of probes) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) { ready = false; break; }
      try {
        validateProbe(await request(probe.url, Math.max(1, Math.min(3000, remaining))), probe);
      } catch (error) {
        lastError = new Error(`${probe.label}: ${error.message}`);
        ready = false;
        break;
      }
    }
    if (ready && performance.now() < deadline) return;
    const remaining = deadline - performance.now();
    if (remaining > 0) await sleep(Math.min(intervalMs, remaining));
  }
  throw new Error(`Readiness deadline reached. ${lastError.message}`);
}

export async function deploymentProbes(mode, directory = root) {
  if (mode === 'frontend') {
    return Promise.all(assets.map(async file => ({ kind: 'asset', label: `HTTPS /${file}`,
      url: `${origin}/${file}`, digest: digest(await readFile(new URL(`dist/${file}`, directory))) })));
  }
  if (!['backend', 'proxy'].includes(mode)) throw new Error('Usage: node deploy/verify-accounts.mjs backend|proxy|frontend');
  const { version } = JSON.parse(await readFile(new URL('package.json', directory), 'utf8'));
  const base = mode === 'backend' ? 'http://127.0.0.1:3081' : origin;
  const probes = [{ kind: 'health', label: `${mode} /api/health`, url: `${base}/api/health`, version }];
  if (mode === 'proxy') probes.push(
    { kind: 'session', label: 'HTTPS /api/session', url: `${base}/api/session` },
    { kind: 'callback', label: 'HTTPS /auth/discord/callback', url: `${base}/auth/discord/callback` }
  );
  return probes;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const mode = process.argv[2];
    await waitForProbes(await deploymentProbes(mode));
    console.log(`${mode} readiness checks passed.`);
  } catch (error) {
    // Never print response bodies, cookies, OAuth credentials or authorization URLs.
    console.error(error.message);
    process.exitCode = 1;
  }
}
