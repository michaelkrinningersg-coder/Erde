import {
  ArcType,
  BillboardCollection,
  CallbackProperty,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  CustomDataSource,
  DistanceDisplayCondition,
  Ellipsoid,
  EllipsoidGeodesic,
  HorizontalOrigin,
  LabelStyle,
  Math as CesiumMath,
  NearFarScalar,
  PointPrimitiveCollection,
  PolygonHierarchy,
  PolylineDashMaterialProperty,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  VerticalOrigin,
  type ImageryLayer,
  type Billboard,
  type Viewer,
} from 'cesium';
import { icon } from '../svgIcons';
import { ALLIANCES, colorScheme, PALETTE, type LegendEntry } from './colors';
import { HISTORY_YEARS, loadJson, type Admin1File, type DisputedFile, type HistoryFile, type PlacesFile, type River, type WaterFile } from './data';
import {
  decodeLines,
  decodePolys,
  distToLine,
  escapeHtml,
  fmt,
  heightForBox,
  inBox,
  insidePolys,
  unionBox,
  wikiLink,
  type BBox,
  type CitiesFile,
  type CityRow,
  type CountriesFile,
  type CountryData,
  type Line,
  type PointInfo,
  type Poly,
} from './geo';
import { LabelManager, rangeForZoom, type LabelItem } from './labels';
import { CITY_CLASSES, cityClass, cityIcon, iconUrl, markerIcon, MarkerLayer, type MarkerItem } from './markers';
import { MyMap, shrinkPhoto, type OwnPlace } from './mymap';
import { CountryQuiz, type QuizCountry, type QuizHost } from './quiz';
import { dayLength, fetchWeather, sunTimes, timeIn, todayIn } from './sunweather';
import { CanvasLayer, COARSE_MAX_LEVEL, fillPolys, strokeLines, strokePolys, widthFor, type TileView } from './tiles';

const WATER = '#6aa5dc';
const BORDER = 'rgba(55, 60, 72, 0.75)';
const SEA_TEXT = '#1d4f8f';

/** Stufen des Stadtgrößen-Reglers (Welt ab 10.000, Deutschland ab 5.000 Einwohnern) */
export const CITY_STEPS = [5_000, 10_000, 20_000, 50_000, 100_000, 250_000, 500_000, 1_000_000, 2_000_000, 5_000_000];
export const DEFAULT_STEP = 4;

interface Country {
  data: CountryData;
  fine: Poly[];
  coarse: Poly[];
  bbox: BBox;
  idx: number;
}

interface HistCountry {
  n: string;
  s: string;
  c: number;
  l: [number, number];
  fine: Poly[];
  coarse: Poly[];
  bbox: BBox;
}

interface City {
  row: CityRow;
  pos: Cartesian3;
  point?: Billboard;
}

interface MeasurePoint {
  pos: Cartographic;
  name: string;
}

/** Schaltbare Ebenen und Einstellungen (alles Neue standardmäßig aus) */
export interface Options {
  satellite: boolean;
  borders: boolean;
  colorMode: string;
  year: number; // 0 = heute
  admin1: boolean;
  disputed: boolean;
  neighbors: boolean;
  seas: boolean;
  lakes: boolean;
  rivers: boolean;
  deeps: boolean;
  geolines: boolean;
  graticule: boolean;
  peaks: boolean;
  wonders: boolean;
  buildings: boolean;
  unesco: boolean;
  volcanoes: boolean;
  quakes: boolean;
  parks: boolean;
  deserts: boolean;
  ranges: boolean;
  waterfalls: boolean;
  extremes: boolean;
  airports: boolean;
  ports: boolean;
  own: boolean;
  visited: boolean;
  weather: boolean;
}

const DEFAULTS: Options = {
  satellite: false,
  borders: false,
  colorMode: 'neighbors',
  year: 0,
  admin1: false,
  disputed: false,
  neighbors: false,
  seas: false,
  lakes: false,
  rivers: false,
  deeps: false,
  geolines: false,
  graticule: false,
  peaks: false,
  wonders: false,
  buildings: false,
  unesco: false,
  volcanoes: false,
  quakes: false,
  parks: false,
  deserts: false,
  ranges: false,
  waterfalls: false,
  extremes: false,
  airports: false,
  ports: false,
  own: false,
  visited: false,
  weather: false,
};
const OPT_KEY = 'erde.politik.optionen';

/** Ein Treffer der Suche */
export interface SearchHit {
  name: string;
  kind: string;
  lon: number;
  lat: number;
  height: number;
  open?: () => void;
  rank: number;
}

const labelRange = (pop: number, capital: boolean) => Math.max(9e5 * Math.pow(Math.max(pop, 5e3) / 1e5, 0.55), capital ? 3.5e6 : 0);
const pointRange = (pop: number) =>
  pop >= 5e6 ? 1.3e7 : pop >= 1e6 ? 8e6 : pop >= 5e5 ? 5e6 : pop >= 1e5 ? 2.6e6 : pop >= 5e4 ? 1.4e6 : pop >= 2e4 ? 8e5 : 4.5e5;
const isMainCapital = (role: string) => role.startsWith('Hauptstadt') || role === 'Bundesstadt';
const km = (v: number) => `${v < 10 ? fmt(v, 1) : fmt(Math.round(v))} km`;
const sqkm = (v: number) => `${fmt(v)} km²`;

/**
 * Politische Karte: statisch (keine Zeit, keine Wolken), Länder in Nachbarfarben oder eingefärbt nach Werten/Bündnissen,
 * wahlweise Satellitenbild oder historische Grenzen; Städte, Wasser, besondere Orte; Steckbriefe, Suche, Messen, Vergleiche.
 */
export class PoliticalView implements QuizHost {
  active = false;
  onChange?: (active: boolean) => void;
  /** Bedienfeld aktualisieren (Legende, Zähler, Listen) */
  onState?: () => void;
  readonly opt: Options;
  readonly myMap = new MyMap();
  legend: LegendEntry[] = [];
  legendInfo = '';
  places?: PlacesFile;

  private loaded?: Promise<void>;
  private scale = 1;
  private countries: Country[] = [];
  private cityData?: CitiesFile;
  private cities: City[] = [];
  private lakes: Poly[] = [];
  private lakesCoarse: Poly[] = [];
  private borderLines: Line[] = [];
  private borderCoarse: Line[] = [];
  private water?: WaterFile;
  private riverLines: { river: River; fine: Line[]; coarse: Line[] }[] = [];
  private admin1?: { lines: Line[]; coarse: Line[] };
  private disputed: { n: string; note: string; w: string; fine: Poly[]; bbox: BBox }[] = [];
  private history?: { year: number; countries: HistCountry[] };
  private highlight?: Country;
  readonly quiz: CountryQuiz;
  private quizPaint?: Map<number, string>;
  private quizSaved?: { satellite: boolean; year: number };

  private readonly labels: LabelManager;
  private readonly points = new BillboardCollection();
  private readonly capitals = new BillboardCollection();
  private readonly quakePoints = new PointPrimitiveCollection();
  private readonly markers = new Map<string, MarkerLayer>();
  private readonly base: CanvasLayer;
  private readonly borderLayer: CanvasLayer;
  private readonly riverLayer: CanvasLayer;
  private readonly admin1Layer: CanvasLayer;
  private readonly disputedLayer: CanvasLayer;
  private readonly graticuleLayer: CanvasLayer;
  private readonly visitedLayer: CanvasLayer;
  private readonly quizLayer: CanvasLayer;
  private readonly overlay = new CustomDataSource('politik');
  private readonly lines = new CustomDataSource('politik-linien');
  private readonly compareSrc = new CustomDataSource('politik-vergleich');
  private readonly pinSrc = new CustomDataSource('politik-markierung');
  private threshold = CITY_STEPS[DEFAULT_STEP];
  private saved?: () => void;
  private handler?: ScreenSpaceEventHandler;
  private measuring = false;
  private measure: MeasurePoint[] = [];
  private compareFirst?: Country;
  private addingPlace = false;
  private quakeTimer?: number;
  private dragOutline?: { country: Country; target: Cartesian3; moving: boolean };

  readonly bar = document.createElement('div');
  readonly card = document.createElement('div');
  private readonly measureBtn = document.createElement('button');
  private readonly hint = document.createElement('span');
  private readonly coords = document.createElement('div');

  constructor(
    private readonly viewer: Viewer,
    /** Satellitenbild der Erde (Sentinel-2 ohne Wolken) */
    private readonly satellite: ImageryLayer,
  ) {
    let stored: Partial<Options> = {};
    try {
      stored = JSON.parse(localStorage.getItem(OPT_KEY) ?? '{}') as Partial<Options>;
    } catch {
      /* ohne gespeicherte Einstellungen */
    }
    this.opt = { ...DEFAULTS, ...stored };
    const scene = viewer.scene;
    this.labels = new LabelManager(scene);
    this.labels.setActive(false);
    for (const p of [this.points, this.capitals, this.quakePoints]) {
      p.show = false;
      scene.primitives.add(p);
    }
    const layers = viewer.imageryLayers;
    // Reihenfolge der Ebenen: Grundkarte, Besucht, Bundesländer, Umstritten, Flüsse, Grenzen, Gradnetz
    this.base = new CanvasLayer(layers, 2000, (t) => this.drawBase(t), true, WATER);
    this.visitedLayer = new CanvasLayer(layers, 2000, (t) => this.drawVisited(t));
    this.admin1Layer = new CanvasLayer(layers, 2000, (t) => this.drawAdmin1(t));
    this.disputedLayer = new CanvasLayer(layers, 2000, (t) => this.drawDisputed(t));
    this.riverLayer = new CanvasLayer(layers, 2000, (t) => this.drawRivers(t));
    this.borderLayer = new CanvasLayer(layers, 2000, (t) => this.drawBorders(t));
    this.graticuleLayer = new CanvasLayer(layers, 2000, (t) => this.drawGraticule(t));
    this.quizLayer = new CanvasLayer(layers, 2000, (t) => this.drawQuiz(t));
    this.quiz = new CountryQuiz(this);
    for (const ds of [this.overlay, this.lines, this.compareSrc, this.pinSrc]) {
      ds.show = false;
      void viewer.dataSources.add(ds);
    }
    this.myMap.onChange = () => {
      this.updateOwnPlaces();
      this.visitedLayer.redraw();
      this.onState?.();
    };
    this.buildDom();
  }

  private get canvasLayers() {
    return [this.base, this.visitedLayer, this.quizLayer, this.admin1Layer, this.disputedLayer, this.riverLayer, this.borderLayer, this.graticuleLayer];
  }

  toggle() {
    void (this.active ? this.exit() : this.enter());
  }

  async enter() {
    if (this.active) return;
    this.active = true;
    document.body.classList.add('political-mode', 'political-loading');
    this.hideEverythingElse();
    this.onChange?.(true);
    try {
      await (this.loaded ??= this.load());
    } catch (e) {
      console.error('Politische Karte konnte nicht geladen werden', e);
      this.loaded = undefined;
      document.body.classList.remove('political-loading');
      void this.exit();
      return;
    }
    document.body.classList.remove('political-loading');
    if (!this.active) return;
    this.labels.setActive(true);
    for (const p of [this.points, this.capitals]) p.show = true;
    for (const ds of [this.overlay, this.lines, this.compareSrc, this.pinSrc]) ds.show = true;
    this.applyThreshold();
    await this.applyAll();
    this.handler = new ScreenSpaceEventHandler(this.viewer.canvas);
    this.handler.setInputAction((e: { position: Cartesian2 }) => void this.click(e.position), ScreenSpaceEventType.LEFT_CLICK);
    this.handler.setInputAction((e: { endPosition: Cartesian2 }) => this.mouseMove(e.endPosition), ScreenSpaceEventType.MOUSE_MOVE);
  }

