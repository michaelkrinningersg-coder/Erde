import { JulianDate, type Entity, type Viewer } from 'cesium';
import type { CameraControl } from './camera';
import { FOCUS_TARGETS } from './camera';
import type { LayerStatus, TimeImageLayer } from './clouds/timeLayer';
import type { GlobeLayers } from './globe';
import { HOME_CITIES, type HomeControl } from './home';
import { AIRPORTS, type Flights } from './objects/flights';
import { LAUNCH_SITES, type RocketTarget } from './objects/rocket';
import type { Rockets } from './objects/rocketControl';
import type { Satellites } from './objects/satellites';
import type { Sky } from './objects/sky';
import type { SolarSystemView } from './solar/solarSystem';
import { hydrateIcons, icon, type IconName } from './svgIcons';
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

/** Knopf mit Symbol; Erklärung steht im Tooltip */
function btn(ico: IconName, title: string, onClick: (e: MouseEvent) => void, cls = 'icon-btn', text?: string) {
  const b = h('button', { class: cls, title }, icon(ico, 18), text ? h('span', { textContent: text }) : null);
  b.addEventListener('click', (e) => {
    e.preventDefault();
    onClick(e);
  });
  return b;
}

/** Schalter mit Symbol und kurzer Beschriftung; Erklärung im Tooltip */
function toggle(ico: IconName | null, label: string, tip: string, checked: boolean, onChange: (v: boolean) => void, extra?: Child) {
  const input = h('input', { type: 'checkbox', checked });
  input.addEventListener('change', () => onChange(input.checked));
  const row = h('label', { class: 'row', title: tip }, input, ico ? icon(ico, 18) : null, h('span', { textContent: label }), extra);
  return { row, input };
}

function section(ico: IconName, title: string, open: boolean, ...children: Child[]) {
  return h('details', { open }, h('summary', {}, icon(ico, 20), h('span', { textContent: title })), h('div', { class: 'section' }, ...children));
}

/** Gruppe mit Haupt-Schalter und aufklappbarer Liste einzelner Objekte */
function group(
  ico: IconName | null,
  label: string,
  tip: string,
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
      const t = toggle(null, it.label, it.label, it.checked, it.onChange, it.extra);
      childInputs.push(t.input);
      return t.row;
    }),
  );
  const head = toggle(
    ico,
    label,
    tip,
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
  const caret = btn('expand', 'Einzeln ein-/ausblenden', () => wrap.classList.toggle('open'), 'caret');
  const wrap = h('div', { class: 'group' }, h('div', { class: 'group-head' }, caret, head.row), list);
  return wrap;
}

export interface UiDeps {
  viewer: Viewer;
  layers: GlobeLayers;
  clouds: TimeImageLayer;
  color: TimeImageLayer;
  colorAmerica: TimeImageLayer;
  solar: SolarSystemView;
  home: HomeControl;
  sky: Sky;
  satellites: Satellites;
  flights: Flights;
  rockets: Rockets;
  camera: CameraControl;
  time: TimeControl;
}

