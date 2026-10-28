import {
  Credit,
  Event,
  GeographicTilingScheme,
  ImageryLayer,
  JulianDate,
  type ImageryProvider,
  type Viewer,
} from 'cesium';
import { CLOUDS } from '../config';
import { cloudTileUrls, isoTime, type CloudSource } from './cloudUrls';
import type { CloudRequest, CloudResponse } from './cloudWorker';

const STEP = CLOUDS.stepHours * 3600_000;
const MAX_DECODED = 5; // so viele fertige Wolkenbilder bleiben im Speicher
const MAX_PARALLEL_BUILDS = 2;
const WARM_FRAMES = 8; // so viele Zeitschritte in Abspielrichtung werden vorab in den Browser-Cache geladen

interface CloudFrame {
  halves: [ImageBitmap, ImageBitmap];
}

interface FrameEntry {
  state: 'queued' | 'loading' | 'ready' | 'failed';
  frame?: CloudFrame;
  lastUsed: number;
  failedAt?: number;
}

export interface CloudStatus {
  shownFrame?: number; // ms
  latest?: number; // ms
  loading: number;
  error?: string;
}

/** Liefert unser fertiges Bild direkt an Cesium (zwei Kacheln: West- und Osthalbkugel). */
class BitmapImageryProvider {
  readonly tilingScheme = new GeographicTilingScheme();
  readonly rectangle = this.tilingScheme.rectangle;
  readonly tileWidth: number;
  readonly tileHeight: number;
  readonly maximumLevel = 0;
  readonly minimumLevel = 0;
  readonly tileDiscardPolicy = undefined;
  readonly errorEvent = new Event();
  readonly hasAlphaChannel = true;
  readonly proxy = undefined;
  constructor(
    private readonly halves: [ImageBitmap, ImageBitmap],
    readonly credit: Credit,
  ) {
    this.tileWidth = halves[0].width;
    this.tileHeight = halves[0].height;
  }
  getTileCredits() {
    return [];
  }
  requestImage(x: number) {
    return Promise.resolve(this.halves[x]);
  }
  pickFeatures() {
    return undefined;
  }
}

/** Wählt eine Texturgröße, die das Gerät flüssig schafft. */
function pickTextureWidth(viewer: Viewer): number {
  const ctx = (viewer.scene as unknown as { context: { _gl: WebGLRenderingContext } }).context;
  const maxTex = ctx._gl.getParameter(ctx._gl.MAX_TEXTURE_SIZE) as number;
  const mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  if (mobile || maxTex < 4096 || (navigator.hardwareConcurrency ?? 8) <= 4) return 2048;
  return CLOUDS.textureWidth;
}

export class CloudLayer {
  private readonly worker = new Worker(new URL('./cloudWorker.ts', import.meta.url), { type: 'module' });
  private readonly source: CloudSource;
  private readonly credit = new Credit(CLOUDS.credit);
  private readonly entries = new Map<number, FrameEntry>();
  private readonly layers = new Map<number, ImageryLayer>();
  private readonly callbacks = new Map<number, (r: CloudResponse) => void>();
  private readonly warmed = new Set<number>();
  private warming = 0;
  private nextId = 1;
  private building = 0;
  private wanted: number[] = [];
  private latest: number;
  private earliest = 0;
  private lastError?: string;
  private shownFrame?: number;
  private visible = true;
  /** Bilder im eigenen Archiv (GitHub Pages), Zeit in ms */
  private readonly archive = new Set<number>();

  onStatus?: (s: CloudStatus) => void;

  constructor(private readonly viewer: Viewer) {
    const width = pickTextureWidth(viewer);
    this.source = { wms: CLOUDS.wms, layer: CLOUDS.layer, width, tile: width / CLOUDS.tilesAcross };
    this.latest = Math.floor((Date.now() - CLOUDS.typicalLatencyHours * 3600_000) / STEP) * STEP;
    this.worker.onmessage = (ev: MessageEvent<CloudResponse>) => {
      this.callbacks.get(ev.data.id)?.(ev.data);
      this.callbacks.delete(ev.data.id);
    };
    void this.refreshLatest();
    void this.loadArchiveIndex();
    setInterval(() => {
      void this.refreshLatest();
      void this.loadArchiveIndex();
    }, 20 * 60_000);
  }

  /** Liste der vorab gespeicherten Wolkenbilder (wird stündlich von GitHub Actions erneuert) */
  private async loadArchiveIndex() {
    try {
      const res = await fetch(`${CLOUDS.archive}/index.json`, { cache: 'no-cache' });
      if (!res.ok) return;
      const idx: { frames: string[] } = await res.json();
      for (const f of idx.frames) this.archive.add(Date.parse(f));
      const newest = Math.max(...this.archive);
      if (newest > this.latest) this.latest = newest;
    } catch {
      /* kein Archiv (z. B. lokale Entwicklung) → direkt von EUMETSAT */
    }
  }

