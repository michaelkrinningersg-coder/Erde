import {
  ArcType,
  BillboardCollection,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  CustomDataSource,
  DistanceDisplayCondition,
  Ellipsoid,
  EllipsoidGeodesic,
  Event,
  GeographicTilingScheme,
  HorizontalOrigin,
  ImageryLayer,
  LabelCollection,
  LabelStyle,
  Math as CesiumMath,
  NearFarScalar,
  PointPrimitiveCollection,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  VerticalOrigin,
  type Billboard,
  type ImageryProvider,
  type Label,
  type PointPrimitive,
  type Viewer,
} from 'cesium';
import { icon } from './svgIcons';

// ── Daten (scripts/build_political.py) ──────────────────────────────────────

/** Ring als Differenzen: [x0, y0, dx1, dy1, …] in 1/scale Grad */
type EncodedRing = number[];
interface CountryData {
  n: string; // Name
  i: string; // ISO-Code
  c: number; // Farbe 0…8 (Nachbarn verschieden)
  l: [number, number]; // Beschriftungspunkt
  z: number; // Zoomstufe, ab der Natural Earth den Namen zeigt
  e: number; // Einwohner (Schätzung)
  q: string; // Wikidata
  p: EncodedRing[][]; // genaue Polygone (Außenring + Löcher), Natural Earth 1:10 Mio.
  g: EncodedRing[][]; // grobe Polygone für den Blick auf die ganze Erde
}
interface CountriesFile {
  scale: number;
  countries: CountryData[];
  lakes: EncodedRing[][];
  lakesCoarse: EncodedRing[][];
}
/**
 * [Name, Land, Einwohner, Breite, Länge, Rang Land, Rang Kontinent, Rang Welt, Hauptstadt-Rolle, Wikipedia-Titel,
 *  Höhe in m (null = unbekannt), Ballungsraum UN 2025 (0 = unbekannt), Verwaltungsgebiet (0 = Zahl nicht korrigiert)]
 */
type CityRow = [string, string, number, number, number, number, number, number, string, string, number | null, number, number];
interface CitiesFile {
  continents: Record<string, string>;
  countries: Record<string, [string, string, number]>;
  continentCount: Record<string, number>;
  worldCount: number;
  cities: CityRow[];
}

type BBox = [number, number, number, number]; // W S O N in 1/scale Grad
/** Ein Polygon (Außenring + Löcher) mit fertigem Zeichenpfad */
interface Poly {
  rings: Int32Array[]; // x, y abwechselnd
  path: Path2D;
  bbox: BBox;
}

interface Country {
  data: CountryData;
  fine: Poly[];
  coarse: Poly[];
  bbox: BBox;
}

interface City {
  row: CityRow;
  pos: Cartesian3;
  point?: PointPrimitive;
  star?: Billboard;
  /** Name erscheint, wenn die Kamera näher ist (m) */
  range: number;
  /** Vorrang beim Beschriften: Hauptstädte, dann nach Einwohnern */
  prio: number;
}

interface CountryLabel {
  label: Label;
  pos: Cartesian3;
  range: number;
}

// Wasser blau, Länder in neun hellen, gut unterscheidbaren Farben
const WATER = '#6aa5dc';
const PALETTE = ['#f39a8f', '#f7c46c', '#f2e27a', '#a9d873', '#7fd0b0', '#c3a6ea', '#f0a6d2', '#d9b98f', '#9fd4e6'];
const BORDER = 'rgba(55, 60, 72, 0.75)';

/** Stufen des Stadtgrößen-Reglers (Welt ab 10.000, Deutschland ab 5.000 Einwohnern) */
export const CITY_STEPS = [5_000, 10_000, 20_000, 50_000, 100_000, 250_000, 500_000, 1_000_000, 2_000_000, 5_000_000];
const DEFAULT_STEP = 4;
/** Höchstens so viele Stadtnamen gleichzeitig */
const MAX_LABELS = 260;
const CITY_FONT = 12;

const fmt = (v: number) => v.toLocaleString('de-DE');

/** Bis zu dieser Kachelstufe reichen die groben Grenzen (Stufe 3 ≈ 0,04° pro Pixel) */
const COARSE_MAX_LEVEL = 3;