  async exit() {
    if (!this.active) return;
    if (this.quiz.active) this.quiz.stop();
    this.active = false;
    this.stopAudio();
    this.handler?.destroy();
    this.handler = undefined;
    for (const l of this.canvasLayers) l.show = false;
    this.labels.setActive(false);
    for (const p of [this.points, this.capitals, this.quakePoints]) p.show = false;
    for (const m of this.markers.values()) m.show = false;
    for (const ds of [this.overlay, this.lines, this.compareSrc, this.pinSrc]) ds.show = false;
    this.stopQuakes();
    this.setMeasuring(false);
    this.dragOutline = undefined;
    this.card.classList.add('hidden');
    this.coords.classList.add('hidden');
    this.saved?.();
    this.saved = undefined;
    document.body.classList.remove('political-mode');
    this.onChange?.(false);
  }

  /** Alles andere ausblenden (Bildebenen, Objekte, Licht, Himmel) und die Zeit anhalten; merkt sich den alten Zustand */
  private hideEverythingElse() {
    const v = this.viewer;
    const s = v.scene;
    const own = new Set(this.canvasLayers.map((l) => l.layer));
    const layers: [ImageryLayer, boolean][] = [];
    for (let i = 0; i < v.imageryLayers.length; i++) {
      const l = v.imageryLayers.get(i);
      if (own.has(l)) continue;
      layers.push([l, l.show]);
      l.show = false;
    }
    const state = {
      entities: v.entities.show,
      lighting: s.globe.enableLighting,
      groundAtmo: s.globe.showGroundAtmosphere,
      skyAtmo: s.skyAtmosphere?.show,
      sun: s.sun?.show,
      moon: s.moon?.show,
      skyBox: s.skyBox?.show,
      background: s.backgroundColor.clone(),
      baseColor: s.globe.baseColor.clone(),
      animate: v.clock.shouldAnimate,
    };
    v.trackedEntity = undefined;
    v.selectedEntity = undefined;
    v.entities.show = false;
    // Cesiums eigene Auswahl (grüner Rahmen, Info-Kasten) aus – wir zeigen eigene Steckbriefe
    const ssh = v.screenSpaceEventHandler;
    const defaultClick = ssh.getInputAction(ScreenSpaceEventType.LEFT_CLICK);
    ssh.removeInputAction(ScreenSpaceEventType.LEFT_CLICK);
    s.globe.enableLighting = false;
    s.globe.showGroundAtmosphere = false;
    if (s.skyAtmosphere) s.skyAtmosphere.show = false;
    if (s.sun) s.sun.show = false;
    if (s.moon) s.moon.show = false;
    if (s.skyBox) s.skyBox.show = false;
    s.backgroundColor = Color.fromCssColorString('#0b1424');
    s.globe.baseColor = Color.fromCssColorString(WATER);
    v.clock.shouldAnimate = false;
    this.saved = () => {
      for (const [l, show] of layers) if (!l.isDestroyed()) l.show = show;
      v.entities.show = state.entities;
      s.globe.enableLighting = state.lighting;
      s.globe.showGroundAtmosphere = state.groundAtmo;
      if (s.skyAtmosphere && state.skyAtmo !== undefined) s.skyAtmosphere.show = state.skyAtmo;
      if (s.sun && state.sun !== undefined) s.sun.show = state.sun;
      if (s.moon && state.moon !== undefined) s.moon.show = state.moon;
      if (s.skyBox && state.skyBox !== undefined) s.skyBox.show = state.skyBox;
      s.backgroundColor = state.background;
      s.globe.baseColor = state.baseColor;
      v.clock.shouldAnimate = state.animate;
      if (defaultClick) ssh.setInputAction(defaultClick, ScreenSpaceEventType.LEFT_CLICK);
    };
  }

  // ── Laden ───────────────────────────────────────────────────────────────

  private async load() {
    const [cf, cities] = await Promise.all([loadJson<CountriesFile>('countries.json'), loadJson<CitiesFile>('cities.json')]);
    this.scale = cf.scale;
    this.countries = cf.countries.map((data, idx) => {
      const fine = decodePolys(data.p);
      const coarse = decodePolys(data.g);
      data.p = data.g = []; // Rohdaten nicht doppelt im Speicher halten
      return { data, fine, coarse, bbox: unionBox(fine), idx };
    });
    this.lakes = decodePolys(cf.lakes);
    this.lakesCoarse = decodePolys(cf.lakesCoarse);
    this.borderLines = decodeLines(cf.borders);
    this.borderCoarse = decodeLines(cf.bordersCoarse);
    this.cityData = cities;
    this.buildCountryLabels();
    this.buildCities();
    this.buildPeaks();
    this.updateOwnPlaces();
  }

  private buildCountryLabels() {
    const items: LabelItem[] = this.countries.map((ct) => {
      const c = ct.data;
      return {
        pos: Cartesian3.fromDegrees(c.l[0], c.l[1]),
        text: c.n,
        size: c.z <= 2 ? 17 : c.z <= 3.5 ? 15 : 13,
        bold: true,
        fill: '#1d2433',
        range: rangeForZoom(c.z),
        prio: 9e11 - c.z * 1e10,
        id: { kind: 'country', country: ct },
      };
    });
    this.labels.set('countries', items, true);
  }

  private buildCities() {
    const capImg = iconUrl(markerIcon('capital'));
    const seatImg = iconUrl(markerIcon('seat'));
    const items: LabelItem[] = [];
    for (const row of this.cityData!.cities) {
      const [name, , pop, lat, lon, , , , cap] = row;
      const pos = Cartesian3.fromDegrees(lon, lat);
      const capital = !!cap;
      const city: City = { row, pos };
      if (capital) {
        this.capitals.add({
          position: pos,
          image: isMainCapital(cap) ? capImg : seatImg,
          width: 16,
          height: 16,
          // ganz weit draußen klein, damit sich die Zeichen nicht überdecken
          scaleByDistance: new NearFarScalar(1.5e6, 1, 2.2e7, 0.3),
          id: { city: row },
        });
      } else {
        const cls = cityClass(pop);
        const size = CITY_CLASSES[cls].size;
        city.point = this.points.add({
          position: pos,
          image: iconUrl(cityIcon(cls)),
          width: size,
          height: size,
          scaleByDistance: new NearFarScalar(1e6, 1, 1.3e7, 0.6),
          distanceDisplayCondition: new DistanceDisplayCondition(0, pointRange(pop)),
          id: { city: row },
        });
      }
      this.cities.push(city);
      items.push({
        pos,
        text: name,
        size: capital ? 14 : pop >= 1e6 ? 13 : 12,
        bold: capital || pop >= 1e6,
        fill: '#10151f',
        range: labelRange(pop, capital),
        prio: (capital ? 7e11 : 0) + pop,
        offset: capital ? -10 : -6,
        mark: 8,
        id: { city: row },
      });
    }
    this.labels.set('cities', items, true, (it) => {
      const row = (it.id as { city: CityRow }).city;
      return !!row[8] || row[2] >= this.threshold;
    });
  }

  private marker(key: string, style: ConstructorParameters<typeof MarkerLayer>[3]) {
    let m = this.markers.get(key);
    if (!m) {
      m = new MarkerLayer(this.viewer.scene, this.labels, key, style);
      this.markers.set(key, m);
    }
    return m;
  }

  /** Höchste Punkte: gleicher Berg für mehrere Länder (z. B. Mont Blanc) nur einmal */
  private buildPeaks() {
    const group = (get: (c: CountryData) => PointInfo | null | undefined) => {
      const map = new Map<string, { p: PointInfo; countries: string[] }>();
      for (const { data } of this.countries) {
        const p = get(data);
        if (!p) continue;
        const key = `${p[1].toFixed(2)},${p[2].toFixed(2)}`;
        const e = map.get(key);
        if (e) e.countries.push(data.n);
        else map.set(key, { p, countries: [data.n] });
      }
      return [...map.values()];
    };
    this.marker('peaks', { fill: '#3b2414', size: 12, bold: true }).setItems(
      group((c) => c.h).map(({ p, countries }) => ({
        lon: p[1],
        lat: p[2],
        name: `${p[0] ? `${p[0]}\n` : ''}${fmt(p[3])} m`,
        icon: 'peak',
        range: p[3] > 4000 ? 7e6 : 4e6,
        prio: 5e11 + p[3],
        data: { info: p, countries, what: 'Höchster Punkt' },
      })),
    );
    this.lowestPoints = group((c) => c.x.lo).map(({ p, countries }) => ({ p, countries }));
  }

  private lowestPoints: { p: PointInfo; countries: string[] }[] = [];

  // ── Ebenen schalten ─────────────────────────────────────────────────────

  /** Einstellung ändern (vom Bedienfeld) */
  async set<K extends keyof Options>(key: K, value: Options[K]) {
    this.opt[key] = value;
    try {
      localStorage.setItem(OPT_KEY, JSON.stringify(this.opt));
    } catch {
      /* egal */
    }
    if (this.active) await this.apply(key);
    this.onState?.();
  }

  private async applyAll() {
    for (const k of Object.keys(this.opt) as (keyof Options)[]) await this.apply(k);
  }

  private async apply(key: keyof Options) {
    const o = this.opt;
    try {
      switch (key) {
        case 'satellite':
        case 'borders':
          this.base.show = !o.satellite;
          this.satellite.show = o.satellite;
          this.borderLayer.show = o.satellite && o.borders;
          this.order();
          break;
        case 'colorMode':
        case 'year':
          await this.applyBase();
          break;
        case 'admin1':
          if (o.admin1) await this.loadAdmin1();
          this.admin1Layer.show = o.admin1;
          this.labels.show('admin1', o.admin1);
          for (const c of this.cities) if (c.point && c.row[14]) c.point.color = o.admin1 ? Color.fromCssColorString('#ffd36b') : Color.WHITE;
          this.order();
          break;
        case 'disputed':
          if (o.disputed) await this.loadDisputed();
          this.disputedLayer.show = o.disputed;
          this.labels.show('disputed', o.disputed);
          this.order();
          break;
        case 'neighbors':
          if (!o.neighbors && this.highlight) {
            this.highlight = undefined;
            this.base.redraw();
          }
          break;
        case 'seas':
        case 'lakes':
        case 'rivers':
        case 'deeps':
          if (o[key]) await this.loadWater();
          this.labels.show(key, o[key]);
          if (key === 'rivers') {
            this.riverLayer.show = o.rivers;
            this.order();
          }
          if (key === 'deeps' && this.markers.has('deeps')) this.markers.get('deeps')!.show = o.deeps;
          break;
        case 'geolines':
          if (o.geolines) await this.loadPlaces();
          this.buildGeoLines();
          this.labels.show('geolines', o.geolines);
          break;
        case 'graticule':
          this.graticuleLayer.show = o.graticule;
          this.coords.classList.toggle('hidden', !o.graticule);
          this.order();
          break;
        case 'peaks':
          this.markers.get('peaks')!.show = o.peaks;
          break;
        case 'quakes':
          if (o.quakes) this.startQuakes();
          else this.stopQuakes();
          break;
        case 'own':
          this.markers.get('own')!.show = o.own;
          break;
        case 'visited':
          this.visitedLayer.show = o.visited;
          this.order();
          break;
        case 'weather':
          break;
        default:
          // Orte-Ebenen aus places.json
          if (o[key]) await this.loadPlaces();
          if (this.markers.has(key)) this.markers.get(key)!.show = !!o[key];
          if (key === 'ranges' && this.markers.has('summits')) this.markers.get('summits')!.show = o.ranges;
          if (key === 'ports' && this.markers.has('canals')) this.markers.get('canals')!.show = o.ports;
          if (key === 'deserts' || key === 'ranges') this.labels.show(key, !!o[key]);
      }
    } catch (e) {
      console.error('Ebene konnte nicht geladen werden', key, e);
    }
  }

