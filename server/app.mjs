import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { authorizeUrl, discordIdentity } from './discord.mjs';

export const FRAMEWORKS = ['Standalone', 'ND_Framework', 'ESX', 'QBCore', 'Qbox', 'vRP', 'ox_core', 'Custom'];
export const hash = value => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const validToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const equal = (a, b) => validToken(a) && validToken(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };
function text(value, max, label, required = true) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()) || /[\u0000]/u.test(value)) {
    fail(400, `Invalid ${label}.`);
  }
  return value.trim();
}
function fields(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) {
    fail(400, 'Unexpected request fields.');
  }
}
function version(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail(400, 'A valid revision is required.');
  return value;
}
function briefData(body, tools) {
  fields(body, ['name', 'requirements', 'toolId', 'target', 'version', 'sourceId']);
  const tool = tools.find(item => item.id === body.toolId && item.category !== 'browse');
  if (!tool) fail(400, 'Choose a creation or conversion tool.');
  if (tool.engine === 'coding' && !FRAMEWORKS.includes(body.target)) fail(400, 'Invalid target framework.');
  return { name: text(body.name, 80, 'project name'), requirements: text(body.requirements, 12000, 'requirements'),
    toolId: tool.id, target: tool.engine === 'coding' ? body.target : 'Asset workspace', version: body.version };
}
export function publicUser(user) {
  return { id: user.id, discordId: user.discord_id, username: user.username, displayName: user.display_name,
    avatarUrl: user.avatar ? `https://cdn.discordapp.com/avatars/${user.discord_id}/${user.avatar}.png?size=128` : null,
    bio: user.bio, preferredFramework: user.preferred_framework, density: user.density,
    version: user.version, createdAt: user.created_at, updatedAt: user.updated_at };
}
function cookies(req) {
  const result = Object.create(null);
  for (const item of (req.headers.cookie || '').split(';')) {
    const index = item.indexOf('=');
    if (index < 0) continue;
    const name = item.slice(0, index).trim();
    if (Object.hasOwn(result, name)) { result[name] = ''; continue; }
    result[name] = item.slice(index + 1).trim();
  }
  return result;
}
function readJson(req, limit = 65536) {
  if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json') || req.headers['content-encoding']) {
    fail(415, 'Send uncompressed application/json.');
  }
  return new Promise((resolve, reject) => {
    let bytes = 0, oversized = false;
    const parts = [];
    req.on('data', chunk => {
      if (oversized) return;
      bytes += chunk.length;
      if (bytes > limit) { oversized = true; parts.length = 0; reject(new HttpError(413, 'Request is too large.')); }
      else parts.push(chunk);
    });
    req.on('end', () => {
      if (oversized) return;
      try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8'))); }
      catch { reject(new HttpError(400, 'Invalid JSON.')); }
    });
    req.on('error', () => reject(new HttpError(400, 'Request interrupted.')));
    req.on('aborted', () => reject(new HttpError(400, 'Request interrupted.')));
  });
}

