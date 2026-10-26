import { mkdir, rm, copyFile, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { validateCatalog } from '../web/data.js';
import { renderPolicyPages } from './policies.mjs';
import { renderSiteAsset } from './site-pages.mjs';
const root = new URL('../', import.meta.url);
const output = new URL('dist/', root);
const catalog = validateCatalog(JSON.parse(await readFile(new URL('config/tools.json', root), 'utf8')));
if (catalog.tools.length !== 24) throw new Error('Expected the approved 24-tool catalog.');
const transformed = new Map();
// Validate presentation markers before replacing a previous local build.
for (const file of ['index.html', 'workspace.html', 'account.js']) {
  transformed.set(file, renderSiteAsset(file, await readFile(new URL(`web/${file}`, root), 'utf8')));
}
const policies = renderPolicyPages();
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const file of ['index.html', 'styles.css', 'app.js', 'data.js', 'account.js', 'account.css', 'controls.js', 'workspace.html', 'workspace.css', 'workspace.js', 'workspace-drafts.js', 'models.js', 'models.css', 'billing.js', 'branding.css', 'legal.css', 'nd-logo.webp', 'favicon.png', 'favicon.ico', 'agent.html', 'agent.js', 'agent.css']) {
  if (transformed.has(file)) await writeFile(new URL(file, output), transformed.get(file));
  else await copyFile(new URL(`web/${file}`, root), new URL(file, output));
}
for (const [file, html] of Object.entries(policies)) await writeFile(new URL(file, output), html);
await copyFile(new URL('config/tools.json', root), new URL('catalog.json', output));
console.log(`Built Studio frontend: ${fileURLToPath(output)}`);
