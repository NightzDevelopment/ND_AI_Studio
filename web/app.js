import { STORAGE_KEY, MAX_BRIEFS, validateCatalog, filterTools, parseBriefs, serializeBriefs } from './data.js';

const $ = id => document.getElementById(id);
const form = $('brief-form');
const glyphs = { coding: '</>', '3d-assets': '3D', animation: 'FX', 'image-texture': '2D', 'utility-content': '[]' };
const engines = { coding: 'AI coding', 'image-texture': 'Image & texture', '3d-assets': '3D assets', animation: 'Animation', 'utility-content': 'Utility & content' };
let catalog;
let briefs = [];
let category = 'all';
let activeTool;
let editing;
let storageBlocked = false;
let toastTimer;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function notify(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500);
}

function showError(message) {
  $('error-banner').textContent = message;
  $('error-banner').hidden = false;
}

function readBriefs() {
  return parseBriefs(localStorage.getItem(STORAGE_KEY), catalog.tools);
}

function loadBriefs() {
  try {
    briefs = readBriefs();
    storageBlocked = false;
    $('error-banner').hidden = true;
  } catch {
    storageBlocked = true;
    showError('Browser storage is unavailable or contains invalid project data. Existing data has not been changed. Brief writes are disabled.');
  }
}

function persist(next) {
  if (storageBlocked) throw new Error('Browser storage is unavailable. Existing data has not been changed.');
  const raw = serializeBriefs(next);
  parseBriefs(raw, catalog.tools);
  try { localStorage.setItem(STORAGE_KEY, raw); }
  catch { throw new Error('The brief could not be saved. Browser storage may be full or disabled.'); }
  briefs = next;
  renderProjects();
}

function renderTools() {
  if (!catalog) return;
  const matches = filterTools(catalog.tools, $('search').value, category);
  $('result-count').textContent = `${matches.length} of ${catalog.tools.length} planned tools`;
  $('no-tools').hidden = matches.length > 0;
  $('tool-grid').replaceChildren(...matches.map(tool => {
    const card = element('button', 'tool-card');
    card.type = 'button';
    card.setAttribute('aria-label', `${tool.name}. Planned. View details.`);
    const top = element('span', 'card-top');
    const glyph = element('span', 'tool-glyph', glyphs[tool.engine]);
    glyph.setAttribute('aria-hidden', 'true');
    top.append(glyph, element('span', 'planned-label', 'PLANNED'));
    const bottom = element('span', 'card-bottom');
    bottom.append(element('span', '', engines[tool.engine]), element('span', '', 'View details ↗'));
    card.append(top, element('strong', 'tool-title', tool.name), element('span', 'tool-summary', tool.description), bottom);
    card.addEventListener('click', () => openTool(tool));
    return card;
  }));
}

function openTool(tool) {
  activeTool = tool;
  $('tool-dialog-title').textContent = tool.name;
  $('tool-description').textContent = tool.description;
  $('tool-brief').hidden = tool.category === 'browse';
  $('tool-dialog').showModal();
}

function updateTarget() {
  const tool = catalog.tools.find(item => item.id === form.elements.toolId.value);
  $('target-label').hidden = tool?.engine !== 'coding';
}

function openBrief(toolId, brief) {
  if (!catalog) return notify('The tool catalog is not available yet.');
  if (storageBlocked) return notify('Browser storage must be available before saving briefs.');
  form.reset();
  editing = brief ? { ...brief } : null;
  if (toolId) form.elements.toolId.value = toolId;
  if (brief) {
    form.elements.name.value = brief.name;
    form.elements.requirements.value = brief.requirements;
    const target = [...form.elements.target.options].find(option => option.value === brief.target);
    if (target) form.elements.target.value = brief.target;
  }
  $('brief-dialog-title').textContent = brief ? 'Refine your brief.' : 'Start with an idea.';
  $('form-error').hidden = true;
  updateTarget();
  $('brief-dialog').showModal();
  form.elements.name.focus();
}

