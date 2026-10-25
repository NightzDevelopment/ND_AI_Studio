'use strict';
// Runs only inside the disposable validator image. Never import or execute project source.
const fs=require('node:fs'), path=require('node:path'), cp=require('node:child_process');
function inspectProject(root,tool,runner=cp.spawnSync) {
  const checks=[]; let ok=true;
  function fail(message) { ok=false; checks.push(message.slice(0,1900)); }
  function walk(directory) {
    return fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=> {
      const filename=path.join(directory,entry.name);
      if (entry.isDirectory()) return walk(filename);
      if (!entry.isFile()) throw Object.assign(new Error('Unexpected source type.'),{code:'UNSAFE_ENTRY'});
      return [filename];
    });
  }
  try {
    const files=walk(root), text=new Map();
    // Read every file before interpreting diagnostics. EACCES is infrastructure,
    // not a source-code defect an AI model should be paid to repair.
    for (const filename of files) text.set(filename,fs.readFileSync(filename,'utf8'));
    for (const filename of files) {
      const relative=path.relative(root,filename);
      if (/\.(?:js|mjs|cjs|lua)$/i.test(filename)) {
        const lua=/\.lua$/i.test(filename);
        const result=runner(lua ? 'luac5.4' : 'node',lua ? ['-p',filename] : ['--check',filename],{timeout:3000,maxBuffer:8192,env:{PATH:'/usr/local/bin:/usr/bin:/bin'},encoding:'utf8'});
        if (result.error || result.signal || result.status === null) throw Object.assign(new Error('Parser unavailable.'),{code:result.error?.code || 'PARSER_UNAVAILABLE'});
        if (result.status!==0) fail(`${relative}: ${(result.stderr || 'Syntax check failed.').replaceAll(root+'/','').slice(0,1500)}`);
        else checks.push(`${relative}: ${lua ? 'Lua 5.4' : 'JavaScript'} syntax passed.`);
      }
      if (/\.json$/i.test(filename)) {
        try { JSON.parse(text.get(filename)); checks.push(`${relative}: JSON parsed.`); }
        catch { fail(`${relative}: invalid JSON.`); }
      }
    }
    if (tool==='ai-script-generator') {
      const manifest=path.join(root,'fxmanifest.lua');
      if (!text.has(manifest)) fail('fxmanifest.lua is required at the project root.');
      else if (!/\bfx_version\s+['"]cerulean['"]/.test(text.get(manifest)) || !/\bgame\s+['"]gta5['"]/.test(text.get(manifest))) fail('fxmanifest.lua must declare cerulean and gta5.');
      checks.push('Not tested: FiveM native availability, framework behavior, NUI callbacks, server events or in-game execution.');
    } else if (tool==='discord-bot-generator') {
      const filename=path.join(root,'package.json');
      if (!text.has(filename)) fail('A Discord bot requires package.json.');
      else {
        try {
          const pkg=JSON.parse(text.get(filename));
          if (!pkg?.dependencies?.['discord.js']) fail('Declare discord.js in dependencies.');
          if (Object.keys(pkg?.scripts || {}).some(key=>['preinstall','install','postinstall','prepare'].includes(key))) fail('Package installation lifecycle scripts are not allowed.');
          const entry=pkg?.main || 'index.js';
          if (typeof entry!=='string' || !/^[A-Za-z0-9_./-]+$/.test(entry) || entry.split('/').includes('..') || entry.startsWith('/') || !text.has(path.join(root,entry))) fail('Declare an existing project entry file in package.json main.');
        } catch { fail('Could not validate the bot package manifest.'); }
      }
      checks.push('Not tested: package installation, Discord authentication, Gateway intents, slash command registration or runtime boot.');
    } else throw Object.assign(new Error('Unsupported validator tool.'),{code:'UNSUPPORTED_TOOL'});
    if (!files.some(file=>/\/README(?:\.md|\.txt)?$/i.test(file))) fail('Include a README with installation, dependencies and runtime checks.');
    return {ok,kind:ok?'ok':'source',checks:checks.slice(0,100)};
  } catch (error) {
    const code=typeof error.code==='string' && /^[A-Z_0-9]{1,40}$/.test(error.code) ? error.code : 'INSPECTION_FAILED';
    return {ok:false,kind:'infrastructure',checks:[`Validator infrastructure failed (${code}). No source repair should be attempted.`]};
  }
}
module.exports={inspectProject};
if (require.main===module) process.stdout.write(JSON.stringify(inspectProject('/workspace',process.argv[2])));