  private archiveUrl(f: number) {
    if (!this.archive.has(f)) return undefined;
    const name = isoTime(f).replace(/[-:]/g, '').replace(/00Z$/, 'Z');
    // Absolute Adresse: im Worker würden relative Pfade relativ zum Worker-Skript aufgelöst
    return new URL(`${CLOUDS.archive}/${name}.webp`, document.baseURI).href;
  }

  get show() {
    return this.visible;
  }
  set show(v: boolean) {
    this.visible = v;
    for (const l of this.layers.values()) l.show = v;
  }

  /** Frühestes Bild, das geladen werden darf (Rückspulgrenze) */
  setEarliest(ms: number) {
    this.earliest = Math.floor(ms / STEP) * STEP;
  }

  /** Fragt beim Dienst nach, welches das neueste verfügbare Wolkenbild ist. */
  private async refreshLatest() {
    try {
      const res = await fetch(`${CLOUDS.wms}?service=WMS&version=1.3.0&request=GetCapabilities`);
      const xml = await res.text();
      const at = xml.indexOf(`<Name>${CLOUDS.layer}</Name>`);
      const dim = /<Dimension name="time"[^>]*>([^<]+)<\/Dimension>/.exec(xml.slice(at));
      const lastInterval = dim?.[1].trim().split(',').pop() ?? '';
      const end = Date.parse(lastInterval.split('/')[1] ?? lastInterval);
      if (at >= 0 && Number.isFinite(end)) this.latest = Math.max(this.latest, Math.floor(end / STEP) * STEP);
    } catch {
      /* Schätzwert bleibt */
    }
  }

  /** Jedes Bild der Simulation: passende Wolkenbilder wählen, laden und überblenden. */
  update(time: JulianDate, multiplier: number) {
    const t = JulianDate.toDate(time).getTime();
    const tc = Math.min(Math.max(t, this.earliest), this.latest);
    const f0 = Math.floor(tc / STEP) * STEP;
    const f1 = Math.min(f0 + STEP, this.latest);
    const frac = f1 > f0 ? (tc - f0) / STEP : 0;
    const dir = multiplier < 0 ? -1 : 1;

    // Benötigt: aktuelle zwei Bilder, dann das nächste in Abspielrichtung
    const ahead = dir > 0 ? f1 + STEP : f0 - STEP;
    this.wanted = [f0, f1, ahead].filter((f) => f >= this.earliest && f <= this.latest);
    this.pump();
    this.warmCache(dir > 0 ? f1 : f0, dir);

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
        const provider = new BitmapImageryProvider(entry.frame!.halves, this.credit);
        layer = new ImageryLayer(provider as unknown as ImageryProvider, { alpha });
        layer.show = this.visible;
        this.viewer.imageryLayers.add(layer);
        this.layers.set(f, layer);
      }
      layer.alpha = alpha;
      this.entries.get(f)!.lastUsed = performance.now();
    }
    // Späteres Bild immer oben
    for (const [f] of [...desired].sort((a, b) => a[0] - b[0])) this.viewer.imageryLayers.raiseToTop(this.layers.get(f)!);
    this.shownFrame = desired.reduce((a, b) => (b[1] >= a[1] ? b : a))[0];
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
    const res = await new Promise<CloudResponse>((resolve) => {
      this.callbacks.set(id, resolve);
      this.worker.postMessage({ ...this.source, id, time: isoTime(f), archiveUrl: this.archiveUrl(f) } satisfies CloudRequest);
    });
    this.building--;
    if (res.ok) {
      entry.state = 'ready';
      entry.frame = { halves: [res.left, res.right] };
      this.lastError = undefined;
      this.evict();
    } else {
      entry.state = 'failed';
      entry.failedAt = performance.now();
      this.lastError = res.error;
      console.warn('Wolkenbild fehlgeschlagen', isoTime(f), res.error);
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
      e.frame?.halves.forEach((b) => b.close());
      this.entries.delete(f);
    }
  }

  /** Lädt kommende Zeitschritte schon einmal in den Browser-Cache (ohne sie zu dekodieren). */
  private warmCache(from: number, dir: number) {
    if (this.warming > 0) return;
    for (let k = 1; k <= WARM_FRAMES; k++) {
      const f = from + dir * k * STEP;
      if (f < this.earliest || f > this.latest || this.warmed.has(f)) continue;
      this.warmed.add(f);
      const archived = this.archiveUrl(f);
      const urls = archived ? [archived] : cloudTileUrls(this.source, isoTime(f)).map((u) => u.url);
      this.warming++;
      void Promise.allSettled(
        urls.map((u) => fetch(u, { priority: 'low' } as RequestInit).then((r) => r.blob())),
      ).finally(() => this.warming--);
      return; // eins nach dem anderen, um den Dienst zu schonen
    }
  }
}