/** Zeichnet die Länderkarte kachelweise auf Canvas (scharf in jeder Zoomstufe). */
class PoliticalImagery {
  readonly tilingScheme = new GeographicTilingScheme();
  readonly rectangle = this.tilingScheme.rectangle;
  readonly tileWidth = 512;
  readonly tileHeight = 512;
  readonly minimumLevel = 0;
  readonly maximumLevel = 17;
  readonly tileDiscardPolicy = undefined;
  readonly errorEvent = new Event();
  readonly hasAlphaChannel = false;
  readonly credit = undefined;
  readonly proxy = undefined;

  constructor(
    private readonly countries: Country[],
    private readonly lakes: Poly[],
    private readonly lakesCoarse: Poly[],
    private readonly scale: number,
  ) {}

  getTileCredits() {
    return [];
  }

  pickFeatures() {
    return undefined;
  }

  requestImage(x: number, y: number, level: number) {
    const r = this.tilingScheme.tileXYToRectangle(x, y, level);
    const q = this.scale;
    const [w, s, e, n] = [r.west, r.south, r.east, r.north].map((v) => CesiumMath.toDegrees(v) * q);
    const c = document.createElement('canvas');
    c.width = this.tileWidth;
    c.height = this.tileHeight;
    const g = c.getContext('2d')!;
    g.fillStyle = WATER;
    g.fillRect(0, 0, c.width, c.height);
    // Koordinaten in 1/scale Grad, y = −Breite
    const k = c.width / (e - w);
    g.setTransform(k, 0, 0, k, -w * k, n * k);
    const pad = 3 / k;
    const visible = (b: BBox) => b[0] <= e + pad && b[2] >= w - pad && b[1] <= n + pad && b[3] >= s - pad;
    const coarse = level <= COARSE_MAX_LEVEL;
    const shown: Poly[][] = [];
    for (const ct of this.countries) {
      if (!visible(ct.bbox)) continue;
      const polys = (coarse ? ct.coarse : ct.fine).filter((p) => visible(p.bbox));
      if (!polys.length) continue;
      g.fillStyle = PALETTE[ct.data.c % PALETTE.length];
      for (const p of polys) g.fill(p.path, 'evenodd');
      shown.push(polys);
    }
    g.fillStyle = WATER;
    for (const l of coarse ? this.lakesCoarse : this.lakes) if (visible(l.bbox)) g.fill(l.path, 'evenodd');
    g.strokeStyle = BORDER;
    g.lineJoin = 'round';
    g.lineWidth = (level >= 8 ? 2 : level >= 5 ? 1.6 : 1.1) / k;
    for (const polys of shown) for (const p of polys) g.stroke(p.path);
    return Promise.resolve(c);
  }
}

/** Differenzen auspacken und Zeichenpfad bauen */
function decode(polys: EncodedRing[][]): Poly[] {
  return polys.map((poly) => {
    const path = new Path2D();
    const bbox: BBox = [Infinity, Infinity, -Infinity, -Infinity];
    const rings = poly.map((enc) => {
      const ring = new Int32Array(enc.length);
      let x = 0;
      let y = 0;
      for (let i = 0; i < enc.length; i += 2) {
        x += enc[i];
        y += enc[i + 1];
        ring[i] = x;
        ring[i + 1] = y;
        if (i === 0) path.moveTo(x, -y);
        else path.lineTo(x, -y);
        if (x < bbox[0]) bbox[0] = x;
        if (y < bbox[1]) bbox[1] = y;
        if (x > bbox[2]) bbox[2] = x;
        if (y > bbox[3]) bbox[3] = y;
      }
      path.closePath();
      return ring;
    });
    return { rings, path, bbox };
  });
}

function unionBox(polys: Poly[]): BBox {
  const b: BBox = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of polys) {
    b[0] = Math.min(b[0], p.bbox[0]);
    b[1] = Math.min(b[1], p.bbox[1]);
    b[2] = Math.max(b[2], p.bbox[2]);
    b[3] = Math.max(b[3], p.bbox[3]);
  }
  return b;
}

/** Punkt-in-Polygon (gerade/ungerade über alle Ringe eines Polygons) */
function inside(polys: Poly[], x: number, y: number) {
  for (const poly of polys) {
    if (x < poly.bbox[0] || x > poly.bbox[2] || y < poly.bbox[1] || y > poly.bbox[3]) continue;
    let c = false;
    for (const r of poly.rings) {
      const n = r.length;
      for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
        const xi = r[i];
        const yi = r[i + 1];
        const xj = r[j];
        const yj = r[j + 1];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
      }
    }
    if (c) return true;
  }
  return false;
}