export function buildUi(d: UiDeps) {
  const { viewer, layers, clouds, color, colorAmerica, solar, home, sky, satellites, flights, rockets, camera, time } = d;
  hydrateIcons();
  const body = document.getElementById('panel-body')!;
  const scene = viewer.scene;
  const follow = (e: Entity) => {
    camera.release();
    viewer.trackedEntity = e;
  };

  // ── Erde ──────────────────────────────────────────────────────────────
  const earth = section(
    'globe',
    'Erde',
    true,
    toggle('cloud', 'Wolken', 'Echte Wolken aus Infrarot-Satellitenbildern (weltweit, Tag und Nacht)', true, (v) => (clouds.show = v)).row,
    toggle('photo', 'Europa & Afrika', 'Echtfarben-Satellitenbild von Meteosat-12 (nur am Tag)', true, (v) => (color.show = v)).row,
    toggle('photo', 'Amerika', 'Echtfarben-Satellitenbild von GOES-19 (nur am Tag)', true, (v) => (colorAmerica.show = v)).row,
    toggle('lights', 'Stadtlichter', 'Lichter der Städte auf der Nachtseite', true, (v) => (layers.night.show = v)).row,
    toggle('daynight', 'Tag & Nacht', 'Beleuchtung nach dem echten Sonnenstand', true, (v) => {
      scene.globe.enableLighting = v;
      layers.day.nightAlpha = v ? 0.3 : 1;
    }).row,
    toggle('atmosphere', 'Atmosphäre', 'Blauer Lufthauch am Rand der Erde', true, (v) => {
      scene.globe.showGroundAtmosphere = v;
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = v;
    }).row,
    toggle('stars', 'Sterne', 'Sternenhimmel im Hintergrund', true, (v) => {
      if (scene.skyBox) scene.skyBox.show = v;
    }).row,
  );

  // ── Himmel ────────────────────────────────────────────────────────────
  let initialScale = 0.6;
  try {
    initialScale = Number(localStorage.getItem('erde.planetScale')) || initialScale;
  } catch {
    /* ohne Speicher */
  }
  const slider = h('input', { type: 'range', min: '0.25', max: '1.5', step: '0.05', value: String(initialScale) });
  const applyScale = () => {
    const v = Number(slider.value);
    sky.setPlanetScale(v);
    slider.title = `Planetengröße: ${Math.round(v * 100)} %`;
    try {
      localStorage.setItem('erde.planetScale', String(v));
    } catch {
      /* ohne Speicher */
    }
  };
  slider.addEventListener('input', applyScale);
  applyScale();

  const skySection = section(
    'sun',
    'Himmel',
    true,
    btn('solar', 'Sonnensystem ansehen (oder ganz weit rauszoomen)', () => solar.open(), 'wide', 'Sonnensystem'),
    toggle('sun', 'Sonne', 'Sonne', true, (v) => (sky.showSunDisc = v)).row,
    toggle('moon', 'Mond', 'Mond mit echter Mondphase', true, (v) => (sky.showMoonDisc = v), btn('follow', 'Zum Mond fliegen', () => camera.flyToMoon(sky.moon.entity), 'mini')).row,
    group(
      'planet',
      'Planeten',
      'Richtung stimmt, zur besseren Sichtbarkeit größer und näher gezeichnet',
      undefined,
      true,
      (v) => sky.planets.forEach((p) => (p.entity.show = v)),
      sky.planets.map((p) => ({ label: p.name, checked: true, onChange: (v: boolean) => (p.entity.show = v) })),
    ),
    h('label', { class: 'row slider', title: 'Größe der Planeten-Marker' }, icon('planet', 18), slider),
    toggle('telescope', 'James Webb', 'James-Webb-Teleskop am Lagrangepunkt L2 (Näherung)', true, (v) => (sky.jwst.entity.show = v)).row,
  );

  // ── Satelliten ────────────────────────────────────────────────────────
  const satGroups = satellites.groups.map((g) =>
    group(
      g.id === 'stations' ? 'station' : g.id === 'telescopes' ? 'telescope' : 'satellite',
      g.name,
      g.name,
      g.color,
      g.show,
      (v) => satellites.setGroupVisible(g, v),
      g.items.map((it) => {
        const orbitBtn = btn('orbit', 'Umlaufbahn zeigen', () => {
          const on = !orbitBtn.classList.contains('on');
          orbitBtn.classList.toggle('on', on);
          satellites.setOrbitVisible(it, on);
        }, 'mini');
        if (it.id === '25544') orbitBtn.classList.add('on');
        const followBtn = btn('follow', 'Mitfliegen', () => {
          follow(it.entity);
          viewer.selectedEntity = it.entity;
        }, 'mini');
        return { label: it.name, checked: g.show, onChange: (v: boolean) => satellites.setItemVisible(it, v), extra: h('span', { class: 'btns' }, orbitBtn, followBtn) };
      }),
    ),
  );
  const satTip = satellites.generated
    ? `Bahndaten vom ${satellites.generated.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`
    : '';
  const satSection = section('satellite', 'Satelliten', true, ...satGroups);
  satSection.querySelector('summary')!.title = satTip;

  // ── Ansicht ───────────────────────────────────────────────────────────
  const targetSelect = h('select', { title: 'Ort auswählen' }, ...FOCUS_TARGETS.map((t, i) => h('option', { value: String(i), textContent: t.name })));
  const view = section(
    'target',
    'Ansicht',
    false,
    h('div', { class: 'row wrap' }, targetSelect, btn('target', 'Hinfliegen (Doppelklick auf die Erde geht auch)', () => camera.focus(FOCUS_TARGETS[Number(targetSelect.value)]))),
    toggle('globe', 'Erde dreht sich', 'Blick aus dem All: Die Kamera steht still, die Erde dreht sich darunter', false, (v) => camera.setSpaceView(v)).row,
    h(
      'div',
      { class: 'row wrap' },
      btn('globe', 'Ganze Erde zeigen', () => camera.home(), 'icon-btn', 'Ganze Erde'),
      btn('home', 'Zuhause festlegen', () => openHomeDialog(), 'icon-btn', 'Zuhause'),
    ),
  );

  // ── Starten (eingeklappt): Flugzeug oder Rakete ───────────────────────
  const starts = h('div', { class: 'flights' });
  const renderStarts = () => {
    starts.replaceChildren(
      ...flights.list.map((f) =>
        h(
          'div',
          { class: 'row' },
          icon('plane', 16),
          h('span', { textContent: `${f.from.code} → ${f.to.code}`, title: `${f.from.city} → ${f.to.city}, ${f.distanceKm.toLocaleString('de-DE')} km` }),
          h(
            'span',
            { class: 'btns' },
            btn('follow', 'Mitfliegen', () => {
              if (JulianDate.lessThan(viewer.clock.currentTime, f.departure)) viewer.clock.currentTime = f.departure.clone();
              follow(f.plane);
            }, 'mini'),
            btn('close', 'Entfernen', () => flights.remove(f), 'mini'),
          ),
        ),
      ),
      ...rockets.missions.map((m) =>
        h(
          'div',
          { class: 'row' },
          icon('rocket', 16),
          h('span', { textContent: `${m.site.rocket} → ${m.target.name}`, title: m.site.name }),
          h('span', { class: 'btns' }, btn('follow', 'Mitfliegen', () => follow(m.entity), 'mini'), btn('close', 'Entfernen', () => rockets.remove(m), 'mini')),
        ),
      ),
    );
  };
  flights.onChange = renderStarts;
  rockets.onChange = renderStarts;

  // Flugzeug
  const apOptions = (sel: string) => AIRPORTS.map((a) => h('option', { value: a.code, textContent: a.city, selected: a.code === sel }));
  const fromSel = h('select', { title: 'Abflug' }, ...apOptions('FRA'));
  const toSel = h('select', { title: 'Ziel' }, ...apOptions('JFK'));
  const planeForm = h(
    'div',
    { class: 'start-form' },
    h(
      'div',
      { class: 'row wrap' },
      fromSel,
      btn('swap', 'Richtung tauschen', () => ([fromSel.value, toSel.value] = [toSel.value, fromSel.value]), 'mini'),
      toSel,
    ),
    btn('plane', 'Simulierter Flug auf dem kürzesten Weg (Großkreis)', () => {
      const from = AIRPORTS.find((a) => a.code === fromSel.value)!;
      const to = AIRPORTS.find((a) => a.code === toSel.value)!;
      if (from === to) return;
      const f = flights.create(from, to, viewer.clock.currentTime.clone());
      if (!viewer.clock.shouldAnimate || viewer.clock.multiplier < 60) time.setSpeed(600);
      follow(f.plane);
    }, 'go', 'Abheben'),
  );

  // Rakete
  const targets: RocketTarget[] = (['25544', '48274'] as const)
    .map((id) => satellites.find(id))
    .filter((it): it is NonNullable<typeof it> => !!it)
    .map((it) => ({ id: it.id, name: it.id === '25544' ? 'ISS' : 'Tiangong', satrec: it.satrec, entity: it.entity }));
  const siteSel = h('select', { title: 'Startplatz' }, ...LAUNCH_SITES.map((s) => h('option', { value: s.id, textContent: s.name })));
  const targetSel = h('select', { title: 'Ziel' }, ...targets.map((t) => h('option', { value: t.id, textContent: t.name })));
  const rocketMsg = h('div', { class: 'msg' });
  const rocketForm = h(
    'div',
    { class: 'start-form hidden' },
    h('div', { class: 'row wrap' }, siteSel, targetSel),
    btn('launch', 'Wartet auf das nächste Startfenster und fliegt mit Zeitraffer bis zum Andocken', () => {
      const site = LAUNCH_SITES.find((s) => s.id === siteSel.value)!;
      const target = targets.find((t) => t.id === targetSel.value)!;
      const r = rockets.launch(site, target);
      rocketMsg.textContent = typeof r === 'string' ? r : '';
    }, 'go', 'Start'),
    rocketMsg,
  );
  const tabPlane = btn('plane', 'Flugzeug', () => showTab('plane'), 'tab on', 'Flugzeug');
  const tabRocket = btn('rocket', 'Rakete zur Raumstation', () => showTab('rocket'), 'tab', 'Rakete');
  const showTab = (t: 'plane' | 'rocket') => {
    tabPlane.classList.toggle('on', t === 'plane');
    tabRocket.classList.toggle('on', t === 'rocket');
    planeForm.classList.toggle('hidden', t !== 'plane');
    rocketForm.classList.toggle('hidden', t !== 'rocket');
  };
  const startSection = section('launch', 'Starten', false, h('div', { class: 'tabs' }, tabPlane, tabRocket), planeForm, rocketForm, starts);

  body.append(earth, skySection, satSection, view, startSection);

  // Panel ein-/ausklappen (auf dem Handy standardmäßig zu)
  const panel = document.getElementById('panel')!;
  if (window.innerWidth < 700) panel.classList.add('collapsed');
  document.getElementById('panel-toggle')!.addEventListener('click', () => panel.classList.toggle('collapsed'));

  // ── Einnorden ─────────────────────────────────────────────────────────
  const northBtn = document.getElementById('north-btn')!;
  northBtn.addEventListener('click', () => camera.north());
  scene.postRender.addEventListener(() => {
    // Kompassnadel zeigt, wo Norden gerade ist
    const deg = -(viewer.camera.heading * 180) / Math.PI;
    northBtn.style.setProperty('--heading', `${deg.toFixed(1)}deg`);
  });

  // ── Zeitleiste ────────────────────────────────────────────────────────
  for (const b of document.querySelectorAll<HTMLButtonElement>('#timebar [data-speed]')) {
    b.addEventListener('click', () => {
      rockets.autopilot = false;
      time.setSpeed(Number(b.dataset.speed));
    });
  }
  document.getElementById('btn-live')!.addEventListener('click', () => {
    rockets.autopilot = false;
    time.goLive();
  });
  const rangeSel = document.getElementById('range-select') as HTMLSelectElement;
  rangeSel.addEventListener('change', () => time.applyRange(Number(rangeSel.value)));

  // ── Zuhause ───────────────────────────────────────────────────────────
  function openHomeDialog() {
    const close = () => dlg.remove();
    const status = h('p', { class: 'msg' });
    const accept = (place: { name: string; lat: number; lon: number } | undefined) => {
      if (!place) return;
      home.set(place);
      close();
      home.goHome();
    };
    const gpsBtn = btn('gps', 'Standort des Geräts (auf ~1 km gerundet)', () => {
      if (!navigator.geolocation) return void (status.textContent = 'Kein Standort verfügbar.');
      status.textContent = 'Standort wird ermittelt …';
      navigator.geolocation.getCurrentPosition(
        (p) => accept({ name: 'Mein Standort', lat: +p.coords.latitude.toFixed(2), lon: +p.coords.longitude.toFixed(2) }),
        () => (status.textContent = 'Standort nicht erlaubt – bitte eine Stadt wählen.'),
        { timeout: 15000 },
      );
    }, 'go', 'Mein Standort');
    const citySel = h('select', { title: 'Stadt' }, ...HOME_CITIES.map((c, i) => h('option', { value: String(i), textContent: c.name })));
    const centerBtn = btn('target', 'Den Punkt in der Bildmitte nehmen', () => {
      const p = home.centerOfView();
      if (!p) return void (status.textContent = 'In der Bildmitte ist keine Erde zu sehen.');
      accept({ ...p, name: 'Zuhause' });
    }, 'icon-btn', 'Bildmitte');
    const dlg = h(
      'div',
      { class: 'dialog-backdrop' },
      h(
        'div',
        { class: 'dialog glass', title: 'Wird nur in diesem Browser gespeichert' },
        h('div', { class: 'row' }, icon('home', 22), h('h2', { textContent: 'Zuhause' }), btn('close', 'Schließen', close, 'mini')),
        gpsBtn,
        h('div', { class: 'row wrap' }, citySel, btn('home', 'Diese Stadt übernehmen', () => accept(HOME_CITIES[Number(citySel.value)]), 'icon-btn', 'OK')),
        centerBtn,
        status,
      ),
    );
    dlg.addEventListener('click', (e) => e.target === dlg && close());
    document.body.append(dlg);
  }
  document.getElementById('home-btn')!.addEventListener('click', () => {
    if (!home.goHome()) openHomeDialog();
  });

  // ── Statuszeile ───────────────────────────────────────────────────────
  const status = document.getElementById('status')!;
  const clockLabel = document.getElementById('clock-label')!;
  const st: Record<string, LayerStatus> = {};
  clouds.onStatus = (s) => (st.clouds = s);
  color.onStatus = (s) => (st.eu = s);
  colorAmerica.onStatus = (s) => (st.am = s);
  const speedButtons = document.querySelectorAll<HTMLButtonElement>('#timebar [data-speed]');
  const lines = {
    clouds: statusLine('cloud', 'Wolken weltweit (Infrarot)'),
    eu: statusLine('photo', 'Echtfarben Europa & Afrika'),
    am: statusLine('photo', 'Echtfarben Amerika'),
  };
  status.replaceChildren(lines.clouds.el, lines.eu.el, lines.am.el);
  setInterval(() => {
    const live = time.isLive();
    clockLabel.innerHTML = `${time.label()} ${live ? '<b class="live">LIVE</b>' : ''}`;
    const { clock } = viewer;
    for (const b of speedButtons) {
      const s = Number(b.dataset.speed);
      b.classList.toggle('on', s === 0 ? !clock.shouldAnimate : clock.shouldAnimate && clock.multiplier === s);
    }
    lines.clouds.update(clouds.show ? st.clouds : undefined, 'Welt');
    lines.eu.update(color.show ? st.eu : undefined, 'EU');
    lines.am.update(colorAmerica.show ? st.am : undefined, 'AM');
  }, 500);
}

