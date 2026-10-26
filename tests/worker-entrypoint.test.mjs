import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = new URL('../', import.meta.url);
const image = `sha256:${'b'.repeat(64)}`;
const startupError = 'Worker startup failed. Check its private environment and rootless validator.';

// Match the installer's release layout, including its current directory symlink.
// Subprocesses receive no real credentials and never connect to external services.
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'nd-ai-entry-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const release = join(directory, 'releases', 'release #1');
  mkdirSync(join(release, 'worker'), { recursive: true, mode: 0o700 });
  mkdirSync(join(release, 'server'), { mode: 0o700 });
  for (const name of ['worker/start.mjs', 'worker/provider.mjs', 'worker/validate.mjs', 'worker/code-preview.mjs', 'server/studio-domain.mjs']) {
    copyFileSync(new URL(name, root), join(release, name));
  }
  const current = join(directory, 'current');
  symlinkSync(release, current, 'dir');
  const special = join(directory, 'current # link');
  symlinkSync(release, special, 'dir');
  const env = {
    PATH: process.env.PATH || '/usr/bin:/bin', HOME: directory,
    STUDIO_ORIGIN: 'https://studio.invalid', STUDIO_WORKER_TOKEN: '', OPENAI_API_KEY: '',
  };
  const run = (args, extra = {}) => spawnSync(process.execPath, args, {
    cwd: directory, env, encoding: 'utf8', timeout: 10000, maxBuffer: 65536, ...extra,
  });
  return { directory, release, current, special, env, run };
}
function assertStartupAttempt(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1, 'Invalid configuration must fail startup, not silently exit successfully.');
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), startupError);
}

test('direct worker invocation starts main and fails closed without credentials', t => {
  const f = fixture(t);
  assertStartupAttempt(f.run([join(f.release, 'worker/start.mjs')]));
});
test('worker main runs through the same current symlink used by systemd', t => {
  const f = fixture(t);
  assertStartupAttempt(f.run([join(f.current, 'worker/start.mjs')]));
});
test('relative current symlink invocation also enters main', t => {
  const f = fixture(t);
  assertStartupAttempt(f.run(['current/worker/start.mjs']));
});
test('symlinked worker paths with spaces and URL-special characters enter main', t => {
  const f = fixture(t);
  assertStartupAttempt(f.run([join(f.special, 'worker/start.mjs')]));
});
test('entry detection also works when Node preserves the main symlink', t => {
  const f = fixture(t);
  assertStartupAttempt(f.run(['--preserve-symlinks-main', join(f.current, 'worker/start.mjs')]));
});
test('importing worker exports does not start the worker or require credentials', t => {
  const f = fixture(t);
  const wrapper = join(f.directory, 'import-only.mjs');
  writeFileSync(wrapper, `import { main, runJob } from ${JSON.stringify(pathToFileURL(join(f.current, 'worker/start.mjs')).href)};\nif (typeof main !== 'function' || typeof runJob !== 'function') throw new Error('Missing exports');\nconsole.log('Imported without starting');\n`);
  const result = f.run([wrapper]);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), 'Imported without starting');
  assert.equal(result.stderr, '');
});
test('eval imports with no script argument remain side-effect free', t => {
  const f = fixture(t);
  const address = pathToFileURL(join(f.current, 'worker/start.mjs')).href;
  const result = f.run(['--input-type=module', '--eval', `await import(${JSON.stringify(address)}); console.log('Imported');`]);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), 'Imported');
  assert.equal(result.stderr, '');
});

