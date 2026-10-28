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
import type { TimeLayerSpec } from '../config';
import { archiveName, isoTime, wmsTileUrls, type ImageSource } from './cloudUrls';
import type { ImageRequest, ImageResponse } from './cloudWorker';

const MAX_DECODED = 5; // so viele fertige Bilder bleiben je Ebene im Speicher
const MAX_PARALLEL_BUILDS = 2;
const WARM_FRAMES = 8; // so viele Zeitschritte in Abspielrichtung werden vorab in den Browser-Cache geladen

interface FrameEntry {
  state: 'loading' | 'ready' | 'failed';
  parts?: ImageBitmap[];
  lastUsed: number;
  failedAt?: number;
}

export interface LayerStatus {
  shownFrame?: number; // ms
  latest?: number; // ms
  loading: number;
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
 * Eine zeitabhängige Bildebene (Wolken weltweit oder Echtfarben Europa):
 * wählt passend zur Simulationszeit zwei Bilder, lädt sie (Archiv oder EUMETSAT direkt),
 * blendet weich über und lädt in Abspielrichtung vor.
 */
export class TimeImageLayer {
  private readonly worker = new Worker(new URL('./cloudWorker.ts', import.meta.url), { type: 'module' });
  private readonly source: ImageSource;
  private readonly step: number;
  private readonly rect: Rectangle;
  private readonly credit: Credit;
  private readonly entries = new Map<number, FrameEntry>();
  private readonly layers = new Map<number, ImageryLayer>();
  private readonly callbacks = new Map<number, (r: ImageResponse) => void>();
  private readonly warmed = new Set<number>();
  /** Bilder im eigenen Archiv (GitHub Pages), Zeit in ms */
  private readonly archive = new Set<number>();
  private warming = 0;
  private nextId = 1;
  private building = 0;
  private wanted: number[] = [];
  private latest: number;
  private earliest = 0;
  private lastError?: string;
  private shownFrame?: number;
  private visible = true;
  /** Zusätzlicher Faktor für die Deckkraft (z. B. Ausblenden beim nahen Reinzoomen) */
  alphaScale = 1;

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
    this.step = spec.stepMinutes * 60_000;
    this.rect = Rectangle.fromDegrees(spec.rect.west, spec.rect.south, spec.rect.east, spec.rect.north);
    this.credit = new Credit(spec.credit);
    this.latest = this.floor(Date.now() - spec.typicalLatencyMinutes * 60_000);
    this.worker.onmessage = (ev: MessageEvent<ImageResponse>) => {
      this.callbacks.get(ev.data.id)?.(ev.data);
      this.callbacks.delete(ev.data.id);
    };
    const refresh = () => {
      void this.refreshLatest();
      void this.loadArchiveIndex();
    };
    refresh();
    setInterval(refresh, 20 * 60_000);
  }

  private floor(ms: number) {
    return Math.floor(ms / this.step) * this.step;
  }

  get show() {
    return this.visible;
  }
  set show(v: boolean) {
    this.visible = v;
    for (const l of this.layers.values()) l.show = v && this.alphaScale > 0;
  }

  /** Frühestes Bild, das geladen werden darf (Rückspulgrenze) */
  setEarliest(ms: number) {
    this.earliest = this.floor(ms);
  }

  /** Liste der vorab gespeicherten Bilder (wird stündlich von GitHub Actions erneuert) */
  private async loadArchiveIndex() {
    try {
      const res = await fetch(`${this.spec.archive}/index.json`, { cache: 'no-cache' });
      if (!res.ok) return;
      const idx: { frames: string[] } = await res.json();
      for (const f of idx.frames) this.archive.add(Date.parse(f));
      if (this.archive.size) this.latest = Math.max(this.latest, ...this.archive);
    } catch {
      /* kein Archiv (z. B. lokale Entwicklung) → direkt von EUMETSAT */
    }
  }

  private archiveUrl(f: number) {
    if (!this.archive.has(f)) return undefined;
    // Absolute Adresse: im Worker würden relative Pfade relativ zum Worker-Skript aufgelöst
    return new URL(`${this.spec.archive}/${archiveName(f)}`, document.baseURI).href;
  }

  /** Fragt beim Dienst nach, welches das neueste verfügbare Bild ist. */
  private async refreshLatest() {
    try {
      const res = await fetch(`${this.spec.wms}?service=WMS&version=1.3.0&request=GetCapabilities`);
      const xml = await res.text();
      const at = xml.indexOf(`<Name>${this.spec.layer}</Name>`);
      const dim = /<Dimension name="time"[^>]*>([^<]+)<\/Dimension>/.exec(xml.slice(at));
      const lastInterval = dim?.[1].trim().split(',').pop() ?? '';
      const end = Date.parse(lastInterval.split('/')[1] ?? lastInterval);
      if (at >= 0 && Number.isFinite(end)) this.latest = Math.max(this.latest, this.floor(end));
    } catch {
      /* Schätzwert bleibt */
    }
  }

