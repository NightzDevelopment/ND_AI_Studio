import { refreshSelects, confirmAction } from './controls.js';

export const account = { user: null, csrf: null, configured: false, online: false };
let notify = () => {};
let profilePending = false, sessionPending = false, logoutPending = false, exportPending = false, reloadPending = false;
let profileOwner = null, profileBaseline = null, profileRevision = null, profileConflict = false;
const profileFields = ['displayName', 'bio', 'preferredFramework', 'density'];
const profileValues = form => Object.fromEntries(profileFields.map(name => [name, form.elements[name].value]));
const sameProfile = (first, second) => profileFields.every(name => first[name] === second[name]);
function profileDirty() {
  const form = $('profile-form');
  return Boolean(form && profileBaseline && !sameProfile(profileValues(form), profileBaseline));
}
function profileState(message) {
  const node = $('profile-state');
  const next = message || (profileDirty() ? 'You have unsaved profile changes.' : 'Your profile is up to date.');
  if (node && node.textContent !== next) node.textContent = next;
}
const $ = id => document.getElementById(id);
const frameworks = ['Standalone', 'ND_Framework', 'ESX', 'QBCore', 'Qbox', 'vRP', 'ox_core', 'Custom'];

export async function api(path, { method = 'GET', body } = {}) {
  const authentication = { userId: account.user?.id ?? null, csrf: account.csrf ?? null };
  let response;
  try {
    response = await fetch(path, {
      method, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { accept: 'application/json', ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-csrf-token': account.csrf || '' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new Error(method === 'GET' ? 'Studio could not be reached. Check your connection and try again.' : 'The request could not be confirmed. Check your connection and saved data before trying again.');
  }
  const staleAuthentication = response.status === 401 && (authentication.userId !== (account.user?.id ?? null) || authentication.csrf !== (account.csrf ?? null));
  if (response.status === 401 && !staleAuthentication) {
    account.user = null; account.csrf = null; renderAccount({ preserveProfile: true });
    document.dispatchEvent(new Event('account-expired'));
  }
  let data;
  try {
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error();
    data = await response.json();
  } catch {
    const error = new Error(staleAuthentication ? 'Your sign-in changed while this request was running. Retry the action in your current session.' : response.status === 401 ? 'Your session expired. Sign in again to continue. Your form text is kept.' : 'The account service returned an unexpected response. Check the connection and saved data before trying again.');
    error.status = response.status; error.staleAuthentication = staleAuthentication; throw error;
  }
  if (!response.ok) {
    const error = new Error(staleAuthentication ? 'Your sign-in changed while this request was running. Retry the action in your current session.' : data?.error || 'The account request failed.');
    error.status = response.status; error.staleAuthentication = staleAuthentication;
    throw error;
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
    image.addEventListener('error', () => { if (node.contains(image)) node.textContent = user.displayName.slice(0, 1).toUpperCase(); }, { once: true });
    node.append(image);
  } else node.textContent = user?.displayName.slice(0, 1).toUpperCase() || 'ND';
}
function renderAccount({ preserveProfile = false } = {}) {
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
  $('account-retry').hidden = account.online && Boolean(user);
  if (!user) return;
  avatar($('profile-avatar'), user);
  $('profile-name').textContent = user.displayName;
  $('profile-discord').textContent = `@${user.username}`;
  $('profile-id').textContent = user.discordId;
  $('profile-joined').textContent = new Date(user.createdAt).toLocaleDateString(undefined, { dateStyle: 'medium' });
  const form = $('profile-form');
  if (!preserveProfile || profileOwner !== user.id) {
    for (const name of profileFields) form.elements[name].value = user[name];
    profileConflict = false;
  }
  profileOwner = user.id; profileRevision = user.version; profileBaseline = Object.fromEntries(profileFields.map(name => [name, user[name]]));
  refreshSelects(form); profileState();
}
export async function initAccount(onNotify) {
  notify = onNotify;
  const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = '/account.css'; document.head.append(css);
  const nav = document.createElement('a'); nav.href = '#account'; nav.dataset.view = 'account';
  nav.innerHTML = '<span class="nav-icon">@</span>My account'; $('navigation').append(nav);
  const control = document.createElement('div'); control.className = 'account-control';
  control.innerHTML = `<button type="button" class="account-button" id="account-button" aria-expanded="false" aria-controls="account-menu"><span class="avatar small-avatar" id="account-button-avatar">ND</span><span id="account-button-name">Sign in</span><span aria-hidden="true" class="account-chevron">⌄</span></button><div class="account-menu" id="account-menu" hidden><span class="eyebrow">YOUR WORKSPACE</span><a href="#account">Profile &amp; preferences</a><a href="#projects">Saved project briefs</a><a href="/workspace.html#projects">Source projects</a><button type="button" id="menu-logout">Sign out</button></div>`;
  document.querySelector('.top-actions').append(control);
  document.querySelector('.preview-label').textContent = 'V0.3 / WORKSPACES';
  document.querySelector('.sidebar-footer').innerHTML = '<span class="status-dot"></span><span id="account-service-state">Connecting accounts</span><small>ai.nightz.dev</small>';
  const section = document.createElement('section'); section.id = 'account-section'; section.hidden = true;
  section.setAttribute('aria-labelledby', 'account-title');
  section.innerHTML = `<div class="section-heading"><div><p class="eyebrow">YOUR IDENTITY / YOUR WORKSPACE</p><h2 id="account-title">Make it yours.</h2></div><span class="account-tag">PRIVATE PROFILE</span></div>
    <div id="account-guest" class="sign-in-panel"><div class="identity-symbol" aria-hidden="true">ND</div><p class="eyebrow">ONE DISCORD IDENTITY</p><h3>Your workspace. Wherever you build.</h3><p>Sign in with Discord to keep your profile, preferences and project briefs in your Studio account.</p><a id="discord-login" class="primary discord-login" href="/auth/discord" hidden>Continue with Discord <span aria-hidden="true">↗</span></a><p id="account-connection" class="fine-print muted" role="status">Connecting...</p><button type="button" class="secondary" id="account-retry" hidden>Check connection</button><p class="fine-print muted">OAuth requests your Discord identity, not your password, email or messages. A configured Studio bot may check your membership and roles in its guild. Store purchases and memberships are not linked.</p></div>
    <div id="account-settings" class="account-layout" hidden><aside class="profile-summary"><div class="profile-banner"></div><div class="profile-summary-content"><span class="avatar profile-avatar" id="profile-avatar"></span><span class="account-tag">DISCORD CONNECTED</span><h3 id="profile-name"></h3><p id="profile-discord" class="muted"></p><dl><dt>Discord ID</dt><dd id="profile-id"></dd><dt>Studio member since</dt><dd id="profile-joined"></dd><dt>Profile visibility</dt><dd>Only you</dd></dl><p class="fine-print muted">Your avatar and Discord username refresh when you sign in again.</p></div></aside>
    <div class="account-panels"><form id="profile-form" class="settings-panel"><div class="panel-heading"><p class="eyebrow">01 / IDENTITY</p><h3>Profile &amp; preferences</h3><p>Your display name is independent of your Discord username.</p></div><label>Display name<input name="displayName" maxlength="80" autocomplete="nickname" required></label><label>About you<textarea name="bio" maxlength="500" rows="3" placeholder="What are you building?"></textarea></label><div class="form-columns"><label>Default framework<select name="preferredFramework"></select></label><label>Workspace density<select name="density"><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></label></div><p class="form-error" id="profile-error" role="alert" hidden></p><p id="profile-state" class="profile-state" role="status" aria-live="polite"></p><div class="dialog-actions"><button type="button" class="secondary" id="profile-reload" hidden>Load saved profile</button><button type="submit" class="primary">Save changes</button></div></form>
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
  control.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !$('account-menu').hidden) { closeMenu(true); event.preventDefault(); event.stopPropagation(); }
  });
  control.addEventListener('focusout', event => { if (!control.contains(event.relatedTarget)) closeMenu(); });
  document.addEventListener('pointerdown', event => { if (!control.contains(event.target)) closeMenu(); });
  $('account-menu').querySelectorAll('a').forEach(link => link.addEventListener('click', () => closeMenu()));
  const profile = $('profile-form');
  profile.addEventListener('input', () => profileState());
  profile.addEventListener('change', () => profileState());
  window.addEventListener('beforeunload', event => {
    if (profilePending || profileDirty()) { event.preventDefault(); event.returnValue = ''; }
  });
  profile.addEventListener('submit', async event => {
    event.preventDefault();
    if (profilePending) return;
    if (!account.user) return notify('Sign in again before saving your profile.');
    if (profileConflict) { $('profile-error').textContent = 'Your saved profile changed while you were disconnected. Your edits are kept. Load the saved profile before saving again.'; $('profile-error').hidden = false; $('profile-reload').hidden = false; return; }
    const form = event.currentTarget, button = form.querySelector('[type=submit]');
    const submitted = profileValues(form), userId = account.user.id;
    if (!submitted.displayName.trim()) {
      $('profile-error').textContent = 'Enter a display name, not only spaces.'; $('profile-error').hidden = false;
      form.elements.displayName.focus(); return;
    }
    profilePending = true; button.disabled = true; button.textContent = 'Saving...';
    form.setAttribute('aria-busy', 'true'); $('profile-error').hidden = true; $('profile-reload').hidden = true;
    profileState('Saving your profile...');
    try {
      const data = await api('/api/account', { method: 'PATCH', body: { ...submitted, version: account.user.version } });
      if (account.user?.id !== userId) return;
      if (data?.user?.id !== userId || !Number.isSafeInteger(data.user.version) || data.user.version <= account.user.version || !profileFields.every(name => typeof data.user[name] === 'string')) throw new Error('The service did not confirm a saved profile. Your form text is kept.');
      profileConflict = false;
      const newerEdits = !sameProfile(profileValues(form), submitted);
      account.user = data.user; renderAccount({ preserveProfile: newerEdits });
      profileState(newerEdits ? 'Earlier changes saved. Your newer edits are still unsaved.' : 'Your profile and preferences are saved.');
      notify(newerEdits ? 'Profile saved. Your newer edits are still here.' : 'Your profile and preferences are saved.');
    } catch (error) {
      $('profile-error').textContent = error.message; $('profile-error').hidden = false;
      $('profile-reload').hidden = error.status === 401;
      profileState('Your form text is still here. It has not been confirmed saved.');
    } finally {
      profilePending = false; button.disabled = false; button.textContent = 'Save changes'; form.removeAttribute('aria-busy');
    }
  });
  async function refreshSession({ discardProfile = false, announce = false } = {}) {
    if (sessionPending) return;
    const button = discardProfile ? $('profile-reload') : $('account-retry');
    sessionPending = true; button.disabled = true;
    const previous = account.user, previousValues = profileValues(profile);
    try {
      const data = await api('/api/session');
      if (!data || typeof data.configured !== 'boolean' || (data.user !== null && (!data.user?.id || !data.csrf || !Number.isSafeInteger(data.user.version) || !profileFields.every(name => typeof data.user[name] === 'string')))) throw new Error('The account service returned an incomplete session. Please check the connection again.');
      const sameOwner = data.user?.id === profileOwner;
      const preserveProfile = sameOwner && ((!discardProfile && profileDirty()) || !sameProfile(profileValues(profile), previousValues));
      const revisionConflict = preserveProfile && (profileConflict || profileRevision !== data.user.version);
      account.user = data.user; account.csrf = data.csrf; account.configured = data.configured; account.online = true;
      renderAccount({ preserveProfile });
      profileConflict = Boolean(revisionConflict);
      $('profile-error').hidden = !profileConflict; $('profile-reload').hidden = !profileConflict;
      if (profileConflict) $('profile-error').textContent = 'Your saved profile changed while you were disconnected. Your edits are kept. Load the saved profile before saving again.';
      document.dispatchEvent(new CustomEvent('account-session', { detail: { previousUserId: previous?.id || null, userId: data.user?.id || null } }));
      if (announce && !data.user) notify('The account service is connected. Sign in with Discord to continue.');
    } catch (error) { account.online = false; renderAccount({ preserveProfile: true }); notify(error.message); }
    finally { sessionPending = false; button.disabled = false; }
  }
  $('account-retry').onclick = () => refreshSession({ announce: true });
  $('profile-reload').onclick = async () => {
    if (profilePending || sessionPending || reloadPending) return;
    reloadPending = true;
    try {
      if (profileDirty() && !await confirmAction('Load your saved profile?', 'Your unsaved profile edits will be replaced by the latest saved profile.', 'Load saved profile')) return;
      await refreshSession({ discardProfile: true, announce: true });
    } finally { reloadPending = false; }
  };
  async function logout(all) {
    if (logoutPending) return;
    if (profilePending) return notify('Wait for your profile save to finish before signing out.');
    logoutPending = true;
    try {
      if (!await confirmAction(all ? 'Sign out everywhere?' : 'Sign out of Studio?', 'Unsaved changes will not be kept. Saved account briefs stay in your account.', 'Sign out')) return;
      $('menu-logout').disabled = true; $('logout-all').disabled = true;
      await api(all ? '/api/logout-all' : '/api/logout', { method: 'POST', body: {} });
      profileBaseline = profileValues(profile); location.replace('/#account'); location.reload();
    } catch (error) { notify(error.message); }
    finally { logoutPending = false; $('menu-logout').disabled = false; $('logout-all').disabled = false; }
  }
  $('menu-logout').onclick = () => logout(false); $('logout-all').onclick = () => logout(true);
  $('account-export').onclick = async () => {
    if (exportPending) return;
    exportPending = true; const button = $('account-export'); button.disabled = true; button.textContent = 'Preparing...';
    const userId = account.user?.id;
    try { const data = await api('/api/account/export'); if (account.user?.id === userId) downloadJson(data, 'nd-ai-studio-account.json'); }
    catch (error) { notify(error.message); }
    finally { exportPending = false; button.disabled = false; button.textContent = 'Export data'; }
  };
  await refreshSession();
  const auth = new URLSearchParams(location.search).get('auth');
  const messages = { cancelled: 'Discord sign-in was cancelled. No account changes were made.', expired: 'That sign-in attempt expired. Please try again.', failed: 'Discord sign-in failed. Check the OAuth configuration or try again.', 'not-configured': 'Discord OAuth has not been configured on this server.' };
  if (auth) { history.replaceState(null, '', location.pathname + location.hash); notify(messages[auth] || 'Sign-in could not be completed.'); }
  if (account.online) {
    const readiness = document.querySelector('.readiness-card');
    readiness.children[1].textContent = 'Discord accounts, private profiles, saved briefs, source projects, custom editing, revision history, ZIP exports and owner controls. Open the source workspace to build.';
    readiness.children[3].textContent = 'The Script and Discord Bot generators require an enabled tool, configured model and isolated worker. The other 22 tool engines, billing, shared store accounts and public publishing remain planned. No builds or credits are simulated.';
  }
}
