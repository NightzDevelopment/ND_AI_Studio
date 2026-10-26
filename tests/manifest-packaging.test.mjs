import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {inspectProject}=require('../worker/check.cjs');
const header="fx_version 'cerulean'\ngame 'gta5'\n";
function inspect(t,manifest,files={}) {
  const root=mkdtempSync(join(tmpdir(),'nd-manifest-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  for(const [name,text] of Object.entries({'fxmanifest.lua':manifest,'README.md':'# Test fixture',...files})) {
    const target=join(root,name);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,text);
  }
  // These cases isolate packaging from the separately tested Lua syntax parser.
  return inspectProject(root,'ai-script-generator',()=>({status:0,stderr:''}));
}
test('metadata in a Lua comment is not an active manifest declaration',t=>{
  const result=inspect(t,"-- fx_version 'cerulean'\n-- game 'gta5'\n");
  assert.equal(result.kind,'source');assert.equal(result.ok,false);
});
test('valid parenthesized metadata and plural games are accepted',t=>{
  const result=inspect(t,"fx_version('cerulean')\ngames { 'rdr3', 'gta5' }\n");
  assert.equal(result.ok,true,JSON.stringify(result.checks));
});
test('missing literal script references fail packaging before saving generated source',t=>{
  const result=inspect(t,header+"client_script 'client/missing.lua'\n");
  assert.equal(result.ok,false);assert.equal(result.kind,'source');assert.match(result.checks.join('\n'),/client\/missing\.lua/);
});
test('a local NUI page must be included in the client packfile',t=>{
  const result=inspect(t,header+"ui_page 'html/index.html'\n",{'html/index.html':'<!doctype html><title>Test</title>'});
  assert.equal(result.ok,false);assert.match(result.checks.join('\n'),/packfile|files/i);
});

const {inspectManifest,globMatches}=require('../worker/manifest.cjs');
function manifest(source,paths=[]) {return inspectManifest(source,['fxmanifest.lua','README.md',...paths]);}
function valid(result) {assert.deepEqual(result.errors,[],JSON.stringify(result));}
function invalid(result,pattern) {assert.ok(result.errors.length,JSON.stringify(result));assert.match(result.errors.join('\n'),pattern);}
for(const name of ['client_script','server_script','shared_script','file']) {
  test(`${name} checks exact local paths and identifies wrong letter case`,()=>{
    invalid(manifest(header+`${name} 'client/main.lua'`,['client/Main.lua']),/exact case.*client\/Main.lua/);
    valid(manifest(header+`${name} './client/main.lua'`,['client/main.lua']));
  });
}
for(const [name,body] of [
  ['line comment',"-- fx_version 'cerulean'\n-- game 'gta5'"],
  ['block comment',"--[[fx_version 'cerulean'\ngame 'gta5']]"],
  ['equal bracket comment',"--[==[fx_version 'cerulean'\ngame 'gta5'\n]==]"],
  ['quoted description',`description "fx_version 'cerulean' game 'gta5'"`],
  ['long description',"description [=[fx_version 'cerulean'\ngame 'gta5']=]"],
  ['table keys',"metadata = { fx_version = 'cerulean', game = 'gta5' }"],
  ['method names',"metadata.fx_version('cerulean')\nmetadata:game('gta5')"],
])test(`${name} cannot supply fake required metadata`,()=>{
  const result=manifest(body);invalid(result,/fx_version/);invalid(result,/game/);
});
for(const body of [
  "fx_version 'cerulean'\ngame 'gta5'",
  'fx_version "cerulean";game "gta5"',
  "fx_version('cerulean');games({'rdr3', 'gta5'})",
  "fx_version [[cerulean]]\ngames { [=[gta5]=]; 'rdr3'; }",
  "fx_version('cerulean') -- ignored\n game( -- comment\n'gta5'\n)",
  "fx_version 'cerulean'\ngame '\\103ta5'",
  "fx_version 'cerulean'\ngame '\\x67ta5'",
  "fx_version 'cerulean'\ngame '\\u{67}ta5'",
  "fx_version 'cerulean'\ngame 'g\\z  \n ta5'",
])test(`literal metadata supports ${JSON.stringify(body).slice(0,70)}`,()=>valid(manifest(body)));