/** Eine Zeile der Statusbox: Symbol, Kürzel, Uhrzeit des Bildes; Details im Tooltip */
function statusLine(ico: IconName, name: string) {
  const text = document.createElement('span');
  const el = h('div', { class: 'status-line' }, icon(ico, 16), text);
  return {
    el,
    update(s: LayerStatus | undefined, short: string) {
      el.classList.toggle('hidden', !s);
      if (!s) return;
      if (!s.shownFrame) {
        text.innerHTML = `${short} <span class="spin">⟳</span>`;
        el.title = `${name}: wird geladen${s.error ? ' (Anbieter antwortet nicht, neuer Versuch läuft)' : ''}`;
        return;
      }
      const shown = new Date(s.shownFrame);
      const ageMin = Math.round((Date.now() - shown.getTime()) / 60_000);
      const clock = shown.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
      const dense = s.dense !== undefined && s.dense < 1 ? ` · 10-Minuten-Bilder: ${Math.round(s.dense * 100)} % geladen` : '';
      text.innerHTML = `${short} ${clock}${s.loading > 0 ? ' <span class="spin">⟳</span>' : ''}`;
      el.title = `${name}: Bild von ${shown.toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} (vor ${ageMin < 120 ? `${ageMin} Min.` : `${Math.round(ageMin / 60)} Std.`})${dense}`;
    },
  };
}