/** Hauptstadt: roter Stern mit weißem Rand */
function starIcon() {
  const s = 22;
  const c = document.createElement('canvas');
  c.width = c.height = s * 2;
  const g = c.getContext('2d')!;
  g.scale(2, 2);
  g.translate(s / 2, s / 2);
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? 4.2 : 9.5;
    const a = (i * Math.PI) / 5 - Math.PI / 2;
    g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  g.closePath();
  g.fillStyle = '#e0262b';
  g.strokeStyle = '#fff';
  g.lineWidth = 2;
  g.stroke();
  g.fill();
  return c;
}

/** Wie nah man heranzoomen muss, bis der Stadtname erscheint (m) */
const labelRange = (pop: number, capital: boolean) => Math.max(9e5 * Math.pow(Math.max(pop, 5e3) / 1e5, 0.55), capital ? 3.5e6 : 0);
/** Ab welchem Abstand der Punkt einer Stadt erscheint (m) – ganz weit draußen nur die Hauptstädte */
const pointRange = (pop: number) =>
  pop >= 5e6 ? 1.3e7 : pop >= 1e6 ? 8e6 : pop >= 5e5 ? 5e6 : pop >= 1e5 ? 2.6e6 : pop >= 5e4 ? 1.4e6 : pop >= 2e4 ? 8e5 : 4.5e5;

interface MeasurePoint {
  pos: Cartographic;
  name: string;
}

/**
 * Politische Karte: statisch (keine Zeit, keine Wolken), Wasser blau, Länder in Nachbarfarben,
 * Ländernamen beim Heranzoomen, Hauptstädte und Regierungssitze, Städte nach Einwohnerzahl,
 * Steckbrief beim Anklicken und Luftlinien-Messung.
 */
export class PoliticalView {
  active = false;
  onChange?: (active: boolean) => void;
  private loaded?: Promise<void>;
  private layer?: ImageryLayer;
  private countries: Country[] = [];
  private scale = 1;
  private cityData?: CitiesFile;
  private cities: City[] = [];
  private readonly points = new PointPrimitiveCollection();
  private readonly stars = new BillboardCollection();
  private readonly labels = new LabelCollection();
  private readonly labelPool: Label[] = [];
  private readonly countryLabels = new LabelCollection();
  private countryLabelList: CountryLabel[] = [];
  private labelsDirty = true;
  private lastLabelUpdate = 0;
  private readonly lastCam = new Cartesian3();
  private readonly lastDir = new Cartesian3();
  private readonly overlay = new CustomDataSource('politik');
  private threshold = CITY_STEPS[DEFAULT_STEP];
  private saved?: () => void;
  private handler?: ScreenSpaceEventHandler;
  private measuring = false;
  private measure: MeasurePoint[] = [];

  private readonly bar = document.createElement('div');
  private readonly card = document.createElement('div');
  private readonly measureBtn = document.createElement('button');
  private readonly measureText = document.createElement('span');

  constructor(private readonly viewer: Viewer) {
    for (const p of [this.countryLabels, this.points, this.stars, this.labels]) {
      p.show = false;
      viewer.scene.primitives.add(p);
    }
    this.overlay.show = false;
    void viewer.dataSources.add(this.overlay);
    this.buildDom();
    viewer.scene.postRender.addEventListener(() => this.maybeUpdateLabels());
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
    this.layer!.show = true;
    this.viewer.imageryLayers.raiseToTop(this.layer!);
    for (const p of [this.countryLabels, this.points, this.stars, this.labels]) p.show = true;
    this.overlay.show = true;
    this.applyThreshold();
    this.handler = new ScreenSpaceEventHandler(this.viewer.canvas);
    this.handler.setInputAction((e: { position: Cartesian2 }) => this.click(e.position), ScreenSpaceEventType.LEFT_CLICK);
  }

  async exit() {
    if (!this.active) return;
    this.active = false;
    this.handler?.destroy();
    this.handler = undefined;
    if (this.layer) this.layer.show = false;
    for (const p of [this.countryLabels, this.points, this.stars, this.labels]) p.show = false;
    this.overlay.show = false;
    this.setMeasuring(false);
    this.card.classList.add('hidden');
    this.saved?.();
    this.saved = undefined;
    document.body.classList.remove('political-mode');
    this.onChange?.(false);
  }

