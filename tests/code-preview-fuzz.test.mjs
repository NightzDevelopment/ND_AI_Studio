import test from 'node:test';
import assert from 'node:assert/strict';
import { partialChanges } from '../worker/code-preview.mjs';

test('every structured-output prefix previews only exact source prefixes, including escapes and literal JSON',()=>{
  let seed=9173,sawPartial=false;
  const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed;};
  const alphabet=['a','"','\\','\n','\r','\t','{','}',']',':','😀','中','\u2028','<script>','/'];
  for(let sample=0;sample<80;sample++){
    const contents=Array.from({length:2},()=>Array.from({length:12},()=>alphabet[random()%alphabet.length]).join(''));
    let changes=[{path:'README.md',content:contents[0]},{path:'client/main.lua',content:contents[1]},{path:'old.lua',content:null}];
    if(sample%2)changes=changes.map(({path,content})=>({content,path}));
    let output=JSON.stringify({summary:'Literal JSON: {"changes":[{"path":"wrong.lua"}]}',changes});
    if(sample%3===0)output=output.replaceAll('😀','\\ud83d\\ude00');
    if(sample%5===0)output=output.replaceAll('client/main.lua','client\\/main.lua');
    const expected=new Map(changes.map(change=>[change.path,change.content]));
    for(let end=0;end<=output.length;end++)for(const file of partialChanges(output.slice(0,end))){
      assert.ok(expected.has(file.path),'JSON inside source or summary must never become a file.');
      const target=expected.get(file.path);
      if(file.content===null)assert.equal(target,null);
      else{
        assert.equal(typeof target,'string');
        assert.ok(target.startsWith(file.content),'Streamed source must be an exact decoded prefix.');
        if(file.complete)assert.equal(file.content,target);
        else sawPartial=true;
      }
    }
    assert.equal(partialChanges(output).length,3,'Complete valid changes must remain visible.');
  }
  assert.ok(sawPartial,'Source must be visible before the complete JSON arrives.');
});