test('long-string leading newline and CRLF content follow Lua string semantics',()=>{
  valid(manifest("fx_version [==[\r\ncerulean]==]\ngame [[\ngta5]]"));
});
test('comments between a declaration and its argument do not hide the declaration',()=>{
  valid(manifest("fx_version --[=[ first ]=]\n'cerulean'\ngame -- second\n'gta5'"));
});
test('commented missing script declarations are ignored',()=>{
  valid(manifest(header+"-- client_script 'missing.lua'\n--[[ file 'also-missing.json' ]]\ndescription [==[ui_page 'absent.html']==]"));
});
test('wrong literal manifest version or game is a source error',()=>{
  invalid(manifest("fx_version 'adamant'\ngame 'gta5'"),/cerulean/);
  invalid(manifest("fx_version 'cerulean'\ngames {'rdr3'}"),/gta5/);
});
test('array and parenthesized script declarations check every literal file',()=>{
  valid(manifest(header+"client_scripts({ 'client/a.lua', 'client/b.lua' })",['client/a.lua','client/b.lua']));
  invalid(manifest(header+"server_scripts { 'server/a.lua'; 'server/b.lua', }",['server/a.lua']),/server\/b.lua/);
});
test('computed string arguments are disclosed, not partially interpreted or executed',()=>{
  const result=manifest(header+"client_script('client/' .. fileName)\nfiles { prefix .. '.html' }\nui_page 'index.html'",['index.html']);
  valid(result);assert.match(result.notes.join('\n'),/dynamic or scoped/);assert.match(result.notes.join('\n'),/packfile coverage/);
});
test('conditional, function-local and shadowed declarations are not asserted to execute',()=>{
  const result=manifest(header+"if false then client_script 'missing.lua' end\nlocal function helper() file 'missing.txt' end\nlocal shared_script = function() end\nshared_script 'missing-shared.lua'");
  valid(result);assert.equal(result.notes.filter(note=>note.includes('dynamic or scoped')).length,3);
});
test('nested loop scopes do not contaminate a following top-level declaration',()=>{
  const result=manifest(header+"for i=1,2 do while false do file 'optional.txt' end end\nfile 'required.txt'");
  invalid(result,/required.txt/);assert.ok(!result.errors.some(text=>text.includes('optional.txt')));
});
test('multiple scalar arguments are not mistaken for a plural metadata list',()=>{
  const result=manifest("fx_version 'cerulean'\ngame('rdr3', 'gta5')");
  assert.match(result.notes.join('\n'),/dynamic or scoped/);
});
test('normal external framework references and dependencies are explicitly unverified',()=>{
  const result=manifest(header+"shared_script '@ox_lib/init.lua'\nserver_script '@oxmysql/lib/MySQL.lua'\ndependencies { 'ox_lib', '/onesync' }");
  valid(result);assert.match(result.notes.join('\n'),/not fetched/);assert.match(result.notes.join('\n'),/dependency.*ox_lib/);
});
for(const value of ['../secret.lua','/etc/passwd','C:/secret.lua','client/../server.lua','client//file.lua','client\\file.lua','@../secret.lua','@ox_lib/../secret.lua','@ox_lib/']) {
  test(`unsafe reference ${JSON.stringify(value)} is rejected without filesystem access`,()=>{
    // Encode the Windows separator as a Lua escaped backslash.
    const literal=value.replaceAll('\\','\\\\');
    invalid(manifest(header+`client_script '${literal}'`),/unsafe|invalid external/);
  });
}
for(const [pattern,file,expected] of [
  ['*.lua','client.lua',true],['*.lua','client/main.lua',false],
  ['client/*.lua','client/main.lua',true],['client/*.lua','client/deep/main.lua',false],
  ['**/*.lua','main.lua',true],['**/*.lua','client/deep/main.lua',true],
  ['**.lua','client/deep/main.lua',true],['**/cl_*.lua','client/cl_main.lua',true],
  ['**/cl_*.lua','client/sv_main.lua',false],['client/**/main.lua','client/main.lua',true],
  ['client/**/main.lua','client/deep/main.lua',true],['html/**','html/assets/ui.css',true],
  ['html/*','html/assets/ui.css',false],['*.lua','FILE.LUA',false],
  ['a**/b.lua','ab.lua',false],['a**/b.lua','a/deep/b.lua',true],
])test(`glob ${pattern} matches ${file}: ${expected}`,()=>assert.equal(globMatches(pattern,file),expected));
test('wildcard inspection remains bounded with repeated hostile star segments',()=>{
  const start=performance.now();
  for(let i=0;i<200;i++)assert.equal(globMatches('a*'.repeat(80)+'b','a'.repeat(179)),false);
  assert.ok(performance.now()-start<3000);
});
test('an empty glob is a warning rather than an invented runtime requirement',()=>{
  const result=manifest(header+"client_scripts { 'optional/*.lua' }");valid(result);assert.match(result.notes.join('\n'),/matches no supplied files/);
});
test('unsupported wildcard syntax is disclosed and never sent to a shell',()=>{
  const result=manifest(header+"files { 'html/[a-z]*.css' }");valid(result);assert.match(result.notes.join('\n'),/unsupported path pattern/);
});
for(const key of ['ui_page','loadscreen']) {
  test(`${key} validates page existence and packfile coverage`,()=>{
    invalid(manifest(header+`${key} 'html/index.html'`),/missing file/);
    invalid(manifest(header+`${key} 'html/index.html'`,['html/index.html']),/client packfile/);
    valid(manifest(header+`${key} 'html/index.html'\nfiles {'html/**'}`,['html/index.html']));
    valid(manifest(header+`${key} './html/index.html?version=1#app'\nfile 'html/index.html'`,['html/index.html']));
  });
  test(`${key} external URLs remain unverified without network access`,()=>{
    const result=manifest(header+`${key} 'https://example.invalid/index.html'`);valid(result);assert.match(result.notes.join('\n'),/external URL/);
  });
}
test('server scripts do not implicitly place a local NUI page in the client packfile',()=>{
  invalid(manifest(header+"ui_page 'index.html'\nserver_script 'index.html'",['index.html']),/client packfile/);
});
test('data_file supports direct, parenthesized and curried string pairs',()=>{
  for(const body of ["data_file 'HANDLING_FILE' 'data/handling.meta'","data_file('HANDLING_FILE', 'data/handling.meta')","data_file('HANDLING_FILE')('data/handling.meta')"]) {
    valid(manifest(header+body,['data/handling.meta']));invalid(manifest(header+body),/data\/handling.meta/);
  }
});
test('data_file audio directories are not mistaken for missing ordinary files',()=>{
  const result=manifest(header+"data_file 'AUDIO_WAVEPACK' 'audio/waves'",['audio/waves/test.awc']);valid(result);assert.match(result.notes.join('\n'),/audio directory/);
});
test('source diagnostics include the actual manifest line and preserve errors ahead of informational output',t=>{
  const sources=Object.fromEntries(Array.from({length:62},(_,n)=>[`src/file${n}.lua`,'local a = true']));
  const result=inspect(t,header+"\nclient_script 'missing.lua'\n"+Array.from({length:110},(_,n)=>`dependency 'external${n}'`).join('\n'),sources);
  assert.equal(result.kind,'source');assert.match(result.checks[0],/fxmanifest.lua:4.*missing.lua/);assert.ok(result.checks.length<=100);
});
test('unterminated and unsupported escaped strings do not fabricate required metadata',()=>{
  for(const body of ["fx_version 'cerulean\ngame 'gta5'","fx_version 'cerulean'\ngame '\\qgta5'"]) {
    const result=manifest(body);assert.ok(result.errors.length||result.notes.some(note=>note.includes('Not tested')));
  }
});

