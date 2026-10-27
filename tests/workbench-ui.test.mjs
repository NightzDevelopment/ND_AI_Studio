import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {projectIdFromHash,normalizeDisplay,sourceLineCount,describeBuild} from '../web/workbench-ui.js';
const read=file=>readFile(new URL(`../${file}`,import.meta.url),'utf8');
const id='fdf8623f-cc1a-4860-9792-8a3de5b5d77c';

test('project links accept only a complete local project route',()=>{
  assert.equal(projectIdFromHash(`#project/${id}`),id);
  for(const value of ['', '#projects','#admin',`#project/${id}/more`,`#project/${id}?next=evil`,`#project/${id}%2f..`,'#project/../../admin','#project/javascript:alert(1)',null,undefined])assert.equal(projectIdFromHash(value),null);
});
test('display preferences accept only bounded integers and known layouts',()=>{
  assert.deepEqual(normalizeDisplay({layout:'focus',font:18}),{layout:'focus',font:18});
  for(const value of [null,undefined,{},[],{layout:'__proto__',font:'14'},{font:Infinity},{font:11},{font:21},{font:13.5}])assert.deepEqual(normalizeDisplay(value),{layout:'balanced',font:14});
  for(let size=12;size<=20;size++)assert.equal(normalizeDisplay({font:size}).font,size);
});
test('line numbers count source lines without interpreting source markup',()=>{
  assert.equal(sourceLineCount(''),1);assert.equal(sourceLineCount('a\nb\n'),3);assert.equal(sourceLineCount('a\r\nb'),2);assert.equal(sourceLineCount('<script>throw 1</script>'),1);assert.equal(sourceLineCount(null),1);
});
for(const value of ['idle','queued','running','applied','review','failed','cancelled'])test(`build summary describes the existing ${value} state`,()=>{
  const state=describeBuild(` ${value.toUpperCase()} `);assert.equal(state.state,value);assert.ok(state.message.length>20);assert.ok(state.label.length>0);
});
test('unknown build state never implies completion or refunds',()=>{
  assert.equal(describeBuild('__proto__').state,'unknown');assert.match(describeBuild('anything').message,/No success or billing outcome is inferred/);
  assert.doesNotMatch(describeBuild('cancelled').message,/refunded|free|zero|success/i);
});
test('the shared display module never sends source, task or billing mutations',async()=>{
  const source=await read('web/workbench-ui.js');
  assert.doesNotMatch(source,/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|innerHTML|document\.write|\beval\s*\(/);
  assert.doesNotMatch(source,/source\.value\s*=(?!=)|\.click\(\).*save|\.submit\s*\(/);
  assert.match(source,/Display preferences never gate saving source/);
});
test('both pages register the shared assets once and retain distinct authenticated surfaces',async()=>{
  for(const name of ['workspace','agent']){
    const html=await read(`web/${name}.html`);
    for(const asset of ['workbench-ui.css','workbench-ui.js'])assert.equal(html.split(`/${asset}`).length-1,1);
    const ids=[...html.matchAll(/\bid="([^\"]+)"/g)].map(match=>match[1]);assert.equal(new Set(ids).size,ids.length);
    for(const id of ['workbench-file-search','workbench-file-count','workbench-file-empty','workbench-font-size'])assert.ok(ids.includes(id));
    assert.doesNotMatch(html,/<iframe|srcdoc=|onclick=/i);
  }
});
test('source controller retains its IDs, form and source disclosure marker',async()=>{
  const html=await read('web/workspace.html');
  for(const id of ['editor-view','code-editor','code-highlight','file-list','file-tabs','build-state','build-form','build-history','build-log','generate-button','review-button','apply-proposal','save-file','history-button','cancel-build','download-build','build-prompt','draft-dialog','live-preview'])assert.equal(html.split(`id="${id}"`).length-1,1,id);
  assert.match(html,/current project's source are sent/);assert.match(html,/data-agent-link/);assert.match(html,/QUICK BUILD/);
  assert.match(html,/<details id="build-log-disclosure"/);
});
test('agent plan and allowance approvals remain explicit and preview availability stays honest',async()=>{
  const html=await read('web/agent.html'),js=await read('web/agent.js');
  assert.match(html,/NUI preview not connected/);assert.match(html,/Interactive NUI simulation and agent browser testing are not enabled yet/);
  for(const id of ['approve','stop','pause','resume','project-instructions','edit-plan','message','model-select','source-mode','code','save-file'])assert.ok(html.includes(`id="${id}"`));
  assert.match(js,/Authorize paid planning/);assert.match(js,/Approve this exact plan/);assert.match(js,/beforeunload/);
  assert.match(js,/\.mobile-tabs \[data-panel\]/);
});
test('published display assets retain CSP and never enable generated-page execution',async()=>{
  const serve=await read('scripts/serve.mjs');
  assert.match(serve,/workbench-ui\.css.*text\/css/);assert.match(serve,/workbench-ui\.js.*text\/javascript/);
  assert.match(serve,/script-src 'self'/);assert.doesNotMatch(serve,/unsafe-eval|unsafe-inline/);
});
test('display text and new code do not introduce forbidden dash characters',async()=>{
  for(const file of ['web/workbench-ui.js','web/workbench-ui.css','web/agent.html','web/workspace.html'])assert.doesNotMatch(await read(file),/[\u2013\u2014]/u);
});
