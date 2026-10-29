// Kleine Helfer zum Bauen der Bedienelemente (ohne Framework).
import { icon, type IconName } from './svgIcons';

export type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string; dataset?: Record<string, string> } = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  const { class: cls, dataset, ...rest } = props;
  if (cls) el.className = cls;
  if (dataset) Object.assign(el.dataset, dataset);
  Object.assign(el, rest);
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

/** Knopf mit Symbol; Erklärung steht im Tooltip */
export function btn(ico: IconName, title: string, onClick: (e: MouseEvent) => void, cls = 'icon-btn', text?: string) {
  const b = h('button', { class: cls, title }, icon(ico, 18), text ? h('span', { textContent: text }) : null);
  b.addEventListener('click', (e) => {
    e.preventDefault();
    onClick(e);
  });
  return b;
}

/** Schalter mit Symbol und kurzer Beschriftung; Erklärung im Tooltip */
export function toggle(ico: IconName | null, label: string, tip: string, checked: boolean, onChange: (v: boolean) => void, extra?: Child) {
  const input = h('input', { type: 'checkbox', checked });
  input.addEventListener('change', () => onChange(input.checked));
  const row = h('label', { class: 'row', title: tip }, input, ico ? icon(ico, 18) : null, h('span', { textContent: label }), extra);
  return { row, input };
}

export function section(ico: IconName, title: string, open: boolean, ...children: Child[]) {
  return h('details', { open }, h('summary', {}, icon(ico, 20), h('span', { textContent: title })), h('div', { class: 'section' }, ...children));
}

