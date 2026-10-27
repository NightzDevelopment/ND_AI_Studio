import test from 'node:test';
import assert from 'node:assert/strict';
import { actionData } from '../server/agent-domain.mjs';
import { prepareAgentRequest, requestAgentAction } from '../worker/agent-provider.mjs';

const action = (type, extra = {}) => ({ type, message:'Inspect the project.', path:null, query:null, content:null, plan:null, ...extra });
const plan = { goal:'Inspect the source', steps:['Read source'], changes:[], capabilities:[] };

for (const type of ['list_files','validate_project','ask_user','finish','propose_plan']) {
  test(`${type} accepts neutral unused path and query without weakening required arguments`, () => {
    const value = actionData(action(type, { path:'', query:'', ...(type === 'propose_plan' ? {plan} : {}) }));
    assert.equal(value.path, null);
    assert.equal(value.query, null);
  });
}
test('required file paths remain strict even when neutral unused fields are accepted', () => {
  for (const type of ['read_file','write_file','delete_file']) {
    for (const path of [null, '', ' ', '../secret.lua', '/etc/private.txt', 'private/../secret.lua', '.env']) {
      assert.throws(() => actionData(action(type, {path, content:type === 'write_file' ? '' : null, query:''})));
    }
    assert.equal(actionData(action(type, {path:'client/main.lua', query:'', content:type === 'write_file' ? '' : null})).path, 'client/main.lua');
  }
});
test('required search queries and complete write contents remain strict', () => {
  for (const query of [null, '', ' ', 2, 'a'.repeat(201)]) assert.throws(() => actionData(action('search_files', {query, path:''})));
  assert.equal(actionData(action('search_files', {query:'command', path:''})).query, 'command');
  for (const content of [null, {}, '\0', 'x'.repeat(65537)]) assert.throws(() => actionData(action('write_file', {path:'client/main.lua', content})));
  assert.equal(actionData(action('write_file', {path:'client/main.lua', content:''})).content, '');
});
test('neutral normalization does not excuse unsafe nonempty unused paths or unknown fields', () => {
  for (const path of ['../secret.lua','.env','/private.txt']) assert.throws(() => actionData(action('list_files', {path, query:''})));
  assert.throws(() => actionData({...action('finish'), shell:'run something'}));
});
test('schema-valid neutral fields from the Responses adapter reach server action validation', async () => {
  const context = { phase:'plan', request:'Keep improving the script and ask questions if needed.', project:{name:'Test',tool:'ai-script-generator',target:'Standalone',requirements:'Inspect source'}, settings:{model:'fixture-model',provider:'openai',maxOutputTokens:1024,inputUsdPerMillion:1,outputUsdPerMillion:2}, steps:0,maxSteps:16,spentMicros:0,budgetMicros:500000,files:[],baseFiles:[],history:[],conversation:[] };
  const candidate = action('list_files', {path:'',query:'',content:''});
  const prepared = prepareAgentRequest(context);
  assert.deepEqual(prepared.payload.text.format.schema.properties.path.type, ['string','null']);
  const result = await requestAgentAction(context,prepared,{key:'fixture-key-private',fetcher:async () => new Response(JSON.stringify({status:'completed',usage:{input_tokens:10,output_tokens:20},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(candidate)}]}]}))});
  assert.equal(actionData(result.action).type, 'list_files');
});
