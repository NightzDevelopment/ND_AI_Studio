import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateCatalog, filterTools, parseBriefs, serializeBriefs, MAX_BRIEFS } from '../web/data.js';
const catalog = JSON.parse(await readFile(new URL('../config/tools.json', import.meta.url), 'utf8'));
const brief = { id: 'test-brief', toolId: 'ai-script-generator', name: 'ND_Garage', requirements: 'Persistent vehicles', target: 'ND_Framework', updatedAt: '2026-10-25T00:00:00Z' };
test('catalog contains the approved 17 creation, 4 conversion and 3 browse tools', () => {
  validateCatalog(catalog);
  assert.equal(catalog.tools.length, 24);
  for (const [category, count] of [['create', 17], ['convert-bundle', 4], ['browse', 3]]) assert.equal(filterTools(catalog.tools, '', category).length, count);
});
test('every generation tool remains disabled and honestly labeled', () => {
  for (const tool of catalog.tools) { assert.equal(tool.enabled, false); assert.equal(tool.status, 'planned'); }
});
test('duplicate and enabled catalog entries fail validation', () => {
  assert.throws(() => validateCatalog({ ...catalog, tools: [...catalog.tools, catalog.tools[0]] }));
  assert.throws(() => validateCatalog({ ...catalog, tools: [{ ...catalog.tools[0], enabled: true }] }));
});
test('search combines category, text terms and framework names', () => {
  assert.equal(filterTools(catalog.tools, '  SCRIPT   ND_Framework ', 'create')[0].id, 'ai-script-generator');
  assert.equal(filterTools(catalog.tools, 'nonexistent').length, 0);
  assert.equal(filterTools(catalog.tools, 'discord', 'browse').length, 0);
});
test('empty and valid project storage round-trip without executing user text', () => {
  assert.deepEqual(parseBriefs(null, catalog.tools), []);
  const item = { ...brief, name: '<script>alert(1)</script>' };
  assert.deepEqual(parseBriefs(serializeBriefs([item]), catalog.tools), [item]);
});
test('malformed, duplicate, unknown-tool and over-limit briefs are rejected', () => {
  assert.throws(() => parseBriefs('{', catalog.tools));
  for (const item of [{ ...brief, toolId: 'missing' }, { ...brief, name: ' ' }, { ...brief, requirements: 'x'.repeat(12001) }, { ...brief, updatedAt: 'bad' }]) assert.throws(() => parseBriefs(serializeBriefs([item]), catalog.tools));
  assert.throws(() => parseBriefs(serializeBriefs([brief, brief]), catalog.tools));
  assert.throws(() => parseBriefs(serializeBriefs(Array(MAX_BRIEFS + 1).fill(brief)), catalog.tools));
});
