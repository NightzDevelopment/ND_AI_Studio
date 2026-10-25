import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderSiteAsset } from '../scripts/site-pages.mjs';
import { renderPolicyPages, policyDocuments, policyNotice } from '../scripts/policies.mjs';
import { deploymentProbes, validateProbe } from '../deploy/verify-accounts.mjs';

const indexFixture = '<html><head></head><body><a class="brand"><span class="brand-mark">N<span>D</span></span>AI STUDIO</a><footer>Nightz Development</footer></body></html>';
const workspaceFixture = '<html><head></head><body><a class="brand"><b>N<span>D</span></b>AI STUDIO</a><a class="primary" href="/auth/discord">Continue with Discord</a><p class="fine muted">This request and the current project\'s source are sent to the configured AI provider. Never include credentials.</p><footer>Nightz Development</footer></body></html>';
const accountFixture = 'const view = `<div class="identity-symbol" aria-hidden="true">ND</div><a id="discord-login" class="primary discord-login" href="/auth/discord" hidden>Continue with Discord <span aria-hidden="true">↗</span></a>`;';
const published = ['index.html','styles.css','app.js','data.js','catalog.json','account.js','account.css','controls.js','workspace.html','workspace.css','workspace.js','workspace-drafts.js','models.js','models.css','branding.css','legal.css','nd-logo.webp','favicon.png','favicon.ico','policies.html','terms.html','privacy.html','acceptable-use.html'];
const pages = renderPolicyPages();

test('three policy drafts and their overview render as standalone static HTML', () => {
  assert.equal(policyDocuments.length, 3);
  assert.deepEqual(Object.keys(pages), ['policies.html', 'terms.html', 'privacy.html', 'acceptable-use.html']);
  for (const html of Object.values(pages)) {
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /<html lang="en">/);
    assert.match(html, /DRAFT \/ NOT IN EFFECT/);
    assert.match(html, /No effective date assigned/);
    assert.match(html, /content="noindex,nofollow"/);
    assert.doesNotMatch(html, /<script|<form|type="checkbox"|mailto:/i);
  }
});

test('drafts identify unresolved decisions without inventing contacts or legal entity details', () => {
  const all = Object.values(pages).join('\n');
  assert.doesNotMatch(all, /support@|privacy@|legal@| LLC| Inc\.|governed by the laws|all sales are final|30-day refund/i);
  assert.match(all, /legal business identity/);
  assert.match(all, /deletion-request/);
  assert.match(all, /pricing/i);
  assert.match(all, /not active agreements|not final polic/i);
  assert.doesNotMatch(all, /[\u2013\u2014]/u);
});

test('privacy distinguishes a source snapshot from the open file and archives from deletion', () => {
  assert.match(pages['privacy.html'], /not limited to the file currently open/i);
  assert.match(pages['privacy.html'], /Archiving a project is not deletion/);
  assert.match(pages['privacy.html'], /does not, by itself, mean the provider retains no data/);
  assert.match(pages['privacy.html'], /self-service account-deletion control/);
  assert.match(pages['privacy.html'], /membership and roles/);
});

