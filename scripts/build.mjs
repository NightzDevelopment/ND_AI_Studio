import { mkdir, rm, copyFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { validateCatalog } from '../web/data.js';
const root = new URL('../', import.meta.url);
const output = new URL('dist/', root);
const catalog = validateCatalog(JSON.parse(await readFile(new URL('config/tools.json', root), 'utf8')));
if (catalog.tools.length !== 24) throw new Error('Expected the approved 24-tool catalog.');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const file of ['index.html', 'styles.css', 'app.js', 'data.js', 'account.js', 'account.css', 'controls.js']) {
  await copyFile(new URL(`web/${file}`, root), new URL(file, output));
}
await copyFile(new URL('config/tools.json', root), new URL('catalog.json', output));
console.log(`Built Studio frontend: ${fileURLToPath(output)}`);
