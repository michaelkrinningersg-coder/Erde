import {
  Credit,
  Event,
  GeographicTilingScheme,
  ImageryLayer,
  JulianDate,
  Rectangle,
  type ImageryProvider,
  type Viewer,
} from 'cesium';
import { COLOR_REGIONS, type TimeLayerSpec } from '../config';
import { archiveName, isoTime, type ImageSource } from './cloudUrls';
import type { ImageRequest, ImageResponse } from './cloudWorker';

// Fertige Bilder brauchen viel Speicher; nur wenige bleiben bereit. Die übrigen liegen im
// Browser-Cache und sind dank vorberechneter Karten im Worker in Sekundenbruchteilen neu aufgebaut.
const MAX_DECODED = 6;
const MAX_PARALLEL_BUILDS = 2;

interface Decoded {
  parts: ImageBitmap[];
  inner: ImageBitmap[];
}

interface FrameEntry {
  /** stored = schon einmal erfolgreich geladen (liegt im Browser-Cache) */
  state: 'loading' | 'stored' | 'failed';
  innerRects: Rectangle[];
  decoded?: Decoded;
  loading?: boolean;
  lastUsed: number;
  failedAt?: number;
}

export interface LayerStatus {
  shownFrame?: number; // ms
  latest?: number; // ms
  loading: number;
  /** Anteil des 10-Minuten-Fensters, der schon geladen ist (0…1), falls vorhanden */
  dense?: number;
  error?: string;
}

/** Liefert unser fertiges Bild direkt an Cesium (in Spalten geteilt). */
class BitmapImageryProvider {
  readonly tilingScheme: GeographicTilingScheme;
  readonly rectangle: Rectangle;
  readonly tileWidth: number;
  readonly tileHeight: number;
  readonly maximumLevel = 0;
  readonly minimumLevel = 0;
  readonly tileDiscardPolicy = undefined;
  readonly errorEvent = new Event();
  readonly hasAlphaChannel = true;
  readonly proxy = undefined;
  constructor(
    private readonly parts: ImageBitmap[],
    rect: Rectangle,
    readonly credit: Credit,
  ) {
    this.tilingScheme = new GeographicTilingScheme({ rectangle: rect, numberOfLevelZeroTilesX: parts.length, numberOfLevelZeroTilesY: 1 });
    this.rectangle = rect;
    this.tileWidth = parts[0].width;
    this.tileHeight = parts[0].height;
  }
  getTileCredits() {
    return [];
  }
  requestImage(x: number) {
    return Promise.resolve(this.parts[x]);
  }
  pickFeatures() {
    return undefined;
  }
}

/** Handys und schwache Geräte bekommen die halbe Texturgröße. */
function isLowEnd(viewer: Viewer): boolean {
  const ctx = (viewer.scene as unknown as { context: { _gl: WebGLRenderingContext } }).context;
  const maxTex = ctx._gl.getParameter(ctx._gl.MAX_TEXTURE_SIZE) as number;
  const mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  return mobile || maxTex < 4096 || (navigator.hardwareConcurrency ?? 8) <= 4;
}

/** Reihenfolge aller zeitabhängigen Ebenen auf dem Globus (Ebene, dann Zeit) */
const stackKey = new WeakMap<ImageryLayer, number>();

/**
 * Eine zeitabhängige Bildebene (Wolken weltweit oder Echtfarben):
 *  - grobes Raster (z. B. stündlich) aus dem eigenen Archiv,
 *  - optional ein dichtes 10-Minuten-Fenster für die letzten Stunden, das die App beim Start
 *    selbst direkt beim Anbieter nachlädt (neueste zuerst),
 * wählt passend zur Simulationszeit die zwei nächsten vorhandenen Bilder und blendet weich über.
 */