export function createApp({ config, store, catalog, identity = discordIdentity, logger = console }) {
  const rates = new Map();
  function rate(req, group, max, windowMs) {
    const peer = req.socket.remoteAddress;
    const forwarded = req.headers['x-real-ip'];
    const ip = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer) && typeof forwarded === 'string' && isIP(forwarded)
      ? forwarded : peer;
    const now = Date.now(), key = `${group}:${ip}`;
    let entry = rates.get(key);
    if (!entry || entry.until <= now) {
      if (rates.size >= 20000 && !entry) fail(429, 'Service is busy. Try again shortly.');
      entry = { count: 0, until: now + windowMs };
      rates.set(key, entry);
    }
    if (++entry.count > max) fail(429, 'Too many requests. Try again shortly.');
  }
  const cleanup = setInterval(() => {
    try { store.cleanup(); }
    catch { logger.error('Account cleanup failed.'); }
    for (const [key, entry] of rates) if (entry.until <= Date.now()) rates.delete(key);
  }, 60000);
  cleanup.unref();
  const cookie = (name, value, seconds) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${config.secure ? '; Secure' : ''}`;
  const json = (res, status, data) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  };
  const redirect = (res, location) => { res.writeHead(303, { location }); res.end(); };
  function current(req) {
    const value = cookies(req)[config.sessionCookie];
    return validToken(value) ? store.session(hash(value)) : null;
  }
  function required(req) {
    const session = current(req);
    if (!session) fail(401, 'Your session ended. Sign in again before saving.');
    return session;
  }
  function mutation(req) {
    const session = required(req);
    if (req.headers.origin !== config.origin || !equal(req.headers['x-csrf-token'], session.csrf)) {
      fail(403, 'Security check failed. Reload this page and try again.');
    }
    rate(req, 'write', 90, 60000);
    return session;
  }
  const server = createServer({ maxHeaderSize: 16384, requestTimeout: 30000, headersTimeout: 15000 }, async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    try {
      const url = new URL(req.url, config.origin);
      const path = url.pathname, method = req.method;
      rate(req, 'all', 240, 60000);
      if (method === 'GET' && path === '/api/health') {
        store.db.prepare('SELECT 1').get();
        return json(res, 200, { ok: true, version: '0.2.0' });
      }
      if (method === 'GET' && path === '/api/session') {
        const session = current(req);
        return json(res, 200, { configured: Boolean(config.clientId && config.clientSecret),
          user: session ? publicUser(store.user(session.user_id)) : null, csrf: session?.csrf ?? null });
      }
      if (method === 'GET' && path === '/auth/discord') {
        if (!config.clientId || !config.clientSecret) return redirect(res, '/?auth=not-configured#account');
        rate(req, 'oauth', 15, 600000);
        store.cleanup();
        if (store.db.prepare('SELECT count(*) AS n FROM oauth_flows').get().n >= 20000) fail(503, 'Sign-in is busy.');
        const state = token(), binding = token(), verifier = token();
        store.addFlow(hash(state), hash(binding), verifier);
        res.setHeader('set-cookie', cookie(config.flowCookie, binding, 600));
        return redirect(res, authorizeUrl(config, state, verifier));
      }
      if (method === 'GET' && path === '/auth/discord/callback') {
        rate(req, 'callback', 30, 600000);
        const state = url.searchParams.get('state'), binding = cookies(req)[config.flowCookie];
        res.setHeader('set-cookie', cookie(config.flowCookie, '', 0));
        if (url.searchParams.getAll('state').length !== 1 || !validToken(state) || !validToken(binding)) {
          return redirect(res, '/?auth=expired#account');
        }
        const flow = store.takeFlow(hash(state), hash(binding));
        if (!flow) return redirect(res, '/?auth=expired#account');
        if (url.searchParams.has('error')) return redirect(res, '/?auth=cancelled#account');
        const code = url.searchParams.get('code'), issuer = url.searchParams.get('iss');
        if (!code || code.length > 2048 || url.searchParams.getAll('code').length !== 1
          || (issuer !== null && issuer !== 'https://discord.com')) return redirect(res, '/?auth=failed#account');
        try {
          const discord = await identity(config, code, flow.verifier);
          const value = token(), csrf = token();
          store.transaction(() => {
            const user = store.login(discord);
            const previous = current(req);
            if (previous) store.db.prepare('DELETE FROM sessions WHERE hash=?').run(previous.hash);
            store.newSession(hash(value), user.id, csrf, config.sessionSeconds);
          });
          res.setHeader('set-cookie', [cookie(config.flowCookie, '', 0), cookie(config.sessionCookie, value, config.sessionSeconds)]);
          return redirect(res, '/#account');
        } catch {
          logger.error('Discord sign-in failed. Credentials and provider responses are not logged.');
          return redirect(res, '/?auth=failed#account');
        }
      }
      if (method === 'POST' && ['/api/logout', '/api/logout-all'].includes(path)) {
        const session = mutation(req);
        if (path === '/api/logout-all') store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(session.user_id);
        else store.db.prepare('DELETE FROM sessions WHERE hash=?').run(session.hash);
        res.setHeader('set-cookie', cookie(config.sessionCookie, '', 0));
        return json(res, 200, { ok: true });
      }
      if (method === 'PATCH' && path === '/api/account') {
        const session = mutation(req), body = await readJson(req);
        fields(body, ['displayName', 'bio', 'preferredFramework', 'density', 'version']);
        const data = { displayName: text(body.displayName, 80, 'display name'), bio: text(body.bio, 500, 'bio', false),
          preferredFramework: body.preferredFramework, density: body.density, version: version(body.version) };
        if (!FRAMEWORKS.includes(data.preferredFramework) || !['comfortable', 'compact'].includes(data.density)) fail(400, 'Invalid preferences.');
        const user = store.profile(session.user_id, data);
        if (!user) fail(409, 'Your profile changed in another tab. Reload before saving.');
        return json(res, 200, { user: publicUser(user) });
      }
      if (method === 'GET' && path === '/api/account/export') {
        const session = required(req);
        return json(res, 200, { format: 'nd-ai-studio-account', version: 1,
          user: publicUser(store.user(session.user_id)), briefs: store.list(session.user_id) });
      }
      if (method === 'GET' && path === '/api/briefs') {
        return json(res, 200, { briefs: store.list(required(req).user_id) });
      }
      if (method === 'POST' && path === '/api/briefs/import') {
        const session = mutation(req), body = await readJson(req, 1048576);
        fields(body, ['briefs']);
        if (!Array.isArray(body.briefs) || body.briefs.length > 20) fail(400, 'Import at most 20 briefs per batch.');
        const items = body.briefs.map(item => {
          const data = briefData(item, catalog.tools);
          if (typeof item.sourceId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(item.sourceId)) fail(400, 'Invalid import identifier.');
          return { data, sourceId: item.sourceId };
        });
        let imported = 0;
        store.transaction(() => {
          for (const item of items) {
            if (store.db.prepare('SELECT 1 FROM briefs WHERE user_id=? AND source_id=?').get(session.user_id, item.sourceId)) continue;
            if (store.count(session.user_id) >= 100) fail(409, 'Your account has reached its 100-brief limit.');
            store.create(session.user_id, item.data, item.sourceId); imported++;
          }
        });
        return json(res, 200, { imported, briefs: store.list(session.user_id) });
      }
      if (method === 'POST' && path === '/api/briefs') {
        const session = mutation(req), data = briefData(await readJson(req), catalog.tools);
        store.transaction(() => {
          if (store.count(session.user_id) >= 100) fail(409, 'Your account has reached its 100-brief limit.');
          store.create(session.user_id, data);
        });
        return json(res, 201, { briefs: store.list(session.user_id) });
      }
      const match = /^\/api\/briefs\/([a-f0-9-]{36})$/.exec(path);
      if (match && ['PATCH', 'DELETE'].includes(method)) {
        const session = mutation(req), body = await readJson(req), revision = version(body.version);
        if (!store.db.prepare('SELECT 1 FROM briefs WHERE user_id=? AND id=?').get(session.user_id, match[1])) fail(404, 'Brief not found.');
        let changed;
        if (method === 'PATCH') changed = store.update(session.user_id, match[1], briefData(body, catalog.tools));
        else {
          fields(body, ['version']);
          changed = store.db.prepare('DELETE FROM briefs WHERE user_id=? AND id=? AND version=?').run(session.user_id, match[1], revision).changes;
        }
        if (!changed) fail(409, 'This brief changed in another tab. Reload the latest version before editing.');
        return json(res, 200, { briefs: store.list(session.user_id) });
      }
      fail(404, 'Endpoint not found.');
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) logger.error('Account request failed. No request bodies or credentials are logged.');
      if (status === 413) res.setHeader('connection', 'close');
      if (status === 429) res.setHeader('retry-after', '60');
      json(res, status, { error: status === 500 ? 'The account service could not complete this request.' : error.message });
    }
  });
  server.on('close', () => clearInterval(cleanup));
  return server;
}