function exportBrief(brief) {
  const blob = new Blob([JSON.stringify({ kind: 'nd-ai-studio-project-brief', version: 1, brief }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = element('a');
  link.href = url;
  link.download = `${brief.name.replace(/[^a-zA-Z0-9_.-]/g, '_')}.brief.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function renderProjects() {
  if (!catalog) return;
  $('project-count').textContent = `${briefs.length} saved in this browser`;
  const list = $('project-list');
  list.replaceChildren();
  if (!briefs.length) {
    const empty = element('div', 'empty');
    empty.append(element('h3', '', 'Your next build starts here.'), element('p', '', 'Create a project brief to capture the requirements before development.'));
    const button = element('button', 'primary', 'Create your first brief');
    button.addEventListener('click', () => openBrief());
    empty.append(button);
    list.append(empty);
    return;
  }
  for (const brief of [...briefs].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))) {
    const tool = catalog.tools.find(item => item.id === brief.toolId);
    const card = element('article', 'project-card');
    const copy = element('div', 'project-copy');
    copy.append(element('h3', '', brief.name), element('div', 'project-meta', `${tool.name} / ${brief.target} / ${new Date(brief.updatedAt).toLocaleDateString()}`), element('p', '', brief.requirements.length > 220 ? `${brief.requirements.slice(0, 220)}...` : brief.requirements));
    const actions = element('div', 'project-actions');
    for (const [label, action] of [
      ['Edit', () => openBrief(brief.toolId, brief)],
      ['Export JSON', () => exportBrief(brief)],
      ['Delete', () => {
        if (!confirm(`Delete the local brief "${brief.name}"? This cannot be undone.`)) return;
        try { persist(readBriefs().filter(item => item.id !== brief.id)); notify('Project brief deleted.'); }
        catch (error) { notify(error.message); }
      }]
    ]) {
      const button = element('button', '', label);
      button.setAttribute('aria-label', `${label}: ${brief.name}`);
      button.addEventListener('click', action);
      actions.append(button);
    }
    card.append(copy, actions);
    list.append(card);
  }
}

function renderView() {
  const requested = location.hash.slice(1);
  const view = ['overview', 'tools', 'projects', 'readiness'].includes(requested) ? requested : 'overview';
  const labels = { overview: 'OVERVIEW', tools: 'TOOL LIBRARY', projects: 'PROJECT BRIEFS', readiness: 'BUILD READINESS' };
  $('view-label').textContent = labels[view];
  document.title = `ND AI Studio | ${labels[view].toLowerCase().replace(/\b\w/g, letter => letter.toUpperCase())}`;
  $('hero').hidden = view !== 'overview';
  $('tool-section').hidden = !['overview', 'tools'].includes(view);
  $('project-section').hidden = view !== 'projects';
  $('readiness-section').hidden = view !== 'readiness';
  document.querySelectorAll('[data-view]').forEach(link => {
    if (link.dataset.view === view) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  renderTools();
  renderProjects();
}

$('search').addEventListener('input', renderTools);
$('filters').addEventListener('click', event => {
  const button = event.target.closest('[data-category]');
  if (!button) return;
  category = button.dataset.category;
  $('filters').querySelectorAll('button').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  renderTools();
});
for (const id of ['new-brief', 'hero-brief']) $(id).addEventListener('click', () => openBrief());
$('tool-brief').addEventListener('click', () => { $('tool-dialog').close(); openBrief(activeTool.id); });
$('brief-tool').addEventListener('change', updateTarget);
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
window.addEventListener('hashchange', () => { renderView(); $('main').focus({ preventScroll: true }); });
window.addEventListener('storage', event => {
  if (catalog && (event.key === STORAGE_KEY || event.key === null)) { loadBriefs(); renderProjects(); }
});
form.addEventListener('submit', event => {
  event.preventDefault();
  try {
    const latest = readBriefs();
    const name = form.elements.name.value.trim();
    const requirements = form.elements.requirements.value.trim();
    if (!name || !requirements) throw new Error('Enter a project name and requirements, not only spaces.');
    if (!editing && latest.length >= MAX_BRIEFS) throw new Error(`A maximum of ${MAX_BRIEFS} local briefs can be saved. Export and delete an older brief first.`);
    const current = editing && latest.find(brief => brief.id === editing.id);
    if (editing && (!current || current.updatedAt !== editing.updatedAt)) throw new Error('This brief changed in another tab. Close this dialog and reopen the latest version.');
    const tool = catalog.tools.find(item => item.id === form.elements.toolId.value);
    if (!tool || tool.category === 'browse') throw new Error('Select a creation or conversion tool.');
    if (!editing && !globalThis.crypto?.randomUUID) throw new Error('Use HTTPS or localhost to create project briefs securely.');
    const brief = { id: editing?.id ?? crypto.randomUUID(), toolId: tool.id, name, requirements,
      target: tool.engine === 'coding' ? form.elements.target.value : 'Asset workspace', updatedAt: new Date().toISOString() };
    persist([brief, ...latest.filter(item => item.id !== brief.id)]);
    $('brief-dialog').close();
    location.hash = 'projects';
    renderView();
    notify('Project brief saved in this browser.');
  } catch (error) {
    $('form-error').textContent = error instanceof SyntaxError ? 'Saved project data is invalid. Existing data has not been changed.' : error.message;
    $('form-error').hidden = false;
  }
});

try {
  const response = await fetch('/catalog.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('Catalog request failed.');
  catalog = validateCatalog(await response.json());
  for (const tool of catalog.tools.filter(item => item.category !== 'browse')) {
    const option = element('option', '', tool.name);
    option.value = tool.id;
    $('brief-tool').append(option);
  }
  for (const [id, name] of Object.entries(engines)) {
    const row = element('div', 'engine-row');
    row.append(element('strong', '', name), element('span', '', `${catalog.tools.filter(tool => tool.engine === id).length} tools / Not connected`));
    $('engine-list').append(row);
  }
  loadBriefs();
  renderView();
} catch {
  showError('The tool catalog could not be loaded. Reload the page or check the deployment files. No brief data has been changed.');
  $('result-count').textContent = 'Catalog unavailable';
}
