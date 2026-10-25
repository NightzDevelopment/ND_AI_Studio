import { randomBytes, timingSafeEqual } from 'node:crypto';
import { StudioError, insist, fields, string, integer, digest, validateFiles, filePath, migrateStudio, studioSettings, settingsData, control, audit, event, project, snapshot, saveRevision, newProject, zipFiles, IMPLEMENTED_TOOLS, PERMISSIONS } from './studio-domain.mjs';
import { createModels } from './studio-models.mjs';
import { memberRoles, discordRequest } from './studio-discord.mjs';

export function createStudio({ store, config, catalog, required, mutation, readJson, json, fetcher = fetch }) {
  migrateStudio(store);
  const models = createModels({store,actor,readJson,json});
  const owners = new Set(config.ownerIds || []);
  const isOwner = user => Boolean(user && owners.has(user.discord_id));
  const blocked = id => control(store, id).status === 'suspended';
  function workerReady() {
    const row = store.db.prepare('SELECT * FROM studio_worker WHERE id=1').get();
    return Boolean(config.workerToken && row?.ready && row.checked_at > Date.now() - 45000);
  }
  async function actor(req, write = false, permission = null) {
    const session = write ? mutation(req) : required(req), user = store.user(session.user_id);
    insist(user && !blocked(user.id), 403, 'This Studio account is suspended.');
    let permissions = [];
    if (isOwner(user)) permissions = [...PERMISSIONS];
    else if (permission || !write) {
      const roles = await memberRoles(store, config, user, { refresh: write, fetcher });
      const mappings = studioSettings(store).roleMappings;
      permissions = [...new Set(roles.flatMap(role => mappings[role] || []))];
    }
    if (permission) insist(permissions.includes(permission), 403, 'You do not have permission for this action.');
    return { user, permissions, owner: isOwner(user) };
  }
  function allowed(toolId, user) {
    const mode = studioSettings(store).tools[toolId];
    return IMPLEMENTED_TOOLS.includes(toolId) && (mode === 'members' || (mode === 'owner' && isOwner(user)));
  }
  function jobView(row, details = true) {
    return { ...models.describe(row), id: row.id, projectId: row.project_id, baseVersion: row.base_version, prompt: details ? row.prompt : undefined, status: row.status,
      costMicros: row.cost, reservedMicros: row.reserve, createdAt: row.created_at, updatedAt: row.updated_at,
      result: details && row.result ? JSON.parse(row.result) : null,
      events: details ? store.db.prepare('SELECT id,stage,message,created_at AS createdAt FROM studio_events WHERE job_id=? ORDER BY id').all(row.id) : [] };
  }
  function expireJobs() {
    const now = new Date().toISOString();
    store.db.prepare("UPDATE studio_jobs SET status='failed',cost=reserve,lease=NULL,result=?,updated_at=? WHERE status='running' AND lease_until<?")
      .run(JSON.stringify({ error: 'Worker lease expired. This job was not automatically retried. Reserved cost is retained until billing is reconciled.' }), now, Date.now());
  }
  function workerAuth(req) {
    const actual = req.headers.authorization || '', expected = `Bearer ${config.workerToken || ''}`;
    insist(config.workerToken?.length >= 32 && timingSafeEqual(Buffer.from(digest(actual)), Buffer.from(digest(expected))), 401, 'Worker authentication required.');
  }
  function workerJob(body) {
    const row = store.db.prepare('SELECT * FROM studio_jobs WHERE id=?').get(body.id || '');
    insist(row && row.status === 'running' && row.lease_until > Date.now() && typeof body.lease === 'string' && row.lease === digest(body.lease), 409, 'Build lease expired or cancelled.');
    const user = store.user(row.user_id), p = project(store,row.user_id,row.project_id);
    insist(!blocked(user.id) && !p.archived && allowed(p.tool_id,user), 409, 'Build access was revoked.');
    return row;
  }
  async function route(req, res, url) {
    const path = url.pathname, method = req.method;
    if (!/^\/api\/(?:studio|projects|jobs|admin|worker)(?:\/|$)/.test(path)) return false;
    try {
      expireJobs();
      models.recover();
      if (await models.route(req,res,url)) return true;
      if (path.startsWith('/api/worker/')) {
        workerAuth(req);
        insist(method === 'POST',405,'Use POST for worker requests.');
        const body = await readJson(req,1048576);
        if (path === '/api/worker/status') {
          fields(body,[]); json(res,200,{ ready:workerReady() }); return true;
        }
        if (path === '/api/worker/heartbeat') {
          fields(body,['ready']); insist(typeof body.ready === 'boolean',400,'Invalid worker readiness.');
          store.db.prepare('INSERT INTO studio_worker VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET checked_at=excluded.checked_at,ready=excluded.ready').run(Date.now(),Number(body.ready));
          json(res,200,{ ok:true }); return true;
        }
        if (path === '/api/worker/claim') {
          fields(body,[]); insist(workerReady(),503,'Worker is not ready.');
          let claimed = null;
          store.transaction(() => {
            const rows = store.db.prepare("SELECT * FROM studio_jobs WHERE status='queued' ORDER BY created_at LIMIT 20").all();
            for (const row of rows) {
              const p = project(store,row.user_id,row.project_id), user = store.user(row.user_id);
              if (blocked(user.id) || p.archived || !allowed(p.tool_id,user)) {
                store.db.prepare("UPDATE studio_jobs SET status='cancelled',updated_at=? WHERE id=?").run(new Date().toISOString(),row.id); models.settle(row.id,'released'); continue;
              }
              const lease = randomBytes(32).toString('base64url');
              store.db.prepare("UPDATE studio_jobs SET status='running',lease=?,lease_until=?,updated_at=? WHERE id=? AND status='queued'").run(digest(lease),Date.now()+120000,new Date().toISOString(),row.id);
              event(store,row.id,'planning','Worker claimed the build.');
              claimed = { id:row.id, lease, prompt:row.prompt, project:snapshot(store,p,row.base_version), settings:JSON.parse(row.settings) }; break;
            }
          });
          json(res,200,{ job:claimed }); return true;
        }
        fields(body,['id','lease','stage','message','result','costMicros']);
        const row = workerJob(body);
        if (path === '/api/worker/progress') {
          if (body.stage !== undefined) {
            insist(['planning','generating','checking','repairing','packaging'].includes(body.stage),400,'Invalid build stage.');
            event(store,row.id,body.stage,string(body.message,1000,'build event'));
            store.db.prepare('UPDATE studio_jobs SET updated_at=? WHERE id=?').run(new Date().toISOString(),row.id);
          }
          store.db.prepare('UPDATE studio_jobs SET lease_until=? WHERE id=?').run(Date.now()+120000,row.id);
          json(res,200,{ ok:true }); return true;
        }
        if (path === '/api/worker/complete') {
          fields(body.result,['files','summary','checks','error']);
          const cost = integer(body.costMicros,0,1000000000,'reported cost');
          const settings = JSON.parse(row.settings);
          let result, status;
          if (body.result.error) {
            result = { error:string(body.result.error,1000,'build error') }; status='failed';
          } else {
            const files = validateFiles(body.result.files);
            insist(Array.isArray(body.result.checks) && body.result.checks.length <= 100 && body.result.checks.every(check => typeof check === 'string' && check.length <= 2000),400,'Invalid build checks.');
            result = { files, summary:string(body.result.summary,2000,'build summary'), checks:body.result.checks }; status='review';
          }
          if (cost > settings.maxBudgetMicros) { status='failed'; result={ error:'Provider usage exceeded the configured estimate. Review billing and model prices before retrying.' }; }
          store.transaction(() => {
            workerJob(body);
            store.db.prepare('UPDATE studio_jobs SET status=?,result=?,cost=?,lease=NULL,updated_at=? WHERE id=?').run(status,JSON.stringify(result),cost,new Date().toISOString(),row.id);
            models.settle(row.id,status === 'review' ? 'charged' : cost === 0 ? 'released' : 'pending');
            event(store,row.id,status,status === 'review' ? 'Files are ready for review. In-game behavior has not been tested.' : result.error);
          });
          json(res,200,{ ok:true }); return true;
        }
        throw new StudioError(404,'Worker endpoint not found.');
      }
      if (method === 'GET' && path === '/api/studio/session') {
        const a = await actor(req);
        json(res,200,{ owner:a.owner, permissions:a.permissions, controls:control(store,a.user.id), workerReady:workerReady(),
          tools:IMPLEMENTED_TOOLS.map(id => ({ id, enabled:allowed(id,a.user), workerReady:workerReady() })) }); return true;
      }
      if (method === 'POST' && path === '/api/studio/roles/refresh') {
        const a = await actor(req,true); await memberRoles(store,config,a.user,{ refresh:true,fetcher });
        json(res,200,{ ok:true }); return true;
      }
      if (path.startsWith('/api/admin')) {
        const permission = path.includes('/users') ? (method === 'GET' ? 'users:read' : 'users:manage') : path.includes('/projects') ? (method === 'GET' ? 'projects:read' : 'projects:manage') : path.includes('/audit') ? 'audit:read' : path.includes('/tools') ? 'tools:manage' : 'settings:manage';
        const a = await actor(req,method !== 'GET',permission);
        if (method === 'GET' && path === '/api/admin/settings') {
          json(res,200,{ settings:studioSettings(store), permissions:PERMISSIONS, botConfigured:Boolean(config.botToken), workerConfigured:Boolean(config.workerToken), workerReady:workerReady(), ownerConfigured:owners.size > 0 }); return true;
        }
        if (method === 'PATCH' && path === '/api/admin/settings') {
          insist(a.owner,403,'Only the configured owner can change role mappings and provider settings.');
          const body = await readJson(req), next = settingsData(body); integer(body.version,1,1000000000,'settings revision');
          store.transaction(() => {
            insist(store.db.prepare('UPDATE studio_settings SET value=?,version=version+1 WHERE id=1 AND version=?').run(JSON.stringify(next),body.version).changes,409,'Settings changed. Reload before saving.');
            store.db.prepare('DELETE FROM studio_roles').run(); audit(store,a.user.id,'settings.update','studio');
          });
          json(res,200,{ settings:studioSettings(store) }); return true;
        }
        if (method === 'POST' && path === '/api/admin/discord/test') {
          insist(a.owner,403,'Only the owner can test the bot connection.');
          const s=studioSettings(store); insist(s.guildId,400,'Set a Discord guild ID first.');
          const bot=await discordRequest(config,'/users/@me',fetcher), guild=await discordRequest(config,`/guilds/${s.guildId}`,fetcher);
          insist(bot?.bot && guild?.id === s.guildId,503,'The bot is not installed in this guild.');
          audit(store,a.user.id,'discord.test',s.guildId);
          json(res,200,{ bot:{ id:bot.id,username:bot.username },guild:{ id:guild.id,name:guild.name } }); return true;
        }
        if (method === 'GET' && path === '/api/admin/tools') {
          const s=studioSettings(store); json(res,200,{ tools:s.tools,version:s.version,workerReady:workerReady() }); return true;
        }
        if (method === 'PATCH' && path === '/api/admin/tools') {
          const body=await readJson(req); fields(body,['toolId','mode','version']);
          insist(IMPLEMENTED_TOOLS.includes(body.toolId) && ['disabled','owner','members'].includes(body.mode),400,'Invalid tool mode.');
          insist(a.owner || body.mode !== 'members',403,'Only the owner can release generation to members.');
          store.transaction(() => {
            const s=studioSettings(store); insist(s.version === body.version,409,'Tool settings changed.');
            delete s.version; s.tools[body.toolId]=body.mode;
            store.db.prepare('UPDATE studio_settings SET value=?,version=version+1 WHERE id=1').run(JSON.stringify(s)); audit(store,a.user.id,'tool.mode',body.toolId,body.mode);
          }); json(res,200,{ ok:true }); return true;
        }
        if (method === 'GET' && path === '/api/admin/users') {
          const query=string(url.searchParams.get('q') || '',80,'search',true), after=url.searchParams.get('after') || '';
          const users=store.db.prepare('SELECT u.id,u.discord_id,u.username,u.display_name,u.created_at,coalesce(c.status,\'active\') status,coalesce(c.daily_limit,5) daily_limit,coalesce(c.daily_budget,1000000) daily_budget,coalesce(c.version,0) version FROM users u LEFT JOIN studio_controls c ON c.user_id=u.id WHERE u.id>? AND (instr(lower(u.username),lower(?))>0 OR instr(u.discord_id,?)>0 OR instr(lower(u.display_name),lower(?))>0) ORDER BY u.id LIMIT 50').all(after,query,query,query);
          json(res,200,{ users:users.map(user => ({ ...user, owner:owners.has(user.discord_id) })), next:users.length === 50 ? users.at(-1).id : null }); return true;
        }
        const userMatch=/^\/api\/admin\/users\/([a-f0-9-]{36})$/.exec(path);
        if (userMatch && method === 'PATCH') {
          const body=await readJson(req); fields(body,['status','dailyLimit','dailyBudgetMicros','version','revokeSessions','reason']);
          const target=store.user(userMatch[1]); insist(target,404,'User not found.');
          insist(!isOwner(target) || a.owner,403,'Only an owner can modify owner limits.');
          insist(['active','suspended'].includes(body.status) && !(isOwner(target) && body.status === 'suspended'),400,'The configured owner cannot be suspended.');
          integer(body.dailyLimit,0,100,'daily build limit'); integer(body.dailyBudgetMicros,0,100000000,'daily budget'); integer(body.version,0,1000000000,'account revision');
          insist(typeof body.revokeSessions === 'boolean',400,'Invalid session action.'); const reason=string(body.reason,300,'audit reason');
          store.transaction(() => {
            insist(control(store,target.id).version === body.version,409,'Account controls changed. Reload before saving.');
            store.db.prepare('INSERT INTO studio_controls VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET status=excluded.status,daily_limit=excluded.daily_limit,daily_budget=excluded.daily_budget,version=excluded.version').run(target.id,body.status,body.dailyLimit,body.dailyBudgetMicros,body.version+1);
            if (body.revokeSessions || body.status === 'suspended') store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);
            if (body.status === 'suspended') store.db.prepare("UPDATE studio_jobs SET status='cancelled',cost=CASE WHEN status='running' THEN reserve ELSE 0 END,lease=NULL,updated_at=? WHERE user_id=? AND status IN ('queued','running')").run(new Date().toISOString(),target.id);
            audit(store,a.user.id,'user.update',target.id,reason);
          }); json(res,200,{ ok:true }); return true;
        }
        if (method === 'GET' && path === '/api/admin/projects') {
          const query=string(url.searchParams.get('q') || '',80,'search',true);
          json(res,200,{ projects:store.db.prepare('SELECT id,user_id,tool_id,name,archived,version,updated_at FROM studio_projects WHERE instr(lower(name),lower(?))>0 ORDER BY updated_at DESC LIMIT 100').all(query) }); return true;
        }
        const adminProject=/^\/api\/admin\/projects\/([a-f0-9-]{36})$/.exec(path);
        if (method === 'PATCH' && adminProject) {
          const body=await readJson(req); fields(body,['archived','reason','version']); insist(typeof body.archived === 'boolean',400,'Invalid archive state.');
          const reason=string(body.reason,300,'audit reason'); integer(body.version,1,1000000000,'project revision');
          store.transaction(() => {
            const row=store.db.prepare('SELECT * FROM studio_projects WHERE id=?').get(adminProject[1]);
            insist(row,404,'Project not found.');
            insist(a.owner || !isOwner(store.user(row.user_id)),403,'Only the owner can moderate owner projects.');
            saveRevision(store,row,snapshot(store,row).files,`Moderation: ${reason}`,a.user.id,body.version);
            store.db.prepare('UPDATE studio_projects SET archived=? WHERE id=?').run(Number(body.archived),row.id);
            audit(store,a.user.id,'project.moderate',adminProject[1],reason);
          }); json(res,200,{ ok:true }); return true;
        }
        if (method === 'GET' && path === '/api/admin/audit') {
          const before=Number(url.searchParams.get('before') || Number.MAX_SAFE_INTEGER); integer(before,1,Number.MAX_SAFE_INTEGER,'audit cursor');
          const items=store.db.prepare('SELECT * FROM studio_audit WHERE id<? ORDER BY id DESC LIMIT 100').all(before);
          json(res,200,{ items,next:items.length === 100 ? items.at(-1).id : null }); return true;
        }
        throw new StudioError(404,'Admin endpoint not found.');
      }
      const a=await actor(req,method !== 'GET');
      if (path === '/api/projects' && method === 'GET') {
        json(res,200,{ projects:store.db.prepare('SELECT * FROM studio_projects WHERE user_id=? ORDER BY updated_at DESC').all(a.user.id) }); return true;
      }
      if (path === '/api/projects' && method === 'POST') {
        const body=await readJson(req); fields(body,['name','toolId','target','requirements','briefId']);
        let data=body;
        if (body.briefId) {
          const brief=store.list(a.user.id).find(brief => brief.id === body.briefId); insist(brief,404,'Brief not found.'); data=brief;
        }
        const created=store.transaction(() => newProject(store,a.user.id,data,catalog));
        json(res,201,{ project:created }); return true;
      }
      const pm=/^\/api\/projects\/([a-f0-9-]{36})(?:\/(files|revisions|restore|export|jobs))?$/.exec(path);
      if (pm) {
        const row=project(store,a.user.id,pm[1]), action=pm[2];
        if (method === 'GET' && !action) { json(res,200,{ project:snapshot(store,row) }); return true; }
        if (method === 'GET' && action === 'revisions') {
          const value=url.searchParams.get('version');
          if (value) { json(res,200,{ project:snapshot(store,row,integer(Number(value),1,1000000000,'revision')) }); return true; }
          json(res,200,{ revisions:store.db.prepare('SELECT version,summary,actor,created_at AS createdAt FROM studio_revisions WHERE project_id=? ORDER BY version DESC').all(row.id) }); return true;
        }
        if (method === 'GET' && action === 'export') {
          const version=url.searchParams.get('version'); const data=snapshot(store,row,version ? integer(Number(version),1,1000000000,'revision') : row.version);
          res.writeHead(200,{ 'content-type':'application/zip','content-disposition':`attachment; filename="${row.name.replace(/[^A-Za-z0-9_-]/g,'_')}-v${data.revision}.zip"` }); res.end(zipFiles(data.files)); return true;
        }
        if (method === 'GET' && action === 'jobs') {
          json(res,200,{ jobs:store.db.prepare('SELECT * FROM studio_jobs WHERE project_id=? ORDER BY created_at DESC LIMIT 20').all(row.id).map(item => jobView(item,false)) }); return true;
        }
        const body=await readJson(req,1048576);
        if (method === 'PATCH' && !action) {
          fields(body,['version','name','requirements','favorite','archived']); integer(body.version,1,1000000000,'project revision');
          const name=string(body.name,80,'name'), requirements=string(body.requirements,12000,'requirements');
          insist(typeof body.favorite === 'boolean' && typeof body.archived === 'boolean',400,'Invalid project state.');
          const saved=store.transaction(() => {
            saveRevision(store,row,snapshot(store,row).files,'Project details updated',a.user.id,body.version);
            store.db.prepare('UPDATE studio_projects SET name=?,requirements=?,favorite=?,archived=? WHERE id=?').run(name,requirements,Number(body.favorite),Number(body.archived),row.id);
            return snapshot(store,project(store,a.user.id,row.id));
          }); json(res,200,{ project:saved }); return true;
        }
        insist(!row.archived,409,'Unarchive this project before changing files or generating.');
        if (method === 'PUT' && action === 'files') {
          fields(body,['version','path','content','renameTo','remove']); integer(body.version,1,1000000000,'project revision'); filePath(body.path);
          insist(body.remove === undefined || typeof body.remove === 'boolean',400,'Invalid delete action.');
          const files=snapshot(store,row).files, index=files.findIndex(file => file.path === body.path);
          if (body.remove) { insist(index >= 0,404,'File not found.'); files.splice(index,1); }
          else if (body.renameTo) { filePath(body.renameTo); insist(index >= 0,404,'File not found.'); files[index].path=body.renameTo; }
          else { const file={path:body.path,content:body.content}; if (index >= 0) files[index]=file; else files.push(file); }
          const saved=store.transaction(() => saveRevision(store,row,files,body.remove ? `Delete ${body.path}` : body.renameTo ? `Rename ${body.path}` : `Save ${body.path}`,a.user.id,body.version));
          json(res,200,{ project:saved }); return true;
        }
        if (method === 'POST' && action === 'restore') {
          fields(body,['version','revision']); integer(body.version,1,1000000000,'project revision'); const old=snapshot(store,row,integer(body.revision,1,1000000000,'revision'));
          const saved=store.transaction(() => saveRevision(store,row,old.files,`Restore revision ${body.revision}`,a.user.id,body.version));
          json(res,200,{ project:saved }); return true;
        }
        if (method === 'POST' && action === 'jobs') {
          fields(body,['version','prompt','requestId','modelId','pricingVersion','quotedCredits']); const prompt=string(body.prompt,12000,'build request');
          insist(typeof body.requestId === 'string' && /^[a-f0-9-]{36}$/.test(body.requestId),400,'Invalid build request ID.');
          const duplicate=store.db.prepare('SELECT * FROM studio_jobs WHERE user_id=? AND request_id=?').get(a.user.id,body.requestId);
          if (duplicate) { insist(duplicate.project_id === row.id && duplicate.prompt === prompt && (body.modelId === undefined || JSON.parse(duplicate.settings).model === body.modelId),409,'This request ID belongs to another build.'); json(res,200,{ job:jobView(duplicate) }); return true; }
          insist(row.version === body.version,409,'Project changed. Reload before generating.');
          insist(allowed(row.tool_id,a.user),403,'This generator is not enabled for your account.');
          insist(workerReady(),503,'No healthy isolated worker is connected.');
          const id=randomBytes(16).toString('hex'), now=new Date().toISOString();
          store.transaction(() => {
            const s=models.select(body);
            const limits=control(store,a.user.id), day=now.slice(0,10);
            const usage=store.db.prepare("SELECT count(*) n,coalesce(sum(CASE WHEN status IN ('queued','running') THEN reserve ELSE cost END),0) cost FROM studio_jobs WHERE user_id=? AND created_at>=?").get(a.user.id,day);
            insist(usage.n < limits.daily_limit && usage.cost+s.maxBudgetMicros <= limits.daily_budget,429,'Your daily build or spending limit has been reached.');
            insist(!store.db.prepare("SELECT 1 FROM studio_jobs WHERE user_id=? AND status IN ('queued','running')").get(a.user.id),409,'Finish or cancel your active build first.');
            insist(store.db.prepare("SELECT count(*) n FROM studio_jobs WHERE status IN ('queued','running')").get().n < 20,503,'The build queue is full.');
            store.db.prepare('INSERT INTO studio_jobs(id,user_id,project_id,request_id,base_version,prompt,settings,reserve,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,a.user.id,row.id,body.requestId,row.version,prompt,JSON.stringify(s),s.maxBudgetMicros,now,now);
            models.reserve(id,a.user.id,s);
            event(store,id,'queued','Build queued. Only this project snapshot and request will be sent to the configured AI provider.');
          }); json(res,202,{ job:jobView(store.db.prepare('SELECT * FROM studio_jobs WHERE id=?').get(id)) }); return true;
        }
      }
      const jm=/^\/api\/jobs\/([a-f0-9]{32})(?:\/(cancel|apply|export))?$/.exec(path);
      if (jm) {
        const job=store.db.prepare('SELECT * FROM studio_jobs WHERE id=? AND user_id=?').get(jm[1],a.user.id); insist(job,404,'Build not found.');
        if (method === 'GET' && !jm[2]) { json(res,200,{ job:jobView(job) }); return true; }
        if (method === 'GET' && jm[2] === 'export') {
          const result=job.result ? JSON.parse(job.result) : null; insist(result?.files,409,'This build has no exportable files.');
          res.writeHead(200,{ 'content-type':'application/zip','content-disposition':`attachment; filename="proposal-${job.id}.zip"` }); res.end(zipFiles(result.files)); return true;
        }
        const body=await readJson(req); fields(body,jm[2] === 'apply' ? ['version'] : []);
        if (method === 'POST' && jm[2] === 'cancel') {
          store.transaction(() => {
            insist(store.db.prepare("UPDATE studio_jobs SET status='cancelled',cost=CASE WHEN status='running' THEN reserve ELSE 0 END,lease=NULL,updated_at=? WHERE id=? AND status IN ('queued','running')").run(new Date().toISOString(),job.id).changes,409,'This build is no longer running.');
            models.settle(job.id,job.status === 'queued' ? 'released' : 'pending');
            event(store,job.id,'cancelled','Cancellation requested. Any provider work already accepted may still be billed.');
          }); json(res,200,{ ok:true }); return true;
        }
        if (method === 'POST' && jm[2] === 'apply') {
          const saved=store.transaction(() => {
            insist(job.status === 'review',409,'Only reviewed build results can be applied.');
            const row=project(store,a.user.id,job.project_id); insist(!row.archived && row.version === job.base_version && body.version === row.version,409,'Project changed after this build started. Export the result or start a new build; nothing was overwritten.');
            const result=JSON.parse(job.result), updated=saveRevision(store,row,result.files,result.summary,a.user.id,body.version);
            store.db.prepare("UPDATE studio_jobs SET status='applied',updated_at=? WHERE id=?").run(new Date().toISOString(),job.id); return updated;
          }); json(res,200,{ project:saved }); return true;
        }
      }
      throw new StudioError(404,'Studio endpoint not found.');
    } catch (error) {
      if (!(error instanceof StudioError)) throw error;
      if (error.status === 429) res.setHeader('retry-after','60');
      json(res,error.status,{error:error.message}); return true;
    }
  }
  return { route, blocked };
}
