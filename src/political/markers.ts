import { BillboardCollection, Cartesian3, DistanceDisplayCondition, NearFarScalar, VerticalOrigin, type Scene } from 'cesium';
import type { LabelItem, LabelManager } from './labels';

// ── Symbole (selbst gezeichnet, keine Bilddateien) ──────────────────────────

const iconCache = new Map<string, HTMLCanvasElement>();

function canvasIcon(key: string, size: number, draw: (g: CanvasRenderingContext2D, s: number) => void) {
  let c = iconCache.get(key);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = c.height = size * 2;
  const g = c.getContext('2d')!;
  g.scale(2, 2);
  draw(g, size);
  iconCache.set(key, c);
  return c;
}

const disc = (g: CanvasRenderingContext2D, s: number, fill: string) => {
  g.beginPath();
  g.arc(s / 2, s / 2, s / 2 - 1.2, 0, Math.PI * 2);
  g.fillStyle = fill;
  g.fill();
  g.lineWidth = 1.6;
  g.strokeStyle = '#fff';
  g.stroke();
};

export type MarkerIcon =
  | 'capital'
  | 'seat'
  | 'peak'
  | 'deep'
  | 'wonder'
  | 'building'
  | 'unesco'
  | 'volcano'
  | 'volcanoActive'
  | 'park'
  | 'summit'
  | 'waterfall'
  | 'extreme'
  | 'airport'
  | 'port'
  | 'canal'
  | 'own'
  | 'pin';