function inspectBot(t,pkg,extra={},parser=()=>({status:0,stderr:''})) {
  const root=mkdtempSync(join(tmpdir(),'nd-bot-package-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  for(const [name,text] of Object.entries({'package.json':JSON.stringify(pkg),'README.md':'# Test bot','index.js':'const ready = true;',...extra})) {
    const target=join(root,name);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,text);
  }
  return {root,result:inspectProject(root,'discord-bot-generator',parser)};
}
for(const value of [true,42,{},[],['^14.0.0'],'','   ']) {
  test(`Discord dependency rejects invalid declaration ${JSON.stringify(value)}`,t=>{
    const {result}=inspectBot(t,{dependencies:{'discord.js':value}});
    assert.equal(result.kind,'source');assert.match(result.checks.join('\n'),/discord\.js/);
  });
}
for(const scripts of [null,[],true,42,'node index.js',{start:42},{start:{command:'node index.js'}}]) {
  test(`bot scripts must be a string-valued command map: ${JSON.stringify(scripts)}`,t=>{
    const {result}=inspectBot(t,{dependencies:{'discord.js':'^14.0.0'},scripts});
    assert.equal(result.kind,'source');assert.match(result.checks.join('\n'),/scripts.*object|scripts.*string/i);
  });
}
test('normal Discord package commands and empty optional commands remain supported',t=>{
  const {result}=inspectBot(t,{dependencies:{'discord.js':'^14.0.0'},scripts:{start:'node index.js',test:''}});
  assert.equal(result.ok,true,JSON.stringify(result));
});