export class TimeImageLayer {
  private readonly worker = new Worker(new URL('./cloudWorker.ts', import.meta.url), { type: 'module' });
  private readonly source: ImageSource;
  private readonly directSource: ImageSource;
  private readonly step: number;
  private readonly denseStep: number;
  private readonly denseSpan: number;
  private readonly rect: Rectangle;
  private readonly credit: Credit;
  private readonly entries = new Map<number, FrameEntry>();
  /** Je angezeigtem Zeitpunkt: Hauptebene und ggf. Innenebenen (Wolken in Echtfarben-Gebieten) */
  private readonly layers = new Map<number, { main: ImageryLayer; inner: ImageryLayer[] }>();
  private readonly callbacks = new Map<number, (r: ImageResponse) => void>();
  /** Bilder im eigenen Archiv (GitHub Pages), Zeit in ms */
  private readonly archive = new Set<number>();
  private nextId = 1;
  private readonly archiveReady: Promise<void>;
  private building = 0;
  private wanted: number[] = [];
  /** Neuester Zeitpunkt beim Anbieter (genau) und im groben Raster */
  private latestRaw: number;
  private earliest = 0;
  private lastError?: string;
  private shownFrame?: number;
  private visible = true;
  /** Zusätzlicher Faktor für die Deckkraft (z. B. Ausblenden beim nahen Reinzoomen) */
  alphaScale = 1;
  /** Nur Wolken: Sichtbarkeit der Innenebenen am Tag, je Echtfarben-Gebiet (= 1 − dessen Deckkraft) */
  innerDayAlpha: number[] = [];

  onStatus?: (s: LayerStatus) => void;

  constructor(
    private readonly viewer: Viewer,
    private readonly spec: TimeLayerSpec,
  ) {
    const scale = isLowEnd(viewer) ? 0.5 : 1;
    this.source = {
      wms: spec.wms,
      layer: spec.layer,
      format: spec.format,
      rect: spec.rect,
      width: spec.width * scale,
      height: spec.height * scale,
      tilesX: spec.tilesX,
      tilesY: spec.tilesY,
    };
    // Direkt beim Anbieter: kleinere Bilder (schneller), wenn ein 10-Minuten-Fenster festgelegt ist
    const d = spec.dense;
    this.directSource = d
      ? { ...this.source, width: d.width * scale, height: d.height * scale, tilesX: d.tilesX, tilesY: d.tilesY }
      : this.source;
    this.step = spec.stepMinutes * 60_000;
    this.denseStep = (d?.minutes ?? spec.stepMinutes) * 60_000;
    this.denseSpan = (d?.hours ?? 0) * 3_600_000;
    this.rect = Rectangle.fromDegrees(spec.rect.west, spec.rect.south, spec.rect.east, spec.rect.north);
    this.credit = new Credit(spec.credit);
    this.latestRaw = Date.now() - spec.typicalLatencyMinutes * 60_000;
    this.worker.onmessage = (ev: MessageEvent<ImageResponse>) => {
      this.callbacks.get(ev.data.id)?.(ev.data);
      this.callbacks.delete(ev.data.id);
    };
    // Erst die Archivliste abwarten (höchstens 4 s), damit nichts unnötig den langsamen Direktweg nimmt
    this.archiveReady = Promise.race([this.loadArchiveIndex(), new Promise<void>((r) => setTimeout(r, 4000))]);
    void this.refreshLatest();
    setInterval(() => {
      void this.refreshLatest();
      void this.loadArchiveIndex();
    }, 10 * 60_000);
  }

  private get latest() {
    return Math.floor(this.latestRaw / this.denseStep) * this.denseStep;
  }

  private get denseStart() {
    return this.latest - this.denseSpan;
  }

  /** Alle Zeitpunkte, die es geben kann: grobes Raster, dazu das dichte Fenster am Ende */
  private gridPrev(t: number) {
    const coarse = Math.floor(t / this.step) * this.step;
    if (t < this.denseStart) return coarse;
    return Math.max(coarse, Math.floor(t / this.denseStep) * this.denseStep);
  }
  private gridNext(f: number) {
    const s = f >= this.denseStart ? this.denseStep : this.step;
    return Math.floor(f / s) * s + s;
  }

  get show() {
    return this.visible;
  }
  set show(v: boolean) {
    this.visible = v;
    this.refreshLayerState();
  }

  /** Wie stark diese Ebene gerade tatsächlich zu sehen ist (0…1) */
  effectiveAlpha() {
    return this.visible && this.shownFrame !== undefined && this.layers.size > 0 ? this.alphaScale : 0;
  }

