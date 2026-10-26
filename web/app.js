import { STORAGE_KEY, MAX_BRIEFS, validateCatalog, filterTools, parseBriefs, serializeBriefs } from './data.js';
import { account, api, initAccount, downloadJson } from './account.js';
import { refreshSelects, confirmAction } from './controls.js';

const $ = id => document.getElementById(id);
const form = $('brief-form');
const glyphs = { coding: '</>', '3d-assets': '3D', animation: 'FX', 'image-texture': '2D', 'utility-content': '[]' };
const engines = { coding: 'AI coding', 'image-texture': 'Image & texture', '3d-assets': '3D assets', animation: 'Animation', 'utility-content': 'Utility & content' };
const codeWorkspaces = new Set(['ai-script-generator', 'discord-bot-generator']);
let catalog;
let briefs = [];
let category = 'all';
let activeTool;
let editing;
let cloud = false;
let storageBlocked = false;
let toastTimer;
let savePending = false, importPending = false;
let briefUserId = null, briefScope = null, briefsReady = false, briefLoadSequence = 0;
const deletingBriefs = new Set();
let pendingBriefCreate = null, briefBaseline = null;
function briefFormValues() { return JSON.stringify(['name', 'requirements', 'toolId', 'target'].map(name => form.elements[name].value)); }
function currentBriefScope() { return { cloud, userId: cloud ? briefUserId : null }; }
function sameBriefScope(scope) { return scope && scope.cloud === cloud && scope.userId === (cloud ? briefUserId : null) && (!cloud || account.user?.id === briefUserId); }

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function notify(message) {
  $('toast').textContent = message; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6000);
}
function showError(message) { $('error-banner').textContent = message; $('error-banner').hidden = false; }
function readBriefs() { return parseBriefs(localStorage.getItem(STORAGE_KEY), catalog.tools); }
async function loadBriefs() {
  const sequence = ++briefLoadSequence, scope = currentBriefScope();
  try {
    const loaded = cloud ? (await api('/api/briefs')).briefs : readBriefs();
    if (sequence !== briefLoadSequence || !sameBriefScope(scope)) return;
    briefs = loaded; storageBlocked = false; $('error-banner').hidden = true;
  } catch (error) {
    if (sequence !== briefLoadSequence || !sameBriefScope(scope)) return;
    storageBlocked = true; briefs = [];
    showError(cloud ? error.message : 'Browser storage is unavailable or contains invalid data. Existing briefs have not been changed.');
  }
}