for(const newline of ['\n','\r','\r\n','\n\r'])test(`Lua newline convention ${JSON.stringify(newline)} preserves comment boundaries and line numbers`,()=>{
  const result=manifest(["-- ignored game 'bad'","fx_version 'cerulean'","game 'gta5'","client_script 'missing.lua'"].join(newline));
  invalid(result,/fxmanifest.lua:4.*missing.lua/);assert.equal(result.errors.length,1);
  valid(manifest(`fx_version [=[${newline}cerulean]=]${newline}game [[${newline}gta5]]`));
});

test('real JavaScript syntax checking does not execute project code or npm lifecycle hooks',t=>{
  const marker=join(tmpdir(),`nd-never-execute-${process.pid}-${Date.now()}`);
  const parser=(command,args,options)=>{assert.equal(command,'node');assert.equal(args[0],'--check');return spawnSync(process.execPath,args,options);};
  const {result}=inspectBot(t,{dependencies:{'discord.js':'^14.0.0'},scripts:{prepare:'node index.js'}},
    {'index.js':`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'must not execute');`},parser);
  assert.equal(result.kind,'source');assert.ok(result.checks.includes('Package installation lifecycle scripts are not allowed.'));
  assert.equal(existsSync(marker),false);
});
test('real JavaScript syntax failures remain source failures',t=>{
  const parser=(command,args,options)=>spawnSync(process.execPath,args,options);
  const {result}=inspectBot(t,{dependencies:{'discord.js':'^14.0.0'}},{'index.js':'const = ;'},parser);
  assert.equal(result.kind,'source');assert.match(result.checks[0],/index.js:/);
});
test('missing parser remains an infrastructure error, not a repairable manifest problem',t=>{
  const {result}=inspectBot(t,{dependencies:{'discord.js':'^14.0.0'}},{},()=>({status:null,error:{code:'ENOENT'}}));
  assert.equal(result.kind,'infrastructure');assert.match(result.checks[0],/ENOENT/);
});
test('validator image definition includes both modules and retains the non-root user',()=>{
  const dockerfile=readFileSync(new URL('../worker/Dockerfile',import.meta.url),'utf8');
  assert.match(dockerfile,/^COPY check\.cjs manifest\.cjs \/opt\/nd-ai\/$/m);
  assert.match(dockerfile,/^USER 65534:65534$/m);
  assert.match(dockerfile,/^ENTRYPOINT \["node", "\/opt\/nd-ai\/check.cjs"\]$/m);
});
test('validator modules load together from a clean packaged directory',t=>{
  const directory=mkdtempSync(join(tmpdir(),'nd-validator-image-layout-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  for(const name of ['check.cjs','manifest.cjs'])copyFileSync(new URL(`../worker/${name}`,import.meta.url),join(directory,name));
  const result=spawnSync(process.execPath,['-e',"const {inspectProject}=require('./check.cjs');console.log(typeof inspectProject);"],{cwd:directory,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),'function');
});
test('malformed and dynamic manifest text stays bounded without throwing or evaluating Lua',()=>{
  let seed=12345;const alphabet="ab'\"[]{}(),;=-\\\n\r*/_012fxgame";
  for(let n=0;n<1000;n++) {
    let text='';for(let i=0;i<120;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;text+=alphabet[seed%alphabet.length];}
    const result=manifest(text);assert.ok(Array.isArray(result.errors));assert.ok(Array.isArray(result.notes));
  }
});