  /** Grundkarte und Überlagerungen in fester Reihenfolge übereinander */
  private order() {
    for (const l of this.canvasLayers) l.raise();
  }

  private async applyBase() {
    const o = this.opt;
    if (o.year) {
      const h = await loadJson<HistoryFile>(`history/${o.year}.json`);
      if (this.history?.year !== h.year) {
        this.history = {
          year: h.year,
          countries: h.countries.map((c) => {
            const fine = decodePolys(c.p);
            return { n: c.n, s: c.s, c: c.c, l: c.l, fine, coarse: decodePolys(c.g), bbox: unionBox(fine) };
          }),
        };
      }
      this.labels.set(
        'history',
        this.history.countries.map((c) => ({
          pos: Cartesian3.fromDegrees(c.l[0], c.l[1]),
          text: c.n,
          size: 13,
          bold: true,
          fill: '#2b2016',
          range: heightForBox(c.bbox, this.scale) * 3.5,
          prio: 9e11 + (c.bbox[2] - c.bbox[0]) * (c.bbox[3] - c.bbox[1]) * 1e-6,
          id: { kind: 'hist', item: c },
        })),
        true,
      );
    }
    this.labels.show('history', !!o.year);
    this.labels.show('countries', !o.year);
    const scheme = colorScheme(o.year ? 'neighbors' : o.colorMode, this.countries.map((c) => c.data));
    this.legend = scheme.legend;
    this.legendInfo = o.year ? `Grenzen von ${o.year} (ungefähr, nach historical-basemaps). Städte und Namen sind von heute.` : scheme.info ?? '';
    this.colorFn = scheme.fn;
    this.base.show = !o.satellite;
    this.base.redraw();
    this.order();
  }

  private colorFn: (c: CountryData) => string = (c) => PALETTE[c.c % PALETTE.length];

  setThreshold(v: number) {
    this.threshold = v;
    this.applyThreshold();
  }

  private applyThreshold() {
    for (const c of this.cities) if (c.point) c.point.show = c.row[2] >= this.threshold;
    this.labels.refresh();
  }

  // ── Kacheln zeichnen ────────────────────────────────────────────────────

  private drawBase(t: TileView) {
    const coarse = t.level <= COARSE_MAX_LEVEL;
    const shown: Poly[][] = [];
    if (this.opt.year && this.history) {
      for (const c of this.history.countries) {
        if (!t.visible(c.bbox)) continue;
        const polys = coarse ? c.coarse : c.fine;
        fillPolys(t, polys, PALETTE[c.c % PALETTE.length]);
        shown.push(polys);
      }
    } else {
      const hi = this.highlight;
      const nb = new Set(hi?.data.nb ?? []);
      for (const ct of this.countries) {
        if (!t.visible(ct.bbox)) continue;
        const polys = coarse ? ct.coarse : ct.fine;
        const color = hi ? (ct === hi ? '#ff8c1a' : nb.has(ct.idx) ? '#ffd166' : '#ebe8e1') : this.colorFn(ct.data);
        fillPolys(t, polys, color);
        shown.push(polys);
      }
    }
    fillPolys(t, coarse ? this.lakesCoarse : this.lakes, WATER);
    for (const polys of shown) strokePolys(t, polys, BORDER, widthFor(t.level));
  }

  private drawBorders(t: TileView) {
    strokeLines(t, t.level <= COARSE_MAX_LEVEL ? this.borderCoarse : this.borderLines, 'rgba(255, 224, 110, 0.95)', widthFor(t.level, 1.25), 'rgba(0, 0, 0, 0.5)');
  }

  private drawVisited(t: TileView) {
    const visited = new Set(this.myMap.data.visited);
    if (!visited.size) return;
    const coarse = t.level <= COARSE_MAX_LEVEL;
    for (const ct of this.countries) {
      if (!visited.has(ct.data.n) || !t.visible(ct.bbox)) continue;
      fillPolys(t, coarse ? ct.coarse : ct.fine, 'rgba(34, 160, 70, 0.55)');
      strokePolys(t, coarse ? ct.coarse : ct.fine, 'rgba(10, 90, 30, 0.9)', widthFor(t.level, 1.4));
    }
  }

  private drawQuiz(t: TileView) {
    if (!this.quizPaint?.size) return;
    const coarse = t.level <= COARSE_MAX_LEVEL;
    for (const [idx, color] of this.quizPaint) {
      const ct = this.countries[idx];
      if (!ct || !t.visible(ct.bbox)) continue;
      fillPolys(t, coarse ? ct.coarse : ct.fine, color);
      strokePolys(t, coarse ? ct.coarse : ct.fine, '#ffffff', widthFor(t.level, 2.2));
    }
  }

  // ── Quiz (QuizHost) ───────────────────────────────────────────────────

  quizCountries(): QuizCountry[] {
    return this.countries.map((c) => ({ idx: c.idx, data: c.data, bbox: c.bbox }));
  }

  paint(colors: Map<number, string> | undefined) {
    this.quizPaint = colors && colors.size ? new Map(colors) : undefined;
    this.quizLayer.show = !!this.quizPaint;
    if (this.quizLayer.layer) this.quizLayer.layer.alpha = 1;
    this.quizLayer.redraw();
    this.order();
  }

  blink(dim: boolean) {
    if (this.quizLayer.layer) this.quizLayer.layer.alpha = dim ? 0.2 : 1;
  }

  flyToCountry(idx: number) {
    const ct = this.countries[idx];
    if (!ct) return;
    this.viewer.camera.flyTo({
      // nah genug, dass man das Land sieht, aber nicht zu weit draußen (große Länder wie Russland)
      destination: Cartesian3.fromDegrees(ct.data.l[0], ct.data.l[1], Math.min(7e6, Math.max(heightForBox(ct.bbox, this.scale) * 2.2, 2.2e6))),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      duration: 1.8,
    });
  }

  setQuizMode(on: boolean) {
    this.closeCard();
    this.setMeasuring(false);
    if (on) {
      this.quizSaved = { satellite: this.opt.satellite, year: this.opt.year };
      if (this.opt.satellite) void this.set('satellite', false);
      if (this.opt.year) void this.set('year', 0);
    } else if (this.quizSaved) {
      const s = this.quizSaved;
      this.quizSaved = undefined;
      if (s.satellite) void this.set('satellite', true);
      if (s.year) void this.set('year', s.year);
    }
    // Länder- und Stadtnamen verraten die Antwort
    this.labels.show('countries', !on && !this.opt.year);
    this.labels.show('history', !on && !!this.opt.year);
    this.labels.show('cities', !on);
    document.body.classList.toggle('quiz-mode', on);
  }

  private drawAdmin1(t: TileView) {
    if (!this.admin1) return;
    const sat = this.opt.satellite;
    strokeLines(t, t.level <= COARSE_MAX_LEVEL ? this.admin1.coarse : this.admin1.lines, sat ? 'rgba(255,255,255,0.8)' : 'rgba(70,70,80,0.7)', widthFor(t.level, 0.7), undefined, [4, 3]);
  }

  private hatch?: CanvasPattern;

  private drawDisputed(t: TileView) {
    if (!this.disputed.length) return;
    const g = t.g;
    if (!this.hatch) {
      const c = document.createElement('canvas');
      c.width = c.height = 8;
      const p = c.getContext('2d')!;
      p.strokeStyle = 'rgba(200, 30, 40, 0.55)';
      p.lineWidth = 2;
      p.beginPath();
      p.moveTo(0, 8);
      p.lineTo(8, 0);
      p.stroke();
      this.hatch = g.createPattern(c, 'repeat')!;
    }
    // Schraffur in Bildschirm-Pixeln (Muster nicht mitskalieren)
    this.hatch.setTransform(new DOMMatrix([1 / t.k, 0, 0, 1 / t.k, 0, 0]));
    for (const d of this.disputed) {
      if (!t.visible(d.bbox)) continue;
      g.fillStyle = this.hatch;
      for (const p of d.fine) if (t.visible(p.bbox)) g.fill(p.path, 'evenodd');
      g.setLineDash([5 / t.k, 3 / t.k]);
      strokePolys(t, d.fine, 'rgba(190, 20, 30, 0.9)', widthFor(t.level, 1));
      g.setLineDash([]);
    }
  }

  private drawRivers(t: TileView) {
    const coarse = t.level <= COARSE_MAX_LEVEL;
    for (const r of this.riverLines) {
      // kleine Flüsse erst beim Heranzoomen
      if (r.river.r > 6 && t.level < 5) continue;
      if (r.river.r > 3 && t.level < 3) continue;
      const lines = coarse && r.coarse.length ? r.coarse : r.fine;
      strokeLines(t, lines, this.opt.satellite ? '#7cc4ff' : '#3a7fd0', widthFor(t.level, r.river.r <= 3 ? 1.3 : 0.9));
    }
  }

  private drawGraticule(t: TileView) {
    const steps = [30, 30, 15, 10, 5, 5, 2, 1, 0.5, 0.25, 0.1, 0.05, 0.02, 0.01];
    const step = steps[Math.min(t.level, steps.length - 1)] * this.scale;
    const g = t.g;
    g.strokeStyle = this.opt.satellite ? 'rgba(255,255,255,0.45)' : 'rgba(40,60,90,0.35)';
    g.lineWidth = 1 / t.k;
    g.beginPath();
    for (let x = Math.ceil(t.w / step) * step; x <= t.e; x += step) {
      g.moveTo(x, -t.n);
      g.lineTo(x, -t.s);
    }
    for (let y = Math.ceil(t.s / step) * step; y <= t.n; y += step) {
      g.moveTo(t.w, -y);
      g.lineTo(t.e, -y);
    }
    g.stroke();
    // Gradzahlen am Kachelrand
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.font = '600 11px system-ui, sans-serif';
    g.fillStyle = this.opt.satellite ? '#fff' : '#22344f';
    const deg = (v: number, pos: string, neg: string) => `${fmt(Math.abs(v / this.scale), 2)}°${v === 0 ? '' : v > 0 ? pos : neg}`;
    for (let x = Math.ceil(t.w / step) * step; x <= t.e; x += step) g.fillText(deg(x, ' O', ' W'), (x - t.w) * t.k + 3, 12);
    for (let y = Math.ceil(t.s / step) * step; y <= t.n; y += step) g.fillText(deg(y, ' N', ' S'), 3, (t.n - y) * t.k - 3);
    g.restore();
  }

  // ── Zusatzdaten laden ───────────────────────────────────────────────────

