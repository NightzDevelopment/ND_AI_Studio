import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixture } from './fixtures/agent-http.mjs';

test('ordinary agent browser fixture serves every referenced local stylesheet and module',async t=>{
  const fixture=await createFixture();t.after(()=>fixture.close());
  const html=await (await fetch(fixture.config.origin+'/agent.html')).text();
  const paths=[...html.matchAll(/(?:href|src)="(\/[a-z0-9-]+\.(?:css|js))"/g)].map(match=>match[1]);
  assert.ok(paths.includes('/workbench-ui.js'));assert.ok(paths.includes('/workbench-ui.css'));
  for(const path of paths){const response=await fetch(fixture.config.origin+path);assert.equal(response.status,200,`${path} must be served through normal browser navigation`);assert.match(response.headers.get('content-type'),path.endsWith('.css')?/text\/css/:/text\/javascript/);}
});
