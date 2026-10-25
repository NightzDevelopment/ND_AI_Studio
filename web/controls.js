const controls = new WeakMap();
let sequence = 0;
let active;

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
  let focused = 0, options = [], typed = '', lastType = 0;
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
    if (commit && !list.hidden && options[focused]) {
      select.selectedIndex = focused;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    list.hidden = true; button.setAttribute('aria-expanded', 'false'); button.removeAttribute('aria-activedescendant');
    if (active?.close === close) active = null;
    refresh();
  }
  function open() {
    if (select.disabled) return;
    active?.close(); active = { close };
    focused = Math.max(0, select.selectedIndex); list.hidden = false;
    button.setAttribute('aria-expanded', 'true'); paint();
  }
  function refresh() {
    button.textContent = select.selectedOptions[0]?.textContent || 'Choose an option';
    button.disabled = select.disabled;
    options = [...select.options].map((option, index) => {
      const node = document.createElement('span'); node.className = 'select-option'; node.id = `${id}-${index}`;
      node.setAttribute('role', 'option'); node.textContent = option.textContent;
      node.addEventListener('pointerdown', event => event.preventDefault());
      node.addEventListener('click', () => { focused = index; close(true); button.focus(); });
      return node;
    });
    list.replaceChildren(...options); paint();
  }
  button.addEventListener('click', () => list.hidden ? open() : close());
  button.addEventListener('keydown', event => {
    const key = event.key;
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(key)) {
      event.preventDefault();
      if (list.hidden) { open(); if (key === 'Home') focused = 0; else if (key === 'End') focused = options.length - 1; }
      else if (key === 'Enter' || key === ' ') return close(true);
      else if (key === 'Home') focused = 0;
      else if (key === 'End') focused = options.length - 1;
      else focused = Math.max(0, Math.min(options.length - 1, focused + (key === 'ArrowDown' ? 1 : -1)));
      paint();
    } else if (key === 'Escape' && !list.hidden) {
      event.preventDefault(); event.stopPropagation(); close();
    } else if (key === 'Tab') close(true);
    else if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      if (list.hidden) open();
      typed = Date.now() - lastType > 700 ? key.toLowerCase() : typed + key.toLowerCase(); lastType = Date.now();
      const match = options.findIndex(option => option.textContent.toLowerCase().startsWith(typed));
      if (match >= 0) focused = match;
      paint();
    }
  });
  button.addEventListener('blur', () => close());
  document.addEventListener('pointerdown', event => { if (!wrapper.contains(event.target)) close(); });
  select.addEventListener('change', refresh);
  select.addEventListener('invalid', event => { event.preventDefault(); button.focus(); button.setAttribute('aria-invalid', 'true'); });
  select.form?.addEventListener('reset', () => queueMicrotask(() => { close(); button.removeAttribute('aria-invalid'); }));
  select.closest('dialog')?.addEventListener('close', () => close());
  controls.set(select, { refresh }); refresh();
}
export function refreshSelects(root = document) {
  root.querySelectorAll('select').forEach(enhanceSelect);
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