  private async loadWater() {
    if (this.water) return;
    const w = await loadJson<WaterFile>('water.json');
    this.water = w;
    this.riverLines = w.rivers.map((river) => ({ river, fine: decodeLines(river.p), coarse: decodeLines(river.g) }));
    const o = this.opt;
    this.labels.set(
      'seas',
      w.seas.map((s) => ({
        pos: Cartesian3.fromDegrees(s[1], s[2]),
        text: s[0],
        size: s[3] === 'Ozean' ? 16 : s[4] <= 3 ? 14 : 12,
        italic: true,
        bold: s[3] === 'Ozean',
        fill: SEA_TEXT,
        outline: 'rgba(225, 238, 252, 0.9)',
        range: rangeForZoom(s[4], 1.5),
        prio: 8.5e11 - s[4] * 1e10,
        id: { kind: 'sea', item: s },
      })),
      o.seas,
    );
    this.labels.set(
      'lakes',
      w.lakes.map((l) => ({
        pos: Cartesian3.fromDegrees(l[1], l[2]),
        text: l[0],
        size: 11,
        italic: true,
        fill: SEA_TEXT,
        outline: 'rgba(225, 238, 252, 0.9)',
        range: rangeForZoom(l[3], 1.2),
        prio: 3e6 + l[5],
        id: { kind: 'lake', item: l },
      })),
      o.lakes,
    );
    this.labels.set(
      'rivers',
      w.rivers.map((r) => ({
        pos: Cartesian3.fromDegrees(r.l[0], r.l[1]),
        text: r.n,
        size: 11,
        italic: true,
        fill: '#1f5fae',
        outline: 'rgba(235, 244, 255, 0.9)',
        range: rangeForZoom(r.z, 1.3),
        prio: 2e6 - r.r * 1e5 + r.len,
        id: { kind: 'river', item: r },
      })),
      o.rivers,
    );
    const deeps: MarkerItem[] = [
      ...w.deeps.map((d) => ({
        lon: d[1],
        lat: d[2],
        name: `${d[0]}\n${fmt(d[3])} m`,
        icon: 'deep' as const,
        range: 9e6,
        prio: 4e11 - d[3],
        data: { info: d, countries: [] as string[], what: 'Tiefste Stelle im Meer' },
      })),
      ...this.lowestPoints.map(({ p, countries }) => ({
        lon: p[1],
        lat: p[2],
        name: `${p[0] ? `${p[0]}\n` : ''}${fmt(p[3], Math.abs(p[3]) < 10 ? 1 : 0)} m`,
        icon: 'deep' as const,
        range: p[3] < -50 ? 6e6 : 3e6,
        prio: 3e11 - p[3],
        data: { info: p, countries, what: 'Tiefster Punkt' },
      })),
    ];
    const m = this.marker('deeps', { fill: SEA_TEXT, size: 12, bold: true });
    m.setItems(deeps);
    m.show = o.deeps;
    this.riverLayer.redraw();
  }

  private async loadAdmin1() {
    if (this.admin1) return;
    const a = await loadJson<Admin1File>('admin1.json');
    this.admin1 = { lines: decodeLines(a.lines), coarse: decodeLines(a.coarse) };
    this.labels.set(
      'admin1',
      a.labels.map((l) => ({
        pos: Cartesian3.fromDegrees(l[1], l[2]),
        text: l[0],
        size: 11,
        fill: '#4a4550',
        range: rangeForZoom(l[5], 1.8),
        prio: 1e8 - l[5] * 1e7,
        id: { kind: 'admin1', item: l },
      })),
      this.opt.admin1,
    );
    this.admin1Layer.redraw();
  }

  private async loadDisputed() {
    if (this.disputed.length) return;
    const d = await loadJson<DisputedFile>('disputed.json');
    this.disputed = d.areas.map((a) => {
      const fine = decodePolys(a.p);
      return { n: a.n, note: a.note, w: a.w, fine, bbox: unionBox(fine) };
    });
    this.labels.set(
      'disputed',
      d.areas.map((a, i) => ({
        pos: Cartesian3.fromDegrees(a.l[0], a.l[1]),
        text: a.n,
        size: 11,
        italic: true,
        fill: '#9b1020',
        range: rangeForZoom(a.z, 1.2),
        prio: 1.2e8,
        id: { kind: 'disputed', item: this.disputed[i] },
      })),
      this.opt.disputed,
    );
    this.disputedLayer.redraw();
  }

  private placesLoading?: Promise<void>;

  async loadPlaces() {
    if (this.places) return;
    this.placesLoading ??= (async () => {
      const p = await loadJson<PlacesFile>('places.json');
      this.places = p;
      this.buildPlaces(p);
      this.onState?.();
    })();
    await this.placesLoading;
  }

  private buildPlaces(p: PlacesFile) {
    const o = this.opt;
    const add = (key: keyof Options | 'summits' | 'canals', style: ConstructorParameters<typeof MarkerLayer>[3], items: MarkerItem[], show: boolean) => {
      const m = this.marker(key, style);
      m.setItems(items);
      m.show = show;
    };
    add('wonders', { fill: '#7a5208', bold: true, iconSize: 22 }, p.wonders.map((w) => ({ lon: w[1], lat: w[2], name: w[0], icon: 'wonder', range: 9e6, prio: 6e11, data: w })), o.wonders);
    add('buildings', { fill: '#33404d', bold: true }, p.buildings.map((b) => ({ lon: b[1], lat: b[2], name: b[0], icon: 'building', range: 2.5e6, prio: 3e7, data: b })), o.buildings);
    add('unesco', { fill: '#164f86', size: 11 }, p.unesco.map((u) => ({ lon: u[1], lat: u[2], name: u[0], icon: 'unesco', range: 9e5, prio: 2e5, iconRange: 9e6, data: u })), o.unesco);
    add(
      'volcanoes',
      { fill: '#7a2410', size: 11 },
      p.volcanoes.map((v) => ({ lon: v[1], lat: v[2], name: v[0], icon: v[5] !== null && v[5] >= 1900 ? 'volcanoActive' : 'volcano', range: 1.2e6, prio: 1e5 + v[4], iconRange: 1.4e7, data: v })),
      o.volcanoes,
    );
    add('parks', { fill: '#1f6b2a', size: 11 }, p.parks.map((n) => ({ lon: n[1], lat: n[2], name: n[0], icon: 'park', range: 1.4e6, prio: 1.5e5 + n[5] * 1000, iconRange: 9e6, data: n })), o.parks);
    add('summits', { fill: '#3e2a66', bold: true }, p.summits.map((s) => ({ lon: s[1], lat: s[2], name: `${s[0]}\n${fmt(s[3])} m`, icon: 'summit', range: 1e7, prio: 5.5e11, data: s })), o.ranges);
    add('waterfalls', { fill: '#145a8f', size: 11 }, p.waterfalls.map((w) => ({ lon: w[1], lat: w[2], name: w[0], icon: 'waterfall', range: 2.5e6, prio: 2e7, data: w })), o.waterfalls);
    add('extremes', { fill: '#4b2f73', bold: true, size: 11 }, p.extremes.map((e) => ({ lon: e[1], lat: e[2], name: e[0], icon: 'extreme', range: 8e6, prio: 4.5e11, data: e })), o.extremes);
    add('airports', { fill: '#2c3e50', bold: true, size: 11 }, p.airports.map((a) => ({ lon: a[1], lat: a[2], name: a[3], icon: 'airport', range: 1.5e6, prio: 1e5, iconRange: 6e6, data: a })), o.airports);
    add('ports', { fill: '#123d5c', size: 11 }, p.ports.map((h) => ({ lon: h[1], lat: h[2], name: h[0], icon: 'port', range: 9e5, prio: 5e4 - h[3], iconRange: 5e6, data: h })), o.ports);
    add('canals', { fill: '#0d6466', bold: true, size: 11 }, p.canals.map((c) => ({ lon: c[1], lat: c[2], name: c[0], icon: 'canal', range: 4e6, prio: 3e7, data: c })), o.ports);
    const region = (kind: string, color: string, items: PlacesFile['deserts']): LabelItem[] =>
      items.map((r) => ({
        pos: Cartesian3.fromDegrees(r[1], r[2]),
        text: r[0],
        size: r[3] <= 3 ? 13 : 11,
        italic: true,
        bold: r[3] <= 3,
        fill: color,
        range: rangeForZoom(r[3], 1.4),
        prio: 1.1e8 - r[3] * 1e6,
        id: { kind, item: r },
      }));
    this.labels.set('deserts', region('desert', '#8a5a12', p.deserts), o.deserts);
    this.labels.set('ranges', region('range', '#5e3d22', p.ranges), o.ranges);
    this.buildGeoLines();
  }

  private buildGeoLines() {
    this.lines.entities.removeAll();
    if (!this.opt.geolines || !this.places) return;
    const colors: Record<string, string> = { Äquator: '#e0453a', Datumsgrenze: '#8e44ad' };
    const items: LabelItem[] = [];
    for (const l of this.places.geolines) {
      const c = Color.fromCssColorString(colors[l.n] ?? (l.n.includes('Wendekreis') ? '#e69a1c' : '#3d8bd9'));
      this.lines.entities.add({
        polyline: {
          positions: l.p.map(([x, y]) => Cartesian3.fromDegrees(x, y)),
          width: 2.5,
          arcType: l.k === 'Date line' ? ArcType.GEODESIC : ArcType.RHUMB,
          material: new PolylineDashMaterialProperty({ color: c, dashLength: 18 }),
          clampToGround: true,
        },
      });
      const step = Math.max(1, Math.floor(l.p.length / 6));
      for (let i = Math.floor(step / 2); i < l.p.length; i += step) {
        items.push({
          pos: Cartesian3.fromDegrees(l.p[i][0], l.p[i][1]),
          text: l.n,
          size: 12,
          bold: true,
          fill: colors[l.n] ?? (l.n.includes('Wendekreis') ? '#9a5d00' : '#1d5c9e'),
          range: 3e7,
          prio: 9.5e11,
          offset: -4,
          id: { kind: 'geoline', item: l },
        });
      }
    }
    this.labels.set('geolines', items, this.opt.geolines);
  }

  // ── Erdbeben (USGS, live, erst beim Einschalten) ──────────────────────

  private async loadQuakes() {
    const r = await fetch('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson');
    const j = (await r.json()) as {
      features: { id: string; properties: { mag: number; place: string; time: number; url: string; tsunami: number }; geometry: { coordinates: [number, number, number] } }[];
    };
    this.quakePoints.removeAll();
    const now = Date.now();
    const items: LabelItem[] = [];
    for (const f of j.features) {
      const [lon, lat, depth] = f.geometry.coordinates;
      const p = f.properties;
      const ageH = (now - p.time) / 3600e3;
      const pos = Cartesian3.fromDegrees(lon, lat);
      const data = { ...p, depth, lon, lat };
      this.quakePoints.add({
        position: pos,
        pixelSize: 4 + Math.max(0, p.mag - 2.5) * 4,
        color: Color.fromCssColorString(ageH < 24 ? '#e6262b' : ageH < 72 ? '#ff8c1a' : '#ffd23f').withAlpha(0.85),
        outlineColor: Color.fromCssColorString('#5a0f0f'),
        outlineWidth: 1,
        id: { kind: 'quake', item: data },
      });
      if (p.mag >= 5) {
        items.push({ pos, text: `M ${fmt(p.mag, 1)}`, size: 11, bold: true, fill: '#7a1010', range: 1.4e7, prio: 2e11 + p.mag, offset: -8, id: { kind: 'quake', item: data } });
      }
    }
    this.labels.set('quakes', items, this.opt.quakes);
  }

  private startQuakes() {
    this.quakePoints.show = true;
    this.labels.show('quakes', true);
    const run = () => this.loadQuakes().catch((e) => console.warn('Erdbeben konnten nicht geladen werden', e));
    void run();
    window.clearInterval(this.quakeTimer);
    this.quakeTimer = window.setInterval(run, 10 * 60e3);
  }

  private stopQuakes() {
    window.clearInterval(this.quakeTimer);
    this.quakeTimer = undefined;
    this.quakePoints.show = false;
    this.labels.show('quakes', false);
  }

  // ── Meine Karte ───────────────────────────────────────────────────────

  private updateOwnPlaces() {
    const m = this.marker('own', { fill: '#a01e52', bold: true });
    m.setItems(this.myMap.data.places.map((p) => ({ lon: p.lon, lat: p.lat, name: p.name, icon: 'own', range: 3e7, prio: 8e11, data: p })));
    m.show = this.active && this.opt.own;
  }

  startAddPlace() {
    this.addingPlace = true;
    this.setMeasuring(false);
    this.viewer.canvas.style.cursor = 'crosshair';
    this.hint.textContent = 'Klicke auf die Karte, wo der neue Ort hin soll';
    if (!this.opt.own) void this.set('own', true);
  }

  // ── Anklicken ─────────────────────────────────────────────────────────