  /** Jedes Bild der Simulation: passende Bilder wählen, laden und überblenden. */
  update(time: JulianDate, multiplier: number) {
    const STEP = this.step;
    const t = JulianDate.toDate(time).getTime();
    const tc = Math.min(Math.max(t, this.earliest), this.latest);
    const f0 = this.floor(tc);
    const f1 = Math.min(f0 + STEP, this.latest);
    const frac = f1 > f0 ? (tc - f0) / STEP : 0;
    const dir = multiplier < 0 ? -1 : 1;

    // Benötigt: aktuelle zwei Bilder, dann das nächste in Abspielrichtung
    const ahead = dir > 0 ? f1 + STEP : f0 - STEP;
    if (this.visible) {
      this.wanted = [f0, f1, ahead].filter((f) => f >= this.earliest && f <= this.latest);
      this.pump();
      this.warmCache(dir > 0 ? f1 : f0, dir);
    }

    const ready = (f: number) => this.entries.get(f)?.state === 'ready';
    let desired: [number, number][];
    if (ready(f0) && ready(f1) && f1 !== f0) {
      // Überblendung: in der Mitte sind beide Bilder voll sichtbar → kein „Ausdünnen“
      desired = [
        [f0, Math.min(1, 2 * (1 - frac))],
        [f1, Math.min(1, 2 * frac)],
      ];
    } else if (ready(f0)) desired = [[f0, 1]];
    else if (ready(f1)) desired = [[f1, 1]];
    else desired = []; // noch nichts da → bisherige Anzeige stehen lassen

    if (desired.length) this.applyLayers(desired);
    else for (const l of this.layers.values()) l.show = this.visible && this.alphaScale > 0;
    this.onStatus?.({
      shownFrame: this.shownFrame,
      latest: this.latest,
      loading: this.building + this.warming,
      error: this.lastError,
    });
  }

  private applyLayers(desired: [number, number][]) {
    const keep = new Set(desired.map(([f]) => f));
    for (const [f, layer] of this.layers) {
      if (!keep.has(f)) {
        this.viewer.imageryLayers.remove(layer, true);
        this.layers.delete(f);
      }
    }
    for (const [f, alpha] of desired) {
      let layer = this.layers.get(f);
      if (!layer) {
        const entry = this.entries.get(f)!;
        const provider = new BitmapImageryProvider(entry.parts!, this.rect, this.credit);
        layer = new ImageryLayer(provider as unknown as ImageryProvider, { alpha, nightAlpha: this.spec.nightAlpha });
        this.insertOrdered(layer, this.spec.zIndex * 1e13 + f);
        this.layers.set(f, layer);
      }
      layer.alpha = alpha * this.alphaScale;
      layer.show = this.visible && this.alphaScale > 0;
      this.entries.get(f)!.lastUsed = performance.now();
    }
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

  /** Startet Ladeaufträge für benötigte Bilder (begrenzt parallel). */
  private pump() {
    for (const f of this.wanted) {
      if (this.building >= MAX_PARALLEL_BUILDS) return;
      const e = this.entries.get(f);
      if (e && (e.state === 'ready' || e.state === 'loading')) continue;
      if (e?.state === 'failed' && performance.now() - (e.failedAt ?? 0) < 60_000) continue;
      void this.build(f);
    }
  }

  private async build(f: number) {
    const entry: FrameEntry = { state: 'loading', lastUsed: performance.now() };
    this.entries.set(f, entry);
    this.building++;
    const id = this.nextId++;
    const res = await new Promise<ImageResponse>((resolve) => {
      this.callbacks.set(id, resolve);
      this.worker.postMessage({
        ...this.source,
        id,
        time: isoTime(f),
        mode: this.spec.mode,
        splitX: this.spec.splitX,
        archiveUrl: this.archiveUrl(f),
      } satisfies ImageRequest);
    });
    this.building--;
    if (res.ok) {
      entry.state = 'ready';
      entry.parts = res.parts;
      this.lastError = undefined;
      this.evict();
    } else {
      entry.state = 'failed';
      entry.failedAt = performance.now();
      this.lastError = res.error;
      console.warn(`${this.spec.name}: Bild fehlgeschlagen`, isoTime(f), res.error);
    }
    this.pump();
  }

  /** Alte, nicht angezeigte Bilder freigeben. */
  private evict() {
    const ready = [...this.entries].filter(([f, e]) => e.state === 'ready' && !this.layers.has(f));
    const excess = ready.length + this.layers.size - MAX_DECODED;
    if (excess <= 0) return;
    ready.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [f, e] of ready.slice(0, excess)) {
      e.parts?.forEach((b) => b.close());
      this.entries.delete(f);
    }
  }

  /** Lädt kommende Zeitschritte schon einmal in den Browser-Cache (ohne sie zu dekodieren). */
  private warmCache(from: number, dir: number) {
    if (this.warming > 0) return;
    for (let k = 1; k <= WARM_FRAMES; k++) {
      const f = from + dir * k * this.step;
      if (f < this.earliest || f > this.latest || this.warmed.has(f)) continue;
      this.warmed.add(f);
      const archived = this.archiveUrl(f);
      const urls = archived ? [archived] : wmsTileUrls(this.source, isoTime(f)).map((u) => u.url);
      this.warming++;
      void Promise.allSettled(
        urls.map((u) => fetch(u, { priority: 'low' } as RequestInit).then((r) => r.blob())),
      ).finally(() => this.warming--);
      return; // eins nach dem anderen, um den Dienst zu schonen
    }
  }
}
