const controls = new WeakMap();
let sequence = 0;
let active;
let outsideRegistered = false;

export function enhanceSelect(select) {
  if (controls.has(select)) { controls.get(select).refresh(); return; }
  const id = `nd-select-${++sequence}`;
  const wrapper = document.createElement('span');
  wrapper.className = 'custom-select';
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'select-trigger'; button.id = `${id}-trigger`;
  button.setAttribute('role', 'combobox'); button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false'); button.setAttribute('aria-controls', `${id}-list`);
  button.setAttribute('aria-required', String(select.required));
  const label = select.labels?.[0];
  button.setAttribute('aria-label', select.getAttribute('aria-label') || label?.firstChild?.textContent?.trim() || select.name);
  const list = document.createElement('span');
  list.id = `${id}-list`; list.className = 'select-options'; list.setAttribute('role', 'listbox'); list.hidden = true;
  list.setAttribute('aria-label', button.getAttribute('aria-label'));
  select.insertAdjacentElement('afterend', wrapper); wrapper.append(button, list);
  select.hidden = true;
  if (!outsideRegistered) {
    outsideRegistered = true;
    document.addEventListener('pointerdown', event => {
      if (active && active.wrapper && !active.wrapper.contains(event.target)) active.close();
    });
  }
  let focused = 0, options = [], typed = '', lastType = 0;
  const enabled = index => Boolean(select.options[index] && !select.options[index].disabled && !select.options[index].parentElement?.disabled);
  const firstEnabled = () => [...select.options].findIndex((option,index) => enabled(index));
  const lastEnabled = () => [...select.options].reduce((last,option,index) => enabled(index) ? index : last, -1);
  function move(direction) {
    for (let index=focused+direction; index>=0 && index<options.length; index+=direction) if (enabled(index)) { focused=index; return; }
  }
  function paint() {
    options.forEach((option, index) => {
      option.classList.toggle('is-active', index === focused);
      option.setAttribute('aria-selected', String(index === select.selectedIndex));
    });
    if (!list.hidden && options[focused]) {
      button.setAttribute('aria-activedescendant', options[focused].id);
      options[focused].scrollIntoView({ block: 'nearest' });
    }
  }
  function close(commit = false) {
    if (commit && !list.hidden && options[focused] && enabled(focused)) {
      select.selectedIndex = focused;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    list.hidden = true; list.classList.remove('up'); button.setAttribute('aria-expanded', 'false'); button.removeAttribute('aria-activedescendant');
    if (active?.close === close) active = null;
    refresh();
  }
  function open() {
    if (select.disabled) return;
    active?.close();
    focused = enabled(select.selectedIndex) ? select.selectedIndex : firstEnabled(); list.hidden = false;
    const rect = button.getBoundingClientRect();
    const estimatedListHeight = 220;
    const up = (window.innerHeight - rect.bottom) < estimatedListHeight && rect.top > estimatedListHeight;
    list.classList.toggle('up', up);
    active = { close, wrapper };
    button.setAttribute('aria-expanded', 'true'); paint();
  }
  function refresh() {
    button.textContent = select.selectedOptions[0]?.textContent || 'Choose an option';
    button.disabled = select.disabled;
    const wasHidden = list.hidden;
    const prevFocused = focused;
    options = [...select.options].map((option, index) => {
      const node = document.createElement('span'); node.className = 'select-option'; node.id = `${id}-${index}`;
      node.setAttribute('role', 'option'); node.setAttribute('aria-disabled',String(!enabled(index))); node.textContent = option.textContent;
      node.addEventListener('pointerdown', event => event.preventDefault());
      node.addEventListener('click', () => { if(!enabled(index))return; focused = index; close(true); button.focus(); });
      return node;
    });
    list.replaceChildren(...options);
    if (!wasHidden) {
      list.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      focused = enabled(prevFocused) ? prevFocused : firstEnabled();
    }
    paint();
  }
  button.addEventListener('click', () => list.hidden ? open() : close());
  button.addEventListener('keydown', event => {
    const key = event.key;
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(key)) {
      event.preventDefault();
      if (list.hidden) { open(); if (key === 'Home') focused = firstEnabled(); else if (key === 'End') focused = lastEnabled(); }
      else if (key === 'Enter' || key === ' ') return close(true);
      else if (key === 'Home') focused = firstEnabled();
      else if (key === 'End') focused = lastEnabled();
      else move(key === 'ArrowDown' ? 1 : -1);
      paint();
    } else if (key === 'Escape' && !list.hidden) {
      event.preventDefault(); event.stopPropagation(); close();
    } else if (key === 'Tab') close(true);
    else if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      if (list.hidden) open();
      typed = Date.now() - lastType > 700 ? key.toLowerCase() : typed + key.toLowerCase(); lastType = Date.now();
      const match = options.findIndex((option,index) => enabled(index) && option.textContent.toLowerCase().startsWith(typed));
      if (match >= 0) focused = match;
      paint();
    }
  });
  button.addEventListener('blur', () => close());
  select.addEventListener('change', refresh);
  select.addEventListener('invalid', event => { event.preventDefault(); button.focus(); button.setAttribute('aria-invalid', 'true'); });
  select.form?.addEventListener('reset', () => queueMicrotask(() => { close(); button.removeAttribute('aria-invalid'); }));
  select.closest('dialog')?.addEventListener('close', () => close());
  controls.set(select, { refresh }); refresh();
}
export function refreshSelects(root = document) {
  root.querySelectorAll('select').forEach(enhanceSelect);
  enhanceNavigation();
}

