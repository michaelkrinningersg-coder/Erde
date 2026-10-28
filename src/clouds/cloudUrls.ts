// Gemeinsam von Worker und Hauptprogramm genutzt, damit die Adressen exakt gleich sind
// und der Browser-Cache (EUMETSAT liefert max-age = 7 Tage) greift.

export interface ImageSource {
  wms: string;
  layer: string;
  format: string;
  rect: { west: number; south: number; east: number; north: number };
  width: number;
  height: number;
  tilesX: number;
  tilesY: number;
}

export interface TileSpec {
  url: string;
  ix: number;
  iy: number;
}

export function wmsTileUrls(src: ImageSource, timeIso: string): TileSpec[] {
  const { west, south, east, north } = src.rect;
  const dLon = (east - west) / src.tilesX;
  const dLat = (north - south) / src.tilesY;
  const out: TileSpec[] = [];
  for (let iy = 0; iy < src.tilesY; iy++) {
    for (let ix = 0; ix < src.tilesX; ix++) {
      const maxLat = north - iy * dLat;
      const minLon = west + ix * dLon;
      const p = new URLSearchParams({
        service: 'WMS',
        version: '1.3.0',
        request: 'GetMap',
        layers: src.layer,
        styles: '',
        crs: 'EPSG:4326',
        bbox: `${maxLat - dLat},${minLon},${maxLat},${minLon + dLon}`,
        width: String(src.width / src.tilesX),
        height: String(src.height / src.tilesY),
        format: src.format,
        transparent: 'true',
        time: timeIso,
      });
      out.push({ url: `${src.wms}?${p}`, ix, iy });
    }
  }
  return out;
}

/** ISO-Zeit ohne Millisekunden, wie sie der WMS-Dienst erwartet */
export const isoTime = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');

/** Dateiname im Archiv, z. B. 20261028T1500Z.webp */
export const archiveName = (ms: number) => `${isoTime(ms).replace(/[-:]/g, '').replace(/00Z$/, 'Z')}.webp`;

import type { ColorRegion } from '../config';

const D = Math.PI / 180;
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const FEATHER = 13; // Grad – breiter, weicher Übergang zum Rand des Ausschnitts

/** Rohgewicht eines Echtfarben-Gebiets: weich zur Kante der Satellitensicht und zum Ausschnittsrand */
function rawWeight(lat: number, lon: number, g: ColorRegion): number {
  const r = g.rect;
  if (lon <= r.west || lon >= r.east || lat <= r.south || lat >= r.north) return 0;
  const disk = smooth(Math.cos(76 * D), Math.cos(64 * D), Math.cos(lat * D) * Math.cos((lon - g.satLon) * D));
  const edge = smooth(0, FEATHER, Math.min(lat - r.south, r.north - lat, lon - r.west, r.east - lon));
  return disk * edge;
}

/**
 * Wie stark jedes Echtfarben-Gebiet an einer Stelle zählt (je 0…1, Summe ≤ 1).
 * Überlappen sich Gebiete (Atlantik), teilen sie sich den Anteil; die Infrarot-Wolken
 * treten dort genau um die Summe zurück → zusammen immer 100 %, kein doppelter Schleier.
 */
export function regionWeights(lat: number, lon: number, regions: ColorRegion[], out: number[] = []): number[] {
  let sum = 0;
  for (let i = 0; i < regions.length; i++) sum += out[i] = rawWeight(lat, lon, regions[i]);
  if (sum > 1) for (let i = 0; i < regions.length; i++) out[i] /= sum;
  return out;
}

/** Dateiname einer GOES-Vollscheibe beim NOAA-CDN, z. B. 20263011600_GOES19-ABI-FD-GEOCOLOR-1808x1808.jpg */
export function noaaFileName(ms: number, product: string): string {
  const d = new Date(ms);
  const doy = Math.floor((ms - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000) + 1;
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${String(doy).padStart(3, '0')}${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}_${product}.jpg`;
}
