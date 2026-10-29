// Auswahllisten im Stil der übrigen Menüs (statt der weißen Browser-Liste).
// Das echte <select> bleibt (unsichtbar) bestehen: Wert, change-Ereignis und Tastatur-Bedienung wie gewohnt.

const valueProp = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!;
const indexProp = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex')!;
let openMenu: { close: () => void } | undefined;

export function enhanceSelect(sel: HTMLSelectElement) {
  if (sel.dataset.enhanced) return;
  sel.dataset.enhanced = '1';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'select-btn';
  btn.title = sel.title;
  const label = document.createElement('span');
  label.className = 'select-label';
  const caret = document.createElement('span');
  caret.className = 'select-caret';
  caret.setAttribute('aria-hidden', 'true');
  btn.append(label, caret);
  sel.classList.add('select-native');
  sel.tabIndex = -1;
  sel.after(btn);

  const refresh = () => {
    label.textContent = sel.selectedOptions[0]?.textContent ?? '';
    btn.disabled = sel.disabled;
    btn.title = sel.title;
  };
  // Wert, der im Programm gesetzt wird, sofort anzeigen
  Object.defineProperty(sel, 'value', {
    get: () => valueProp.get!.call(sel),
    set: (v: string) => {
      valueProp.set!.call(sel, v);
      refresh();
    },
  });
  Object.defineProperty(sel, 'selectedIndex', {
    get: () => indexProp.get!.call(sel),
    set: (v: number) => {
      indexProp.set!.call(sel, v);
      refresh();
    },
  });
  new MutationObserver(refresh).observe(sel, { attributes: true, childList: true, subtree: true });
  sel.addEventListener('change', refresh);

  const choose = (opt: HTMLOptionElement) => {
    if (opt.disabled) return;
    const changed = sel.value !== opt.value;
    sel.value = opt.value;
    close();
    if (changed) sel.dispatchEvent(new Event('change', { bubbles: true }));
    btn.focus();
  };

  let menu: HTMLDivElement | undefined;
  const close = () => {
    menu?.remove();
    menu = undefined;
    btn.classList.remove('open');
    document.removeEventListener('pointerdown', outside, true);
    window.removeEventListener('resize', close);
    if (openMenu?.close === close) openMenu = undefined;
  };
  const outside = (e: Event) => {
    if (menu && !menu.contains(e.target as Node) && e.target !== btn && !btn.contains(e.target as Node)) close();
  };

  const open = () => {
    openMenu?.close();
    menu = document.createElement('div');
    menu.className = 'select-menu glass';
    menu.setAttribute('role', 'listbox');
    const addOption = (opt: HTMLOptionElement) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'select-item';
      item.textContent = opt.textContent;
      item.disabled = opt.disabled;
      if (opt.selected) item.classList.add('selected');
      item.addEventListener('click', () => choose(opt));
      menu!.append(item);
    };
    for (const child of Array.from(sel.children)) {
      if (child instanceof HTMLOptGroupElement) {
        const head = document.createElement('div');
        head.className = 'select-group';
        head.textContent = child.label;
        menu.append(head);
        for (const o of Array.from(child.children)) if (o instanceof HTMLOptionElement) addOption(o);
      } else if (child instanceof HTMLOptionElement) {
        addOption(child);
      }
    }
    document.body.append(menu);
    // unter (oder, wenn kein Platz, über) dem Knopf, mindestens so breit wie der Knopf
    const r = btn.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const up = below < 220 && above > below;
    menu.style.minWidth = `${r.width}px`;
    menu.style.maxHeight = `${Math.max(140, Math.min(420, up ? above : below))}px`;
    menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))}px`;
    if (up) menu.style.bottom = `${window.innerHeight - r.top + 4}px`;
    else menu.style.top = `${r.bottom + 4}px`;
    menu.querySelector<HTMLElement>('.selected')?.scrollIntoView({ block: 'nearest' });
    btn.classList.add('open');
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', close);
    openMenu = { close };
  };

  btn.addEventListener('click', () => (menu ? close() : open()));
  btn.addEventListener('keydown', (e) => {
    const opts = Array.from(sel.options).filter((o) => !o.disabled);
    const i = opts.findIndex((o) => o.selected);
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = opts[Math.max(0, Math.min(opts.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next && next !== opts[i]) {
        sel.value = next.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        if (menu) {
          close();
          open();
        }
      }
    }
  });
  refresh();
}

/** Alle vorhandenen und künftig eingefügten Auswahllisten umstellen */
export function enhanceAllSelects(root: HTMLElement = document.body) {
  root.querySelectorAll('select').forEach((s) => enhanceSelect(s));
  new MutationObserver((records) => {
    for (const r of records) {
      r.addedNodes.forEach((n) => {
        if (n instanceof HTMLSelectElement) enhanceSelect(n);
        else if (n instanceof HTMLElement) n.querySelectorAll('select').forEach((s) => enhanceSelect(s));
      });
    }
  }).observe(root, { childList: true, subtree: true });
}