test('policy navigation stays on ai.nightz.dev and resolves every local link', () => {
  for (const html of Object.values(pages)) {
    const paths = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map(match => match[1]);
    for (const value of paths) {
      assert.ok(value.startsWith('/') || value.startsWith('#'), value);
      const path = value.split(/[?#]/)[0].slice(1);
      assert.ok(!path || published.includes(path), value);
    }
    assert.equal((html.match(/<h1>/g) || []).length, 1);
    assert.equal((html.match(/aria-current="page"/g) || []).length, 1);
  }
});

test('overview and source workspace get the supplied logo, favicon and draft footer links', () => {
  for (const [file, template] of [['index.html', indexFixture], ['workspace.html', workspaceFixture]]) {
    const html = renderSiteAsset(file, template);
    assert.match(html, /src="\/nd-logo.webp"/);
    assert.match(html, /href="\/favicon.ico\?v=nd-20261025"/);
    assert.match(html, /href="\/favicon.png\?v=nd-20261025"/);
    assert.match(html, /aria-label="Policy drafts"/);
    assert.doesNotMatch(html, /<b>N<span>D|class="brand-mark"/);
  }
});

test('login disclosures do not assert agreement and retain the existing OAuth route', () => {
  for (const [file, template] of [['workspace.html', workspaceFixture], ['account.js', accountFixture]]) {
    const output = renderSiteAsset(file, template);
    assert.ok(output.includes(policyNotice));
    assert.match(output, /href="\/auth\/discord"/);
    assert.match(output, /does not record acceptance/);
    assert.doesNotMatch(output, /type="checkbox"|I agree|by continuing.*agree/i);
  }
  assert.match(renderSiteAsset('account.js', accountFixture), /nd-brand-symbol/);
  assert.match(renderSiteAsset('workspace.html', workspaceFixture), /not only the open file/);
});

test('template marker drift and repeat processing fail rather than silently duplicating links', () => {
  assert.throws(() => renderSiteAsset('index.html', indexFixture.replace('</head>', '')), /Expected one/);
  assert.throws(() => renderSiteAsset('index.html', indexFixture.replace('</footer>', '</footer><footer></footer>')), /Expected one/);
  assert.throws(() => renderSiteAsset('account.js', accountFixture.replace('identity-symbol', 'different')), /Expected one/);
  assert.throws(() => renderSiteAsset('index.html', renderSiteAsset('index.html', indexFixture)), /Expected one/);
});

test('non-presentation assets are returned without changes', () => {
  const source = 'export const value = "unchanged";\n';
  assert.equal(renderSiteAsset('app.js', source), source);
  for (const file of ['workspace.js', 'workspace-drafts.js', 'models.js', 'models.css']) assert.equal(renderSiteAsset(file, source), source);
});

test('logo and favicons have real image signatures and distinct ICO size entries', async () => {
  const read = file => readFile(new URL(`../web/${file}`, import.meta.url));
  const webp = await read('nd-logo.webp'), png = await read('favicon.png'), ico = await read('favicon.ico');
  assert.equal(webp.subarray(0,4).toString(), 'RIFF');
  assert.equal(webp.subarray(8,12).toString(), 'WEBP');
  assert.deepEqual(png.subarray(0,8), Buffer.from([137,80,78,71,13,10,26,10]));
  assert.equal(png.readUInt32BE(16), 48); assert.equal(png.readUInt32BE(20), 48);
  assert.equal(ico.readUInt16LE(0), 0); assert.equal(ico.readUInt16LE(2), 1); assert.equal(ico.readUInt16LE(4), 3);
  assert.deepEqual([ico[6], ico[22], ico[38]], [16,32,48]);
  for (let i = 0; i < 3; i++) {
    const entry = 6 + i * 16, length = ico.readUInt32LE(entry + 8), offset = ico.readUInt32LE(entry + 12);
    assert.ok(offset + length <= ico.length && length > 0);
  }
});

test('publish and HTTPS readiness include all 23 assets, including policy and branding files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nd-brand-ready-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'dist'));
  for (const file of published) await writeFile(join(directory, 'dist', file), file);
  const probes = await deploymentProbes('frontend', pathToFileURL(directory + '/'));
  assert.equal(probes.length, 23);
  assert.deepEqual(probes.map(probe => new URL(probe.url).pathname.slice(1)), published);
  const publisher = await readFile(new URL('../deploy/publish.sh', import.meta.url), 'utf8');
  assert.deepEqual(publisher.match(/^files=\(([^)]+)\)/m)[1].split(' '), published);
  const favicon = probes.find(probe => probe.url.endsWith('/favicon.ico'));
  assert.doesNotThrow(() => validateProbe({ status:200, body:Buffer.from('favicon.ico') }, favicon));
  assert.throws(() => validateProbe({ status:200, body:Buffer.from('wrong file') }, favicon));
});

test('all generated draft HTML escapes text rather than embedding user-supplied markup', () => {
  const original = policyDocuments[0].title;
  try {
    policyDocuments[0].title = '<img src=x onerror=alert(1)>';
    const html = renderPolicyPages()['terms.html'];
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(html, /<img src=x/);
  } finally { policyDocuments[0].title = original; }
});
