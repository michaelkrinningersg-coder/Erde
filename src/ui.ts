import { JulianDate, type Viewer } from 'cesium';
import type { CameraControl } from './camera';
import { FOCUS_TARGETS } from './camera';
import type { LayerStatus, TimeImageLayer } from './clouds/timeLayer';
import type { GlobeLayers } from './globe';
import { AIRPORTS, type Flights } from './objects/flights';
import type { Satellites } from './objects/satellites';
import type { Sky } from './objects/sky';
import type { TimeControl } from './time';

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(
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

/** Schalter mit Beschriftung */
function toggle(label: string, checked: boolean, onChange: (v: boolean) => void, extra?: Child) {
  const input = h('input', { type: 'checkbox', checked });
  input.addEventListener('change', () => onChange(input.checked));
  return { row: h('label', { class: 'row' }, input, h('span', {}, label), extra), input };
}

function section(title: string, open: boolean, ...children: Child[]) {
  return h('details', { open }, h('summary', {}, title), h('div', { class: 'section' }, ...children));
}

/** Gruppe mit Haupt-Schalter und aufklappbarer Liste einzelner Objekte */
function group(
  label: string,
  color: string | undefined,
  checked: boolean,
  onGroup: (v: boolean) => void,
  items: { label: string; checked: boolean; onChange: (v: boolean) => void; extra?: Child }[],
) {
  const childInputs: HTMLInputElement[] = [];
  const list = h(
    'div',
    { class: 'sublist' },
    ...items.map((it) => {
      const t = toggle(it.label, it.checked, it.onChange, it.extra);
      childInputs.push(t.input);
      return t.row;
    }),
  );
  const head = toggle(
    label,
    checked,
    (v) => {
      childInputs.forEach((c) => (c.checked = v));
      onGroup(v);
    },
    h('span', { class: 'count' }, String(items.length)),
  );
  if (color) {
    const sw = h('i', { class: 'swatch' });
    sw.style.background = color;
    head.row.querySelector('input')!.after(sw);
  }
  // Aufklapp-Pfeil getrennt vom Schalter, damit ein Klick auf den Schalter nicht aufklappt
  const caret = h('button', { class: 'caret', textContent: '▸', title: 'Einzelne Objekte zeigen' });
  const wrap = h('div', { class: 'group' }, h('div', { class: 'group-head' }, caret, head.row), list);
  caret.addEventListener('click', () => {
    const open = wrap.classList.toggle('open');
    caret.textContent = open ? '▾' : '▸';
  });
  return wrap;
}

export interface UiDeps {
  viewer: Viewer;
  layers: GlobeLayers;
  clouds: TimeImageLayer;
  color: TimeImageLayer;
  sky: Sky;
  satellites: Satellites;
  flights: Flights;
  camera: CameraControl;
  time: TimeControl;
}

export function buildUi(d: UiDeps) {
  const { viewer, layers, clouds, color, sky, satellites, flights, camera, time } = d;
  const body = document.getElementById('panel-body')!;
  const scene = viewer.scene;

  // ── Erde ──────────────────────────────────────────────────────────────
  const earth = section(
    '🌍 Erde',
    true,
    toggle('Wolken (echte Satellitenbilder)', true, (v) => (clouds.show = v)).row,
    toggle('Echtfarben Europa & Afrika', true, (v) => (color.show = v)).row,
    toggle('Stadtlichter bei Nacht', true, (v) => (layers.night.show = v)).row,
    toggle('Tag & Nacht (Sonnenlicht)', true, (v) => {
      scene.globe.enableLighting = v;
      layers.day.nightAlpha = v ? 0.3 : 1;
    }).row,
    toggle('Atmosphäre', true, (v) => {
      scene.globe.showGroundAtmosphere = v;
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = v;
    }).row,
    toggle('Sterne', true, (v) => {
      if (scene.skyBox) scene.skyBox.show = v;
    }).row,
  );

  // Regler für die Planetengröße (wird im Browser gemerkt)
  function planetSizeRow() {
    let initial = 0.6;
    try {
      initial = Number(localStorage.getItem('erde.planetScale')) || initial;
    } catch {
      /* ohne Speicher */
    }
    const value = h('span', { class: 'count' });
    const slider = h('input', { type: 'range', min: '0.25', max: '1.5', step: '0.05', value: String(initial) });
    const apply = () => {
      const v = Number(slider.value);
      sky.setPlanetScale(v);
      value.textContent = `${Math.round(v * 100)} %`;
      try {
        localStorage.setItem('erde.planetScale', String(v));
      } catch {
        /* ohne Speicher */
      }
    };
    slider.addEventListener('input', apply);
    apply();
    return h('label', { class: 'row slider' }, h('span', { textContent: 'Planetengröße' }), slider, value);
  }

  // ── Himmel ────────────────────────────────────────────────────────────
  const moonBtn = h('button', { class: 'small', textContent: '🚀 hinfliegen', title: 'Zum Mond fliegen' });
  moonBtn.addEventListener('click', (e) => {
    e.preventDefault();
    camera.flyToMoon(sky.moon.entity);
  });
  const skySection = section(
    '☀️ Sonne, Mond & Planeten',
    true,
    toggle('Sonne', true, (v) => (sky.showSunDisc = v)).row,
    toggle('Mond', true, (v) => (sky.showMoonDisc = v), moonBtn).row,
    group(
      'Planeten',
      undefined,
      true,
      (v) => sky.planets.forEach((p) => (p.entity.show = v)),
      sky.planets.map((p) => ({ label: p.name, checked: true, onChange: (v: boolean) => (p.entity.show = v) })),
    ),
    planetSizeRow(),
    toggle('James-Webb-Teleskop', true, (v) => (sky.jwst.entity.show = v)).row,
    h('p', { class: 'hint', textContent: 'Planeten: Richtung stimmt, sie sind aber größer und näher gezeichnet, damit man sie sieht.' }),
  );

  // ── Satelliten ────────────────────────────────────────────────────────
  const satGroups = satellites.groups.map((g) =>
    group(
      g.name,
      g.color,
      g.show,
      (v) => satellites.setGroupVisible(g, v),
      g.items.map((it) => {
        const orbitBtn = h('button', { class: 'small ghost', textContent: 'Bahn', title: 'Umlaufbahn zeigen' });
        orbitBtn.addEventListener('click', (e) => {
          e.preventDefault();
          const on = !orbitBtn.classList.contains('on');
          orbitBtn.classList.toggle('on', on);
          satellites.setOrbitVisible(it, on);
        });
        if (it.id === '25544') orbitBtn.classList.add('on');
        const followBtn = h('button', { class: 'small ghost', textContent: '🎥', title: 'Mitfliegen' });
        followBtn.addEventListener('click', (e) => {
          e.preventDefault();
          camera.release();
          viewer.trackedEntity = it.entity;
          viewer.selectedEntity = it.entity;
        });
        return {
          label: it.name,
          checked: g.show,
          onChange: (v: boolean) => satellites.setItemVisible(it, v),
          extra: h('span', { class: 'btns' }, orbitBtn, followBtn),
        };
      }),
    ),
  );
  const satAge = satellites.generated
    ? `Bahndaten vom ${satellites.generated.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`
    : '';
  const satSection = section('🛰️ Satelliten', true, ...satGroups, h('p', { class: 'hint', textContent: satAge }));

  // ── Ansicht ───────────────────────────────────────────────────────────
  const targetSelect = h('select', {}, ...FOCUS_TARGETS.map((t, i) => h('option', { value: String(i), textContent: t.name })));
  const focusBtn = h('button', { textContent: '🎯 Fokus' });
  focusBtn.addEventListener('click', () => camera.focus(FOCUS_TARGETS[Number(targetSelect.value)]));
  const homeBtn = h('button', { textContent: '🌍 Ganze Erde' });
  homeBtn.addEventListener('click', () => camera.home());
  const view = section(
    '🎯 Ansicht',
    false,
    h('div', { class: 'row wrap' }, targetSelect, focusBtn),
    toggle('Blick aus dem All (Erde dreht sich)', false, (v) => camera.setSpaceView(v)).row,
    h('div', { class: 'row wrap' }, homeBtn),
    h('p', {
      class: 'hint',
      innerHTML: '<b>Doppelklick</b> auf die Erde: um diesen Punkt drehen.<br><b>Doppelklick</b> auf ein Objekt: mitfliegen.',
    }),
  );

  // ── Flugzeug ──────────────────────────────────────────────────────────
  const apOptions = (sel: string) =>
    AIRPORTS.map((a) => h('option', { value: a.code, textContent: `${a.city} (${a.code})`, selected: a.code === sel }));
  const fromSel = h('select', {}, ...apOptions('FRA'));
  const toSel = h('select', {}, ...apOptions('JFK'));
  const swapBtn = h('button', { class: 'small', textContent: '⇄', title: 'Richtung tauschen' });
  swapBtn.addEventListener('click', () => {
    const a = fromSel.value;
    fromSel.value = toSel.value;
    toSel.value = a;
  });
  const startBtn = h('button', { class: 'primary', textContent: '✈️ Abheben!' });
  const flightList = h('div', { class: 'flights' });
  startBtn.addEventListener('click', () => {
    const from = AIRPORTS.find((a) => a.code === fromSel.value)!;
    const to = AIRPORTS.find((a) => a.code === toSel.value)!;
    if (from === to) return;
    const f = flights.create(from, to, viewer.clock.currentTime.clone());
    // Damit man den Flug auch sieht: Zeitraffer 10 Minuten pro Sekunde
    if (!viewer.clock.shouldAnimate || viewer.clock.multiplier < 60) time.setSpeed(600);
    camera.release();
    viewer.trackedEntity = f.plane;
    viewer.selectedEntity = f.plane;
  });
  const renderFlights = () => {
    flightList.replaceChildren(
      ...flights.list.map((f) => {
        const follow = h('button', { class: 'small ghost', textContent: '🎥', title: 'Mitfliegen' });
        follow.addEventListener('click', () => {
          camera.release();
          viewer.clock.currentTime = JulianDate.lessThan(viewer.clock.currentTime, f.departure)
            ? f.departure.clone()
            : viewer.clock.currentTime;
          viewer.trackedEntity = f.plane;
        });
        const del = h('button', { class: 'small ghost', textContent: '✕', title: 'Flug entfernen' });
        del.addEventListener('click', () => flights.remove(f));
        return h('div', { class: 'row' }, h('span', { textContent: `${f.from.code} → ${f.to.code} · ${f.distanceKm.toLocaleString('de-DE')} km` }), h('span', { class: 'btns' }, follow, del));
      }),
    );
  };
  flights.onChange = renderFlights;
  const flightSection = section(
    '✈️ Flugzeug starten',
    true,
    h('div', { class: 'row wrap' }, h('span', { class: 'lbl', textContent: 'Von' }), fromSel),
    h('div', { class: 'row wrap' }, h('span', { class: 'lbl', textContent: 'Nach' }), toSel, swapBtn),
    startBtn,
    flightList,
  );

  body.append(earth, skySection, satSection, view, flightSection);

  // Panel ein-/ausklappen (auf dem Handy standardmäßig zu)
  const panel = document.getElementById('panel')!;
  if (window.innerWidth < 700) panel.classList.add('collapsed');
  document.getElementById('panel-toggle')!.addEventListener('click', () => panel.classList.toggle('collapsed'));

  // ── Zeitleiste ────────────────────────────────────────────────────────
  for (const btn of document.querySelectorAll<HTMLButtonElement>('#timebar [data-speed]')) {
    btn.addEventListener('click', () => time.setSpeed(Number(btn.dataset.speed)));
  }
  document.getElementById('btn-live')!.addEventListener('click', () => time.goLive());
  const rangeSel = document.getElementById('range-select') as HTMLSelectElement;
  rangeSel.addEventListener('change', () => time.applyRange(Number(rangeSel.value)));

  // ── Fokus-Anzeige ─────────────────────────────────────────────────────
  const chip = document.getElementById('focus-chip')!;
  camera.onChange = () => {
    chip.classList.toggle('hidden', !camera.focusName);
    chip.replaceChildren();
    if (camera.focusName) {
      const x = h('button', { class: 'small ghost', textContent: '✕', title: 'Fokus lösen' });
      x.addEventListener('click', () => camera.release());
      chip.append(h('span', { textContent: `🎯 ${camera.focusName}` }), x);
    }
  };

  // ── Statuszeile ───────────────────────────────────────────────────────
  const status = document.getElementById('status')!;
  const clockLabel = document.getElementById('clock-label')!;
  let cloudStatus: LayerStatus = { loading: 0 };
  let colorStatus: LayerStatus = { loading: 0 };
  clouds.onStatus = (s) => (cloudStatus = s);
  color.onStatus = (s) => (colorStatus = s);
  const speedButtons = document.querySelectorAll<HTMLButtonElement>('#timebar [data-speed]');
  const describe = (icon: string, label: string, st: LayerStatus, live: boolean) => {
    if (!st.shownFrame) return `${icon} ${label} wird geladen …${st.error ? ' <small>(Dienst antwortet nicht – neuer Versuch läuft)</small>' : ''}`;
    const shown = new Date(st.shownFrame);
    const ageMin = Math.round((Date.now() - shown.getTime()) / 60_000);
    let txt = `${icon} ${label} ${shown.toLocaleString('de-DE', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`;
    if (live || ageMin < 360) txt += ageMin < 90 ? ` (vor ${ageMin} Min.)` : ` (vor ${Math.round(ageMin / 60)} Std.)`;
    if (st.loading > 0) txt += ' <span class="spin">⟳</span>';
    return txt;
  };
  setInterval(() => {
    const live = time.isLive();
    clockLabel.innerHTML = `${time.label()} ${live ? '<b class="live">LIVE</b>' : ''}`;
    const { clock } = viewer;
    for (const b of speedButtons) {
      const s = Number(b.dataset.speed);
      b.classList.toggle('on', s === 0 ? !clock.shouldAnimate : clock.shouldAnimate && clock.multiplier === s);
    }
    const lines = [];
    if (clouds.show) lines.push(describe('☁️', 'Wolken', cloudStatus, live));
    if (color.show) lines.push(describe('🎨', 'Echtfarben', colorStatus, live));
    const txt = lines.join('<br>') || '—';
    status.innerHTML = txt;
  }, 500);
}
