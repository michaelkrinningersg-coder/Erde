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

type Rect = { west: number; south: number; east: number; north: number };
const D = Math.PI / 180;
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Wie stark das Echtfarbenbild an einer Stelle zählt (0…1): weich ausgeblendet zur Kante der
 * Satellitensicht (Meteosat steht über 0°/0°) und zum Rand des Ausschnitts.
 * Wird auch für die Infrarot-Wolken genutzt, die dort genau um diesen Anteil zurücktreten.
 */
export function colorWeight(lat: number, lon: number, rect: Rect): number {
  const feather = 13; // Grad – breiter, weicher Übergang
  if (lon <= rect.west || lon >= rect.east || lat <= rect.south || lat >= rect.north) return 0;
  const disk = smooth(Math.cos(76 * D), Math.cos(64 * D), Math.cos(lat * D) * Math.cos(lon * D));
  const edge = smooth(0, feather, Math.min(lat - rect.south, rect.north - lat, lon - rect.west, rect.east - lon));
  return disk * edge;
}
