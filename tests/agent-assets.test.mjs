import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {deploymentProbes} from '../deploy/verify-accounts.mjs';
const root=new URL('../',import.meta.url),read=file=>readFile(new URL(file,root),'utf8');

test('agent assets are built, previewed, published and byte-probed alongside billing assets',async t=>{
  const build=await read('scripts/build.mjs'),serve=await read('scripts/serve.mjs'),publisher=await read('deploy/publish.sh');
  const names=publisher.match(/^files=\(([^)]+)\)/m)[1].split(' ');
  assert.equal(names.length,27);assert.equal(new Set(names).size,names.length);
  for(const file of ['billing.js','agent.html','agent.js','agent.css']){assert.ok(names.includes(file));assert.ok(build.includes(`'${file}'`));assert.ok(serve.includes(`'/${file}'`));}
  const dir=await mkdtemp(join(tmpdir(),'nd-agent-assets-'));t.after(()=>rm(dir,{recursive:true,force:true}));await mkdir(join(dir,'dist'));
  for(const file of names)await writeFile(join(dir,'dist',file),file);
  const probes=await deploymentProbes('frontend',pathToFileURL(`${dir}/`));assert.deepEqual(probes.map(p=>new URL(p.url).pathname.slice(1)),names);
});
test('agent page references existing DOM controls without executing project source',async()=>{
  const html=await read('web/agent.html'),script=await read('web/agent.js');const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);assert.equal(new Set(ids).size,ids.length);
  for(const m of script.matchAll(/\$\('([^']+)'\)/g))assert.ok(ids.includes(m[1]),`Missing DOM element ${m[1]}`);
  assert.doesNotMatch(script,/innerHTML|document\.write|\beval\s*\(/);
  assert.match(html,/Interactive NUI simulation and agent browser testing are not enabled yet/);
  assert.match(html,/\/nd-logo.webp/);assert.match(html,/\/favicon.ico/);
});
test('legacy API and worker integration are additive with agent capability advertisement',async()=>{
  const app=await read('server/app.mjs'),worker=await read('worker/start.mjs');
  assert.ok(app.indexOf('await agent.route')<app.indexOf('await studio.route'));
  assert.match(worker,/job\.agent \? runAgentTask : runJob/);assert.match(worker,/'x-nd-studio-agent':'1'/);
  for(const file of ['server/studio-models.mjs','server/subscriptions.mjs'])assert.match(await read(file),/NOT IN \('queued','running','agent'\)/);
});
