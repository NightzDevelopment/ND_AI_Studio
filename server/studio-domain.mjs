import { randomUUID, createHash } from 'node:crypto';

export const IMPLEMENTED_TOOLS = ['ai-script-generator', 'discord-bot-generator'];
export const PERMISSIONS = ['users:read', 'users:manage', 'projects:read', 'projects:manage', 'tools:manage', 'settings:manage', 'audit:read'];
export const FRAMEWORKS = ['Standalone', 'ND_Framework', 'ESX', 'QBCore', 'Qbox', 'vRP', 'ox_core', 'Custom'];
export const MAX_FILES = 64;
export const MAX_PROJECT_BYTES = 131072;
export class StudioError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const insist = (condition, status, message) => { if (!condition) throw new StudioError(status, message); };
export const digest = value => createHash('sha256').update(value).digest('hex');
export function string(value, limit, label, empty = false) {
  insist(typeof value === 'string' && value.length <= limit && !value.includes('\0') && (empty || value.trim()), 400, `Invalid ${label}.`);
  return value.trim();
}
export function integer(value, min, max, label) {
  insist(Number.isSafeInteger(value) && value >= min && value <= max, 400, `Invalid ${label}.`);
  return value;
}
export function fields(body, allowed) {
  insist(body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).every(key => allowed.includes(key)), 400, 'Unexpected request fields.');
}
export function filePath(path) {
  insist(typeof path === 'string' && path.length <= 180 && /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(path), 400, 'Use a relative file path with letters, digits, dots, underscores or hyphens.');
  const parts = path.split('/');
  insist(parts.every(part => part !== '.' && part !== '..' && !part.endsWith('.') && !/^(?:\.git|\.ssh|node_modules|vendor)$/i.test(part)), 400, 'Unsafe project path.');
  const name = parts.at(-1);
  insist(!/^(?:\.env(?:\..+)?|credentials(?:\..+)?|id_rsa|id_ed25519)$/i.test(name) || name === '.env.example', 400, 'Keep real credentials out of projects. Use .env.example for empty configuration examples.');
  insist(/\.(?:lua|js|mjs|cjs|json|html|css|sql|md|txt|cfg|meta|xml)$/i.test(name) || ['README', 'LICENSE', '.gitignore', '.env.example'].includes(name), 400, 'Only supported text source files can be stored.');
  return path;
}
export function validateFiles(files) {
  insist(Array.isArray(files) && files.length <= MAX_FILES, 400, `A project supports at most ${MAX_FILES} files.`);
  const seen = new Set(); let bytes = 0;
  const result = files.map(file => {
    fields(file, ['path', 'content']);
    const path = filePath(file.path);
    insist(!seen.has(path.toLowerCase()), 400, 'Duplicate or case-colliding file paths.');
    insist(typeof file.content === 'string' && !file.content.includes('\0') && Buffer.byteLength(file.content) <= 65536, 400, 'Each file must be text, at most 64 KiB.');
    seen.add(path.toLowerCase()); bytes += Buffer.byteLength(file.content);
    return { path, content: file.content };
  }).sort((a, b) => a.path.localeCompare(b.path));
  insist(bytes <= MAX_PROJECT_BYTES, 413, 'Project source exceeds 128 KiB.');
  for (const path of seen) for (const other of seen) insist(!other.startsWith(`${path}/`), 400, 'A file cannot also be a directory.');
  return result;
}
export function changedFiles(base, changes) {
  insist(Array.isArray(changes) && changes.length <= MAX_FILES, 400, 'Invalid generated file changes.');
  const map = new Map(validateFiles(base).map(file => [file.path, file.content]));
  const seen = new Set();
  for (const change of changes) {
    fields(change, ['path', 'content']); const path = filePath(change.path);
    insist(!seen.has(path.toLowerCase()), 400, 'Duplicate generated change.'); seen.add(path.toLowerCase());
    if (change.content === null) map.delete(path); else map.set(path, change.content);
  }
  return validateFiles([...map].map(([path, content]) => ({ path, content })));
}
export const DEFAULT_SETTINGS = Object.freeze({
  guildId: '', roleMappings: {}, tools: { 'ai-script-generator': 'disabled', 'discord-bot-generator': 'disabled' },
  model: '', maxOutputTokens: 8192, maxCalls: 2, maxBudgetMicros: 250000,
  inputUsdPerMillion: 0, outputUsdPerMillion: 0,
});
export function settingsData(body) {
  fields(body, [...Object.keys(DEFAULT_SETTINGS), 'version']);
  const next = { ...DEFAULT_SETTINGS, ...body }; delete next.version;
  insist(next.guildId === '' || /^\d{17,20}$/.test(next.guildId), 400, 'Invalid Discord guild ID.');
  insist(next.roleMappings && typeof next.roleMappings === 'object' && !Array.isArray(next.roleMappings) && Object.keys(next.roleMappings).length <= 20, 400, 'At most 20 role mappings are supported.');
  for (const [role, permissions] of Object.entries(next.roleMappings)) {
    insist(/^\d{17,20}$/.test(role) && Array.isArray(permissions) && permissions.length <= PERMISSIONS.length && permissions.every(permission => PERMISSIONS.includes(permission)), 400, 'Invalid Discord role permissions.');
  }
  fields(next.tools, IMPLEMENTED_TOOLS);
  insist(IMPLEMENTED_TOOLS.every(id => ['disabled', 'owner', 'members'].includes(next.tools[id])), 400, 'Invalid tool access mode.');
  insist(typeof next.model === 'string' && (next.model === '' || /^[a-zA-Z0-9_.:-]{1,100}$/.test(next.model)), 400, 'Invalid model identifier.');
  integer(next.maxOutputTokens, 512, 16384, 'output token limit'); integer(next.maxCalls, 1, 2, 'provider call limit');
  integer(next.maxBudgetMicros, 10000, 10000000, 'per-build budget');
  for (const key of ['inputUsdPerMillion', 'outputUsdPerMillion']) insist(typeof next[key] === 'number' && Number.isFinite(next[key]) && next[key] >= 0 && next[key] <= 1000, 400, 'Invalid model price.');
  return next;
}
export function migrateStudio(store) {
  store.transaction(() => store.db.exec(`
    CREATE TABLE IF NOT EXISTS studio_settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1) STRICT;
    CREATE TABLE IF NOT EXISTS studio_controls (user_id TEXT PRIMARY KEY REFERENCES users(id), status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended')), daily_limit INTEGER NOT NULL DEFAULT 5, daily_budget INTEGER NOT NULL DEFAULT 1000000, version INTEGER NOT NULL DEFAULT 1) STRICT;
    CREATE TABLE IF NOT EXISTS studio_roles (user_id TEXT PRIMARY KEY REFERENCES users(id), guild_id TEXT NOT NULL, roles TEXT NOT NULL, checked_at INTEGER NOT NULL, ok INTEGER NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS studio_audit (id INTEGER PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS studio_projects (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), tool_id TEXT NOT NULL, name TEXT NOT NULL, target TEXT NOT NULL, requirements TEXT NOT NULL, favorite INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
    CREATE INDEX IF NOT EXISTS studio_projects_owner ON studio_projects(user_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS studio_revisions (project_id TEXT NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE, version INTEGER NOT NULL, files TEXT NOT NULL, summary TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(project_id, version)) STRICT;
    CREATE TABLE IF NOT EXISTS studio_jobs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), project_id TEXT NOT NULL REFERENCES studio_projects(id), request_id TEXT NOT NULL, base_version INTEGER NOT NULL, prompt TEXT NOT NULL, settings TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', lease TEXT, lease_until INTEGER, cancel INTEGER NOT NULL DEFAULT 0, result TEXT, cost INTEGER NOT NULL DEFAULT 0, reserve INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(user_id,request_id)) STRICT;
    CREATE INDEX IF NOT EXISTS studio_jobs_queue ON studio_jobs(status,created_at);
    CREATE INDEX IF NOT EXISTS studio_jobs_owner ON studio_jobs(user_id,created_at);
    CREATE TABLE IF NOT EXISTS studio_events (id INTEGER PRIMARY KEY, job_id TEXT NOT NULL REFERENCES studio_jobs(id), stage TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
    CREATE INDEX IF NOT EXISTS studio_events_job ON studio_events(job_id,id);
    CREATE TABLE IF NOT EXISTS studio_worker (id INTEGER PRIMARY KEY CHECK(id=1), checked_at INTEGER NOT NULL, ready INTEGER NOT NULL) STRICT;
  `));
  store.db.prepare('INSERT OR IGNORE INTO studio_settings(id,value) VALUES(1,?)').run(JSON.stringify(DEFAULT_SETTINGS));
}
export function studioSettings(store) {
  const row = store.db.prepare('SELECT * FROM studio_settings WHERE id=1').get();
  return { ...JSON.parse(row.value), version: row.version };
}
export function control(store, userId) {
  return store.db.prepare('SELECT * FROM studio_controls WHERE user_id=?').get(userId) || { user_id: userId, status: 'active', daily_limit: 5, daily_budget: 1000000, version: 0 };
}
export function audit(store, actor, action, target, detail = '') {
  store.db.prepare('INSERT INTO studio_audit(actor,action,target,detail,created_at) VALUES(?,?,?,?,?)').run(actor, action, target, detail.slice(0, 500), new Date().toISOString());
}
export function event(store, jobId, stage, message) {
  const count = store.db.prepare('SELECT count(*) n FROM studio_events WHERE job_id=?').get(jobId).n;
  insist(count < 100, 409, 'Build event limit reached.');
  store.db.prepare('INSERT INTO studio_events(job_id,stage,message,created_at) VALUES(?,?,?,?)').run(jobId, stage, message.slice(0, 1000), new Date().toISOString());
}
export function project(store, userId, id) {
  const row = store.db.prepare('SELECT * FROM studio_projects WHERE id=? AND user_id=?').get(id, userId);
  insist(row, 404, 'Project not found.'); return row;
}
export function snapshot(store, row, version = row.version) {
  const revision = store.db.prepare('SELECT * FROM studio_revisions WHERE project_id=? AND version=?').get(row.id, version);
  insist(revision, 404, 'Project revision not found.');
  return { ...row, files: JSON.parse(revision.files), revision: version };
}
export function saveRevision(store, row, files, summary, actor, expected = row.version) {
  integer(expected, 1, 1000000000, 'project revision');
  insist(row.version === expected, 409, 'Project changed. Reload and compare your changes before saving.');
  const count = store.db.prepare('SELECT count(*) n FROM studio_revisions WHERE project_id=?').get(row.id).n;
  insist(count < 100, 409, 'Project reached 100 revisions. Export it before starting a new project.');
  const raw = JSON.stringify(validateFiles(files));
  const stored = store.db.prepare('SELECT coalesce(sum(length(CAST(r.files AS BLOB))),0) n FROM studio_revisions r JOIN studio_projects p ON p.id=r.project_id WHERE p.user_id=?').get(row.user_id).n;
  insist(stored + Buffer.byteLength(raw) <= 33554432, 409, 'Account source storage has reached 32 MiB.');
  const now = new Date().toISOString();
  const changed = store.db.prepare('UPDATE studio_projects SET version=version+1,updated_at=? WHERE id=? AND version=?').run(now, row.id, expected).changes;
  insist(changed, 409, 'Project changed. Reload before saving.');
  store.db.prepare('INSERT INTO studio_revisions VALUES(?,?,?,?,?,?)').run(row.id, expected + 1, raw, summary.slice(0, 500), actor, now);
  return snapshot(store, project(store, row.user_id, row.id));
}
export function newProject(store, userId, data, catalog) {
  const tool = catalog.tools.find(tool => tool.id === data.toolId && tool.category !== 'browse');
  insist(tool, 400, 'Choose a creation or conversion tool.');
  const target = tool.engine === 'coding' ? data.target : 'Asset workspace';
  insist(tool.engine !== 'coding' || FRAMEWORKS.includes(target), 400, 'Invalid framework.');
  insist(store.db.prepare('SELECT count(*) n FROM studio_projects WHERE user_id=?').get(userId).n < 100, 409, 'Account reached 100 projects.');
  const id = randomUUID(), now = new Date().toISOString();
  store.db.prepare('INSERT INTO studio_projects(id,user_id,tool_id,name,target,requirements,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(id,userId,tool.id,string(data.name,80,'project name'),target,string(data.requirements,12000,'requirements'),now,now);
  store.db.prepare('INSERT INTO studio_revisions VALUES(?,?,?,?,?,?)').run(id,1,'[]','Project created',userId,now);
  return snapshot(store, project(store,userId,id));
}
const crcTable = Array.from({ length: 256 }, (_, value) => { for (let n=0;n<8;n++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; return value >>> 0; });
function crc32(buffer) { let crc = 0xffffffff; for (const byte of buffer) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
export function zipFiles(files) {
  files = validateFiles(files); const chunks = [], central = []; let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.path), data = Buffer.from(file.content), crc = crc32(data);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20,4); header.writeUInt16LE(0x800,6); header.writeUInt16LE(33,12); header.writeUInt32LE(crc,14); header.writeUInt32LE(data.length,18); header.writeUInt32LE(data.length,22); header.writeUInt16LE(name.length,26);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20,4); entry.writeUInt16LE(20,6); entry.writeUInt16LE(0x800,8); entry.writeUInt16LE(33,14); entry.writeUInt32LE(crc,16); entry.writeUInt32LE(data.length,20); entry.writeUInt32LE(data.length,24); entry.writeUInt16LE(name.length,28); entry.writeUInt32LE(offset,42);
    chunks.push(header,name,data); central.push(entry,name); offset += header.length+name.length+data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length,8); end.writeUInt16LE(files.length,10); end.writeUInt32LE(directory.length,12); end.writeUInt32LE(offset,16);
  return Buffer.concat([...chunks,directory,end]);
}