function persist(next) {
  if (storageBlocked) throw new Error('Storage is unavailable. Your data has not been changed.');
  const raw = serializeBriefs(next); parseBriefs(raw, catalog.tools);
  try { localStorage.setItem(STORAGE_KEY, raw); }
  catch { throw new Error('The brief could not be saved. Browser storage may be full or disabled.'); }
  briefs = next; renderProjects();
}
function renderTools() {
  if (!catalog) return;
  const overview = document.body.dataset.view === 'overview';
  const tools = overview ? catalog.tools.filter(tool => codeWorkspaces.has(tool.id)) : catalog.tools;
  const matches = overview ? tools : filterTools(tools, $('search').value, category);
  $('result-count').textContent = `${matches.length} of ${tools.length} ${overview ? 'coding workflows' : 'tool definitions'}`;
  $('no-tools').hidden = matches.length > 0;
  $('tool-grid').replaceChildren(...matches.map(tool => {
    const card = element('button', 'tool-card'); card.type = 'button';
    card.dataset.availability = codeWorkspaces.has(tool.id) ? 'coding' : 'planned';
    card.setAttribute('aria-label', `${tool.name}. ${codeWorkspaces.has(tool.id) ? 'Code workspace' : 'Planned'}. View details.`);
    const top = element('span', 'card-top');
    const glyph = element('span', 'tool-glyph', glyphs[tool.engine]); glyph.setAttribute('aria-hidden', 'true');
    top.append(glyph, element('span', 'planned-label', codeWorkspaces.has(tool.id) ? 'CODE WORKSPACE' : 'PLANNED'));
    const bottom = element('span', 'card-bottom');
    bottom.append(element('span', '', engines[tool.engine]), element('span', '', 'View details'));
    card.append(top, element('strong', 'tool-title', tool.name), element('span', 'tool-summary', tool.description), bottom);
    card.addEventListener('click', () => openTool(tool)); return card;
  }));
}
function openTool(tool) {
  activeTool = tool; $('tool-dialog-title').textContent = tool.name; $('tool-description').textContent = tool.description;
  $('tool-brief').hidden = tool.category === 'browse';
  const implemented = codeWorkspaces.has(tool.id), notice = $('tool-dialog').querySelector('.notice');
  notice.querySelector('strong').textContent = implemented ? 'Code workspace available. Generation requires configuration.' : 'Planned, not available yet.';
  notice.querySelector('p').textContent = implemented ? 'Create source files, save revisions, compare changes and export ZIPs. AI generation requires owner approval, a configured model and a healthy isolated worker.' : 'This tool has no connected generation or conversion engine. A brief records requirements; it does not create a resource.';
  $('tool-workspace').hidden = !implemented;
  $('tool-dialog').showModal();
}
function updateTarget() {
  const tool = catalog.tools.find(item => item.id === form.elements.toolId.value);
  $('target-label').hidden = tool?.engine !== 'coding';
}
function openBrief(toolId, brief) {
  if (!catalog) return notify('The tool catalog is not available yet.');
  if (storageBlocked) return notify('Use Refresh briefs to reconnect before saving.');
  if (savePending) return;
  form.reset(); editing = brief ? { ...brief } : null; briefScope = currentBriefScope();
  if (toolId) form.elements.toolId.value = toolId;
  if (brief) {
    form.elements.name.value = brief.name; form.elements.requirements.value = brief.requirements;
    if ([...form.elements.target.options].some(option => option.value === brief.target)) form.elements.target.value = brief.target;
  } else if (account.user) form.elements.target.value = account.user.preferredFramework;
  $('brief-dialog-title').textContent = brief ? 'Refine your brief.' : 'Start with an idea.';
  form.querySelector('.fine-print').textContent = cloud ? 'Saved privately to your Studio account. No AI provider receives this brief yet.' : 'Saved only in this browser. Sign in to save briefs to your account.';
  $('form-error').hidden = true; updateTarget(); refreshSelects(form); briefBaseline = briefFormValues(); $('brief-dialog').showModal(); form.elements.name.focus();
}
function exportBrief(brief) {
  downloadJson({ kind: 'nd-ai-studio-project-brief', version: 1, brief }, `${brief.name.replace(/[^a-zA-Z0-9_.-]/g, '_')}.brief.json`);
}
async function deleteBrief(brief) {
  if (deletingBriefs.has(brief.id)) return;
  deletingBriefs.add(brief.id); const scope = currentBriefScope();
  try {
    if (!await confirmAction('Delete this brief?', `"${brief.name}" will be removed from ${cloud ? 'your Studio account' : 'this browser'}. This cannot be undone.`)) return;
    if (!sameBriefScope(scope)) throw new Error('The account changed. Reload your saved briefs before deleting.');
    if (storageBlocked) throw new Error('Storage is unavailable. Check the connection before deleting.');
    ++briefLoadSequence;
    if (cloud) {
      const result = await api(`/api/briefs/${brief.id}`, { method: 'DELETE', body: { version: brief.version } });
      if (!sameBriefScope(scope)) return;
      ++briefLoadSequence; briefs = briefs.filter(item => item.id !== brief.id);
    } else {
      const latest = readBriefs(), current = latest.find(item => item.id === brief.id);
      if (!current || current.updatedAt !== brief.updatedAt) throw new Error('This brief changed in another tab. Reload before deleting.');
      persist(latest.filter(item => item.id !== brief.id));
    }
    renderProjects(); notify('Project brief deleted.');
  } catch (error) { notify(error.message); }
  finally { deletingBriefs.delete(brief.id); }
}