  private pickedId(pos: Cartesian2) {
    return (this.viewer.scene.pick(pos) as { id?: Record<string, unknown> } | undefined)?.id;
  }

  private async click(pos: Cartesian2) {
    const id = this.pickedId(pos);
    const ray = this.viewer.camera.getPickRay(pos);
    const hit = ray && this.viewer.scene.globe.pick(ray, this.viewer.scene);
    const carto = hit ? Cartographic.fromCartesian(hit) : undefined;

    if (this.dragOutline?.moving) {
      this.dragOutline.moving = false;
      this.hint.textContent = '';
      return;
    }
    if (this.addingPlace) {
      this.addingPlace = false;
      this.viewer.canvas.style.cursor = '';
      this.hint.textContent = '';
      if (carto) this.editPlace({ id: '', name: '', note: '', lon: CesiumMath.toDegrees(carto.longitude), lat: CesiumMath.toDegrees(carto.latitude) });
      return;
    }

    if (this.quiz.active) {
      const ct = carto ? this.countryAt(CesiumMath.toDegrees(carto.longitude) * this.scale, CesiumMath.toDegrees(carto.latitude) * this.scale) : undefined;
      this.quiz.answer(ct?.idx, ct?.data.n);
      return;
    }
    const row = id?.city as CityRow | undefined;
    if (row) {
      if (this.measuring) this.addMeasurePoint({ pos: Cartographic.fromDegrees(row[4], row[3]), name: row[0] });
      this.showCity(row);
      return;
    }
    if (id && typeof id.kind === 'string') {
      const where = this.idPosition(id);
      if (this.measuring && where) this.addMeasurePoint(where);
      if (this.showById(id.kind, id.item, id.country as Country | undefined)) return;
    }
    if (!carto) return;
    const lon = CesiumMath.toDegrees(carto.longitude);
    const lat = CesiumMath.toDegrees(carto.latitude);
    const x = lon * this.scale;
    const y = lat * this.scale;
    const country = this.countryAt(x, y);
    if (this.measuring) {
      this.addMeasurePoint({ pos: carto, name: country ? `Punkt in ${country.data.n}` : 'Punkt im Meer' });
      return;
    }
    // Flüsse: nächster Fluss im Umkreis von ~8 Pixeln
    if (this.opt.rivers && this.riverLines.length) {
      const tol = this.metersPerPixel() * 8 / 111e3 * this.scale;
      let best: { r: River; d: number } | undefined;
      for (const rl of this.riverLines) {
        for (const l of rl.fine) {
          if (!inBox(l.bbox, x, y, tol)) continue;
          const d = distToLine(l.pts, x, y);
          if (d < tol && (!best || d < best.d)) best = { r: rl.river, d };
        }
      }
      if (best) return this.showRiver(best.r);
    }
    if (this.opt.disputed) {
      const d = this.disputed.find((a) => inBox(a.bbox, x, y) && insidePolys(a.fine, x, y));
      if (d) return this.showDisputed(d);
    }
    if (this.opt.year && this.history) {
      const h = this.history.countries.find((c) => inBox(c.bbox, x, y) && insidePolys(c.fine, x, y));
      if (h) return this.showHistory(h);
      return this.closeCard();
    }
    if (country) return this.countryClicked(country);
    if (this.highlight) {
      this.highlight = undefined;
      this.base.redraw();
    }
    this.closeCard();
  }

  private idPosition(id: Record<string, unknown>): MeasurePoint | undefined {
    const it = id.item as unknown[] | { lon?: number; lat?: number; info?: PointInfo; l?: [number, number]; n?: string } | undefined;
    if (Array.isArray(it) && typeof it[1] === 'number' && typeof it[2] === 'number') return { pos: Cartographic.fromDegrees(it[1], it[2]), name: String(it[0]) };
    if (it && !Array.isArray(it)) {
      if (it.info) return { pos: Cartographic.fromDegrees(it.info[1], it.info[2]), name: it.info[0] || 'Punkt' };
      if (typeof it.lon === 'number' && typeof it.lat === 'number') return { pos: Cartographic.fromDegrees(it.lon, it.lat), name: (it as { name?: string }).name ?? 'Ort' };
      if (it.l) return { pos: Cartographic.fromDegrees(it.l[0], it.l[1]), name: it.n ?? 'Ort' };
    }
    return undefined;
  }

  private metersPerPixel() {
    const h = this.viewer.camera.positionCartographic.height;
    return (h * 1.15) / this.viewer.scene.canvas.clientHeight;
  }

  private countryAt(x: number, y: number) {
    return this.countries.find((ct) => inBox(ct.bbox, x, y) && insidePolys(ct.fine, x, y));
  }

  private countryClicked(ct: Country) {
    if (this.compareFirst && this.compareFirst !== ct) {
      const a = this.compareFirst;
      this.compareFirst = undefined;
      this.hint.textContent = '';
      return this.showCompare(a, ct);
    }
    if (this.opt.neighbors) {
      this.highlight = ct;
      this.base.redraw();
    }
    this.showCountry(ct);
  }

  /** Steckbrief zu einem angeklickten Symbol oder Namen; false = nichts Passendes */
  private showById(kind: string, item: unknown, country?: Country): boolean {
    const p = this.places;
    switch (kind) {
      case 'country':
        if (country) this.countryClicked(country);
        return true;
      case 'peaks':
      case 'deeps': {
        const d = item as { info: PointInfo; countries: string[]; what: string };
        const [name, lon, lat, elev, wiki] = d.info;
        const of = d.countries.length ? ` von ${d.countries.join(' und ')}` : '';
        this.openCard(
          `<h3><span class="peak-ico">${elev < 0 || kind === 'deeps' ? '▼' : '▲'}</span> ${escapeHtml(name || d.what)}</h3>
           <div class="sub">${d.what}${of}</div>
           <div class="pop"><span class="big">${fmt(Math.abs(elev), Math.abs(elev) < 10 ? 1 : 0)} m</span> ${elev < 0 ? 'unter' : 'über'} dem Meeresspiegel</div>
           <div class="muted small">Daten: Wikidata</div>`,
          wikiLink(wiki, `${name || d.what} ${d.countries[0] ?? ''}`),
          { pos: Cartographic.fromDegrees(lon, lat), name: name || d.what },
        );
        return true;
      }
      case 'sea': {
        const s = item as WaterFile['seas'][number];
        this.openCard(
          `<h3>${escapeHtml(s[0])}</h3><div class="sub">${s[3]}</div>
           <table>${s[6] ? `<tr><th>Fläche</th><td>${sqkm(s[6])}</td></tr>` : ''}${s[7] ? `<tr><th>Größte Tiefe</th><td>${fmt(s[7])} m</td></tr>` : ''}</table>`,
          wikiLink(s[5], s[0]),
          { pos: Cartographic.fromDegrees(s[1], s[2]), name: s[0] },
        );
        return true;
      }
      case 'lake': {
        const l = item as WaterFile['lakes'][number];
        this.openCard(
          `<h3>${escapeHtml(l[0])}</h3><div class="sub">See</div>
           <table>${l[5] ? `<tr><th>Fläche</th><td>${sqkm(l[5])}</td></tr>` : ''}${l[6] ? `<tr><th>Größte Tiefe</th><td>${fmt(l[6])} m</td></tr>` : ''}</table>`,
          wikiLink(l[4], `${l[0]} See`),
          { pos: Cartographic.fromDegrees(l[1], l[2]), name: l[0] },
        );
        return true;
      }
      case 'river':
        this.showRiver(item as River);
        return true;
      case 'admin1': {
        const a = item as Admin1File['labels'][number];
        const cn = this.cityData!.countries[a[3]]?.[0] ?? '';
        this.openCard(`<h3>${escapeHtml(a[0])}</h3><div class="sub">${escapeHtml(a[4])}${cn ? ` · ${escapeHtml(cn)}` : ''}</div>`, wikiLink(a[6], `${a[0]} ${cn}`), {
          pos: Cartographic.fromDegrees(a[1], a[2]),
          name: a[0],
        });
        return true;
      }
      case 'disputed':
        this.showDisputed(item as (typeof this.disputed)[number]);
        return true;
      case 'hist':
        this.showHistory(item as HistCountry);
        return true;
      case 'geoline': {
        const l = item as PlacesFile['geolines'][number];
        const info: Record<string, string> = {
          Äquator: 'Teilt die Erde in Nord- und Südhalbkugel. Länge: 40.075 km.',
          'nördlicher Wendekreis': 'Am 21. Juni steht die Sonne hier mittags genau senkrecht (23,44° N).',
          'südlicher Wendekreis': 'Am 21. Dezember steht die Sonne hier mittags genau senkrecht (23,44° S).',
          'nördlicher Polarkreis': 'Nördlich davon geht die Sonne im Sommer mindestens einen Tag gar nicht unter (66,56° N).',
          'südlicher Polarkreis': 'Südlich davon geht die Sonne im Dezember mindestens einen Tag gar nicht unter (66,56° S).',
          Datumsgrenze: 'Wer sie nach Westen überquert, springt einen Tag weiter; nach Osten einen Tag zurück.',
        };
        this.openCard(`<h3>${escapeHtml(l.n)}</h3><p>${info[l.n] ?? ''}</p>`, wikiLink('', l.n));
        return true;
      }
      case 'quake': {
        const q = item as { mag: number; place: string; time: number; url: string; tsunami: number; depth: number; lon: number; lat: number };
        this.openCard(
          `<h3>Erdbeben M ${fmt(q.mag, 1)}</h3><div class="sub">${escapeHtml(q.place)}</div>
           <table><tr><th>Zeit</th><td>${new Date(q.time).toLocaleString('de-DE')}</td></tr>
           <tr><th>Tiefe</th><td>${fmt(q.depth)} km</td></tr>${q.tsunami ? '<tr><th>Tsunami</th><td>Warnung ausgegeben</td></tr>' : ''}</table>
           <div class="muted small">Daten: USGS, letzte 7 Tage ab Stärke 2,5</div>`,
          q.url,
          { pos: Cartographic.fromDegrees(q.lon, q.lat), name: `Erdbeben M ${fmt(q.mag, 1)}` },
          'USGS',
        );
        return true;
      }
      case 'own':
        this.showOwnPlace(item as OwnPlace);
        return true;
    }
    if (!p) return false;
    const arr = item as (string | number | null)[];
    const pos = { pos: Cartographic.fromDegrees(arr[1] as number, arr[2] as number), name: String(arr[0]) };
    const card = (sub: string, rows: string, wiki: string, search = String(arr[0]), label?: string) =>
      this.openCard(`<h3>${escapeHtml(String(arr[0]))}</h3><div class="sub">${sub}</div>${rows ? `<table>${rows}</table>` : ''}`, wikiLink(wiki, search), pos, label);
    const row = (k: string, v: string) => `<tr><th>${k}</th><td>${v}</td></tr>`;
    switch (kind) {
      case 'wonders':
        card(String(arr[3]), '', String(arr[4]));
        return true;
      case 'buildings':
        card('Berühmtes Bauwerk', arr[3] ? row('Höhe', `${fmt(arr[3] as number)} m`) : '', String(arr[4]));
        return true;
      case 'waterfalls':
        card('Wasserfall', arr[3] ? row('Fallhöhe', `${fmt(arr[3] as number)} m`) : '', String(arr[4]));
        return true;
      case 'summits':
        card('Seven Summits – höchster Berg eines Kontinents', row('Höhe', `${fmt(arr[3] as number)} m`), String(arr[4]));
        return true;
      case 'canals':
        card('Kanal', arr[3] ? row('Länge', km(arr[3] as number)) : '', String(arr[4]));
        return true;
      case 'extremes':
        card(String(arr[3]), '', String(arr[4]));
        return true;
      case 'unesco':
        card(`UNESCO-Welterbe${arr[3] ? ` · ${escapeHtml(String(arr[3]))}` : ''}`, '', String(arr[4]));
        return true;
      case 'parks':
        card('Nationalpark', arr[3] ? row('Fläche', sqkm(arr[3] as number)) : '', String(arr[4]));
        return true;
      case 'volcanoes': {
        const last = arr[5] as number | null;
        const lastText = last === null ? 'unbekannt' : last < 0 ? `${fmt(-last)} v. Chr.` : String(last);
        this.openCard(
          `<h3>${escapeHtml(String(arr[0]))}</h3><div class="sub">${escapeHtml(String(arr[3]))} · ${escapeHtml(String(arr[6]))}</div>
           <table>${row('Höhe', `${fmt(arr[4] as number)} m`)}${row('Letzter Ausbruch', lastText)}</table>
           <div class="muted small">Daten: Smithsonian Global Volcanism Program · <a href="https://volcano.si.edu/volcano.cfm?vn=${arr[7]}" target="_blank" rel="noopener">Seite des Vulkans</a></div>`,
          wikiLink('', `${arr[0]} Vulkan`),
          pos,
        );
        return true;
      }
      case 'airports':
        card(`Flughafen ${escapeHtml(String(arr[3]))}`, row('Stadt', escapeHtml(String(arr[4]))) + row('Land', escapeHtml(this.cityData!.countries[String(arr[5])]?.[0] ?? String(arr[5]))), String(arr[6]));
        return true;
      case 'ports':
        card('Hafen', '', '', `Hafen ${arr[0]}`);
        return true;
      case 'desert':
      case 'range':
        card(kind === 'desert' ? 'Wüste' : 'Gebirge', arr[5] ? row('Fläche', sqkm(arr[5] as number)) : '', String(arr[4]));
        return true;
    }
    return false;
  }

