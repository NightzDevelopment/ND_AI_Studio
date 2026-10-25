'use strict';
// Runs only inside the disposable validator image. Never import or execute project source.
const fs=require('node:fs'), path=require('node:path'), cp=require('node:child_process');
const checks=[]; let ok=true;
function fail(message) { ok=false; checks.push(message.slice(0,1900)); }
function walk(directory) { return fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory() ? walk(path.join(directory,entry.name)) : [path.join(directory,entry.name)]); }
try {
  const files=walk('/workspace');
  for (const filename of files) {
    const relative=path.relative('/workspace',filename);
    if (/\.(?:js|mjs|cjs|lua)$/i.test(filename)) {
      const lua=/\.lua$/i.test(filename);
      const result=cp.spawnSync(lua ? 'luac5.4' : 'node',lua ? ['-p',filename] : ['--check',filename],{timeout:3000,maxBuffer:8192,env:{PATH:'/usr/local/bin:/usr/bin:/bin'},encoding:'utf8'});
      if (result.status!==0 || result.error) fail(`${relative}: ${(result.stderr || 'Syntax check timed out or failed.').replaceAll('/workspace/','').slice(0,1500)}`);
      else checks.push(`${relative}: ${lua ? 'Lua 5.4' : 'JavaScript'} syntax passed.`);
    }
    if (/\.json$/i.test(filename)) {
      try { JSON.parse(fs.readFileSync(filename,'utf8')); checks.push(`${relative}: JSON parsed.`); } catch { fail(`${relative}: invalid JSON.`); }
    }
  }
  if (process.argv[2]==='ai-script-generator') {
    const manifest='/workspace/fxmanifest.lua';
    if (!fs.existsSync(manifest)) fail('fxmanifest.lua is required at the project root.');
    else { const text=fs.readFileSync(manifest,'utf8'); if (!/\bfx_version\s+['"]cerulean['"]/.test(text) || !/\bgame\s+['"]gta5['"]/.test(text)) fail('fxmanifest.lua must declare cerulean and gta5.'); }
    checks.push('Not tested: FiveM native availability, framework behavior, NUI callbacks, server events or in-game execution.');
  } else {
    const filename='/workspace/package.json';
    if (!fs.existsSync(filename)) fail('A Discord bot requires package.json.');
    else {
      try {
        const pkg=JSON.parse(fs.readFileSync(filename,'utf8'));
        if (!pkg.dependencies?.['discord.js']) fail('Declare discord.js in dependencies.');
        if (Object.keys(pkg.scripts || {}).some(key=>['preinstall','install','postinstall','prepare'].includes(key))) fail('Package installation lifecycle scripts are not allowed.');
        const entry=pkg.main || 'index.js';
        if (typeof entry!=='string' || !/^[A-Za-z0-9_./-]+$/.test(entry) || entry.split('/').includes('..') || entry.startsWith('/') || !fs.existsSync(path.join('/workspace',entry))) fail('Declare an existing project entry file in package.json main.');
      } catch { fail('Could not validate the bot package manifest.'); }
    }
    checks.push('Not tested: package installation, Discord authentication, Gateway intents, slash command registration or runtime boot.');
  }
  if (!files.some(file=>/\/README(?:\.md|\.txt)?$/i.test(file))) fail('Include a README with installation, dependencies and runtime checks.');
} catch { fail('Validator could not inspect the project.'); }
process.stdout.write(JSON.stringify({ok,checks:checks.slice(0,100)}));
