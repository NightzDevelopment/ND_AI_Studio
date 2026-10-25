// Browser drafts retain their original source even when saved revisions change.
export class SourceDrafts {
  constructor() { this.entries = new Map(); }
  get size() { return this.entries.size; }
  has(path) { return this.entries.has(path); }
  get(path) { return this.entries.get(path)?.content; }
  record(path) { return this.entries.get(path); }
  keys() { return this.entries.keys(); }
  delete(path) { this.entries.delete(path); }
  clear() { this.entries.clear(); }
  edit(project, path, content) {
    const saved = project.files.find(file => file.path === path)?.content ?? null;
    if (content === saved) { this.delete(path); return; }
    const previous = this.entries.get(path);
    this.entries.set(path, previous ? { ...previous, content } : { content, baseContent:saved, baseVersion:project.version });
  }
  conflicts(project, path) {
    const draft = this.entries.get(path);
    return Boolean(draft && (project.files.find(file => file.path === path)?.content ?? null) !== draft.baseContent);
  }
  saved(project, path, content) {
    const draft = this.entries.get(path);
    if (!draft) return;
    if (draft.content === content) this.delete(path);
    else this.entries.set(path, { ...draft, baseContent:content, baseVersion:project.version });
  }
  paths(project) { return [...new Set([...project.files.map(file => file.path), ...this.keys()])]; }
  serialize(userId, projectId, tabs, selected) {
    const raw = JSON.stringify({ format:1, userId, projectId, entries:[...this.entries], tabs, selected });
    // Never write a recovery record that this version cannot read back.
    new SourceDrafts().restore(raw, userId, projectId);
    return raw;
  }
  restore(raw, userId, projectId) {
    if (typeof raw !== 'string' || raw.length > 1048576) throw new Error('Invalid draft recovery data.');
    const data = JSON.parse(raw);
    const path = value => typeof value === 'string' && value.length <= 180 && /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value) && value.split('/').every(part => part !== '.' && part !== '..');
    if (data?.format !== 1 || data.userId !== userId || data.projectId !== projectId || !Array.isArray(data.entries) || data.entries.length > 64 || !Array.isArray(data.tabs) || data.tabs.length > 64 || !data.tabs.every(path) || !(data.selected === null || path(data.selected))) throw new Error('Invalid draft recovery data.');
    const restored = new Map();
    for (const entry of data.entries) {
      if (!Array.isArray(entry) || entry.length !== 2 || !path(entry[0]) || restored.has(entry[0])) throw new Error('Invalid draft recovery file.');
      const item = entry[1];
      if (!item || typeof item.content !== 'string' || item.content.length > 131072 || !(item.baseContent === null || typeof item.baseContent === 'string' && item.baseContent.length <= 131072) || !Number.isSafeInteger(item.baseVersion) || item.baseVersion < 1) throw new Error('Invalid draft recovery source.');
      restored.set(entry[0], { content:item.content, baseContent:item.baseContent, baseVersion:item.baseVersion });
    }
    this.entries = restored;
    return { tabs:[...new Set(data.tabs)], selected:data.selected };
  }
}

export const draftStorageKey = (userId, projectId) => `ndai:source-drafts:${userId}:${projectId}`;
