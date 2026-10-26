// Browser drafts retain their original source even when saved revisions change.
export class SourceDrafts {
  constructor() { this.entries = new Map(); this.identities = new Map(); this.projectVersion = null; }
  get size() { return this.entries.size; }
  has(path) { return this.entries.has(path); }
  get(path) { return this.entries.get(path)?.content; }
  record(path) { return this.entries.get(path); }
  identity(path) { return this.identities.get(path); }
  keys() { return this.entries.keys(); }
  delete(path) { this.entries.delete(path); this.identities.delete(path); }
  clear() { this.entries.clear(); this.identities.clear(); this.projectVersion = null; }
  edit(project, path, content) {
    const saved = project.files.find(file => file.path === path)?.content ?? null;
    if (content === saved) { this.delete(path); return; }
    const previous = this.entries.get(path);
    if (!previous) this.identities.set(path, crypto.randomUUID());
    this.entries.set(path, previous ? { ...previous, content } : { content, baseContent:saved, baseVersion:project.version });
  }
  conflicts(project, path) {
    const draft = this.entries.get(path);
    return Boolean(draft && (project.files.find(file => file.path === path)?.content ?? null) !== draft.baseContent);
  }
  saved(project, path, content, identity = this.identity(path)) {
    if (identity !== this.identity(path) || this.projectVersion !== null && project.version < this.projectVersion) return false;
    const draft = this.entries.get(path);
    if (!draft) return false;
    if (draft.content === content) this.delete(path);
    else this.entries.set(path, { ...draft, baseContent:content, baseVersion:project.version });
    return true;
  }
  paths(project) { return [...new Set([...project.files.map(file => file.path), ...this.keys()])]; }
  serialize(userId, projectId, tabs, selected, projectVersion = this.projectVersion) {
    const raw = JSON.stringify({ format:1, userId, projectId, projectVersion, entries:[...this.entries], identities:[...this.identities], tabs, selected });
    // Never write a recovery record that this version cannot read back.
    new SourceDrafts().restore(raw, userId, projectId);
    this.projectVersion = projectVersion;
    return raw;
  }
  restore(raw, userId, projectId) {
    if (typeof raw !== 'string' || raw.length > 1048576) throw new Error('Invalid draft recovery data.');
    const data = JSON.parse(raw);
    const path = value => typeof value === 'string' && value.length <= 180 && /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value) && value.split('/').every(part => part !== '.' && part !== '..');
    if (data?.format !== 1 || data.userId !== userId || data.projectId !== projectId || !Array.isArray(data.entries) || data.entries.length > 64 || !Array.isArray(data.tabs) || data.tabs.length > 64 || !data.tabs.every(path) || !(data.selected === null || path(data.selected))) throw new Error('Invalid draft recovery data.');
    const projectVersion = data.projectVersion ?? null;
    if (projectVersion !== null && (!Number.isSafeInteger(projectVersion) || projectVersion < 1)) throw new Error('Invalid draft recovery revision.');
    const identities = new Map();
    if (data.identities !== undefined) {
      if (!Array.isArray(data.identities) || data.identities.length > 64) throw new Error('Invalid draft recovery identities.');
      for (const pair of data.identities) {
        if (!Array.isArray(pair) || pair.length !== 2 || !path(pair[0]) || identities.has(pair[0]) || typeof pair[1] !== 'string' || !/^[a-f0-9-]{36}$/.test(pair[1])) throw new Error('Invalid draft recovery identity.');
        identities.set(pair[0], pair[1]);
      }
    }
    const restored = new Map();
    for (const entry of data.entries) {
      if (!Array.isArray(entry) || entry.length !== 2 || !path(entry[0]) || restored.has(entry[0])) throw new Error('Invalid draft recovery file.');
      const item = entry[1];
      if (!item || typeof item.content !== 'string' || item.content.length > 131072 || !(item.baseContent === null || typeof item.baseContent === 'string' && item.baseContent.length <= 131072) || !Number.isSafeInteger(item.baseVersion) || item.baseVersion < 1) throw new Error('Invalid draft recovery source.');
      restored.set(entry[0], { content:item.content, baseContent:item.baseContent, baseVersion:item.baseVersion });
    }
    this.entries = restored;
    this.identities = new Map([...restored.keys()].map(path => [path, identities.get(path) || crypto.randomUUID()]));
    this.projectVersion = projectVersion;
    return { tabs:[...new Set(data.tabs)], selected:data.selected };
  }
}

export const draftStorageKey = (userId, projectId) => `ndai:source-drafts:${userId}:${projectId}`;
