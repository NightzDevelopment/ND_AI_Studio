export const STORAGE_KEY = 'nd-ai-studio.briefs.v1';
export const MAX_BRIEFS = 100;

export function validateCatalog(catalog) {
  if (!catalog || !Array.isArray(catalog.categories) || !Array.isArray(catalog.tools)) {
    throw new Error('The tool catalog is invalid.');
  }
  const categories = new Set(catalog.categories.map(category => category.id));
  const ids = new Set();
  for (const tool of catalog.tools) {
    if (!/^[a-z0-9-]+$/.test(tool.id) || ids.has(tool.id) || !categories.has(tool.category)
      || typeof tool.name !== 'string' || typeof tool.description !== 'string'
      || typeof tool.engine !== 'string' || tool.enabled !== false || tool.status !== 'planned') {
      throw new Error('The preview catalog contains an invalid or enabled tool.');
    }
    ids.add(tool.id);
  }
  return catalog;
}

export function filterTools(tools, query = '', category = 'all') {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return tools.filter(tool => (category === 'all' || tool.category === category)
    && terms.every(term => `${tool.name} ${tool.description} ${tool.engine}`.toLowerCase().includes(term)));
}

export function parseBriefs(raw, tools) {
  if (raw === null) return [];
  const data = JSON.parse(raw);
  const ids = new Set(tools.filter(tool => tool.category !== 'browse').map(tool => tool.id));
  const seen = new Set();
  if (data.version !== 1 || !Array.isArray(data.briefs) || data.briefs.length > MAX_BRIEFS) {
    throw new Error('Saved project briefs are invalid. Export or restore the stored data before continuing.');
  }
  for (const brief of data.briefs) {
    if (!brief || typeof brief.id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(brief.id)
      || seen.has(brief.id) || !ids.has(brief.toolId)
      || typeof brief.name !== 'string' || !brief.name.trim() || brief.name.length > 80
      || typeof brief.requirements !== 'string' || !brief.requirements.trim() || brief.requirements.length > 12000
      || typeof brief.target !== 'string' || brief.target.length > 80
      || typeof brief.updatedAt !== 'string' || !Number.isFinite(Date.parse(brief.updatedAt))) {
      throw new Error('A saved project brief is invalid. Stored data has not been changed.');
    }
    seen.add(brief.id);
  }
  return data.briefs.map(({ id, toolId, name, requirements, target, updatedAt }) =>
    ({ id, toolId, name, requirements, target, updatedAt }));
}

export function serializeBriefs(briefs) {
  return JSON.stringify({ version: 1, briefs });
}