const navigationControls = new WeakSet();
export function enhanceNavigation(root = document) {
  for (const button of root.querySelectorAll('[data-navigation-toggle]')) {
    if (navigationControls.has(button)) continue;
    const nav = document.getElementById(button.getAttribute('aria-controls'));
    if (!nav) continue;
    navigationControls.add(button); button.hidden = false;
    const container = button.parentElement; container.classList.add('navigation-ready');
    const setOpen = open => {
      nav.dataset.open = String(open); button.setAttribute('aria-expanded', String(open));
      button.textContent = open ? 'Close menu' : 'Menu';
    };
    setOpen(false);
    button.addEventListener('click', () => { active?.close(); setOpen(nav.dataset.open !== 'true'); });
    nav.addEventListener('click', event => {
      if (!event.target.closest('a[href]') || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      setOpen(false);
      requestAnimationFrame(() => document.querySelector('main')?.focus({ preventScroll:true }));
    });
    document.addEventListener('keydown', event => {
      if (event.defaultPrevented || event.key !== 'Escape' || nav.dataset.open !== 'true' || document.querySelector('dialog[open]')) return;
      event.preventDefault(); setOpen(false); button.focus();
    });
    document.addEventListener('pointerdown', event => { if (!container.contains(event.target)) setOpen(false); });
    matchMedia('(max-width:720px)').addEventListener('change', () => setOpen(false));
  }
}

export function confirmAction(title, description, label = 'Delete') {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog'); dialog.className = 'confirmation-dialog';
    const heading = document.createElement('h2'); heading.id = `confirm-${++sequence}`; heading.textContent = title;
    dialog.setAttribute('aria-labelledby', heading.id);
    const copy = document.createElement('p'); copy.className = 'dialog-description'; copy.textContent = description;
    const actions = document.createElement('div'); actions.className = 'dialog-actions';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'secondary'; cancel.textContent = 'Cancel';
    const accept = document.createElement('button'); accept.type = 'button'; accept.className = 'primary'; accept.textContent = label;
    let accepted = false;
    cancel.onclick = () => dialog.close();
    accept.onclick = () => { accepted = true; dialog.close(); };
    dialog.addEventListener('close', () => { dialog.remove(); resolve(accepted); }, { once: true });
    actions.append(cancel, accept); dialog.append(heading, copy, actions); document.body.append(dialog); dialog.showModal(); cancel.focus();
  });
}