export function markerIcon(kind: MarkerIcon): HTMLCanvasElement {
  switch (kind) {
    case 'capital':
    case 'seat':
      // Atlas-Zeichen: Hauptstadt Kreis mit Punkt, weitere Sitze Quadrat mit Punkt
      return canvasIcon(kind, 18, (g, s) => {
        g.translate(s / 2, s / 2);
        g.beginPath();
        if (kind === 'seat') g.rect(-6.2, -6.2, 12.4, 12.4);
        else g.arc(0, 0, 7, 0, Math.PI * 2);
        g.fillStyle = '#fff';
        g.fill();
        g.lineWidth = 2.4;
        g.strokeStyle = '#a3001b';
        g.stroke();
        g.beginPath();
        g.arc(0, 0, 3, 0, Math.PI * 2);
        g.fillStyle = '#a3001b';
        g.fill();
      });
    case 'peak':
    case 'summit':
      return canvasIcon(kind, 22, (g) => {
        g.beginPath();
        g.moveTo(2, 19);
        g.lineTo(11, 3);
        g.lineTo(20, 19);
        g.closePath();
        g.fillStyle = kind === 'peak' ? '#7a5134' : '#5b3f8f';
        g.strokeStyle = '#fff';
        g.lineWidth = 1.6;
        g.fill();
        g.stroke();
        g.beginPath();
        g.moveTo(11, 3);
        g.lineTo(7.2, 9.8);
        g.lineTo(9.4, 8.8);
        g.lineTo(11, 10.2);
        g.lineTo(12.8, 8.8);
        g.lineTo(14.8, 9.8);
        g.closePath();
        g.fillStyle = '#fff';
        g.fill();
      });
    case 'deep':
      return canvasIcon(kind, 22, (g) => {
        g.beginPath();
        g.moveTo(2, 4);
        g.lineTo(20, 4);
        g.lineTo(11, 20);
        g.closePath();
        g.fillStyle = '#123c7a';
        g.strokeStyle = '#fff';
        g.lineWidth = 1.6;
        g.fill();
        g.stroke();
      });
    case 'wonder':
      return canvasIcon(kind, 22, (g, s) => {
        disc(g, s, '#c8901a');
        g.translate(s / 2, s / 2);
        g.beginPath();
        for (let i = 0; i < 10; i++) {
          const r = i % 2 ? 3 : 7;
          const a = (i * Math.PI) / 5 - Math.PI / 2;
          g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
        }
        g.closePath();
        g.fillStyle = '#fff';
        g.fill();
      });
    case 'building':
      return canvasIcon(kind, 22, (g, s) => {
        disc(g, s, '#5d6b7a');
        g.fillStyle = '#fff';
        g.beginPath();
        g.moveTo(11, 4);
        g.lineTo(13, 9);
        g.lineTo(13, 17);
        g.lineTo(9, 17);
        g.lineTo(9, 9);
        g.closePath();
        g.fill();
        g.fillRect(7, 17, 8, 1.6);
      });
    case 'unesco':
      return canvasIcon(kind, 22, (g, s) => {
        disc(g, s, '#1d6fb8');
        g.fillStyle = '#fff';
        g.beginPath();
        g.moveTo(5, 9);
        g.lineTo(11, 5);
        g.lineTo(17, 9);
        g.closePath();
        g.fill();
        for (const x of [6.5, 9.8, 13.1]) g.fillRect(x, 10, 2.2, 5.5);
        g.fillRect(5, 16, 12, 1.6);
      });
    case 'volcano':
    case 'volcanoActive':
      return canvasIcon(kind, 22, (g) => {
        g.beginPath();
        g.moveTo(2, 19);
        g.lineTo(8, 7);
        g.lineTo(14, 7);
        g.lineTo(20, 19);
        g.closePath();
        g.fillStyle = kind === 'volcanoActive' ? '#c8321c' : '#8a5a3c';
        g.strokeStyle = '#fff';
        g.lineWidth = 1.5;
        g.fill();
        g.stroke();
        if (kind === 'volcanoActive') {
          g.fillStyle = '#ffb000';
          g.beginPath();
          g.arc(9, 4, 2, 0, Math.PI * 2);
          g.arc(13, 3, 2.4, 0, Math.PI * 2);
          g.fill();
        }
      });
    case 'park':
      return canvasIcon(kind, 22, (g, s) => {
        disc(g, s, '#2f8a3a');
        g.fillStyle = '#fff';
        g.beginPath();
        g.moveTo(11, 4);
        g.lineTo(16, 12);
        g.lineTo(6, 12);
        g.closePath();
        g.moveTo(11, 7);
        g.lineTo(17, 16);
        g.lineTo(5, 16);
        g.closePath();
        g.fill();
        g.fillRect(10, 16, 2, 2.5);
      });
    case 'waterfall':
      return canvasIcon(kind, 22, (g, s) => {
        disc(g, s, '#2b8fd6');
        g.strokeStyle = '#fff';
        g.lineWidth = 1.8;
        g.lineCap = 'round';
        for (const x of [7.5, 11, 14.5]) {
          g.beginPath();
          g.moveTo(x, 5);
          g.lineTo(x, 15);
          g.stroke();
        }
        g.beginPath();
        g.moveTo(5, 17.5);
        g.quadraticCurveTo(11, 14, 17, 17.5);
        g.stroke();
      });
    case 'extreme':
    case 'pin':
      return canvasIcon(kind, 22, (g) => {
        g.beginPath();
        g.moveTo(11, 21);
        g.bezierCurveTo(5, 13, 4, 10, 4, 8);
        g.arc(11, 8, 7, Math.PI, 0);
        g.bezierCurveTo(18, 10, 17, 13, 11, 21);
        g.fillStyle = kind === 'pin' ? '#e63946' : '#6a4c93';
        g.fill();
        g.strokeStyle = '#fff';
        g.lineWidth = 1.5;
        g.stroke();
        g.beginPath();
        g.arc(11, 8, 2.6, 0, Math.PI * 2);
        g.fillStyle = '#fff';
        g.fill();
      });
    case 'airport':
      return canvasIcon(kind, 22, (g, s) => {
        disc(g, s, '#34495e');
        g.fillStyle = '#fff';
        g.translate(11, 11);
        g.rotate(-Math.PI / 4);
        g.beginPath();
        g.moveTo(0, -7);
        g.lineTo(1.2, -2);
        g.lineTo(7, 1);
        g.lineTo(7, 2.5);
        g.lineTo(1.2, 1);
        g.lineTo(1, 5);
        g.lineTo(3, 6.5);
        g.lineTo(3, 7.5);
        g.lineTo(0, 6.8);
        g.lineTo(-3, 7.5);
        g.lineTo(-3, 6.5);
        g.lineTo(-1, 5);
        g.lineTo(-1.2, 1);
        g.lineTo(-7, 2.5);
        g.lineTo(-7, 1);
        g.lineTo(-1.2, -2);
        g.closePath();
        g.fill();
      });
    case 'port':
      return canvasIcon(kind, 22, (g, s) => {
        disc(g, s, '#1b4f72');
        g.strokeStyle = '#fff';
        g.lineWidth = 1.7;
        g.lineCap = 'round';
        g.beginPath();
        g.arc(11, 6, 1.8, 0, Math.PI * 2);
        g.moveTo(11, 8);
        g.lineTo(11, 17);
        g.moveTo(7.5, 10.5);
        g.lineTo(14.5, 10.5);
        g.moveTo(5.5, 13);
        g.quadraticCurveTo(6.5, 17, 11, 17);
        g.quadraticCurveTo(15.5, 17, 16.5, 13);
        g.stroke();
      });
    case 'canal':
      return canvasIcon(kind, 22, (g, s) => {
        disc(g, s, '#138d90');
        g.strokeStyle = '#fff';
        g.lineWidth = 1.8;
        g.lineCap = 'round';
        for (const y of [8, 12.5]) {
          g.beginPath();
          g.moveTo(5, y);
          g.bezierCurveTo(8, y - 3, 10, y + 3, 13, y);
          g.bezierCurveTo(15, y - 2, 16, y - 1, 17, y);
          g.stroke();
        }
      });
    case 'own':
      return canvasIcon(kind, 22, (g) => {
        g.beginPath();
        g.moveTo(11, 19);
        g.bezierCurveTo(1, 12, 3, 3, 11, 7);
        g.bezierCurveTo(19, 3, 21, 12, 11, 19);
        g.fillStyle = '#e8467c';
        g.fill();
        g.strokeStyle = '#fff';
        g.lineWidth = 1.6;
        g.stroke();
      });
  }
}

