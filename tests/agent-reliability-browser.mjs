// Real localhost HTTP/SQLite/browser checks. Identity, provider transport and
// validator are fixtures; no production account or paid request is used.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFixture } from './fixtures/agent-http.mjs';

const require=createRequire(import.meta.url);
let chromium;
try{({chromium}=require(process.env.ND_PLAYWRIGHT_MODULE||'playwright'));}
catch{throw new Error('Install Playwright in an isolated browser-test environment. Set ND_PLAYWRIGHT_MODULE to its module path. No application runtime dependency is required.');}
const output=process.env.ND_QA_ARTIFACTS||join(tmpdir(),'nd-agent-reliability-browser');
mkdirSync(output,{recursive:true});
const fixture=await createFixture({autoWorker:true});
const TARGET_URL=fixture.config.origin;
fixture.behavior('api-failure');
let browser;
const errors=[],consoleErrors=[],failedRequests=[],httpErrors=[],checks=[];
const passed=name=>{checks.push(name);console.log(`PASS: ${name}`);};
try{
  browser=await chromium.launch({headless:process.env.ND_QA_HEADLESS==='1',...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
  const context=await browser.newContext({viewport:{width:1920,height:1080},reducedMotion:'reduce'});
  await context.route('**/*',route=>new URL(route.request().url()).origin===TARGET_URL?route.continue():route.abort());
  const page=await context.newPage();page.setDefaultTimeout(15000);
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());});
  page.on('requestfailed',request=>failedRequests.push(request.url()));
  page.on('response',response=>{if(response.status()>=400)httpErrors.push({url:response.url(),status:response.status()});});
  await page.goto(TARGET_URL+'/__fixture/login');
  await page.locator('#new-chat').click();
  await page.locator('#chat-form input[name=title]').fill('Diagnose provider failure');
  await page.getByRole('button',{name:'Save conversation',exact:true}).click();
  await page.locator('#chat-dialog').waitFor({state:'hidden'});
  await page.locator('#message').fill('Keep improving the script and ask questions if needed.');
  await page.locator('#send').click();
  await page.getByRole('button',{name:'Start read-only planning',exact:true}).click();
  await page.waitForFunction(()=>document.getElementById('task-state').textContent==='failed');
  const details=page.getByRole('region',{name:'Task failure details'});
  await details.waitFor({state:'visible'});
  assert.match(await details.innerText(),/Provider service unavailable/);
  assert.match(await details.innerText(),/provider_unavailable \/ HTTP 503/);
  assert.match(await details.innerText(),/explicit authorization/);
  assert.match(await page.locator('#plan').innerText(),/All task Studio credits were returned/);
  assert.equal(fixture.counts().paid,1);
  assert.equal(fixture.store.db.prepare('SELECT version FROM studio_projects WHERE id=?').get(fixture.p.id).version,2);
  passed('Classified failure and next step render through real HTTP/SQLite without a paid retry or source save');
  await page.reload();
  await page.waitForFunction(()=>document.getElementById('task-state').textContent==='failed');
  assert.match(await details.innerText(),/provider_unavailable/);
  assert.equal(fixture.counts().paid,1);
  passed('Failure diagnostics survive reload without another task or dispatch');
  for(const width of [320,390,768,1024,1920]){
    await page.setViewportSize({width,height:width<768?844:1080});
    if(width<=1180)await page.locator('.mobile-tabs button[data-panel="plan"]').click();
    await details.waitFor({state:'visible'});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`document overflow at ${width}px`);
    await page.screenshot({path:join(output,`failure-${width}.png`),fullPage:true});
  }
  passed('Sanitized failure details remain reachable at 320, 390, 768, 1024 and 1920 pixels');
  assert.deepEqual(errors,[]);assert.deepEqual(consoleErrors,[]);assert.deepEqual(failedRequests,[]);assert.deepEqual(httpErrors,[]);
  passed('No page exception, CSP violation, failed request or unexpected HTTP error');
}finally{
  await browser?.close();await fixture.close();
  writeFileSync(join(output,'agent-reliability-results.json'),JSON.stringify({checks,errors,consoleErrors,failedRequests,httpErrors,scope:'Real local HTTP/SQLite/browser. Fixture identity, provider transport and validator. No live provider or production acceptance.'},null,2));
}