  /** Alles andere ausblenden (Bildebenen, Objekte, Licht, Himmel) und die Zeit anhalten; merkt sich den alten Zustand */
  private hideEverythingElse() {
    const v = this.viewer;
    const s = v.scene;
    const layers: [ImageryLayer, boolean][] = [];
    for (let i = 0; i < v.imageryLayers.length; i++) {
      const l = v.imageryLayers.get(i);
      if (l === this.layer) continue;
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
    };
  }

  private async load() {
    const [cf, cities] = await Promise.all([
      fetch('./data/political/countries.json').then((r) => r.json() as Promise<CountriesFile>),
      fetch('./data/political/cities.json').then((r) => r.json() as Promise<CitiesFile>),
    ]);
    this.scale = cf.scale;
    this.countries = cf.countries.map((data) => {
      const fine = decode(data.p);
      const coarse = decode(data.g);
      data.p = data.g = []; // Rohdaten nicht doppelt im Speicher halten
      return { data, fine, coarse, bbox: unionBox(fine) };
    });
    const provider = new PoliticalImagery(this.countries, decode(cf.lakes), decode(cf.lakesCoarse), cf.scale);
    this.layer = new ImageryLayer(provider as unknown as ImageryProvider, { show: false });
    this.viewer.imageryLayers.add(this.layer);

    // Ländernamen: große Länder schon von weit weg, kleine erst beim Heranzoomen
    for (const ct of this.countries) {
      const c = ct.data;
      const far = 3.4e7 / Math.pow(2, Math.max(0, c.z - 1.7));
      const pos = Cartesian3.fromDegrees(c.l[0], c.l[1]);
      const label = this.countryLabels.add({
        position: pos,
        text: c.n,
        font: c.z <= 2 ? 'bold 17px system-ui, sans-serif' : c.z <= 3.5 ? 'bold 15px system-ui, sans-serif' : 'bold 13px system-ui, sans-serif',
        fillColor: Color.fromCssColorString('#1d2433'),
        outlineColor: Color.WHITE.withAlpha(0.85),
        outlineWidth: 3,
        style: LabelStyle.FILL_AND_OUTLINE,
        horizontalOrigin: HorizontalOrigin.CENTER,
        verticalOrigin: VerticalOrigin.CENTER,
        distanceDisplayCondition: new DistanceDisplayCondition(0, far),
        id: { country: ct },
      });
      this.countryLabelList.push({ label, pos, range: far });
    }

    // Städte
    this.cityData = cities;
    const star = starIcon();
    for (const row of cities.cities) {
      const [, , pop, lat, lon, , , , cap] = row;
      const pos = Cartesian3.fromDegrees(lon, lat);
      const capital = !!cap;
      const city: City = { row, pos, range: labelRange(pop, capital), prio: (capital ? 1e10 : 0) + pop };
      if (capital) {
        city.star = this.stars.add({
          position: pos,
          image: star,
          width: 20,
          height: 20,
          // ganz weit draußen klein, damit sich die Sterne nicht überdecken
          scaleByDistance: new NearFarScalar(1.5e6, 1, 2.2e7, 0.3),
          id: { city: row },
        });
      } else {
        city.point = this.points.add({
          position: pos,
          pixelSize: 4 + Math.max(0, Math.log10(pop / 1e4)) * 2,
          color: Color.WHITE,
          outlineColor: Color.fromCssColorString('#20242c'),
          outlineWidth: 1.2,
          scaleByDistance: new NearFarScalar(1e6, 1, 1.3e7, 0.6),
          distanceDisplayCondition: new DistanceDisplayCondition(0, pointRange(pop)),
          id: { city: row },
        });
      }
      this.cities.push(city);
    }
    // Wichtigste zuerst beschriften
    this.cities.sort((a, b) => b.prio - a.prio);
  }

  setThreshold(v: number) {
    this.threshold = v;
    this.applyThreshold();
  }

  private applyThreshold() {
    for (const c of this.cities) if (c.point) c.point.show = c.row[2] >= this.threshold;
    this.labelsDirty = true;
  }