  private showRiver(r: River) {
    this.openCard(
      `<h3>${escapeHtml(r.n)}</h3><div class="sub">Fluss</div>${r.len ? `<div class="pop"><span class="big">${fmt(r.len)} km</span> lang</div>` : ''}`,
      wikiLink(r.w, `${r.n} Fluss`),
      { pos: Cartographic.fromDegrees(r.l[0], r.l[1]), name: r.n },
    );
  }

  private showDisputed(d: (typeof this.disputed)[number]) {
    this.openCard(`<h3>${escapeHtml(d.n)}</h3><div class="sub">Umstrittenes Gebiet</div>${d.note ? `<p>${escapeHtml(d.note)}</p>` : ''}`, wikiLink(d.w, d.n));
  }

  private showHistory(h: HistCountry) {
    this.openCard(
      `<h3>${escapeHtml(h.n)}</h3><div class="sub">Grenzen von ${this.opt.year} (ungefähr)</div>${h.s ? `<p>Gehörte zu: <b>${escapeHtml(h.s)}</b></p>` : ''}`,
      wikiLink('', h.n),
    );
  }

  // ── Steckbriefe ───────────────────────────────────────────────────────

  private showCity(row: CityRow) {
    const d = this.cityData!;
    const [name, cc, pop, lat, lon, rc, rk, rw, cap, wiki, elev, agglo, adminPop, tzi] = row;
    const tz = d.timezones[tzi];
    const [country, cont] = d.countries[cc] ?? [cc, ''];
    const contName = d.continents[cont] ?? '';
    const ranks = rw
      ? `<table>
          <tr><th>In ${escapeHtml(country)}</th><td>Platz <b>${fmt(rc)}</b> <span class="muted">von ${fmt(d.countries[cc]?.[2] ?? 0)}</span></td></tr>
          ${contName ? `<tr><th>In ${contName}</th><td>Platz <b>${fmt(rk)}</b> <span class="muted">von ${fmt(d.continentCount[cont] ?? 0)}</span></td></tr>` : ''}
          <tr><th>Auf der Welt</th><td>Platz <b>${fmt(rw)}</b> <span class="muted">von ${fmt(d.worldCount)}</span></td></tr>
        </table>
        <div class="muted small">Rang nach Einwohnern unter allen Orten ab 1.000 Einwohnern · Daten: GeoNames</div>`
      : '';
    const sunId = `sun-${Math.random().toString(36).slice(2)}`;
    this.openCard(
      `<h3>${cap ? `<span class="cap-mark${isMainCapital(cap) ? '' : ' seat'}"></span>` : ''}${escapeHtml(name)}</h3>
       <div class="sub">${cap ? `<b>${escapeHtml(cap)}</b> · ` : ''}${escapeHtml(country)}${contName ? ` · ${contName}` : ''}</div>
       <div class="pop"><span class="big">${fmt(pop)}</span> Einwohner${adminPop ? ' <span class="muted">(Ballungsraum)</span>' : ''}</div>
       <table>
         ${elev !== null ? `<tr><th>Höhe</th><td><b>${fmt(Math.abs(elev))} m</b> ${elev < 0 ? 'unter' : 'über'} dem Meer</td></tr>` : ''}
         ${agglo && !adminPop && agglo > pop * 1.15 ? `<tr><th>Großraum</th><td>ca. ${fmt(agglo)} <span class="muted">(UN 2025)</span></td></tr>` : ''}
         ${adminPop ? `<tr><th>Verwaltungsgebiet</th><td>${fmt(adminPop)} <span class="muted">(Stadt mit Umland)</span></td></tr>` : ''}
         ${tz ? `<tr><th>Ortszeit</th><td><b>${timeIn(new Date(), tz)}</b> <span class="muted">${escapeHtml(tz.replace(/_/g, ' '))}</span></td></tr>` : ''}
       </table>
       <div class="sun" id="${sunId}"></div>
       <div class="weather"></div>
       ${ranks}`,
      wikiLink(wiki, `${name} ${country}`),
      { pos: Cartographic.fromDegrees(lon, lat), name },
    );
    this.renderSun(this.card.querySelector<HTMLElement>(`#${sunId}`)!, lat, lon, tz);
    if (this.opt.weather) void this.renderWeather(lat, lon);
  }

  /** Sonnenauf-/-untergang mit wählbarem Datum */
  private renderSun(el: HTMLElement, lat: number, lon: number, tz?: string) {
    const input = document.createElement('input');
    input.type = 'date';
    input.value = todayIn(tz);
    input.title = 'Tag auswählen';
    const out = document.createElement('div');
    const update = () => {
      if (!input.value) return;
      const t = sunTimes(input.value, lat, lon);
      out.innerHTML = t.polar
        ? `<b>${t.polar}</b> – die Sonne ${t.polar === 'Polartag' ? 'geht den ganzen Tag nicht unter' : 'geht den ganzen Tag nicht auf'}`
        : `<span title="Sonnenaufgang">☀↑ <b>${timeIn(t.rise, tz)}</b></span> · <span title="Sonnenuntergang">☀↓ <b>${timeIn(t.set, tz)}</b></span> · Tag: ${dayLength(t)}`;
    };
    input.addEventListener('change', update);
    const head = document.createElement('div');
    head.className = 'sun-head';
    head.append('Sonne am ', input);
    el.append(head, out);
    update();
  }

  private async renderWeather(lat: number, lon: number) {
    const el = this.card.querySelector<HTMLElement>('.weather');
    if (!el) return;
    el.textContent = 'Wetter wird geladen …';
    try {
      const w = await fetchWeather(lat, lon);
      el.innerHTML = `Wetter jetzt: <b>${fmt(w.temp, 1)} °C</b>, ${w.text}, Wind ${fmt(w.wind)} km/h <span class="muted small">(Open-Meteo)</span>`;
    } catch {
      el.textContent = 'Wetter gerade nicht abrufbar.';
    }
  }

  private memberships(iso: string) {
    return Object.values(ALLIANCES)
      .filter((a) => a.members.split(' ').includes(iso))
      .map((a) => a.name);
  }

  private showCountry(ct: Country) {
    const c = ct.data;
    const d = this.cityData!;
    const x = c.x;
    const caps = d.cities.filter((r) => r[1] === c.i && r[8]);
    const biggest = d.cities.find((r) => r[1] === c.i);
    const row = (k: string, v: string) => (v ? `<tr><th>${k}</th><td>${v}</td></tr>` : '');
    const point = (p: PointInfo | null | undefined) => (p ? `${p[0] ? `${escapeHtml(p[0])}, ` : ''}${fmt(p[3], Math.abs(p[3]) < 10 ? 1 : 0)} m` : '');
    const nb = c.nb.map((i) => this.countries[i].data.n);
    const member = c.i ? this.memberships(c.i) : [];
    const rows = [
      row('Einwohner', c.e ? `ca. ${fmt(Math.round(c.e / 1000) * 1000)}` : ''),
      row('Fläche', x.area ? sqkm(x.area) : ''),
      row('Einwohner pro km²', x.area && c.e ? fmt(c.e / x.area, c.e / x.area < 10 ? 1 : 0) : ''),
      row(caps.length > 1 ? 'Hauptstädte' : 'Hauptstadt', caps.map((r) => (caps.length > 1 ? `${escapeHtml(r[0])} <span class="muted">(${escapeHtml(r[8])})</span>` : escapeHtml(r[0]))).join('<br>')),
      biggest && !caps.includes(biggest) ? row('Größte Stadt', escapeHtml(biggest[0])) : '',
      row(x.lang && x.lang.length > 1 ? 'Sprachen' : 'Sprache', (x.lang ?? []).map(escapeHtml).join(', ')),
      row('Währung', (x.cur ?? []).map(escapeHtml).join(', ')),
      row('Telefon-Vorwahl', x.tel ? escapeHtml(x.tel) : ''),
      row('Autokennzeichen', x.kfz ? `<span class="kfz">${escapeHtml(x.kfz)}</span>` : ''),
      row('Straßenverkehr', x.drive ? (x.drive === 'links' ? 'Linksverkehr' : 'Rechtsverkehr') : ''),
      row('Höchster Punkt', point(c.h)),
      row('Tiefster Punkt', point(x.lo)),
      row(`Nachbarländer (${nb.length})`, nb.length ? nb.map(escapeHtml).join(', ') : c.k === 'Ozeane' ? '' : 'keine – nur Meer'),
      row('Mitglied in', member.join(', ')),
      x.anthem ? row('Nationalhymne', '<span class="anthem-slot"></span>') : '',
    ].join('');
    const flag = c.i ? `<img class="flag" src="./flags/${c.i.toLowerCase()}.svg" alt="Flagge" onerror="this.remove()">` : '';
    const link = c.q ? `https://www.wikidata.org/wiki/Special:GoToLinkedPage/dewiki/${c.q}` : wikiLink('', c.n);
    this.openCard(`${flag}<h3>${escapeHtml(c.n)}</h3><div class="sub">${escapeHtml(c.k)}</div><table>${rows}</table>`, link, undefined, undefined, [
      this.cardButton('swap', 'Vergleichen', 'Mit einem anderen Land vergleichen: danach das zweite Land anklicken', () => {
        this.compareFirst = ct;
        this.hint.textContent = `${c.n} vergleichen mit … (zweites Land anklicken)`;
        this.closeCard();
      }),
      this.cardButton('expand', 'Größe', 'Umriss verschieben und die echte Größe vergleichen (Klick legt ihn ab)', () => this.startSizeCompare(ct)),
      ...(this.opt.visited ? [this.visitedToggle(c.n)] : []),
    ]);
    if (x.anthem) this.anthemPlayer(this.card.querySelector<HTMLElement>('.anthem-slot')!, x.anthem);
  }

  private audio?: HTMLAudioElement;

