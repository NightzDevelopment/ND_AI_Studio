import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

test('the installed worker release includes the complete pure agent validation and diagnostics dependency graph',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'nd-agent-release-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  cpSync(new URL('../worker/',import.meta.url),join(directory,'worker'),{recursive:true});
  mkdirSync(join(directory,'server'));
  const installer=readFileSync(new URL('../deploy/setup-worker.sh',import.meta.url),'utf8');
  for(const name of ['studio-domain.mjs','agent-actions.mjs','agent-errors.mjs']){
    assert.ok(installer.includes(`server/${name}`),`${name} is explicitly installed`);
    cpSync(new URL(`../server/${name}`,import.meta.url),join(directory,'server',name));
  }
  const entry=await import(pathToFileURL(join(directory,'worker/start.mjs')));
  assert.equal(typeof entry.runJob,'function');assert.equal(typeof entry.main,'function');
});