function renderProjects() {
  if (!catalog) return;
  $('project-count').textContent = storageBlocked ? 'Storage unavailable' : `${briefs.length} saved ${cloud ? 'to your account' : 'in this browser'}`;
  const list = $('project-list'); list.replaceChildren();
  const query = $('project-search')?.value.toLowerCase().trim() || '';
  const filtered = briefs.filter(brief => `${brief.name} ${brief.requirements} ${brief.target}`.toLowerCase().includes(query));
  filtered.sort($('project-sort')?.value === 'name' ? (a, b) => a.name.localeCompare(b.name) : (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  if (!filtered.length) {
    const empty = element('div', 'empty');
    empty.append(element('h3', '', storageBlocked ? 'Reconnect your workspace.' : query ? 'No matching briefs.' : 'Your next build starts here.'),
      element('p', '', storageBlocked ? 'Use Refresh briefs to reconnect. Your saved data has not been overwritten.' : query ? 'Try another project name or framework.' : 'Capture your requirements before development.'));
    if (!query && !storageBlocked) { const button = element('button', 'primary', 'Create your first brief'); button.onclick = () => openBrief(); empty.append(button); }
    list.append(empty); return;
  }
  for (const brief of filtered) {
    const tool = catalog.tools.find(item => item.id === brief.toolId);
    const card = element('article', 'project-card'), copy = element('div', 'project-copy');
    copy.append(element('h3', '', brief.name), element('div', 'project-meta', `${tool?.name || brief.toolId} / ${brief.target} / ${new Date(brief.updatedAt).toLocaleDateString()}`),
      element('p', '', brief.requirements.length > 220 ? `${brief.requirements.slice(0, 220)}...` : brief.requirements));
    const actions = element('div', 'project-actions');
    for (const [label, action] of [['Edit', () => openBrief(brief.toolId, brief)], ['Export JSON', () => exportBrief(brief)], ['Delete', () => deleteBrief(brief)]]) {
      const button = element('button', '', label); button.setAttribute('aria-label', `${label}: ${brief.name}`); button.onclick = action; actions.append(button);
    }
    card.append(copy, actions); list.append(card);
  }
}
function renderView() {
  const requested = location.hash.slice(1);
  const view = ['overview', 'tools', 'projects', 'readiness', 'account'].includes(requested) ? requested : 'overview';
  document.body.dataset.view = view;
  $('tools-title').textContent = view === 'overview' ? 'Coding workspaces.' : 'Tool library.';
  const labels = { overview: 'OVERVIEW', tools: 'TOOL LIBRARY', projects: 'PROJECT BRIEFS', readiness: 'BUILD READINESS', account: 'MY ACCOUNT' };
  $('view-label').textContent = labels[view];
  document.title = `ND AI Studio | ${labels[view].toLowerCase().replace(/\b\w/g, letter => letter.toUpperCase())}`;
  $('hero').hidden = view !== 'overview'; $('tool-section').hidden = !['overview', 'tools'].includes(view);
  $('project-section').hidden = view !== 'projects'; $('readiness-section').hidden = view !== 'readiness';
  if ($('account-section')) $('account-section').hidden = view !== 'account';
  document.querySelectorAll('[data-view]').forEach(link => {
    if (link.dataset.view === view) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  });
  renderTools(); renderProjects();
}
function mountProjectControls() {
  const toolbar = element('div', 'project-toolbar');
  toolbar.innerHTML = '<label class="search"><span class="sr-only">Search briefs</span><input type="search" id="project-search" placeholder="Find a saved brief"></label><label class="project-sort-label">Sort by<select id="project-sort"><option value="updated">Recently updated</option><option value="name">Name A to Z</option></select></label><button type="button" class="secondary" id="refresh-briefs">Refresh briefs</button><button type="button" class="secondary" id="import-local" hidden>Import browser briefs</button>';
  $('project-list').before(toolbar); refreshSelects(toolbar);
  $('project-search').oninput = renderProjects; $('project-sort').onchange = renderProjects;
  renderBriefStorage();
  $('refresh-briefs').onclick = async () => {
    const button = $('refresh-briefs'); if (button.disabled) return;
    button.disabled = true; button.textContent = 'Refreshing...';
    try { await loadBriefs(); renderProjects(); renderBriefStorage(); }
    finally { button.disabled = false; button.textContent = 'Refresh briefs'; }
  };
  $('import-local').onclick = async () => {
    if (importPending) return;
    importPending = true; const button = $('import-local'), scope = currentBriefScope(); let imported = 0;
    try {
      const local = readBriefs();
      if (!await confirmAction('Import browser briefs?', `Copy ${local.length} briefs to your account? Existing imports are skipped. Browser copies are kept as a backup.`, 'Import briefs')) return;
      if (!sameBriefScope(scope) || !cloud || storageBlocked) throw new Error('Reconnect your account before importing browser briefs.');
      button.disabled = true; button.textContent = 'Importing...'; ++briefLoadSequence;
      for (let start = 0; start < local.length; start += 20) {
        const batch = local.slice(start, start + 20).map(({ id, name, requirements, toolId, target }) => ({ sourceId: id, name, requirements, toolId, target }));
        const result = await api('/api/briefs/import', { method: 'POST', body: { briefs: batch } });
        if (!sameBriefScope(scope)) throw new Error('The account changed. Check saved briefs before importing again.');
        ++briefLoadSequence; imported += result.imported;
      }
      await loadBriefs(); renderProjects(); notify(`${imported} briefs imported. Browser copies are unchanged.`);
    } catch (error) {
      if (sameBriefScope(scope) && cloud) await loadBriefs();
      renderProjects(); notify(imported ? `${imported} briefs imported before the interruption. ${error.message}` : error.message);
    }
    finally { importPending = false; button.disabled = false; button.textContent = 'Import browser briefs'; renderBriefStorage(); }
  };
}
function renderBriefStorage() {
  const note = $('project-section').querySelector('.notice');
  note.textContent = cloud ? 'These briefs are private to your Studio account and available across devices. Never store passwords, API keys or confidential customer data here.' : 'Briefs are saved only in this browser. Sign in with Discord to save to your account. Existing local briefs can be imported without deleting the originals.';
  $('import-local').hidden = true;
  if (cloud) {
    try { $('import-local').hidden = !readBriefs().length; }
    catch { notify('Some browser-local briefs could not be read. They have not been changed.'); }
  }
}
$('search').addEventListener('input', renderTools);
$('filters').addEventListener('click', event => {
  const button = event.target.closest('[data-category]'); if (!button) return;
  category = button.dataset.category;
  $('filters').querySelectorAll('button').forEach(item => item.setAttribute('aria-pressed', String(item === button))); renderTools();
});
for (const id of ['new-brief', 'hero-brief']) $(id).addEventListener('click', () => openBrief());
$('tool-brief').addEventListener('click', () => { $('tool-dialog').close(); openBrief(activeTool.id); });
$('brief-tool').addEventListener('change', updateTarget);
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => {
  if (button.closest('dialog') === $('brief-dialog') && savePending) return;
  button.closest('dialog').close();
}));
$('brief-dialog').addEventListener('cancel', event => { if (savePending) event.preventDefault(); });
window.addEventListener('beforeunload', event => {
  if (savePending || ($('brief-dialog').open && briefBaseline !== briefFormValues())) { event.preventDefault(); event.returnValue = ''; }
});
window.addEventListener('hashchange', () => { renderView(); $('main').focus({ preventScroll: true }); });
window.addEventListener('storage', async event => {
  if (!cloud && catalog && (event.key === STORAGE_KEY || event.key === null)) { await loadBriefs(); renderProjects(); }
});
document.addEventListener('account-expired', () => {
  ++briefLoadSequence;
  if (cloud) { briefs = []; storageBlocked = true; showError('Your session expired. Sign in again before saving. Unsaved form text is unchanged.'); renderProjects(); }
});
document.addEventListener('account-session', async () => {
  if (!briefsReady) return;
  const previous = currentBriefScope();
  cloud = Boolean(account.user); briefUserId = account.user?.id || null;
  if (!sameBriefScope(previous) || storageBlocked) {
    ++briefLoadSequence; briefs = []; storageBlocked = true; renderProjects();
    await loadBriefs(); renderBriefStorage(); renderProjects();
    if ($('brief-dialog').open && !sameBriefScope(briefScope)) {
      $('form-error').textContent = 'The sign-in or storage destination changed. Your form text is kept. Copy it before closing, then reopen a brief in the current workspace.';
      $('form-error').hidden = false;
    }
  }
});
form.addEventListener('submit', async event => {
  event.preventDefault(); if (savePending) return;
  const button = form.querySelector('[type=submit]'), locked = []; let replayedBrief = false; savePending = true; button.disabled = true; button.textContent = 'Saving...'; form.setAttribute('aria-busy', 'true');
  try {
    if (!sameBriefScope(briefScope)) throw new Error('The sign-in or storage destination changed. Your form text is kept. Copy it before closing, then reopen this brief.');
    if (storageBlocked) throw new Error('Storage is unavailable. Check the connection before saving.');
    ++briefLoadSequence;
    const name = form.elements.name.value.trim(), requirements = form.elements.requirements.value.trim();
    if (!name || !requirements) throw new Error('Enter a project name and requirements, not only spaces.');
    const tool = catalog.tools.find(item => item.id === form.elements.toolId.value);
    if (!tool || tool.category === 'browse') throw new Error('Select a creation or conversion tool.');
    const data = { toolId: tool.id, name, requirements, target: tool.engine === 'coding' ? form.elements.target.value : 'Asset workspace' };
    if (cloud) {
      for (const field of form.elements) if (['INPUT', 'SELECT', 'TEXTAREA'].includes(field.tagName)) { locked.push([field, field.disabled]); field.disabled = true; }
      refreshSelects(form);
      if (editing) data.version = editing.version;
      else {
        const signature = JSON.stringify([briefUserId, data]);
        if (pendingBriefCreate?.signature !== signature) pendingBriefCreate = { signature, requestId: crypto.randomUUID() };
        data.requestId = pendingBriefCreate.requestId;
      }
      const result = await api(editing ? `/api/briefs/${editing.id}` : '/api/briefs', { method: editing ? 'PATCH' : 'POST', body: data });
      if (!sameBriefScope(briefScope)) throw new Error('The account changed while saving. Check the saved brief in its original account before trying again.');
      if (!Array.isArray(result.briefs)) throw new Error('The service did not confirm the saved brief. Your form text is kept.');
      if (!editing && result.deleted === true) {
        pendingBriefCreate = null;
        throw new Error('The earlier saved brief was deleted. Your form text is kept. Save again to create a new brief.');
      }
      if (!editing) { replayedBrief = result.replayed === true; pendingBriefCreate = null; }
      ++briefLoadSequence; await loadBriefs();
      if (!sameBriefScope(briefScope)) throw new Error('The account changed while refreshing saved briefs. Check the original account before trying again.');
    } else {
      const latest = readBriefs();
      if (!editing && latest.length >= MAX_BRIEFS) throw new Error(`A maximum of ${MAX_BRIEFS} local briefs can be saved.`);
      const current = editing && latest.find(brief => brief.id === editing.id);
      if (editing && (!current || current.updatedAt !== editing.updatedAt)) throw new Error('This brief changed in another tab. Close this dialog and reopen the latest version.');
      const brief = { id: editing?.id ?? crypto.randomUUID(), ...data, updatedAt: new Date().toISOString() };
      persist([brief, ...latest.filter(item => item.id !== brief.id)]);
    }
    $('brief-dialog').close(); location.hash = 'projects'; renderView(); notify(cloud ? (replayedBrief ? 'That brief request was already saved. Current account briefs are shown.' : 'Project brief saved to your account.') : 'Project brief saved in this browser.');
  } catch (error) { $('form-error').textContent = error.message; $('form-error').hidden = false; }
  finally {
    for (const [field, disabled] of locked) field.disabled = disabled;
    refreshSelects(form); button.disabled = false; button.textContent = 'Save brief'; savePending = false; form.removeAttribute('aria-busy');
  }
});
try {
  const response = await fetch('/catalog.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('Catalog request failed.');
  catalog = validateCatalog(await response.json());
  for (const tool of catalog.tools.filter(item => item.category !== 'browse')) $('brief-tool').add(new Option(tool.name, tool.id));
  for (const [id, name] of Object.entries(engines)) {
    const row = element('div', 'engine-row');
    row.append(element('strong', '', name), element('span', '', id === 'coding' ? '2 coding workflows / Owner configuration required' : `${catalog.tools.filter(tool => tool.engine === id).length} tools / Not connected`)); $('engine-list').append(row);
  }
  refreshSelects(form);
  await initAccount(notify); cloud = Boolean(account.user); briefUserId = account.user?.id || null; mountProjectControls();
  await loadBriefs(); briefsReady = true; renderView();
} catch {
  showError('The workspace could not be loaded. Reload the page or check deployment files. No brief data has been changed.');
  $('result-count').textContent = 'Workspace unavailable';
}