  /** Nationalhymne abspielen (Aufnahme von Wikimedia Commons, erst beim Klick geladen) */
  private anthemPlayer(slot: HTMLElement, [name, mp3, ogg, wiki]: [string, string, string, string]) {
    const b = document.createElement('button');
    b.className = 'icon-btn anthem-btn';
    b.title = 'Nationalhymne abspielen';
    const label = document.createElement('span');
    const setPlaying = (on: boolean) => {
      b.replaceChildren(icon(on ? 'pause' : 'play', 16), label);
      label.textContent = on ? 'Anhalten' : 'Abspielen';
      b.classList.toggle('active', on);
    };
    setPlaying(false);
    let failed = false;
    const fail = () => {
      failed = true;
      label.textContent = 'bei Wikimedia anhören';
    };
    b.addEventListener('click', () => {
      // Rückfall: Aufnahme direkt bei Wikimedia öffnen (Browser spielt sie selbst ab)
      if (failed) {
        window.open(ogg, '_blank', 'noopener');
        return;
      }
      if (this.audio && !this.audio.paused) {
        this.audio.pause();
        setPlaying(false);
        return;
      }
      if (!this.audio || this.audio.dataset.src !== mp3) {
        this.stopAudio();
        const a = document.createElement('audio');
        a.dataset.src = mp3;
        a.preload = 'auto';
        for (const [src, type] of [
          [mp3, 'audio/mpeg'],
          [ogg, 'audio/ogg'],
        ]) {
          const s = document.createElement('source');
          s.src = src;
          s.type = type;
          a.append(s);
        }
        a.addEventListener('ended', () => setPlaying(false));
        a.addEventListener('error', fail, true);
        this.audio = a;
      }
      void this.audio.play().then(
        () => setPlaying(true),
        fail,
      );
    });
    const title = document.createElement('a');
    title.href = wikiLink(wiki, name);
    title.target = '_blank';
    title.rel = 'noopener';
    title.textContent = name || 'Wikipedia';
    slot.append(title, document.createElement('br'), b);
  }

  private stopAudio() {
    this.audio?.pause();
    this.audio = undefined;
  }

  private visitedToggle(name: string) {
    const label = document.createElement('label');
    label.className = 'row visited-toggle';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = this.myMap.isVisited(name);
    input.addEventListener('change', () => this.myMap.setVisited(name, input.checked));
    label.append(input, 'War ich schon');
    return label;
  }

  private showCompare(a: Country, b: Country) {
    const rows: [string, (c: CountryData) => string, (c: CountryData) => number | undefined][] = [
      ['Einwohner', (c) => (c.e ? fmt(c.e) : '–'), (c) => c.e],
      ['Fläche', (c) => (c.x.area ? sqkm(c.x.area) : '–'), (c) => c.x.area],
      ['Einwohner pro km²', (c) => (c.x.area ? fmt(c.e / c.x.area, 1) : '–'), (c) => (c.x.area ? c.e / c.x.area : undefined)],
      ['Höchster Punkt', (c) => (c.h ? `${fmt(c.h[3])} m` : '–'), (c) => c.h?.[3]],
      ['Nachbarländer', (c) => String(c.nb.length), (c) => c.nb.length],
      ['Sprache', (c) => escapeHtml(c.x.lang?.[0] ?? '–'), () => undefined],
      ['Währung', (c) => escapeHtml(c.x.cur?.[0] ?? '–'), () => undefined],
      ['Straßenverkehr', (c) => (c.x.drive ? (c.x.drive === 'links' ? 'links' : 'rechts') : '–'), () => undefined],
    ];
    const flag = (c: CountryData) => (c.i ? `<img class="flag small" src="./flags/${c.i.toLowerCase()}.svg" alt="" onerror="this.remove()">` : '');
    const body = rows
      .map(([k, f, v]) => {
        const va = v(a.data);
        const vb = v(b.data);
        const win = va !== undefined && vb !== undefined && va !== vb ? (va > vb ? 0 : 1) : -1;
        return `<tr><th>${k}</th><td class="${win === 0 ? 'win' : ''}">${f(a.data)}</td><td class="${win === 1 ? 'win' : ''}">${f(b.data)}</td></tr>`;
      })
      .join('');
    const ratio = a.data.x.area && b.data.x.area ? a.data.x.area / b.data.x.area : 0;
    const ratioText = ratio ? (ratio >= 1 ? `${a.data.n} ist ${fmt(ratio, 1)}-mal so groß wie ${b.data.n}.` : `${b.data.n} ist ${fmt(1 / ratio, 1)}-mal so groß wie ${a.data.n}.`) : '';
    this.openCard(
      `<h3>Vergleich</h3><table class="compare"><tr><th></th><th>${flag(a.data)}${escapeHtml(a.data.n)}</th><th>${flag(b.data)}${escapeHtml(b.data.n)}</th></tr>${body}</table><p>${escapeHtml(ratioText)}</p>`,
      '',
    );
  }

  private showOwnPlace(p: OwnPlace) {
    this.openCard(
      `<h3><span class="own-ico">♥</span> ${escapeHtml(p.name)}</h3>${p.note ? `<p>${escapeHtml(p.note)}</p>` : ''}${p.photo ? `<img class="own-photo" src="${p.photo}" alt="">` : ''}`,
      '',
      { pos: Cartographic.fromDegrees(p.lon, p.lat), name: p.name },
      undefined,
      [
        this.cardButton('target', 'Bearbeiten', 'Name, Notiz oder Foto ändern', () => this.editPlace(p)),
        this.cardButton('close', 'Löschen', 'Diesen Ort löschen', () => {
          if (confirm(`„${p.name}“ löschen?`)) {
            this.myMap.removePlace(p.id);
            this.closeCard();
          }
        }),
      ],
    );
  }

