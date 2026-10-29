import { Event, GeographicTilingScheme, ImageryLayer, Math as CesiumMath, type ImageryLayerCollection, type ImageryProvider } from 'cesium';
import type { BBox, Line, Poly } from './geo';

/** Was eine Kachel zum Zeichnen braucht: Ausschnitt in 1/scale Grad und Maßstab (Pixel je Einheit) */
export interface TileView {
  g: CanvasRenderingContext2D;
  w: number;
  s: number;
  e: number;
  n: number;
  k: number;
  level: number;
  visible: (b: BBox) => boolean;
}

export type TileDraw = (t: TileView) => void;

/** Bis zu dieser Kachelstufe reichen die groben Umrisse (Stufe 3 ≈ 0,04° pro Pixel) */
export const COARSE_MAX_LEVEL = 3;
const SIZE = 512;

/**
 * Kacheln, die im Browser auf Canvas gezeichnet werden (scharf in jeder Zoomstufe, kein Server).
 * Koordinaten in 1/scale Grad, y = −Breite.
 */
class CanvasTiles {
  readonly tilingScheme = new GeographicTilingScheme();
  readonly rectangle = this.tilingScheme.rectangle;
  readonly tileWidth = SIZE;
  readonly tileHeight = SIZE;
  readonly minimumLevel = 0;
  readonly maximumLevel = 17;
  readonly tileDiscardPolicy = undefined;
  readonly errorEvent = new Event();
  readonly credit = undefined;
  readonly proxy = undefined;

  constructor(
    private readonly scale: number,
    private readonly draw: TileDraw,
    readonly hasAlphaChannel: boolean,
    private readonly background?: string,
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
    c.width = c.height = SIZE;
    const g = c.getContext('2d')!;
    if (this.background) {
      g.fillStyle = this.background;
      g.fillRect(0, 0, SIZE, SIZE);
    }
    const k = SIZE / (e - w);
    g.setTransform(k, 0, 0, k, -w * k, n * k);
    const pad = 4 / k;
    const visible = (b: BBox) => b[0] <= e + pad && b[2] >= w - pad && b[1] <= n + pad && b[3] >= s - pad;
    this.draw({ g, w, s, e, n, k, level, visible });
    return Promise.resolve(c);
  }
}

/** Eine Canvas-Kachelebene, die sich neu zeichnen lässt (z. B. andere Einfärbung) */
export class CanvasLayer {
  layer?: ImageryLayer;
  private shown = false;

  constructor(
    private readonly layers: ImageryLayerCollection,
    private readonly scale: number,
    private draw: TileDraw,
    private readonly opaque = false,
    private readonly background?: string,
  ) {}

  get show() {
    return this.shown;
  }

  set show(v: boolean) {
    this.shown = v;
    if (v && !this.layer) this.create();
    if (this.layer) this.layer.show = v;
  }

  /** Neu zeichnen: Ebene an gleicher Stelle austauschen (Cesium merkt sich fertige Kacheln) */
  redraw(draw?: TileDraw) {
    if (draw) this.draw = draw;
    if (!this.layer) return;
    const idx = this.layers.indexOf(this.layer);
    this.layers.remove(this.layer, true);
    this.layer = undefined;
    this.create(idx);
  }

  raise() {
    if (this.layer) this.layers.raiseToTop(this.layer);
  }

  private create(index?: number) {
    const provider = new CanvasTiles(this.scale, this.draw, !this.opaque, this.background);
    this.layer = new ImageryLayer(provider as unknown as ImageryProvider, { show: this.shown });
    this.layers.add(this.layer, index);
  }
}

/** Polygone füllen (gerade/ungerade, damit Löcher frei bleiben) */
export function fillPolys(t: TileView, polys: Poly[], color: string) {
  t.g.fillStyle = color;
  for (const p of polys) if (t.visible(p.bbox)) t.g.fill(p.path, 'evenodd');
}

export function strokePolys(t: TileView, polys: Poly[], color: string, px: number) {
  t.g.strokeStyle = color;
  t.g.lineWidth = px / t.k;
  t.g.lineJoin = 'round';
  for (const p of polys) if (t.visible(p.bbox)) t.g.stroke(p.path);
}

/** Linien mit optionalem dunklem Rand darunter (gut sichtbar auf Satellitenbildern) */
export function strokeLines(t: TileView, lines: Line[], color: string, px: number, halo?: string, dash?: number[]) {
  const shown = lines.filter((l) => t.visible(l.bbox));
  const g = t.g;
  g.lineJoin = 'round';
  g.lineCap = 'round';
  if (halo) {
    g.strokeStyle = halo;
    g.lineWidth = (px + 2) / t.k;
    g.setLineDash([]);
    for (const l of shown) g.stroke(l.path);
  }
  g.strokeStyle = color;
  g.lineWidth = px / t.k;
  g.setLineDash(dash ? dash.map((d) => d / t.k) : []);
  for (const l of shown) g.stroke(l.path);
  g.setLineDash([]);
}

/** Linienbreite je Zoomstufe */
export const widthFor = (level: number, base = 1) => base * (level >= 8 ? 2 : level >= 5 ? 1.6 : 1.1);
