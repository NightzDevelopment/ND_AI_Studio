import { refreshSelects, confirmAction } from './controls.js';

export const account = { user: null, csrf: null, configured: false, online: false };
let notify = () => {};
const $ = id => document.getElementById(id);
const frameworks = ['Standalone', 'ND_Framework', 'ESX', 'QBCore', 'Qbox', 'vRP', 'ox_core', 'Custom'];

export async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(20000),
    headers: { accept: 'application/json', ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-csrf-token': account.csrf || '' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('The account service is not connected. Your data has not been changed.');
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) {
      account.user = null; account.csrf = null; renderAccount();
      document.dispatchEvent(new Event('account-expired'));
    }
    throw new Error(data.error || 'The account request failed.');
  }
  return data;
}
export function downloadJson(data, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
function avatar(node, user) {
  node.replaceChildren();
  if (user?.avatarUrl) {
    const image = document.createElement('img'); image.src = user.avatarUrl; image.alt = ''; image.referrerPolicy = 'no-referrer';
    image.addEventListener('error', () => { node.textContent = user.displayName.slice(0, 1).toUpperCase(); }, { once: true });
    node.append(image);
  } else node.textContent = user?.displayName.slice(0, 1).toUpperCase() || 'ND';
}
function renderAccount() {
  const user = account.user;
  $('account-guest').hidden = Boolean(user); $('account-settings').hidden = !user;
  $('account-button-name').textContent = user?.displayName || 'Sign in';
  $('account-button').setAttribute('aria-label', user ? `Open account menu for ${user.displayName}` : 'Sign in with Discord');
  avatar($('account-button-avatar'), user);
  $('account-menu').hidden = true; $('account-button').setAttribute('aria-expanded', 'false');
  document.documentElement.dataset.density = user?.density || 'comfortable';
  $('account-connection').textContent = account.online ? (account.configured ? 'Discord sign-in is ready.' : 'Discord OAuth needs server configuration.') : 'The account API is not connected yet.';
  $('discord-login').hidden = !account.online || !account.configured;
  $('account-service-state').textContent = account.online ? 'Account service connected' : 'Local preview';
  if (!user) return;
  avatar($('profile-avatar'), user);
  $('profile-name').textContent = user.displayName;
  $('profile-discord').textContent = `@${user.username}`;
  $('profile-id').textContent = user.discordId;
  $('profile-joined').textContent = new Date(user.createdAt).toLocaleDateString(undefined, { dateStyle: 'medium' });
  const form = $('profile-form');
  form.elements.displayName.value = user.displayName; form.elements.bio.value = user.bio;
  form.elements.preferredFramework.value = user.preferredFramework; form.elements.density.value = user.density;
  refreshSelects(form);
}
export async function initAccount(onNotify) {
  notify = onNotify;
  const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = '/account.css'; document.head.append(css);
  const nav = document.createElement('a'); nav.href = '#account'; nav.dataset.view = 'account';
  nav.innerHTML = '<span class="nav-icon">@</span>My account'; $('navigation').append(nav);
  const control = document.createElement('div'); control.className = 'account-control';
  control.innerHTML = `<button type="button" class="account-button" id="account-button" aria-expanded="false" aria-controls="account-menu"><span class="avatar small-avatar" id="account-button-avatar">ND</span><span id="account-button-name">Sign in</span><span aria-hidden="true" class="account-chevron">⌄</span></button><div class="account-menu" id="account-menu" hidden><span class="eyebrow">YOUR WORKSPACE</span><a href="#account">Profile &amp; preferences</a><a href="#projects">Saved project briefs</a><button type="button" id="menu-logout">Sign out</button></div>`;
  document.querySelector('.top-actions').append(control);
  document.querySelector('.preview-label').textContent = 'V0.2 / ACCOUNTS';
  document.querySelector('.sidebar-footer').innerHTML = '<span class="status-dot"></span><span id="account-service-state">Connecting accounts</span><small>ai.nightz.dev</small>';
  const section = document.createElement('section'); section.id = 'account-section'; section.hidden = true;
  section.setAttribute('aria-labelledby', 'account-title');
  section.innerHTML = `<div class="section-heading"><div><p class="eyebrow">YOUR IDENTITY / YOUR WORKSPACE</p><h2 id="account-title">Make it yours.</h2></div><span class="account-tag">PRIVATE PROFILE</span></div>
    <div id="account-guest" class="sign-in-panel"><div class="identity-symbol" aria-hidden="true">ND</div><p class="eyebrow">ONE DISCORD IDENTITY</p><h3>Your workspace. Wherever you build.</h3><p>Sign in with Discord to keep your profile, preferences and project briefs in your Studio account.</p><a id="discord-login" class="primary discord-login" href="/auth/discord" hidden>Continue with Discord <span aria-hidden="true">↗</span></a><p id="account-connection" class="fine-print muted" role="status">Connecting...</p><p class="fine-print muted">Only your Discord identity is requested. Studio does not request your password, email, servers or messages. Store purchases and memberships are not linked in this release.</p></div>
    <div id="account-settings" class="account-layout" hidden><aside class="profile-summary"><div class="profile-banner"></div><div class="profile-summary-content"><span class="avatar profile-avatar" id="profile-avatar"></span><span class="account-tag">DISCORD CONNECTED</span><h3 id="profile-name"></h3><p id="profile-discord" class="muted"></p><dl><dt>Discord ID</dt><dd id="profile-id"></dd><dt>Studio member since</dt><dd id="profile-joined"></dd><dt>Profile visibility</dt><dd>Only you</dd></dl><p class="fine-print muted">Your avatar and Discord username refresh when you sign in again.</p></div></aside>
    <div class="account-panels"><form id="profile-form" class="settings-panel"><div class="panel-heading"><p class="eyebrow">01 / IDENTITY</p><h3>Profile &amp; preferences</h3><p>Your display name is independent of your Discord username.</p></div><label>Display name<input name="displayName" maxlength="80" autocomplete="nickname" required></label><label>About you<textarea name="bio" maxlength="500" rows="3" placeholder="What are you building?"></textarea></label><div class="form-columns"><label>Default framework<select name="preferredFramework"></select></label><label>Workspace density<select name="density"><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></label></div><p class="form-error" id="profile-error" role="alert" hidden></p><div class="dialog-actions"><button type="submit" class="primary">Save changes</button></div></form>
    <section class="settings-panel"><div class="panel-heading"><p class="eyebrow">02 / SECURITY &amp; DATA</p><h3>You stay in control.</h3><p>Sessions expire after seven days. Sign out everywhere to end all Studio sessions.</p></div><div class="security-row"><div><strong>Export your account</strong><p>Download your profile and saved briefs as JSON.</p></div><button type="button" class="secondary" id="account-export">Export data</button></div><div class="security-row"><div><strong>End all sessions</strong><p>This includes the current browser. Unsaved changes are not stored.</p></div><button type="button" class="secondary" id="logout-all">Sign out everywhere</button></div></section></div></div>`;
  document.querySelector('.page-footer').before(section);
  for (const value of frameworks) $('profile-form').elements.preferredFramework.add(new Option(value, value));
  refreshSelects($('profile-form'));
  function closeMenu(focus = false) {
    $('account-menu').hidden = true; $('account-button').setAttribute('aria-expanded', 'false');
    if (focus) $('account-button').focus();
  }
  $('account-button').addEventListener('click', () => {
    if (!account.user) { location.hash = 'account'; return; }
    const opening = $('account-menu').hidden;
    $('account-menu').hidden = !opening; $('account-button').setAttribute('aria-expanded', String(opening));
    if (opening) $('account-menu').querySelector('a').focus();
  });
  control.addEventListener('keydown', event => { if (event.key === 'Escape') { closeMenu(true); event.preventDefault(); } });
  control.addEventListener('focusout', event => { if (!control.contains(event.relatedTarget)) closeMenu(); });
  document.addEventListener('pointerdown', event => { if (!control.contains(event.target)) closeMenu(); });
  $('account-menu').querySelectorAll('a').forEach(link => link.addEventListener('click', () => closeMenu()));
  $('profile-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!account.user) return notify('Sign in again before saving your profile.');
    const form = event.currentTarget, button = form.querySelector('[type=submit]');
    button.disabled = true; $('profile-error').hidden = true;
    try {
      const data = await api('/api/account', { method: 'PATCH', body: {
        displayName: form.elements.displayName.value, bio: form.elements.bio.value,
        preferredFramework: form.elements.preferredFramework.value, density: form.elements.density.value, version: account.user.version,
      } });
      account.user = data.user; renderAccount(); notify('Your profile and preferences are saved.');
    } catch (error) { $('profile-error').textContent = error.message; $('profile-error').hidden = false; }
    finally { button.disabled = false; }
  });
  async function logout(all) {
    if (!await confirmAction(all ? 'Sign out everywhere?' : 'Sign out of Studio?', 'Unsaved changes will not be kept. Saved account briefs stay in your account.', 'Sign out')) return;
    try { await api(all ? '/api/logout-all' : '/api/logout', { method: 'POST', body: {} }); location.replace('/#account'); location.reload(); }
    catch (error) { notify(error.message); }
  }
  $('menu-logout').onclick = () => logout(false); $('logout-all').onclick = () => logout(true);
  $('account-export').onclick = async () => {
    try { downloadJson(await api('/api/account/export'), 'nd-ai-studio-account.json'); }
    catch (error) { notify(error.message); }
  };
  try {
    const data = await api('/api/session');
    account.user = data.user; account.csrf = data.csrf; account.configured = data.configured; account.online = true;
  } catch { account.online = false; }
  renderAccount();
  const auth = new URLSearchParams(location.search).get('auth');
  const messages = { cancelled: 'Discord sign-in was cancelled. No account changes were made.', expired: 'That sign-in attempt expired. Please try again.', failed: 'Discord sign-in failed. Check the OAuth configuration or try again.', 'not-configured': 'Discord OAuth has not been configured on this server.' };
  if (auth) { history.replaceState(null, '', location.pathname + location.hash); notify(messages[auth] || 'Sign-in could not be completed.'); }
  if (account.online) {
    const readiness = document.querySelector('.readiness-card');
    readiness.children[1].textContent = 'Discord account sign-in when configured, private profiles, preferences, account-backed project briefs, local brief import, custom controls and JSON export.';
    readiness.children[3].textContent = 'AI providers, sandbox workers, generated resources, asset conversion, billing, shared store accounts and public community publishing are not connected. No builds or credits are simulated.';
  }
}