  /** Formular für einen eigenen Ort (neu oder bearbeiten) */
  private editPlace(p: OwnPlace) {
    const body = this.card.querySelector('.card-body')!;
    body.innerHTML = `<h3>${p.id ? 'Ort bearbeiten' : 'Neuer Ort'}</h3>
      <label class="field">Name<input type="text" class="f-name" maxlength="60"></label>
      <label class="field">Notiz<textarea class="f-note" rows="3" maxlength="500"></textarea></label>
      <label class="field">Foto<input type="file" class="f-photo" accept="image/*"></label>
      <div class="row wrap"><button class="icon-btn f-save">Speichern</button><button class="icon-btn f-cancel">Abbrechen</button></div>`;
    const name = body.querySelector<HTMLInputElement>('.f-name')!;
    const note = body.querySelector<HTMLTextAreaElement>('.f-note')!;
    name.value = p.name;
    note.value = p.note;
    let photo = p.photo;
    body.querySelector<HTMLInputElement>('.f-photo')!.addEventListener('change', async (e) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (f) photo = await shrinkPhoto(f);
    });
    body.querySelector('.f-cancel')!.addEventListener('click', () => this.closeCard());
    body.querySelector('.f-save')!.addEventListener('click', () => {
      const data = { name: name.value.trim() || 'Mein Ort', note: note.value.trim(), lon: p.lon, lat: p.lat, photo };
      if (p.id) this.myMap.updatePlace(p.id, data);
      else this.myMap.addPlace(data);
      this.closeCard();
    });
    this.card.classList.remove('hidden');
    name.focus();
  }

  private cardButton(ico: Parameters<typeof icon>[0], text: string, title: string, onClick: () => void) {
    const b = document.createElement('button');
    b.className = 'icon-btn';
    b.title = title;
    b.append(icon(ico, 18), text);
    b.addEventListener('click', onClick);
    return b;
  }

  private openCard(html: string, link: string, from?: MeasurePoint, linkText?: string, extra: HTMLElement[] = []) {
    this.stopAudio();
    const body = this.card.querySelector('.card-body')!;
    body.innerHTML = html;
    const actions = document.createElement('div');
    actions.className = 'row wrap';
    if (link) {
      const a = document.createElement('a');
      a.href = link;
      a.target = '_blank';
      a.rel = 'noopener';
      a.className = 'wiki-link';
      a.textContent = linkText ?? (link.includes('//en.wikipedia') ? 'Wikipedia (englisch)' : 'Wikipedia');
      actions.append(a);
    }
    if (from) {
      actions.append(
        this.cardButton('ruler', 'Entfernung', 'Luftlinie von hier zu einem anderen Ort messen – dann den zweiten Ort anklicken', () => {
          this.setMeasuring(true);
          this.clearMeasure();
          this.addMeasurePoint(from);
        }),
      );
    }
    actions.append(...extra);
    body.append(actions);
    this.card.classList.remove('hidden');
  }

  closeCard() {
    this.stopAudio();
    this.card.classList.add('hidden');
  }

  // ── Größenvergleich: Länderumriss in echter Größe über die Kugel schieben ──

  private startSizeCompare(ct: Country) {
    this.compareSrc.entities.removeAll();
    this.closeCard();
    const [lon0, lat0] = ct.data.l;
    const center = Cartesian3.normalize(Cartesian3.fromDegrees(lon0, lat0), new Cartesian3());
    // Umriss als Einheitsvektoren (grobe Stufe, ohne Inselchen und Löcher)
    const rings = ct.coarse
      .filter((p) => (p.bbox[2] - p.bbox[0]) * (p.bbox[3] - p.bbox[1]) > 0.05 * this.scale * this.scale || ct.coarse.length < 4)
      .map((p) => {
        const r = p.rings[0];
        const pts: Cartesian3[] = [];
        for (let i = 0; i < r.length; i += 2) pts.push(Cartesian3.normalize(Cartesian3.fromDegrees(r[i] / this.scale, r[i + 1] / this.scale), new Cartesian3()));
        return pts;
      });
    const state = { country: ct, target: center.clone(), moving: true };
    this.dragOutline = state;
    const rotate = (v: Cartesian3, out: Cartesian3) => {
      // Drehung, die den Mittelpunkt des Landes auf das Ziel bringt (erhält die echte Größe)
      const t = state.target;
      const axis = Cartesian3.cross(center, t, new Cartesian3());
      const s = Cartesian3.magnitude(axis);
      const c = Cartesian3.dot(center, t);
      if (s < 1e-9) return Cartesian3.multiplyByScalar(v, Ellipsoid.WGS84.maximumRadius, out);
      Cartesian3.divideByScalar(axis, s, axis);
      const cross = Cartesian3.cross(axis, v, new Cartesian3());
      const dot = Cartesian3.dot(axis, v);
      out.x = v.x * c + cross.x * s + axis.x * dot * (1 - c);
      out.y = v.y * c + cross.y * s + axis.y * dot * (1 - c);
      out.z = v.z * c + cross.z * s + axis.z * dot * (1 - c);
      return Cartesian3.multiplyByScalar(out, Ellipsoid.WGS84.maximumRadius, out);
    };
    const color = Color.fromCssColorString('#ff7a00');
    for (const ring of rings) {
      const closed = [...ring, ring[0]];
      this.compareSrc.entities.add({
        polygon: {
          hierarchy: new CallbackProperty(() => new PolygonHierarchy(ring.map((v) => rotate(v, new Cartesian3()))), false),
          material: color.withAlpha(0.35),
          arcType: ArcType.GEODESIC,
          height: 300, // nicht am Boden „ankleben“: so folgt die Fläche flüssig der Maus
        },
        polyline: { positions: new CallbackProperty(() => closed.map((v) => rotate(v, new Cartesian3())), false), width: 2.5, material: color, arcType: ArcType.GEODESIC },
      });
    }
    this.compareSrc.entities.add({
      position: new CallbackProperty(() => Cartesian3.multiplyByScalar(state.target, Ellipsoid.WGS84.maximumRadius, new Cartesian3()), false) as never,
      label: {
        text: `${ct.data.n} (echte Größe)`,
        font: 'bold 15px system-ui, sans-serif',
        fillColor: Color.WHITE,
        outlineColor: Color.fromCssColorString('#7a3a00'),
        outlineWidth: 4,
        style: LabelStyle.FILL_AND_OUTLINE,
        horizontalOrigin: HorizontalOrigin.CENTER,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    this.hint.textContent = `${ct.data.n}: Maus bewegen und klicken, um den Umriss abzulegen`;
    this.showRemoveOutline(true);
  }

  private removeOutlineBtn?: HTMLButtonElement;

  private showRemoveOutline(v: boolean) {
    this.removeOutlineBtn?.classList.toggle('hidden', !v);
  }

  removeOutline() {
    this.compareSrc.entities.removeAll();
    this.dragOutline = undefined;
    this.showRemoveOutline(false);
    this.hint.textContent = '';
  }

  private mouseMove(pos: Cartesian2) {
    if (!this.opt.graticule && !this.dragOutline?.moving) return;
    const ray = this.viewer.camera.getPickRay(pos);
    const hit = ray && this.viewer.scene.globe.pick(ray, this.viewer.scene);
    if (!hit) return;
    if (this.dragOutline?.moving) Cartesian3.normalize(hit, this.dragOutline.target);
    if (this.opt.graticule) {
      const c = Cartographic.fromCartesian(hit);
      const lat = CesiumMath.toDegrees(c.latitude);
      const lon = CesiumMath.toDegrees(c.longitude);
      this.coords.textContent = `${fmt(Math.abs(lat), 3)}° ${lat >= 0 ? 'N' : 'S'}   ${fmt(Math.abs(lon), 3)}° ${lon >= 0 ? 'O' : 'W'}`;
    }
  }

  // ── Suche und Hinfliegen ──────────────────────────────────────────────

  async prepareSearch() {
    await Promise.all([this.loadWater(), this.loadPlaces()]).catch(() => undefined);
  }

  search(q: string): SearchHit[] {
    const query = q.trim().toLocaleLowerCase('de');
    if (query.length < 2) return [];
    const hits: SearchHit[] = [];
    const score = (name: string) => {
      const n = name.toLocaleLowerCase('de');
      return n === query ? 0 : n.startsWith(query) ? 1 : n.includes(` ${query}`) ? 2 : n.includes(query) ? 3 : -1;
    };
    const push = (name: string, kind: string, lon: number, lat: number, height: number, weight: number, open?: () => void) => {
      const s = score(name);
      if (s >= 0) hits.push({ name, kind, lon, lat, height, open, rank: s * 1e12 - weight + name.length * 1e4 });
    };
    for (const ct of this.countries) push(ct.data.n, 'Land', ct.data.l[0], ct.data.l[1], heightForBox(ct.bbox, this.scale), 1e11 + ct.data.e, () => this.showCountry(ct));
    for (const row of this.cityData?.cities ?? []) push(row[0], `Stadt · ${this.cityData!.countries[row[1]]?.[0] ?? row[1]}`, row[4], row[3], 1.2e5, row[2] + (row[8] ? 1e10 : 0), () => this.showCity(row));
    const w = this.water;
    if (w) {
      for (const s of w.seas) push(s[0], s[3] || 'Meer', s[1], s[2], 3e6, 1e9 - s[4] * 1e8, () => this.showById('sea', s));
      for (const l of w.lakes) push(l[0], 'See', l[1], l[2], 4e5, 1e6 + l[5], () => this.showById('lake', l));
      for (const r of w.rivers) push(r.n, 'Fluss', r.l[0], r.l[1], 8e5, 1e6 + r.len, () => this.showRiver(r));
    }
    const p = this.places;
    if (p) {
      const kinds: [keyof PlacesFile, string, number][] = [
        ['wonders', 'Weltwunder', 6e4],
        ['buildings', 'Bauwerk', 3e4],
        ['unesco', 'UNESCO-Welterbe', 1.5e5],
        ['volcanoes', 'Vulkan', 1e5],
        ['parks', 'Nationalpark', 2e5],
        ['deserts', 'Wüste', 2e6],
        ['ranges', 'Gebirge', 2e6],
        ['summits', 'Berg', 1e5],
        ['waterfalls', 'Wasserfall', 3e4],
        ['extremes', 'Besonderer Punkt', 2e5],
        ['canals', 'Kanal', 3e5],
        ['islands', 'Insel', 1e6],
        ['peninsulas', 'Halbinsel', 1.5e6],
        ['capes', 'Kap', 1e5],
      ];
      const kindOf: Record<string, string> = { deserts: 'desert', ranges: 'range' };
      for (const [key, label, height] of kinds) {
        for (const it of p[key] as unknown as (string | number)[][]) {
          push(String(it[0]), label, it[1] as number, it[2] as number, height, 5e5, () => this.showById(kindOf[key] ?? key, it));
        }
      }
      for (const a of p.airports) push(`${a[0]} (${a[3]})`, 'Flughafen', a[1], a[2], 6e4, 1e5, () => this.showById('airports', a));
    }
    for (const own of this.myMap.data.places) push(own.name, 'Mein Ort', own.lon, own.lat, 1e5, 1e12, () => this.showOwnPlace(own));
    hits.sort((a, b) => a.rank - b.rank);
    const seen = new Set<string>();
    return hits.filter((h) => !seen.has(h.name + h.kind) && seen.add(h.name + h.kind)).slice(0, 14);
  }

  flyTo(lon: number, lat: number, height: number, name?: string) {
    this.pinSrc.entities.removeAll();
    if (name) {
      this.pinSrc.entities.add({
        position: Cartesian3.fromDegrees(lon, lat),
        billboard: { image: iconUrl(markerIcon('pin')), width: 26, height: 26, verticalOrigin: VerticalOrigin.BOTTOM, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      });
    }
    this.viewer.camera.flyTo({ destination: Cartesian3.fromDegrees(lon, lat, height), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 }, duration: 2 });
  }

  goTo(hit: SearchHit) {
    this.flyTo(hit.lon, hit.lat, hit.height, hit.name);
    hit.open?.();
  }

  quizRegion = 'Europa';
  quizLevel = 'leicht';

  startQuiz() {
    if (!this.active || !this.countries.length) return;
    this.quiz.start(this.quizRegion, this.quizLevel);
  }

  // ── Entfernung messen (Luftlinie auf der Erdkugel) ────────────────────

  setMeasuring(on: boolean) {
    this.measuring = on;
    this.measureBtn.classList.toggle('active', on);
    this.viewer.canvas.style.cursor = on ? 'crosshair' : '';
    if (!on) this.clearMeasure();
    else if (!this.measure.length) this.hint.textContent = 'Ersten Ort anklicken';
  }

  private clearMeasure() {
    this.measure = [];
    this.overlay.entities.removeAll();
    this.hint.textContent = this.measuring ? 'Ersten Ort anklicken' : '';
  }

  private addMeasurePoint(p: MeasurePoint) {
    if (this.measure.length >= 2) this.clearMeasure();
    this.measure.push(p);
    const pos = Cartographic.toCartesian(p.pos);
    this.overlay.entities.add({
      position: pos,
      point: { pixelSize: 11, color: Color.fromCssColorString('#ffd166'), outlineColor: Color.BLACK, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY },
    });
    if (this.measure.length === 1) {
      this.hint.textContent = `${p.name} → zweiten Ort anklicken`;
      return;
    }
    const [a, b] = this.measure;
    const geo = new EllipsoidGeodesic(a.pos, b.pos, Ellipsoid.WGS84);
    const dist = geo.surfaceDistance / 1000;
    const mid = Cartographic.toCartesian(geo.interpolateUsingFraction(0.5));
    const text = km(dist);
    this.overlay.entities.add({
      polyline: {
        // etwas über dem Boden, damit die Linie zwischen den Stützpunkten nicht in die Kugel taucht
        positions: [a.pos, b.pos].map((c) => Cartesian3.fromRadians(c.longitude, c.latitude, 3000)),
        arcType: ArcType.GEODESIC,
        width: 4,
        material: Color.fromCssColorString('#ffd166'),
      },
    });
    this.overlay.entities.add({
      position: mid,
      label: {
        text,
        font: 'bold 18px system-ui, sans-serif',
        fillColor: Color.fromCssColorString('#ffd166'),
        outlineColor: Color.BLACK,
        outlineWidth: 4,
        style: LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: VerticalOrigin.BOTTOM,
        pixelOffset: new Cartesian2(0, -8),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    const hours = dist / 850 + 0.5; // Reiseflug ~850 km/h plus Start und Landung
    const flight = dist > 300 ? ` · mit dem Flugzeug ca. ${hours < 2 ? `${Math.round(hours * 60)} min` : `${Math.round(hours)} h`}` : '';
    this.hint.textContent = `${a.name} → ${b.name}: ${text} Luftlinie${flight}`;
  }

  // ── Bedienleiste und Steckbrief ───────────────────────────────────────

  private buildDom() {
    this.bar.id = 'political-bar';
    this.bar.className = 'glass';
    // Regler: ab welcher Einwohnerzahl Städte gezeigt werden (Hauptstädte immer)
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = String(CITY_STEPS.length - 1);
    slider.step = '1';
    slider.value = String(DEFAULT_STEP);
    slider.className = 'city-slider';
    slider.title = 'Ab welcher Größe Städte gezeigt werden – weltweit ab 10.000, in Deutschland ab 5.000 Einwohnern. Kleine Städte erscheinen erst beim Heranzoomen.';
    const sliderText = document.createElement('span');
    sliderText.className = 'slider-text';
    const updateSlider = () => {
      const v = CITY_STEPS[Number(slider.value)];
      sliderText.textContent = `ab ${v >= 1e6 ? `${v / 1e6} Mio.` : fmt(v)}`;
      this.setThreshold(v);
    };
    slider.addEventListener('input', updateSlider);
    updateSlider();
    const wrap = document.createElement('span');
    wrap.className = 'slider-wrap';
    const cityIco = document.createElement('span');
    cityIco.className = 'bar-ico';
    cityIco.append(icon('city', 20));
    wrap.append(cityIco, slider, sliderText);
    this.measureBtn.className = 'icon-btn';
    this.measureBtn.title = 'Entfernung messen: zwei Orte anklicken (Luftlinie)';
    this.measureBtn.append(icon('ruler', 20));
    this.measureBtn.addEventListener('click', () => this.setMeasuring(!this.measuring));
    this.removeOutlineBtn = document.createElement('button');
    this.removeOutlineBtn.className = 'icon-btn hidden';
    this.removeOutlineBtn.title = 'Umriss für den Größenvergleich entfernen';
    this.removeOutlineBtn.append(icon('close', 18), 'Umriss');
    this.removeOutlineBtn.addEventListener('click', () => this.removeOutline());
    this.hint.className = 'measure-text';
    const close = document.createElement('button');
    close.className = 'icon-btn';
    close.title = 'Zurück zur echten Erde';
    close.append(icon('globe', 20));
    close.addEventListener('click', () => void this.exit());
    const quizBtn = document.createElement('button');
    quizBtn.className = 'icon-btn quiz-start';
    quizBtn.title = 'Länder-Quiz: Wo ist welches Land? (Einstellungen im Bedienfeld unter „Quiz“)';
    quizBtn.append(icon('stars', 20), 'Quiz');
    quizBtn.addEventListener('click', () => (this.quiz.active ? this.quiz.stop() : this.startQuiz()));
    this.bar.append(wrap, this.measureBtn, quizBtn, this.removeOutlineBtn, close, this.hint);

    this.card.id = 'city-card';
    this.card.className = 'glass hidden';
    const x = document.createElement('button');
    x.className = 'mini card-close';
    x.title = 'Schließen';
    x.append(icon('close', 16));
    x.addEventListener('click', () => this.closeCard());
    const body = document.createElement('div');
    body.className = 'card-body';
    this.card.append(x, body);

    this.coords.id = 'coord-readout';
    this.coords.className = 'glass hidden';
    document.body.append(this.bar, this.card, this.coords);
  }
}

export { HISTORY_YEARS };