  /** Sichtbarkeit und Tages-Deckkraft der Innenebenen an den aktuellen Stand anpassen */
  private refreshLayerState() {
    const show = this.visible && this.alphaScale > 0;
    for (const { main, inner } of this.layers.values()) {
      main.show = show;
      inner.forEach((l, k) => {
        l.show = show;
        l.dayAlpha = this.innerDayAlpha[k] ?? 1;
      });
    }
  }

  /** Frühestes Bild, das geladen werden darf (Rückspulgrenze) */
  setEarliest(ms: number) {
    this.earliest = Math.floor(ms / this.step) * this.step;
  }

  /** Liste der vorab gespeicherten Bilder (wird stündlich von GitHub Actions erneuert) */
  private async loadArchiveIndex() {
    try {
      const res = await fetch(`${this.spec.archive}/index.json`, { cache: 'no-cache' });
      if (!res.ok) return;
      const idx: { frames: string[]; rect?: number[] } = await res.json();
      // Archiv mit anderem Ausschnitt (ältere Version) nicht verwenden
      const r = this.spec.rect;
      if (idx.rect && idx.rect.join() !== [r.west, r.south, r.east, r.north].join()) return;
      for (const f of idx.frames) this.archive.add(Date.parse(f));
      if (this.archive.size) this.latestRaw = Math.max(this.latestRaw, ...this.archive);
    } catch {
      /* kein Archiv (z. B. lokale Entwicklung) → direkt beim Anbieter */
    }
  }

  private archiveUrl(f: number) {
    if (!this.archive.has(f)) return undefined;
    // Absolute Adresse: im Worker würden relative Pfade relativ zum Worker-Skript aufgelöst
    return new URL(`${this.spec.archive}/${archiveName(f)}`, document.baseURI).href;
  }

  /** Fragt beim Anbieter nach, welches das neueste verfügbare Bild ist. */
  private async refreshLatest() {
    if (this.spec.source === 'noaa-fd') return this.refreshLatestNoaa();
    try {
      const res = await fetch(`${this.spec.wms}?service=WMS&version=1.3.0&request=GetCapabilities`);
      const xml = await res.text();
      const at = xml.indexOf(`<Name>${this.spec.layer}</Name>`);
      const dim = /<Dimension name="time"[^>]*>([^<]+)<\/Dimension>/.exec(xml.slice(at));
      const lastInterval = dim?.[1].trim().split(',').pop() ?? '';
      const end = Date.parse(lastInterval.split('/')[1] ?? lastInterval);
      if (at >= 0 && Number.isFinite(end)) this.latestRaw = Math.max(this.latestRaw, end);
    } catch {
      /* Schätzwert bleibt */
    }
  }

