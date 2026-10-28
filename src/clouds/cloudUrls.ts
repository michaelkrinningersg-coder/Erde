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
