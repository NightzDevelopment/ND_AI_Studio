import { randomBytes, timingSafeEqual } from 'node:crypto';
import { StudioError, insist, fields, string, integer, digest, validateFiles, validatePreviewChanges, filePath, migrateStudio, studioSettings, settingsData, control, audit, event, project, snapshot, saveRevision, newProject, zipFiles, IMPLEMENTED_TOOLS, PERMISSIONS } from './studio-domain.mjs';
import { createModels } from './studio-models.mjs';
import { createSubscriptions } from './subscriptions.mjs';
import { memberRoles, discordRequest } from './studio-discord.mjs';

export function createStudio({ store, config, catalog, required, mutation, readJson:readBody, json, fetcher = fetch }) {
  migrateStudio(store);
  const actors = new WeakMap();
  const subscriptions = createSubscriptions({store,config,actor,readJson,json,fetcher,canSell:(userId,plan)=>{
    const settings=studioSettings(store), limits=control(store,userId);
    return workerReady() && IMPLEMENTED_TOOLS.some(id=>settings.tools[id]==='members') && limits.daily_limit>0 && models.configuration().models.some(model=>model.enabled && model.compatible && workerReady(model.provider || 'openai') && model.maxBudgetMicros<=Math.min(plan.credits*10000,limits.daily_budget));
  }});
  const models = createModels({store,actor,readJson,json,workerReady,subscriptions});
  const owners = new Set(config.ownerIds || []);
  const isOwner = user => Boolean(user && owners.has(user.discord_id));
  const blocked = id => control(store, id).status === 'suspended';
  function workerProviders() {
    const row = store.db.prepare('SELECT providers FROM studio_worker_providers WHERE id=1').get();
    return row ? JSON.parse(row.providers) : ['openai'];
  }
  function workerReady(provider = null) {
    const row = store.db.prepare('SELECT * FROM studio_worker WHERE id=1').get();
    return Boolean(config.workerToken && row?.ready && row.checked_at > Date.now() - 45000 && (provider === null || workerProviders().includes(provider)));
  }
  function readyProviders() {
    return workerReady() ? workerProviders() : [];
  }
  async function actor(req, write = false, permission = null) {
    const previous = actors.get(req);
    const session = write ? mutation(req,previous?.session) : required(req), user = store.user(session.user_id);
    if (previous) insist(session.user_id === previous.session.user_id && session.hash === previous.session.hash,401,'Your session changed. Sign in again before continuing.');
    insist(user && !blocked(user.id), 403, 'This Studio account is suspended.');
    let roles = [], guildId = null;
    if (!isOwner(user) && (permission || !write)) {
      guildId = studioSettings(store).guildId;
      roles = await memberRoles(store, config, user, { refresh: write, fetcher });
    }
    const check = () => {
      const current = write ? mutation(req,session) : required(req);
      insist(current.user_id === session.user_id && current.hash === session.hash,401,'Your session changed. Sign in again before continuing.');
      const user = store.user(current.user_id), settings = studioSettings(store);
      insist(user && !blocked(user.id),403,'This Studio account is suspended.');
      insist(guildId === null || settings.guildId === guildId,409,'Discord configuration changed. Retry with current permissions.');
      const permissions = isOwner(user) ? [...PERMISSIONS] : [...new Set(roles.flatMap(role => settings.roleMappings[role] || []))];
      if (permission) insist(permissions.includes(permission),403,'You do not have permission for this action.');
      return { user, permissions, owner:isOwner(user) };
    };
    const result = Object.assign(previous || {},check(),{session,write,permission,check});
    actors.set(req,result);
    return result;
  }
  async function readJson(req,limit) {
    const body = await readBody(req,limit), proof = actors.get(req);
    if (proof) await actor(req,proof.write,proof.permission);
    return body;
  }
  function allowed(toolId, user) {
    const mode = studioSettings(store).tools[toolId];
    return IMPLEMENTED_TOOLS.includes(toolId) && (mode === 'members' || (mode === 'owner' && isOwner(user)));
  }
  function jobView(row, details = true) {
    const live = row.status === 'running' && row.preview && row.lease_until > Date.now();
    const user = live ? store.user(row.user_id) : null;
    const source = user ? store.db.prepare('SELECT tool_id,archived FROM studio_projects WHERE id=? AND user_id=?').get(row.project_id,row.user_id) : null;
    const previewVisible = Boolean(source && !source.archived && !blocked(user.id) && allowed(source.tool_id,user));
    return { ...models.describe(row), id: row.id, projectId: row.project_id, baseVersion: row.base_version, prompt: details ? row.prompt : undefined, status: row.status,
      applicationMode:row.application_mode, appliedVersion:row.applied_version, applicationError:row.application_error,
      costMicros: row.cost, reservedMicros: row.reserve, createdAt: row.created_at, updatedAt: row.updated_at,
      result: details && row.result ? JSON.parse(row.result) : null,
      previewVersion:previewVisible ? row.preview_sequence : 0,
      preview:details ? previewVisible ? JSON.parse(row.preview) : null : undefined,
      events: details ? store.db.prepare('SELECT id,stage,message,created_at AS createdAt FROM studio_events WHERE job_id=? ORDER BY id').all(row.id) : [] };
  }
  function completionView(row) {
    return { ok:true, status:row.status, appliedVersion:row.applied_version, applicationError:row.application_error };
  }
  function expireJobs() {
    const now = new Date().toISOString();
    store.db.prepare("UPDATE studio_jobs SET status='failed',cost=reserve,lease=NULL,preview=NULL,result=?,updated_at=? WHERE status='running' AND lease_until<?")
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
    insist(!blocked(user.id) && !p.archived && allowed(p.tool_id,user) && subscriptions.jobAllowed(row.id), 409, 'Build access was revoked.');
    return row;
  }
  async function route(req, res, url) {
    const path = url.pathname, method = req.method;
    if (!/^\/api\/(?:studio|projects|jobs|admin|worker)(?:\/|$)/.test(path)) return false;
    try {
      expireJobs();
      models.recover();
      subscriptions.recover();
      if (await subscriptions.route(req,res,url)) return true;
      if (await models.route(req,res,url)) return true;
      if (path.startsWith('/api/worker/')) {
        workerAuth(req);
        insist(method === 'POST',405,'Use POST for worker requests.');
        const body = await readJson(req,1048576);
        if (path === '/api/worker/status') {
          fields(body,[]); json(res,200,{ ready:workerReady(), providers:readyProviders() }); return true;
        }
        if (path === '/api/worker/heartbeat') {
          fields(body,['ready','providers']); insist(typeof body.ready === 'boolean',400,'Invalid worker readiness.');
          const providers = body.providers === undefined ? ['openai'] : body.providers;
          insist(Array.isArray(providers) && providers.length <= 2 && providers.every(provider => ['openai','deepseek'].includes(provider)) && new Set(providers).size === providers.length,400,'Invalid worker providers.');
          store.transaction(() => {
            store.db.prepare('INSERT INTO studio_worker VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET checked_at=excluded.checked_at,ready=excluded.ready').run(Date.now(),Number(body.ready));
            store.db.prepare('INSERT INTO studio_worker_providers VALUES(1,?) ON CONFLICT(id) DO UPDATE SET providers=excluded.providers').run(JSON.stringify(providers));
          });
          json(res,200,{ ok:true }); return true;
        }
        if (path === '/api/worker/claim') {
          fields(body,[]); insist(workerReady(),503,'Worker is not ready.');
          let claimed = null;
          store.transaction(() => {
            const rows = store.db.prepare("SELECT * FROM studio_jobs WHERE status='queued' ORDER BY created_at LIMIT 20").all();
            for (const row of rows) {
              const p = project(store,row.user_id,row.project_id), user = store.user(row.user_id);
              if (blocked(user.id) || p.archived || !allowed(p.tool_id,user) || !subscriptions.jobAllowed(row.id)) {
                store.db.prepare("UPDATE studio_jobs SET status='cancelled',preview=NULL,updated_at=? WHERE id=?").run(new Date().toISOString(),row.id); models.settle(row.id,'released'); continue;
              }
              const settings = JSON.parse(row.settings);
              if (!workerReady(settings.provider || 'openai')) continue;
              const lease = randomBytes(32).toString('base64url');
              store.db.prepare("UPDATE studio_jobs SET status='running',lease=?,lease_until=?,updated_at=? WHERE id=? AND status='queued'").run(digest(lease),Date.now()+120000,new Date().toISOString(),row.id);
              event(store,row.id,'planning','Worker claimed the build.');
              claimed = { id:row.id, lease, prompt:row.prompt, applicationMode:row.application_mode, project:snapshot(store,p,row.base_version), settings }; break;
            }
          });
          json(res,200,{ job:claimed }); return true;
        }
        if (path === '/api/worker/preview') {
          fields(body,['id','lease','sequence','attempt','changes']);
          insist(typeof body.id === 'string' && /^[a-f0-9]{32}$/.test(body.id) && typeof body.lease === 'string',400,'Invalid preview build identity.');
          const sequence = integer(body.sequence,1,Number.MAX_SAFE_INTEGER,'preview sequence');
          const attempt = integer(body.attempt,1,2,'preview attempt');
          const changes = validatePreviewChanges(body.changes);
          const reply = store.transaction(() => {
            const row = workerJob(body), previous = row.preview ? JSON.parse(row.preview) : null;
            insist(attempt <= JSON.parse(row.settings).maxCalls,400,'Preview attempt exceeds this build call limit.');
            if (sequence <= row.preview_sequence || previous && attempt < previous.attempt) return { ok:true,accepted:false,previewVersion:row.preview_sequence };
            store.db.prepare('UPDATE studio_jobs SET preview=?,preview_sequence=? WHERE id=?').run(JSON.stringify({sequence,attempt,changes}),sequence,row.id);
            return { ok:true,accepted:true,previewVersion:sequence };
          });
          json(res,200,reply); return true;
        }
        fields(body,['id','lease','stage','message','result','costMicros']);
        if (path === '/api/worker/progress') {
          const row = workerJob(body);
          if (body.stage !== undefined) {
            insist(['planning','generating','checking','repairing','packaging'].includes(body.stage),400,'Invalid build stage.');
            event(store,row.id,body.stage,string(body.message,1000,'build event'));
            store.db.prepare('UPDATE studio_jobs SET updated_at=? WHERE id=?').run(new Date().toISOString(),row.id);
          }
          store.db.prepare('UPDATE studio_jobs SET lease_until=? WHERE id=?').run(Date.now()+120000,row.id);
          json(res,200,{ ok:true }); return true;
        }
        if (path === '/api/worker/complete') {
          fields(body.result,['files','summary','checks','error','accounting']);
          const cost = integer(body.costMicros,0,1000000000,'reported cost');
          let accounting;
          if (body.result.accounting !== undefined) {
            fields(body.result.accounting,['status','reason']);
            insist(body.result.accounting.status === 'unreconciled' && ['cache-write-lifetimes-unavailable','cache-write-price-unconfigured'].includes(body.result.accounting.reason),400,'Invalid provider accounting status.');
            accounting = { status:'unreconciled',reason:body.result.accounting.reason };
          }
          let result, status;
          if (body.result.error) {
            result = { error:string(body.result.error,1000,'build error') }; status='failed';
          } else {
            const files = validateFiles(body.result.files);
            insist(Array.isArray(body.result.checks) && body.result.checks.length <= 100 && body.result.checks.every(check => typeof check === 'string' && check.length <= 2000),400,'Invalid build checks.');
            result = { files, summary:string(body.result.summary,2000,'build summary'), checks:body.result.checks }; status='review';
          }
          if (accounting) result.accounting = accounting;
          const fingerprint = digest(JSON.stringify({costMicros:cost,result}));
          const completed = store.transaction(() => {
            const previous = store.db.prepare('SELECT * FROM studio_jobs WHERE id=?').get(body.id || '');
            if (previous?.completion_hash) {
              insist(typeof body.lease === 'string' && digest(body.lease) === previous.completion_lease && fingerprint === previous.completion_hash,409,'This build was already completed with a different receipt.');
              return previous;
            }
            const row = workerJob(body), settings = JSON.parse(row.settings);
            insist(!accounting || cost >= settings.maxBudgetMicros,400,'Unreconciled provider accounting must retain at least the full captured build reservation.');
            if (cost > settings.maxBudgetMicros) { status='failed'; result={ error:'Provider usage exceeded the configured estimate. Review billing and model prices before retrying.',...(accounting?{accounting}:{}) }; }
            let appliedVersion = null, applicationError = null;
            if (status === 'review' && row.application_mode === 'automatic') {
              // A save conflict must retain the validated output without partial source writes.
              store.db.exec('SAVEPOINT generated_revision');
              try {
                const p = project(store,row.user_id,row.project_id);
                appliedVersion = saveRevision(store,p,result.files,result.summary,row.user_id,row.base_version).version;
                store.db.exec('RELEASE generated_revision');
                status = 'applied';
              } catch (error) {
                store.db.exec('ROLLBACK TO generated_revision'); store.db.exec('RELEASE generated_revision');
                if (!(error instanceof StudioError) || error.status !== 409) throw error;
                applicationError = error.message;
              }
            }
            store.db.prepare('UPDATE studio_jobs SET status=?,result=?,cost=?,lease=NULL,preview=NULL,applied_version=?,application_error=?,completion_lease=?,completion_hash=?,updated_at=? WHERE id=?')
              .run(status,JSON.stringify(result),cost,appliedVersion,applicationError,digest(body.lease),fingerprint,new Date().toISOString(),row.id);
            models.settle(row.id,['review','applied'].includes(status) ? 'charged' : cost === 0 ? 'released' : 'pending');
            const message = status === 'applied' ? `Validated files saved as project revision ${appliedVersion}. Runtime behavior has not been tested.` : status === 'review' ? applicationError ? `Validated output preserved for comparison and ZIP export. ${applicationError}` : 'Validated files are ready for optional review. Runtime behavior has not been tested.' : result.error;
            event(store,row.id,status,message,true);
            return store.db.prepare('SELECT * FROM studio_jobs WHERE id=?').get(row.id);
          });
          json(res,200,completionView(completed)); return true;
        }
        throw new StudioError(404,'Worker endpoint not found.');
      }
      if (method === 'GET' && path === '/api/studio/session') {
        const a = await actor(req);
        json(res,200,{ owner:a.owner, permissions:a.permissions, controls:control(store,a.user.id), workerReady:workerReady(), workerProviders:readyProviders(),
          tools:IMPLEMENTED_TOOLS.map(id => ({ id, enabled:allowed(id,a.user), workerReady:workerReady() })) }); return true;
      }
      if (method === 'POST' && path === '/api/studio/roles/refresh') {
        const a = await actor(req,true); await memberRoles(store,config,a.user,{ refresh:true,fetcher });
        a.check();
        json(res,200,{ ok:true }); return true;
      }
      if (path.startsWith('/api/admin')) {
        const permission = path.includes('/users') ? (method === 'GET' ? 'users:read' : 'users:manage') : path.includes('/projects') ? (method === 'GET' ? 'projects:read' : 'projects:manage') : path.includes('/audit') ? 'audit:read' : path.includes('/tools') ? 'tools:manage' : 'settings:manage';
        const a = await actor(req,method !== 'GET',permission);
        if (method === 'GET' && path === '/api/admin/settings') {
          json(res,200,{ settings:studioSettings(store), permissions:PERMISSIONS, botConfigured:Boolean(config.botToken), workerConfigured:Boolean(config.workerToken), workerReady:workerReady(), workerProviders:readyProviders(), ownerConfigured:owners.size > 0 }); return true;
        }
        if (method === 'PATCH' && path === '/api/admin/settings') {
          insist(a.owner,403,'Only the configured owner can change role mappings and provider settings.');
          const body = await readJson(req), next = settingsData(body); integer(body.version,1,1000000000,'settings revision');
          store.transaction(() => {
            a.check();
            insist(store.db.prepare('UPDATE studio_settings SET value=?,version=version+1 WHERE id=1 AND version=?').run(JSON.stringify(next),body.version).changes,409,'Settings changed. Reload before saving.');
            store.db.prepare('DELETE FROM studio_roles').run(); audit(store,a.user.id,'settings.update','studio');
          });
          json(res,200,{ settings:studioSettings(store) }); return true;
        }
        if (method === 'POST' && path === '/api/admin/discord/test') {
          insist(a.owner,403,'Only the owner can test the bot connection.');
          const s=studioSettings(store); insist(s.guildId,400,'Set a Discord guild ID first.');
          const bot=await discordRequest(config,'/users/@me',fetcher), guild=await discordRequest(config,`/guilds/${s.guildId}`,fetcher);
          a.check();
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
            a.check();
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
            a.check();
            insist(control(store,target.id).version === body.version,409,'Account controls changed. Reload before saving.');
            store.db.prepare('INSERT INTO studio_controls VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET status=excluded.status,daily_limit=excluded.daily_limit,daily_budget=excluded.daily_budget,version=excluded.version').run(target.id,body.status,body.dailyLimit,body.dailyBudgetMicros,body.version+1);
            if (body.revokeSessions || body.status === 'suspended') store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);
            if (body.status === 'suspended') store.db.prepare("UPDATE studio_jobs SET status='cancelled',cost=CASE WHEN status='running' THEN reserve ELSE 0 END,lease=NULL,preview=NULL,updated_at=? WHERE user_id=? AND status IN ('queued','running')").run(new Date().toISOString(),target.id);
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
            a.check();
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
        const created=store.transaction(() => { a.check(); return newProject(store,a.user.id,data,catalog); });
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
          json(res,200,{ jobs:store.db.prepare('SELECT * FROM studio_jobs WHERE project_id=? ORDER BY created_at DESC LIMIT 20').all(row.id).map(item => jobView(item,false)),projectVersion:row.version,projectUpdatedAt:row.updated_at }); return true;
        }
        const body=await readJson(req,1048576);
        if (method === 'PATCH' && !action) {
          fields(body,['version','name','requirements','favorite','archived']); integer(body.version,1,1000000000,'project revision');
          const name=string(body.name,80,'name'), requirements=string(body.requirements,12000,'requirements');
          insist(typeof body.favorite === 'boolean' && typeof body.archived === 'boolean',400,'Invalid project state.');
          const saved=store.transaction(() => {
            a.check();
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
          const saved=store.transaction(() => { a.check(); return saveRevision(store,row,files,body.remove ? `Delete ${body.path}` : body.renameTo ? `Rename ${body.path}` : `Save ${body.path}`,a.user.id,body.version); });
          json(res,200,{ project:saved }); return true;
        }
        if (method === 'POST' && action === 'restore') {
          fields(body,['version','revision']); integer(body.version,1,1000000000,'project revision'); const old=snapshot(store,row,integer(body.revision,1,1000000000,'revision'));
          const saved=store.transaction(() => { a.check(); return saveRevision(store,row,old.files,`Restore revision ${body.revision}`,a.user.id,body.version); });
          json(res,200,{ project:saved }); return true;
        }
        if (method === 'POST' && action === 'jobs') {
          fields(body,['version','prompt','requestId','modelId','pricingVersion','quotedCredits','applicationMode']); const prompt=string(body.prompt,12000,'build request');
          const applicationMode = body.applicationMode === undefined ? 'automatic' : body.applicationMode; insist(['automatic','review'].includes(applicationMode),400,'Choose automatic saving or review for this build.');
          insist(typeof body.requestId === 'string' && /^[a-f0-9-]{36}$/.test(body.requestId),400,'Invalid build request ID.');
          const duplicate=store.db.prepare('SELECT * FROM studio_jobs WHERE user_id=? AND request_id=?').get(a.user.id,body.requestId);
          if (duplicate) { insist(duplicate.project_id === row.id && duplicate.prompt === prompt && (body.applicationMode === undefined || duplicate.application_mode === applicationMode) && (body.modelId === undefined || JSON.parse(duplicate.settings).model === body.modelId),409,'This request ID belongs to another build.'); json(res,200,{ job:jobView(duplicate) }); return true; }
          insist(row.version === body.version,409,'Project changed. Reload before generating.');
          insist(allowed(row.tool_id,a.user),403,'This generator is not enabled for your account.');
          insist(workerReady(),503,'No healthy isolated worker is connected.');
          const id=randomBytes(16).toString('hex'), now=new Date().toISOString();
          store.transaction(() => {
            a.check();
            const current=project(store,a.user.id,row.id);
            insist(!current.archived && current.version === body.version,409,'Project changed. Reload before generating.');
            insist(allowed(current.tool_id,a.user),403,'This generator is not enabled for your account.');
            const s=models.select(body,a.user.id);
            insist(workerReady(s.provider || 'openai'),503,'The connected worker has no configured credential for the selected provider. Choose a supported model or configure that provider privately on the worker.');
            const limits=control(store,a.user.id), day=now.slice(0,10);
            const usage=store.db.prepare("SELECT count(*) n,coalesce(sum(CASE WHEN status IN ('queued','running') THEN reserve ELSE cost END),0) cost FROM studio_jobs WHERE user_id=? AND created_at>=?").get(a.user.id,day);
            insist(usage.n < limits.daily_limit && usage.cost+s.maxBudgetMicros <= limits.daily_budget,429,'Your daily build or spending limit has been reached.');
            insist(!store.db.prepare("SELECT 1 FROM studio_jobs WHERE user_id=? AND status IN ('queued','running')").get(a.user.id),409,'Finish or cancel your active build first.');
            insist(store.db.prepare("SELECT count(*) n FROM studio_jobs WHERE status IN ('queued','running')").get().n < 20,503,'The build queue is full.');
            store.db.prepare('INSERT INTO studio_jobs(id,user_id,project_id,request_id,base_version,prompt,settings,reserve,created_at,updated_at,application_mode) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,a.user.id,row.id,body.requestId,row.version,prompt,JSON.stringify(s),s.maxBudgetMicros,now,now,applicationMode);
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
            a.check();
            const current=store.db.prepare('SELECT status FROM studio_jobs WHERE id=? AND user_id=?').get(job.id,a.user.id);
            insist(store.db.prepare("UPDATE studio_jobs SET status='cancelled',cost=CASE WHEN status='running' THEN reserve ELSE 0 END,lease=NULL,preview=NULL,updated_at=? WHERE id=? AND status IN ('queued','running')").run(new Date().toISOString(),job.id).changes,409,'This build is no longer running.');
            models.settle(job.id,current.status === 'queued' ? 'released' : 'pending');
            event(store,job.id,'cancelled','Cancellation requested. Any provider work already accepted may still be billed.',true);
          }); json(res,200,{ ok:true }); return true;
        }
        if (method === 'POST' && jm[2] === 'apply') {
          const saved=store.transaction(() => {
            a.check();
            const current=store.db.prepare('SELECT * FROM studio_jobs WHERE id=? AND user_id=?').get(job.id,a.user.id);
            if (current.status === 'applied' && current.applied_version) {
              const row=project(store,a.user.id,current.project_id);
              return snapshot(store,row);
            }
            insist(current.status === 'review',409,'Only reviewed build results can be applied.');
            const row=project(store,a.user.id,current.project_id); insist(!row.archived && row.version === current.base_version && body.version === row.version,409,'Project changed after this build started. Export the result or start a new build; nothing was overwritten.');
            const result=JSON.parse(current.result), updated=saveRevision(store,row,result.files,result.summary,a.user.id,body.version);
            store.db.prepare("UPDATE studio_jobs SET status='applied',applied_version=?,application_error=NULL,preview=NULL,updated_at=? WHERE id=?").run(updated.version,new Date().toISOString(),job.id); return updated;
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
