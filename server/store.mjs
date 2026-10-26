import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path, { timeout: 5000, allowExtension: false });
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    if (path !== ':memory:') chmodSync(path, 0o600);
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version > 1) throw new Error('Database schema is newer than this server.');
    if (version === 0) this.transaction(() => {
      this.db.exec(`
        CREATE TABLE users (
          id TEXT PRIMARY KEY, discord_id TEXT NOT NULL UNIQUE,
          username TEXT NOT NULL, avatar TEXT,
          display_name TEXT NOT NULL, bio TEXT NOT NULL DEFAULT '',
          preferred_framework TEXT NOT NULL DEFAULT 'Standalone',
          density TEXT NOT NULL DEFAULT 'comfortable',
          version INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE sessions (
          hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          csrf TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX sessions_expiry ON sessions(expires_at);
        CREATE INDEX sessions_user ON sessions(user_id);
        CREATE TABLE oauth_flows (
          hash TEXT PRIMARY KEY, binding TEXT NOT NULL, verifier TEXT NOT NULL, expires_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX flows_expiry ON oauth_flows(expires_at);
        CREATE TABLE briefs (
          id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          tool_id TEXT NOT NULL, name TEXT NOT NULL, requirements TEXT NOT NULL, target TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          source_id TEXT, UNIQUE(user_id, source_id)
        ) STRICT;
        CREATE INDEX briefs_owner_updated ON briefs(user_id, updated_at DESC);
        PRAGMA user_version=1;
      `);
    });
    // Creation receipts deliberately do not reference a brief: deleting a brief
    // must not let a delayed retry recreate it. Existing import source IDs stay separate.
    this.transaction(() => this.db.exec(`
      CREATE TABLE IF NOT EXISTS brief_create_requests (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, brief_id TEXT NOT NULL,
        created_at TEXT NOT NULL, PRIMARY KEY(user_id, request_id)
      ) STRICT;
    `));
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  cleanup(now = Date.now()) {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
    this.db.prepare('DELETE FROM oauth_flows WHERE expires_at <= ?').run(now);
  }
  login(discord) {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO users(id,discord_id,username,avatar,display_name,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(discord_id) DO UPDATE SET username=excluded.username, avatar=excluded.avatar`)
      .run(randomUUID(), discord.id, discord.username, discord.avatar, discord.displayName, now, now);
    return this.db.prepare('SELECT * FROM users WHERE discord_id=?').get(discord.id);
  }
  user(id) { return this.db.prepare('SELECT * FROM users WHERE id=?').get(id); }
  session(hash) {
    return this.db.prepare('SELECT * FROM sessions WHERE hash=? AND expires_at>?').get(hash, Date.now());
  }
  newSession(hash, userId, csrf, seconds) {
    this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(hash, userId, csrf, Date.now(), Date.now() + seconds * 1000);
    this.db.prepare(`DELETE FROM sessions WHERE user_id=? AND hash NOT IN
      (SELECT hash FROM sessions WHERE user_id=? ORDER BY created_at DESC, rowid DESC LIMIT 10)`).run(userId, userId);
  }
  addFlow(hash, binding, verifier) {
    this.db.prepare('INSERT INTO oauth_flows VALUES(?,?,?,?)').run(hash, binding, verifier, Date.now() + 600000);
  }
  takeFlow(hash, binding) {
    return this.db.prepare('DELETE FROM oauth_flows WHERE hash=? AND binding=? AND expires_at>? RETURNING *')
      .get(hash, binding, Date.now());
  }
  profile(id, data) {
    return this.db.prepare(`UPDATE users SET display_name=?,bio=?,preferred_framework=?,density=?,
      version=version+1,updated_at=? WHERE id=? AND version=? RETURNING *`)
      .get(data.displayName, data.bio, data.preferredFramework, data.density, new Date().toISOString(), id, data.version);
  }
  list(userId) {
    return this.db.prepare(`SELECT id,tool_id AS toolId,name,requirements,target,version,
      created_at AS createdAt,updated_at AS updatedAt FROM briefs WHERE user_id=? ORDER BY updated_at DESC,id`).all(userId);
  }
  count(userId) { return this.db.prepare('SELECT count(*) AS n FROM briefs WHERE user_id=?').get(userId).n; }
  create(userId, data, sourceId = null) {
    const id = randomUUID(), now = new Date().toISOString();
    this.db.prepare('INSERT INTO briefs(id,user_id,tool_id,name,requirements,target,created_at,updated_at,source_id) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, userId, data.toolId, data.name, data.requirements, data.target, now, now, sourceId);
    return id;
  }
  briefCreateReceipt(userId, requestId) {
    return this.db.prepare('SELECT fingerprint,brief_id FROM brief_create_requests WHERE user_id=? AND request_id=?').get(userId, requestId);
  }
  rememberBriefCreate(userId, requestId, fingerprint, briefId) {
    this.db.prepare('INSERT INTO brief_create_requests(user_id,request_id,fingerprint,brief_id,created_at) VALUES(?,?,?,?,?)')
      .run(userId, requestId, fingerprint, briefId, new Date().toISOString());
  }
  update(userId, id, data) {
    return this.db.prepare(`UPDATE briefs SET tool_id=?,name=?,requirements=?,target=?,version=version+1,updated_at=?
      WHERE user_id=? AND id=? AND version=?`).run(data.toolId, data.name, data.requirements, data.target,
      new Date().toISOString(), userId, id, data.version).changes;
  }
  close() { this.db.close(); }
}
