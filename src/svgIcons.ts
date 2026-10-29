// Eigener Symbolsatz (24 × 24, Linienstil, Farbe = currentColor) – ersetzt Emojis in der Oberfläche.

const P: Record<string, string> = {
  globe:
    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.8 2.6 4.2 5.6 4.2 9s-1.4 6.4-4.2 9c-2.8-2.6-4.2-5.6-4.2-9S9.2 5.6 12 3z"/>',
  cloud: '<path d="M7 18.5h10.2a4.3 4.3 0 0 0 .6-8.55A6.2 6.2 0 0 0 5.9 9.6 4.5 4.5 0 0 0 7 18.5z"/>',
  photo:
    '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M3.5 16.5l5-5 4 4 2.5-2.5 5.5 5.5"/><circle cx="15.5" cy="9" r="1.6"/>',
  lights:
    '<path d="M3 20h18M5 20V10h5v10M10 20V5h5v15M15 20v-7h4v7"/><path d="M7 13h1M7 16h1M12 8h1M12 11h1M12 14h1M17 16h0.5" stroke-width="2.2"/>',
  daynight: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none"/>',
  atmosphere: '<circle cx="12" cy="12" r="6"/><path d="M4.2 8.5a9 9 0 0 1 15.6 0M4.2 15.5a9 9 0 0 0 15.6 0" stroke-dasharray="2 2.4"/>',
  stars:
    '<path d="M9 3l1.4 4.6L15 9l-4.6 1.4L9 15l-1.4-4.6L3 9l4.6-1.4z"/><path d="M17.5 13l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/>',
  moon: '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>',
  planet:
    '<circle cx="12" cy="12" r="5.5"/><path d="M6.3 13.8C2.9 15.9 1.6 17.9 2.6 18.9c1.5 1.5 7.2-1.2 12.7-6.4s8.1-10.6 6.2-12.1c-.9-.7-2.8.2-5 2"/>',
  telescope:
    '<path d="M3.5 13.5l13-6.2 2.3 4.8-13 6.2zM16.5 7.3l3.4-1.6 2.3 4.8-3.4 1.6M10 15.5l-2.5 5.5M11.5 14.8l2.5 6.2"/>',
  satellite:
    '<rect x="9.2" y="9.2" width="5.6" height="5.6" rx="1" transform="rotate(45 12 12)"/><path d="M5.5 5.5l3 3M15.5 15.5l3 3"/><rect x="1.8" y="4.3" width="5" height="3" transform="rotate(45 4.3 5.8)"/><rect x="17.2" y="16.2" width="5" height="3" transform="rotate(45 19.7 17.7)"/>',
  station:
    '<path d="M2 7v10M6 7v10M18 7v10M22 7v10M2 12h20"/><rect x="9" y="9.5" width="6" height="5" rx="1.5"/>',
  orbit: '<ellipse cx="12" cy="12" rx="9.5" ry="5" transform="rotate(-20 12 12)"/><circle cx="12" cy="12" r="2.2"/><circle cx="20" cy="9" r="1.4" fill="currentColor"/>',
  follow: '<rect x="2.5" y="6.5" width="13" height="11" rx="2"/><path d="M15.5 10.5l6-3.5v10l-6-3.5z"/>',
  target: '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="2.5"/><path d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4"/>',
  home: '<path d="M3.5 11.5L12 4l8.5 7.5"/><path d="M6 10v10h4.5v-5.5h3V20H18V10"/>',
  compass:
    '<circle cx="12" cy="12" r="9.5"/><path d="M12 4.5l3 7.5h-6z" fill="#ff5d5d" stroke="#ff5d5d"/><path d="M12 19.5l-3-7.5h6z"/>',
  rocket:
    '<path d="M12 2.5c3.2 2.3 4.6 5.9 4.2 10.3l-1.8 3.2H9.6l-1.8-3.2C7.4 8.4 8.8 4.8 12 2.5z"/><circle cx="12" cy="9" r="1.6"/><path d="M7.8 12.8l-2.8 3.4 1 2.3 3.6-2.5M16.2 12.8l2.8 3.4-1 2.3-3.6-2.5M10.3 19l1.7 3 1.7-3"/>',
  plane:
    '<path d="M12 2.5c.9 0 1.4 1.2 1.4 2.8v4.4l7.6 4.3v2l-7.6-2.2v4.1l2.2 1.8v1.6L12 20.3l-3.6 1v-1.6l2.2-1.8v-4.1L3 16v-2l7.6-4.3V5.3c0-1.6.5-2.8 1.4-2.8z"/>',
  swap: '<path d="M7 4l-3.5 3.5L7 11M3.5 7.5h14M17 13l3.5 3.5L17 20M20.5 16.5h-14"/>',
  play: '<path d="M8 5l11 7-11 7z" fill="currentColor"/>',
  pause: '<path d="M8 5v14M16 5v14" stroke-width="3"/>',
  rewind: '<path d="M11.5 6l-7.5 6 7.5 6zM20 6l-7.5 6 7.5 6z" fill="currentColor"/>',
  forward: '<path d="M4 6l7.5 6L4 18zM12.5 6l7.5 6-7.5 6z" fill="currentColor"/>',
  fast: '<path d="M2 6l6.5 6L2 18zM9 6l6.5 6L9 18zM16 6l6.5 6-6.5 6z" fill="currentColor"/>',
  now: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  solar:
    '<circle cx="12" cy="12" r="2.6" fill="currentColor"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="9.5" stroke-dasharray="2 2.6"/><circle cx="18" cy="12" r="1.3" fill="currentColor"/><circle cx="5.3" cy="5.3" r="1.1" fill="currentColor"/>',
  gps: '<path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  launch: '<path d="M4 20h16"/><path d="M12 3c2 1.5 3 3.8 2.7 6.6L13.5 12h-3L9.3 9.6C9 6.8 10 4.5 12 3z"/><path d="M10.5 14l-.8 3M13.5 14l.8 3M12 14v4"/>',
  expand: '<path d="M9 6l6 6-6 6"/>',
  map: '<path d="M3 6.5l6-2.5 6 2.5 6-2.5v13.5l-6 2.5-6-2.5-6 2.5z"/><path d="M9 4v13.5M15 6.5V20"/>',
  ruler:
    '<rect x="1.8" y="8.2" width="20.4" height="7.6" rx="1.4" transform="rotate(-30 12 12)"/><path d="M7.2 13.6l-1-1.7M10 12l-1.5-2.6M12.8 10.4l-1-1.7M15.6 8.8l-1.5-2.6"/>',
  city: '<path d="M3 20.5h18M5 20.5V9l5-3v14.5M10 20.5V4h6v16.5M16 20.5v-9h3.5v9"/>',
};

export type IconName = keyof typeof P;

/** SVG-Symbol als Element */
export function icon(name: IconName, size = 20): SVGSVGElement {
  const wrap = document.createElement('span');
  wrap.innerHTML = `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name]}</svg>`;
  return wrap.firstElementChild as SVGSVGElement;
}

/** Ersetzt in fertigem HTML alle Elemente mit data-icon="…" durch das Symbol */
export function hydrateIcons(root: ParentNode = document) {
  for (const el of root.querySelectorAll<HTMLElement>('[data-icon]')) {
    const name = el.dataset.icon as IconName;
    if (P[name]) el.prepend(icon(name, Number(el.dataset.iconSize) || 20));
    delete el.dataset.icon;
  }
}
