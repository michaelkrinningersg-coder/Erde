import { Cartesian2, Cartesian3, Color, HorizontalOrigin, LabelCollection, LabelStyle, VerticalOrigin, type Label, type Scene } from 'cesium';

export interface LabelItem {
  pos: Cartesian3;
  text: string;
  /** Schriftgröße in Pixel (für die Platzschätzung) */
  size: number;
  bold?: boolean;
  italic?: boolean;
  fill: string;
  outline?: string;
  /** sichtbar, wenn die Kamera näher ist (m) */
  range: number;
  /** Vorrang beim Platzverteilen (größer = wichtiger) */
  prio: number;
  /** Abstand nach oben (negativ) bzw. unten (positiv) zum Punkt in Pixel */
  offset?: number;
  /** Platz für ein Symbol am Punkt freihalten (Pixel) */
  mark?: number;
  /** Wird beim Anklicken zurückgegeben */
  id: unknown;
}

interface Source {
  items: LabelItem[];
  show: boolean;
  filter?: (it: LabelItem) => boolean;
}

const MAX_LABELS = 320;
const colorCache = new Map<string, Color>();
const color = (css: string) => {
  let c = colorCache.get(css);
  if (!c) {
    c = Color.fromCssColorString(css);
    colorCache.set(css, c);
  }
  return c;
};

/**
 * Beschriftung aller Ebenen ohne Überlappung: der Reihe nach (wichtigste zuerst) einen freien Platz auf dem
 * Bildschirm suchen. Nur die Vorderseite der Erde, höchstens MAX_LABELS gleichzeitig.
 */
export class LabelManager {
  readonly collection = new LabelCollection();
  private readonly sources = new Map<string, Source>();
  private readonly pool: Label[] = [];
  private dirty = true;
  private last = 0;
  private readonly lastCam = new Cartesian3();
  private readonly lastDir = new Cartesian3();
  active = false;

  constructor(private readonly scene: Scene) {
    scene.primitives.add(this.collection);
    scene.postRender.addEventListener(() => this.maybeUpdate());
  }

  set(key: string, items: LabelItem[], show = true, filter?: (it: LabelItem) => boolean) {
    this.sources.set(key, { items, show, filter });
    this.dirty = true;
  }

  show(key: string, v: boolean) {
    const s = this.sources.get(key);
    if (s && s.show !== v) {
      s.show = v;
      this.dirty = true;
    }
  }

  has(key: string) {
    return this.sources.has(key);
  }

  refresh() {
    this.dirty = true;
  }

  setActive(v: boolean) {
    this.active = v;
    this.collection.show = v;
    this.dirty = true;
  }

  private maybeUpdate() {
    if (!this.active) return;
    const cam = this.scene.camera;
    const moved = !Cartesian3.equalsEpsilon(cam.positionWC, this.lastCam, 0, 1) || !Cartesian3.equalsEpsilon(cam.directionWC, this.lastDir, 1e-6);
    if (!moved && !this.dirty) return;
    const now = performance.now();
    if (now - this.last < 150) return;
    this.last = now;
    Cartesian3.clone(cam.positionWC, this.lastCam);
    Cartesian3.clone(cam.directionWC, this.lastDir);
    this.dirty = false;
    this.update();
  }

  private update() {
    const scene = this.scene;
    const camPos = scene.camera.positionWC;
    const w = scene.canvas.clientWidth;
    const h = scene.canvas.clientHeight;
    // Kandidaten: in Reichweite und auf der Vorderseite (Kugelnäherung)
    const cand: LabelItem[] = [];
    for (const src of this.sources.values()) {
      if (!src.show) continue;
      for (const it of src.items) {
        if (src.filter && !src.filter(it)) continue;
        if (Cartesian3.distance(it.pos, camPos) > it.range) continue;
        if (Cartesian3.dot(it.pos, camPos) <= Cartesian3.magnitudeSquared(it.pos)) continue;
        cand.push(it);
      }
    }
    cand.sort((a, b) => b.prio - a.prio);
    const boxes: number[] = []; // x0, y0, x1, y1 hintereinander
    const free = (x0: number, y0: number, x1: number, y1: number) => {
      for (let i = 0; i < boxes.length; i += 4) {
        if (x0 < boxes[i + 2] && x1 > boxes[i] && y0 < boxes[i + 3] && y1 > boxes[i + 1]) return false;
      }
      return true;
    };
    const s = new Cartesian2();
    let used = 0;
    for (const it of cand) {
      if (used >= MAX_LABELS) break;
      const p = scene.cartesianToCanvasCoordinates(it.pos, s);
      if (!p || p.x < -60 || p.y < -30 || p.x > w + 60 || p.y > h + 30) continue;
      const lines = it.text.split('\n');
      const tw = Math.max(...lines.map((l) => l.length)) * it.size * (it.bold ? 0.6 : 0.55) + 6;
      const th = lines.length * it.size * 1.2 + 2;
      const off = it.offset ?? 0;
      const y0 = off < 0 ? p.y + off - th : off > 0 ? p.y + off : p.y - th / 2;
      if (!free(p.x - tw / 2, y0, p.x + tw / 2, y0 + th)) continue;
      boxes.push(p.x - tw / 2, y0, p.x + tw / 2, y0 + th);
      if (it.mark) boxes.push(p.x - it.mark / 2, p.y - it.mark / 2, p.x + it.mark / 2, p.y + it.mark / 2);
      this.place(used++, it, off);
    }
    for (let i = used; i < this.pool.length; i++) this.pool[i].show = false;
  }

  private place(i: number, it: LabelItem, off: number) {
    let l = this.pool[i];
    if (!l) {
      l = this.collection.add({ position: it.pos, text: it.text, style: LabelStyle.FILL_AND_OUTLINE, outlineWidth: 3, horizontalOrigin: HorizontalOrigin.CENTER });
      this.pool.push(l);
    }
    const font = `${it.italic ? 'italic ' : ''}${it.bold ? '700' : '500'} ${it.size}px system-ui, sans-serif`;
    if (l.text !== it.text) l.text = it.text;
    if (l.font !== font) l.font = font;
    l.fillColor = color(it.fill);
    l.outlineColor = color(it.outline ?? 'rgba(255,255,255,0.92)');
    l.position = it.pos;
    l.verticalOrigin = off < 0 ? VerticalOrigin.BOTTOM : off > 0 ? VerticalOrigin.TOP : VerticalOrigin.CENTER;
    l.pixelOffset = new Cartesian2(0, off);
    l.id = it.id;
    l.show = true;
  }
}

/** Reichweite aus der Natural-Earth-Zoomstufe (ab der ein Name gezeigt wird) */
export const rangeForZoom = (z: number, factor = 1) => (3.4e7 / Math.pow(2, Math.max(0, z - 1.7))) * factor;