  /** Nach Kamerabewegung (höchstens alle 150 ms) die Beschriftung neu verteilen */
  private maybeUpdateLabels() {
    if (!this.active || !this.cities.length) return;
    const cam = this.viewer.camera;
    const moved = !Cartesian3.equalsEpsilon(cam.positionWC, this.lastCam, 0, 1) || !Cartesian3.equalsEpsilon(cam.directionWC, this.lastDir, 1e-6);
    if (!moved && !this.labelsDirty) return;
    const now = performance.now();
    if (now - this.lastLabelUpdate < 150) return;
    this.lastLabelUpdate = now;
    Cartesian3.clone(cam.positionWC, this.lastCam);
    Cartesian3.clone(cam.directionWC, this.lastDir);
    this.labelsDirty = false;
    this.updateLabels();
  }

  /**
   * Stadtnamen ohne Überlappung: der Reihe nach (Hauptstädte, dann Einwohner) einen Platz auf dem
   * Bildschirm suchen; Ländernamen sind schon belegt. Nur sichtbare Seite der Erde.
   */
  private updateLabels() {
    const scene = this.viewer.scene;
    const camPos = this.viewer.camera.positionWC;
    const camMag2 = Cartesian3.magnitudeSquared(camPos);
    const boxes: [number, number, number, number][] = [];
    const free = (x0: number, y0: number, x1: number, y1: number) => !boxes.some((b) => x0 < b[2] && x1 > b[0] && y0 < b[3] && y1 > b[1]);
    const toScreen = new Cartesian2();
    // Punkt auf der Vorderseite der Kugel? (Kugelnäherung: Kamera sieht über den Horizont hinaus nicht)
    const facing = (p: Cartesian3) => Cartesian3.dot(p, camPos) > Cartesian3.magnitudeSquared(p) && camMag2 > 0;
    for (const cl of this.countryLabelList) {
      if (Cartesian3.distance(cl.pos, camPos) > cl.range || !facing(cl.pos)) continue;
      const s = scene.cartesianToCanvasCoordinates(cl.pos, toScreen);
      if (!s) continue;
      const w = cl.label.text.length * 8.5;
      boxes.push([s.x - w / 2, s.y - 10, s.x + w / 2, s.y + 10]);
    }
    const w = scene.canvas.clientWidth;
    const h = scene.canvas.clientHeight;
    let used = 0;
    for (const c of this.cities) {
      if (used >= MAX_LABELS) break;
      if (!c.star && c.row[2] < this.threshold) continue;
      if (Cartesian3.distance(c.pos, camPos) > c.range || !facing(c.pos)) continue;
      const s = scene.cartesianToCanvasCoordinates(c.pos, toScreen);
      if (!s || s.x < -50 || s.y < -20 || s.x > w + 50 || s.y > h + 20) continue;
      const capital = !!c.star;
      const pop = c.row[2];
      const font = capital ? 14 : pop >= 1e6 ? 13 : CITY_FONT;
      const tw = c.row[0].length * font * 0.56 + 4;
      const off = capital ? 10 : 6;
      const box: [number, number, number, number] = [s.x - tw / 2, s.y - off - font - 3, s.x + tw / 2, s.y - off + 1];
      if (!free(...box)) continue;
      boxes.push(box, [s.x - 4, s.y - 4, s.x + 4, s.y + 4]);
      let l = this.labelPool[used];
      if (!l) {
        l = this.labels.add({
          position: c.pos,
          text: c.row[0],
          fillColor: Color.fromCssColorString('#10151f'),
          outlineColor: Color.WHITE,
          outlineWidth: 3,
          style: LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: VerticalOrigin.BOTTOM,
          horizontalOrigin: HorizontalOrigin.CENTER,
        });
        this.labelPool.push(l);
      }
      const fontStr = capital ? 'bold 14px system-ui, sans-serif' : pop >= 1e6 ? '600 13px system-ui, sans-serif' : `${CITY_FONT}px system-ui, sans-serif`;
      if (l.text !== c.row[0]) l.text = c.row[0];
      if (l.font !== fontStr) l.font = fontStr;
      l.position = c.pos;
      l.pixelOffset = new Cartesian2(0, -off);
      l.id = { city: c.row };
      l.show = true;
      used++;
    }
    for (let i = used; i < this.labelPool.length; i++) this.labelPool[i].show = false;
  }

  // ── Anklicken ─────────────────────────────────────────────────────────