// ── Marker-Ebene: Symbole + Namen (über den gemeinsamen Beschriftungs-Verteiler) ──

export interface MarkerItem {
  lon: number;
  lat: number;
  name: string;
  icon: MarkerIcon;
  /** Name ab diesem Abstand (m) */
  range: number;
  prio: number;
  /** Symbol ab diesem Abstand (m), sonst immer */
  iconRange?: number;
  data: unknown;
}

export interface MarkerStyle {
  fill: string;
  size?: number;
  bold?: boolean;
  italic?: boolean;
  /** Größe des Symbols in Pixel */
  iconSize?: number;
}

export class MarkerLayer {
  private readonly billboards = new BillboardCollection();
  private visible = false;

  constructor(
    scene: Scene,
    private readonly labels: LabelManager,
    readonly key: string,
    private readonly style: MarkerStyle,
  ) {
    this.billboards.show = false;
    scene.primitives.add(this.billboards);
  }

  setItems(items: MarkerItem[]) {
    this.billboards.removeAll();
    const size = this.style.iconSize ?? 20;
    const labelItems: LabelItem[] = [];
    for (const it of items) {
      const pos = Cartesian3.fromDegrees(it.lon, it.lat);
      const id = { kind: this.key, item: it.data };
      const icon = markerIcon(it.icon);
      const pin = it.icon === 'extreme' || it.icon === 'pin' || it.icon === 'peak' || it.icon === 'summit';
      this.billboards.add({
        position: pos,
        image: icon,
        width: size,
        height: size,
        verticalOrigin: pin ? VerticalOrigin.BOTTOM : VerticalOrigin.CENTER,
        scaleByDistance: new NearFarScalar(1.5e6, 1, 2.2e7, 0.4),
        distanceDisplayCondition: it.iconRange ? new DistanceDisplayCondition(0, it.iconRange) : undefined,
        id,
      });
      if (it.name) {
        labelItems.push({
          pos,
          text: it.name,
          size: this.style.size ?? 12,
          bold: this.style.bold,
          italic: this.style.italic,
          fill: this.style.fill,
          range: it.range,
          prio: it.prio,
          offset: pin ? 3 : size / 2 + 2,
          mark: size,
          id,
        });
      }
    }
    this.labels.set(this.key, labelItems, this.visible);
  }

  get show() {
    return this.visible;
  }

  set show(v: boolean) {
    this.visible = v;
    this.billboards.show = v;
    this.labels.show(this.key, v);
  }
}