for (const launch of ['direct', 'current', 'deepseek']) {
  test(`${launch} worker launch reaches heartbeat and claim, then shuts down cleanly with fixtures`, t => {
    const f = fixture(t), bin = join(f.directory, 'bin');
    mkdirSync(bin);
    const dockerLog = join(f.directory, 'docker.log'), apiLog = join(f.directory, 'api.log');
    // This fixture only answers readiness commands. It never starts a container.
    writeFileSync(join(bin, 'docker'), `#!${process.execPath}\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nfs.appendFileSync(process.env.TEST_DOCKER_LOG, args[0] + '\\n');\nif (args[0] === 'info') console.log(JSON.stringify({ SecurityOptions: ['name=rootless'], CgroupVersion: '2', CgroupDriver: 'systemd' }));\nelse if (args[0] === 'image' && args[1] === 'inspect') console.log(${JSON.stringify(image)});\nelse process.exit(72);\n`, { mode: 0o700 });
    const preload = join(f.directory, 'fake-api.mjs');
    writeFileSync(preload, `import { appendFileSync } from 'node:fs';
      globalThis.fetch = async (address, options) => {
        const url = new URL(address);
        if (url.origin !== 'https://studio.invalid' || options.method !== 'POST'
          || options.headers.authorization !== 'Bearer ' + process.env.STUDIO_WORKER_TOKEN) {
          throw new Error('Unexpected fixture request');
        }
        if (url.pathname === '/api/worker/heartbeat') {
          const body = JSON.parse(options.body);
          if (JSON.stringify(body.providers) !== JSON.stringify([process.env.TEST_EXPECTED_PROVIDER])) throw new Error('Provider readiness mismatch');
          appendFileSync(process.env.TEST_API_LOG, 'ready=' + body.ready + '\\n');
          return new Response(JSON.stringify({ ok: true }));
        }
        if (url.pathname === '/api/worker/claim') {
          appendFileSync(process.env.TEST_API_LOG, 'claim\\n');
          setTimeout(() => process.kill(process.pid, 'SIGTERM'), 10);
          return new Response(JSON.stringify({ job: null }));
        }
        throw new Error('Unexpected provider or API call');
      };
    `);
    const env = { ...f.env, PATH: `${bin}:${f.env.PATH}`, STUDIO_WORKER_TOKEN: 'a'.repeat(64),
      OPENAI_API_KEY: launch === 'deepseek' ? '' : 'fixture-only-not-a-real-api-key',
      DEEPSEEK_API_KEY: launch === 'deepseek' ? 'fixture-only-not-a-deepseek-key' : '',
      TEST_EXPECTED_PROVIDER: launch === 'deepseek' ? 'deepseek' : 'openai', VALIDATOR_IMAGE: image,
      TEST_DOCKER_LOG: dockerLog, TEST_API_LOG: apiLog };
    const script = join(launch === 'direct' ? f.release : f.current, 'worker/start.mjs');
    const result = f.run(['--import', pathToFileURL(preload).href, script], { env });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.equal(readFileSync(apiLog, 'utf8'), 'ready=true\nclaim\nready=false\n');
    assert.equal(readFileSync(dockerLog, 'utf8'), 'info\nimage\ninfo\nimage\n');
  });
}

test('a cancelled lease does not mark the worker unavailable or delay claiming the next job',t=>{
  const f=fixture(t),bin=join(f.directory,'bin');mkdirSync(bin);
  writeFileSync(join(bin,'docker'),`#!${process.execPath}\nconst args=process.argv.slice(2);if(args[0]==='info')console.log(JSON.stringify({SecurityOptions:['name=rootless'],CgroupVersion:'2',CgroupDriver:'systemd'}));else if(args[0]==='image')console.log(${JSON.stringify(image)});else process.exit(72);\n`,{mode:0o700});
  const apiLog=join(f.directory,'cancel-api.log'),preload=join(f.directory,'cancel-api.mjs');
  writeFileSync(preload,`import {appendFileSync} from 'node:fs';
    let claims=0;
    globalThis.fetch=async(address,options)=>{
      const url=new URL(address);
      if(url.origin!=='https://studio.invalid')throw new Error('Unexpected provider request');
      if(url.pathname==='/api/worker/heartbeat')return new Response('{}');
      if(url.pathname==='/api/worker/claim'){
        claims++;appendFileSync(process.env.TEST_API_LOG,'claim\\n');
        if(claims===1){
          setTimeout(()=>process.kill(process.pid,'SIGTERM'),1500).unref();
          return new Response(JSON.stringify({job:{id:'cancelled-job',lease:'cancelled-lease',settings:{maxBudgetMicros:1000000},project:{tool_id:'ai-script-generator'}}}));
        }
        setTimeout(()=>process.kill(process.pid,'SIGTERM'),10);
        return new Response(JSON.stringify({job:null}));
      }
      if(url.pathname==='/api/worker/progress'||url.pathname==='/api/worker/complete')return new Response('{}',{status:409});
      throw new Error('Unexpected fixture request');
    };
  `);
  const env={...f.env,PATH:bin+':'+f.env.PATH,STUDIO_WORKER_TOKEN:'a'.repeat(64),OPENAI_API_KEY:'fixture-private-provider-key',VALIDATOR_IMAGE:image,TEST_API_LOG:apiLog};
  const result=f.run(['--import',pathToFileURL(preload).href,join(f.current,'worker/start.mjs')],{env});
  assert.equal(result.error,undefined);assert.equal(result.status,0);assert.equal(result.stderr,'');
  assert.equal(readFileSync(apiLog,'utf8'),'claim\nclaim\n');
});