  private click(pos: Cartesian2) {
    const picked = this.viewer.scene.pick(pos) as { id?: { city?: CityRow; country?: Country } } | undefined;
    const row = picked?.id?.city;
    const ray = this.viewer.camera.getPickRay(pos);
    const hit = ray && this.viewer.scene.globe.pick(ray, this.viewer.scene);
    const carto = row ? Cartographic.fromDegrees(row[4], row[3]) : hit ? Cartographic.fromCartesian(hit) : undefined;
    if (!carto) return;
    const country = picked?.id?.country ?? this.countryAt(carto);
    if (this.measuring) {
      this.addMeasurePoint({ pos: carto, name: row ? row[0] : country ? `Punkt in ${country.data.n}` : 'Punkt im Meer' });
      if (row) this.showCity(row);
      return;
    }
    if (row) this.showCity(row);
    else if (country) this.showCountry(country);
    else this.card.classList.add('hidden');
  }

  private countryAt(c: Cartographic) {
    const x = CesiumMath.toDegrees(c.longitude) * this.scale;
    const y = CesiumMath.toDegrees(c.latitude) * this.scale;
    return this.countries.find((ct) => x >= ct.bbox[0] && x <= ct.bbox[2] && y >= ct.bbox[1] && y <= ct.bbox[3] && inside(ct.fine, x, y));
  }

  private showCity(row: CityRow) {
    const d = this.cityData!;
    const [name, cc, pop, , , rc, rk, rw, cap, wiki, elev, agglo, adminPop] = row;
    const [country, cont] = d.countries[cc] ?? [cc, ''];
    const contName = d.continents[cont] ?? '';
    const ranks = rw
      ? `<table>
          <tr><th>In ${country}</th><td>Platz <b>${fmt(rc)}</b> <span class="muted">von ${fmt(d.countries[cc]?.[2] ?? 0)}</span></td></tr>
          ${contName ? `<tr><th>In ${contName}</th><td>Platz <b>${fmt(rk)}</b> <span class="muted">von ${fmt(d.continentCount[cont] ?? 0)}</span></td></tr>` : ''}
          <tr><th>Auf der Welt</th><td>Platz <b>${fmt(rw)}</b> <span class="muted">von ${fmt(d.worldCount)}</span></td></tr>
        </table>
        <div class="muted small">Rang nach Einwohnern unter allen Orten ab 1.000 Einwohnern · Daten: GeoNames</div>`
      : '';
    const link = wiki
      ? `https://de.wikipedia.org/wiki/${encodeURIComponent(wiki.replace(/ /g, '_'))}`
      : `https://de.wikipedia.org/w/index.php?search=${encodeURIComponent(`${name} ${country}`)}`;
    this.openCard(
      `<h3>${cap ? '<span class="cap-star">★</span> ' : ''}${name}</h3>
       <div class="sub">${cap ? `<b>${cap}</b> · ` : ''}${country}${contName ? ` · ${contName}` : ''}</div>
       <div class="pop"><span class="big">${fmt(pop)}</span> Einwohner${adminPop ? ' <span class="muted">(Ballungsraum)</span>' : ''}</div>
       <table>
         ${elev !== null ? `<tr><th>Höhe</th><td><b>${fmt(Math.abs(elev))} m</b> ${elev < 0 ? 'unter' : 'über'} dem Meer</td></tr>` : ''}
         ${agglo && !adminPop && agglo > pop * 1.15 ? `<tr><th>Großraum</th><td>ca. ${fmt(agglo)} <span class="muted">(UN 2025)</span></td></tr>` : ''}
         ${adminPop ? `<tr><th>Verwaltungsgebiet</th><td>${fmt(adminPop)} <span class="muted">(Stadt mit Umland)</span></td></tr>` : ''}
       </table>
       ${ranks}`,
      link,
      { pos: Cartographic.fromDegrees(row[4], row[3]), name },
    );
  }

  private showCountry(ct: Country) {
    const c = ct.data;
    const d = this.cityData!;
    const caps = d.cities.filter((r) => r[1] === c.i && r[8]);
    const biggest = d.cities.find((r) => r[1] === c.i);
    const rows = [
      c.e ? `<tr><th>Einwohner</th><td>ca. ${fmt(Math.round(c.e / 1000) * 1000)}</td></tr>` : '',
      caps.length ? `<tr><th>${caps.length > 1 ? 'Hauptstädte' : 'Hauptstadt'}</th><td>${caps.map((r) => (caps.length > 1 ? `${r[0]} <span class="muted">(${r[8]})</span>` : r[0])).join('<br>')}</td></tr>` : '',
      biggest && !caps.includes(biggest) ? `<tr><th>Größte Stadt</th><td>${biggest[0]}</td></tr>` : '',
      c.i && d.countries[c.i] ? `<tr><th>Orte ab 1.000 Einw.</th><td>${fmt(d.countries[c.i][2])}</td></tr>` : '',
    ].join('');
    const link = c.q ? `https://www.wikidata.org/wiki/Special:GoToLinkedPage/dewiki/${c.q}` : `https://de.wikipedia.org/w/index.php?search=${encodeURIComponent(c.n)}`;
    this.openCard(`<h3>${c.n}</h3><table>${rows}</table>`, link);
  }

