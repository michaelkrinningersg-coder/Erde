// Bedienfeld der politischen Karte (ersetzt im Kartenmodus die normalen Abschnitte im linken Feld).
import { h, section, toggle } from '../dom';
import { icon, type IconName } from '../svgIcons';
import { COLOR_MODES } from './colors';
import { HISTORY_YEARS } from './data';
import { fmt } from './geo';
import { CITY_CLASSES, cityIcon, markerIcon } from './markers';
import type { Options, PoliticalView, SearchHit } from './view';

type BoolKey = { [K in keyof Options]: Options[K] extends boolean ? K : never }[keyof Options];

export function buildPoliticalPanel(view: PoliticalView, container: HTMLElement) {
  const root = h('div', { id: 'political-panel' });
  const updaters: (() => void)[] = [];

  const sw = (key: BoolKey, ico: IconName | null, label: string, tip: string) => {
    const t = toggle(ico, label, tip, view.opt[key], (v) => void view.set(key, v));
    updaters.push(() => (t.input.checked = view.opt[key]));
    return t.row;
  };

  // ── Suche ──
  const input = h('input', { type: 'search', placeholder: 'Suchen: Land, Stadt, Fluss, Berg …', className: 'search-input' });
  const results = h('div', { class: 'search-results hidden' });
  let hits: SearchHit[] = [];
  const render = () => {
    hits = view.search(input.value);
    results.replaceChildren(
      ...hits.map((hit, i) => {
        const b = h('button', { class: 'search-hit', title: hit.kind }, h('b', { textContent: hit.name }), h('span', { textContent: hit.kind }));
        b.addEventListener('click', () => choose(i));
        return b;
      }),
    );
    results.classList.toggle('hidden', !hits.length);
  };
  const choose = (i: number) => {
    const hit = hits[i];
    if (!hit) return;
    view.goTo(hit);
    results.classList.add('hidden');
    input.blur();
  };
  let prepared = false;
  input.addEventListener('focus', () => {
    if (prepared) return;
    prepared = true;
    void view.prepareSearch().then(render);
  });
  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') choose(0);
    if (e.key === 'Escape') results.classList.add('hidden');
  });
  root.append(h('div', { class: 'search' }, icon('target', 18), input), results);

  // ── Karte ──
  const baseSel = h('select', { title: 'Grundkarte' }, h('option', { value: 'map', textContent: 'Länderkarte' }), h('option', { value: 'sat', textContent: 'Satellitenbild' }));
  baseSel.addEventListener('change', () => void view.set('satellite', baseSel.value === 'sat'));
  const yearSel = h('select', { title: 'Grenzen aus früheren Zeiten (ungefähr)' }, h('option', { value: '0', textContent: 'Grenzen von heute' }), ...HISTORY_YEARS.map((y) => h('option', { value: String(y), textContent: `Grenzen von ${y}` })));
  yearSel.addEventListener('change', () => void view.set('year', Number(yearSel.value)));
  const groups = [...new Set(COLOR_MODES.map((m) => m.group))];
  const colorSel = h(
    'select',
    { title: 'Länder einfärben nach …' },
    ...groups.map((g) => {
      const og = document.createElement('optgroup');
      og.label = g;
      og.append(...COLOR_MODES.filter((m) => m.group === g).map((m) => h('option', { value: m.id, textContent: m.name })));
      return og;
    }),
  );
  colorSel.addEventListener('change', () => void view.set('colorMode', colorSel.value));
  const legend = h('div', { class: 'legend' });
  const bordersRow = sw('borders', 'borders', 'Ländergrenzen', 'Ländergrenzen auf dem Satellitenbild');
  updaters.push(() => {
    baseSel.value = view.opt.satellite ? 'sat' : 'map';
    yearSel.value = String(view.opt.year);
    colorSel.value = view.opt.colorMode;
    colorSel.disabled = !!view.opt.year || view.opt.satellite;
    bordersRow.classList.toggle('hidden', !view.opt.satellite);
    legend.replaceChildren(
      ...(view.opt.satellite || (!view.legend.length && !view.legendInfo)
        ? []
        : [
            ...view.legend.map((e) => h('span', { class: 'legend-item' }, h('i', { class: 'swatch', style: `background:${e.color}` } as never), e.label)),
            ...(view.legendInfo ? [h('div', { class: 'legend-info', textContent: view.legendInfo })] : []),
          ]),
    );
  });
  // Zeichenerklärung der Städte
  const sym = (c: HTMLCanvasElement, size: number) => h('img', { src: c.toDataURL(), width: size, height: size, alt: '' });
  const cityLegend = h(
    'div',
    { class: 'legend city-legend', title: 'Zeichen der Städte' },
    h('span', { class: 'legend-item' }, sym(markerIcon('capital'), 14), 'Hauptstadt'),
    h('span', { class: 'legend-item' }, sym(markerIcon('seat'), 14), 'Regierungssitz u. a.'),
    ...CITY_CLASSES.map((c, i) => h('span', { class: 'legend-item' }, sym(cityIcon(i), c.size), c.label)),
  );
  const mapSection = section(
    'map',
    'Karte',
    true,
    h('div', { class: 'row wrap' }, baseSel),
    h('div', { class: 'row wrap' }, yearSel),
    h('label', { class: 'row field-row', title: 'Länder einfärben nach Werten, Gruppen oder Bündnissen' }, icon('daynight', 18), colorSel),
    legend,
    cityLegend,
    bordersRow,
    sw('admin1', 'borders', 'Bundesländer & Provinzen', 'Grenzen und Namen der Bundesländer, Staaten, Provinzen …'),
    sw('disputed', 'borders', 'Umstrittene Gebiete', 'Gebiete, die mehrere Länder beanspruchen (schraffiert)'),
    sw('neighbors', 'globe', 'Nachbarländer zeigen', 'Beim Anklicken eines Landes leuchten seine Nachbarn'),
    sw('visited', 'gps', 'Besuchte Länder', 'Länder grün färben, in denen du schon warst (Haken im Länder-Steckbrief)'),
  );

  // ── Wasser ──
  const waterSection = section(
    'cloud',
    'Wasser',
    false,
    sw('seas', null, 'Meere & Meerengen', 'Namen der Ozeane, Meere, Buchten und Meerengen'),
    sw('lakes', null, 'Seen', 'Namen der Seen'),
    sw('rivers', null, 'Flüsse', 'Flüsse mit Namen; anklicken zeigt die Länge'),
    sw('deeps', null, 'Tiefste Punkte', 'Tiefster Punkt jedes Landes und die tiefsten Stellen der Meere'),
  );

  // ── Linien ──
  const linesSection = section(
    'orbit',
    'Linien',
    false,
    sw('geolines', null, 'Äquator, Wende- & Polarkreise, Datumsgrenze', 'Besondere Linien auf der Erde'),
    sw('graticule', null, 'Gradnetz & Koordinaten', 'Längen- und Breitengrade, Koordinaten unter der Maus'),
  );

  // ── Orte ──
  const placesSection = section(
    'gps',
    'Orte',
    false,
    sw('peaks', 'mountain', 'Höchste Berge der Länder', 'Höchster Punkt jedes Landes'),
    sw('wonders', 'stars', 'Weltwunder', 'Die neuen sieben Weltwunder und die sieben Weltwunder der Antike'),
    sw('buildings', 'home', 'Berühmte Bauwerke', 'Eiffelturm, Burj Khalifa, Brandenburger Tor …'),
    sw('unesco', 'photo', 'UNESCO-Welterbe', 'Alle Welterbestätten'),
    sw('volcanoes', null, 'Vulkane', 'Vulkane der letzten 12.000 Jahre; rot: Ausbruch seit 1900'),
    sw('quakes', null, 'Erdbeben (live)', 'Erdbeben der letzten 7 Tage ab Stärke 2,5 – wird erst beim Einschalten geladen'),
    sw('parks', null, 'Nationalparks', 'Bekannte Nationalparks'),
    sw('deserts', null, 'Wüsten', 'Namen der Wüsten'),
    sw('ranges', 'mountain', 'Gebirge & Seven Summits', 'Gebirgsnamen und die höchsten Berge der Kontinente'),
    sw('waterfalls', null, 'Wasserfälle', 'Berühmte Wasserfälle'),
    sw('extremes', 'compass', 'Pole & Extrempunkte', 'Nord-/Südpol, Mittelpunkte, nördlichster Punkt Deutschlands …'),
    sw('airports', 'plane', 'Flughäfen', 'Große Flughäfen mit IATA-Code'),
    sw('ports', null, 'Häfen & Kanäle', 'Wichtige Häfen, Suezkanal, Panamakanal …'),
  );

  // ── Rekorde: Inseln, Halbinseln, Kaps ──
  type RecordKey = 'islands' | 'peninsulas' | 'capes';
  const tabs: [RecordKey, string][] = [
    ['islands', 'Inseln'],
    ['peninsulas', 'Halbinseln'],
    ['capes', 'Kaps'],
  ];
  let tab: RecordKey = 'islands';
  const list = h('div', { class: 'record-list' });
  const tabBtns = tabs.map(([key, label]) => {
    const b = h('button', { class: 'tab', textContent: label });
    b.addEventListener('click', () => {
      tab = key;
      renderList();
    });
    return b;
  });
  const renderList = () => {
    tabBtns.forEach((b, i) => b.classList.toggle('active', tabs[i][0] === tab));
    const p = view.places;
    if (!p) {
      list.replaceChildren(h('div', { class: 'muted', textContent: 'wird geladen …' }));
      return;
    }
    const items = p[tab] as [string, number, number, number, string][];
    list.replaceChildren(
      ...items.map((it, i) => {
        const b = h(
          'button',
          { class: 'record' },
          h('span', { class: 'rank', textContent: tab === 'capes' ? '' : `${i + 1}.` }),
          h('span', { class: 'rname', textContent: it[0] }),
          h('span', { class: 'rval', textContent: tab === 'capes' ? '' : `${fmt(it[3])} km²` }),
        );
        b.addEventListener('click', () => view.flyTo(it[1], it[2], tab === 'capes' ? 3e5 : Math.min(6e6, Math.max(4e5, Math.sqrt(it[3]) * 2500)), it[0]));
        return b;
      }),
    );
  };
  const recordSection = section('expand', 'Rekorde', false, h('div', { class: 'tabs' }, ...tabBtns), list);
  recordSection.addEventListener('toggle', () => {
    if ((recordSection as HTMLDetailsElement).open) void view.loadPlaces().then(renderList);
  });
  updaters.push(renderList);

  // ── Meine Karte ──
  const fileInput = h('input', { type: 'file', accept: 'application/json,.json', className: 'hidden' });
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    try {
      await view.myMap.load(f);
    } catch (e) {
      alert(`Datei konnte nicht geladen werden: ${(e as Error).message}`);
    }
    fileInput.value = '';
  });
  const counts = h('div', { class: 'muted small' });
  updaters.push(() => {
    const d = view.myMap.data;
    counts.textContent = `${d.places.length} eigene Orte · ${d.visited.length} besuchte Länder`;
  });
  const button = (ico: IconName, text: string, title: string, onClick: () => void) => {
    const b = h('button', { class: 'icon-btn', title }, icon(ico, 18), text);
    b.addEventListener('click', onClick);
    return b;
  };
  const mySection = section(
    'home',
    'Meine Karte',
    false,
    sw('own', 'gps', 'Meine Orte', 'Eigene Orte mit Notiz und Foto'),
    h('div', { class: 'row wrap' }, button('target', 'Ort hinzufügen', 'Danach auf die Karte klicken', () => view.startAddPlace())),
    counts,
    h(
      'div',
      { class: 'row wrap' },
      button('expand', 'Als Datei speichern', 'Eigene Orte und besuchte Länder als Datei sichern', () => view.myMap.download()),
      button('swap', 'Datei laden', 'Gesicherte Datei wieder laden (ersetzt den aktuellen Stand)', () => fileInput.click()),
    ),
    fileInput,
  );

  // ── Beim Anklicken ──
  const clickSection = section('target', 'Beim Anklicken', false, sw('weather', 'cloud', 'Wetter abrufen', 'Beim Anklicken einer Stadt das aktuelle Wetter laden (Open-Meteo)'));

  root.append(mapSection, waterSection, linesSection, placesSection, recordSection, mySection, clickSection);
  container.append(root);
  view.onState = () => updaters.forEach((u) => u());
  updaters.forEach((u) => u());
}