  /** NOAA: neuestes Bild aus der Dateiliste des CDN */
  private async refreshLatestNoaa() {
    try {
      const html = await (await fetch(`${this.spec.wms}/`)).text();
      const re = /"(\d{4})(\d{3})(\d{2})(\d{2})_[^"]*\.jpg"/g;
      let m: RegExpExecArray | null;
      let best = 0;
      while ((m = re.exec(html))) {
        const ms =
          Date.UTC(Number(m[1]), 0, 1) + (Number(m[2]) - 1) * 86_400_000 + Number(m[3]) * 3_600_000 + Number(m[4]) * 60_000;
        if (ms > best) best = ms;
      }
      if (best) this.latestRaw = Math.max(this.latestRaw, best);
    } catch {
      /* Schätzwert bleibt */
    }
  }

  /** Jedes Bild der Simulation: passende Bilder wählen, laden und überblenden. */
  update(time: JulianDate, multiplier: number) {
    const t = JulianDate.toDate(time).getTime();
    const tc = Math.min(Math.max(t, this.earliest), this.latest);
    const dir = multiplier < 0 ? -1 : 1;

    if (this.visible) {
      // Benötigt: die Rasterpunkte um die aktuelle Zeit (dicht und grob), dann in Abspielrichtung
      const p = this.gridPrev(tc);
      const n = Math.min(this.gridNext(p), this.latest);
      const coarseP = Math.floor(tc / this.step) * this.step;
      // Rückfall: das letzte Archivbild davor (sofort verfügbar, falls das genaue Bild noch fehlt)
      let fallback: number | undefined;
      for (const f of this.archive) if (f <= tc && f > tc - 2 * this.step && (fallback === undefined || f > fallback)) fallback = f;
      const wanted = [
        ...(fallback !== undefined ? [fallback] : []),
        p,
        n,
        dir > 0 ? this.gridNext(n) : this.gridPrev(p - 1),
        coarseP,
        coarseP + this.step,
      ];
      this.wanted = [...new Set(wanted)].filter((f) => f >= this.earliest && f <= this.latest);
      this.pump();
    }

    // Die nächsten vorhandenen Bilder vor und nach der aktuellen Zeit (höchstens ein grobes Raster auseinander)
    let f0: number | undefined;
    let f1: number | undefined;
    for (const [f, e] of this.entries) {
      if (e.state !== 'stored') continue;
      if (f <= tc && f > tc - 2 * this.step && (f0 === undefined || f > f0)) f0 = f;
      if (f >= tc && f < tc + this.step && (f1 === undefined || f < f1)) f1 = f;
    }
    if (f0 !== undefined && f1 !== undefined && f1 - f0 > this.step) {
      // Lücke zu groß zum Überblenden: das zeitlich nähere Bild nehmen
      if (tc - f0 > f1 - tc) f0 = undefined;
      else f1 = undefined;
    }
    for (const f of [f0, f1]) if (f !== undefined) this.ensureDecoded(f);

    const ready = (f: number | undefined): f is number => f !== undefined && !!this.entries.get(f)?.decoded;
    let desired: [number, number][] = [];
    if (ready(f0) && ready(f1) && f1 !== f0) {
      // Überblendung: in der Mitte sind beide Bilder voll sichtbar → kein „Ausdünnen“
      const frac = (tc - f0) / (f1 - f0);
      desired = [
        [f0, Math.min(1, 2 * (1 - frac))],
        [f1, Math.min(1, 2 * frac)],
      ];
    } else if (ready(f0)) desired = [[f0, 1]];
    else if (ready(f1)) desired = [[f1, 1]];

    if (desired.length) this.applyLayers(desired);
    else this.refreshLayerState(); // noch nichts da → bisherige Anzeige stehen lassen

    this.onStatus?.({
      shownFrame: this.shownFrame,
      latest: this.latest,
      loading: this.building,
      dense: this.denseSpan ? this.denseProgress() : undefined,
      error: this.lastError,
    });
  }

  private denseProgress() {
    let have = 0;
    let all = 0;
    for (let f = this.latest; f > this.denseStart; f -= this.denseStep) {
      all++;
      if (this.entries.get(f)?.state === 'stored') have++;
    }
    return all ? have / all : 1;
  }

  /** Bild bereitstellen: ist es nicht mehr im Speicher, aus dem Browser-Cache neu aufbauen */
  private ensureDecoded(f: number) {
    const e = this.entries.get(f);
    if (!e || e.decoded || e.state !== 'stored' || this.building >= MAX_PARALLEL_BUILDS) return;
    void this.build(f);
  }

  private applyLayers(desired: [number, number][]) {
    const keep = new Set(desired.map(([f]) => f));
    for (const [f, l] of this.layers) {
      if (!keep.has(f)) {
        this.viewer.imageryLayers.remove(l.main, true);
        for (const inner of l.inner) this.viewer.imageryLayers.remove(inner, true);
        this.layers.delete(f);
      }
    }
    for (const [f, alpha] of desired) {
      let l = this.layers.get(f);
      const entry = this.entries.get(f)!;
      if (!l) {
        const dec = entry.decoded!;
        const provider = new BitmapImageryProvider(dec.parts, this.rect, this.credit);
        const main = new ImageryLayer(provider as unknown as ImageryProvider, { alpha, nightAlpha: this.spec.nightAlpha });
        this.insertOrdered(main, this.spec.zIndex * 1e13 + f);
        l = { main, inner: [] };
        for (const [k, bmp] of dec.inner.entries()) {
          const p = new BitmapImageryProvider([bmp], entry.innerRects[k], this.credit);
          const inner = new ImageryLayer(p as unknown as ImageryProvider, { alpha, dayAlpha: this.innerDayAlpha[k] ?? 1, nightAlpha: 1 });
          this.insertOrdered(inner, this.spec.zIndex * 1e13 + f + 1);
          l.inner.push(inner);
        }
        this.layers.set(f, l);
      }
      l.main.alpha = alpha * this.alphaScale;
      for (const inner of l.inner) inner.alpha = alpha * this.alphaScale;
      entry.lastUsed = performance.now();
    }
    this.refreshLayerState();
    this.shownFrame = desired.reduce((a, b) => (b[1] >= a[1] ? b : a))[0];
  }

  /** An der richtigen Stelle einfügen: Grundkarten unten, dann nach Ebene und Zeit sortiert */
  private insertOrdered(layer: ImageryLayer, key: number) {
    const coll = this.viewer.imageryLayers;
    let index = 0;
    for (let i = 0; i < coll.length; i++) if ((stackKey.get(coll.get(i)) ?? -Infinity) < key) index = i + 1;
    stackKey.set(layer, key);
    coll.add(layer, index);
  }

  /**
   * Startet Ladeaufträge (begrenzt parallel): zuerst, was gerade gebraucht wird,
   * danach im Hintergrund das 10-Minuten-Fenster (neueste zuerst).
   */
  private pump() {
    const tryBuild = (f: number) => {
      if (this.building >= MAX_PARALLEL_BUILDS) return false;
      const e = this.entries.get(f);
      if (e && (e.state === 'stored' || e.loading)) return true;
      if (e?.state === 'failed' && performance.now() - (e.failedAt ?? 0) < 120_000) return true;
      void this.build(f);
      return true;
    };
    for (const f of this.wanted) if (!tryBuild(f)) return;
    if (!this.visible || !this.denseSpan) return;
    for (let f = this.latest; f > this.denseStart && f >= this.earliest; f -= this.denseStep) {
      if (!tryBuild(f)) return;
    }
  }

  private async build(f: number) {
    const entry: FrameEntry = this.entries.get(f) ?? { state: 'loading', lastUsed: performance.now(), innerRects: [] };
    if (entry.loading) return;
    entry.loading = true;
    this.entries.set(f, entry);
    this.building++;
    await this.archiveReady;
    const id = this.nextId++;
    const archiveUrl = this.archiveUrl(f);
    const src = archiveUrl ? this.source : this.directSource;
    const res = await new Promise<ImageResponse>((resolve) => {
      this.callbacks.set(id, resolve);
      this.worker.postMessage({
        ...src,
        id,
        time: isoTime(f),
        mode: this.spec.mode,
        splitX: this.spec.splitX,
        archiveUrl,
        regions: this.spec.cutouts ?? COLOR_REGIONS,
        region: this.spec.region,
        splitRegions: !!this.spec.cutouts,
        noaa:
          this.spec.source === 'noaa-fd' && this.spec.region !== undefined
            ? { base: this.spec.wms, product: this.spec.layer.replace('5424x5424', '1808x1808'), satLon: COLOR_REGIONS[this.spec.region].satLon }
            : undefined,
      } satisfies ImageRequest);
    });
    this.building--;
    entry.loading = false;
    if (res.ok) {
      entry.state = 'stored';
      entry.decoded = { parts: res.parts, inner: res.inner.map((i) => i.bitmap) };
      entry.innerRects = res.inner.map(({ rect: r }) => Rectangle.fromDegrees(r.west, r.south, r.east, r.north));
      this.lastError = undefined;
      this.trimDecoded();
    } else {
      entry.state = 'failed';
      entry.failedAt = performance.now();
      this.lastError = res.error;
      console.warn(`${this.spec.name}: Bild fehlgeschlagen`, isoTime(f), res.error);
    }
    this.pump();
  }

  /** Entpackte Bilder freigeben, die nicht angezeigt werden */
  private trimDecoded() {
    const list = [...this.entries].filter(([f, e]) => e.decoded && !this.layers.has(f));
    const excess = list.length + this.layers.size - MAX_DECODED;
    if (excess <= 0) return;
    list.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [, e] of list.slice(0, excess)) {
      e.decoded!.parts.forEach((b) => b.close());
      e.decoded!.inner.forEach((b) => b.close());
      e.decoded = undefined;
    }
  }

}