  private openCard(html: string, wiki: string, from?: MeasurePoint) {
    const body = this.card.querySelector('.card-body')!;
    body.innerHTML = html;
    const actions = document.createElement('div');
    actions.className = 'row wrap';
    const a = document.createElement('a');
    a.href = wiki;
    a.target = '_blank';
    a.rel = 'noopener';
    a.className = 'wiki-link';
    a.textContent = 'Wikipedia';
    actions.append(a);
    if (from) {
      const b = document.createElement('button');
      b.className = 'icon-btn';
      b.title = 'Luftlinie von hier zu einem anderen Ort messen – dann den zweiten Ort anklicken';
      b.append(icon('ruler', 18), 'Entfernung von hier');
      b.addEventListener('click', () => {
        this.setMeasuring(true);
        this.clearMeasure();
        this.addMeasurePoint(from);
      });
      actions.append(b);
    }
    body.append(actions);
    this.card.classList.remove('hidden');
  }

  // ── Entfernung messen (Luftlinie auf der Erdkugel) ────────────────────

  private setMeasuring(on: boolean) {
    this.measuring = on;
    this.measureBtn.classList.toggle('active', on);
    this.viewer.canvas.style.cursor = on ? 'crosshair' : '';
    if (!on) this.clearMeasure();
    else if (!this.measure.length) this.measureText.textContent = 'Ersten Ort anklicken';
  }

  private clearMeasure() {
    this.measure = [];
    this.overlay.entities.removeAll();
    this.measureText.textContent = this.measuring ? 'Ersten Ort anklicken' : '';
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
      this.measureText.textContent = `${p.name} → zweiten Ort anklicken`;
      return;
    }
    const [a, b] = this.measure;
    const geo = new EllipsoidGeodesic(a.pos, b.pos, Ellipsoid.WGS84);
    const km = geo.surfaceDistance / 1000;
    const mid = Cartographic.toCartesian(geo.interpolateUsingFraction(0.5));
    const text = `${km < 10 ? km.toLocaleString('de-DE', { maximumFractionDigits: 1 }) : fmt(Math.round(km))} km`;
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
    const hours = km / 850 + 0.5; // Reiseflug ~850 km/h plus Start und Landung
    const flight = km > 300 ? ` · mit dem Flugzeug ca. ${hours < 2 ? `${Math.round(hours * 60)} min` : `${Math.round(hours)} h`}` : '';
    this.measureText.textContent = `${a.name} → ${b.name}: ${text} Luftlinie${flight}`;
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
    const sel = document.createElement('span');
    sel.className = 'slider-wrap';
    sel.append(slider, sliderText);
    const cityIco = document.createElement('span');
    cityIco.className = 'bar-ico';
    cityIco.append(icon('city', 20));
    this.measureBtn.className = 'icon-btn';
    this.measureBtn.title = 'Entfernung messen: zwei Orte anklicken (Luftlinie)';
    this.measureBtn.append(icon('ruler', 20));
    this.measureBtn.addEventListener('click', () => this.setMeasuring(!this.measuring));
    this.measureText.className = 'measure-text';
    const close = document.createElement('button');
    close.className = 'icon-btn';
    close.title = 'Zurück zur echten Erde';
    close.append(icon('globe', 20));
    close.addEventListener('click', () => void this.exit());
    this.bar.append(cityIco, sel, this.measureBtn, close, this.measureText);

    this.card.id = 'city-card';
    this.card.className = 'glass hidden';
    const x = document.createElement('button');
    x.className = 'mini card-close';
    x.title = 'Schließen';
    x.append(icon('close', 16));
    x.addEventListener('click', () => this.card.classList.add('hidden'));
    const body = document.createElement('div');
    body.className = 'card-body';
    this.card.append(x, body);
    document.body.append(this.bar, this.card);
  }
}
