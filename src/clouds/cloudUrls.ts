// Gemeinsam von Worker und Hauptprogramm genutzt, damit die Adressen exakt gleich sind
// und der Browser-Cache (EUMETSAT liefert max-age = 7 Tage) greift.

export interface CloudSource {
  wms: string;
  layer: string;
  width: number;
  tile: number;
}

export interface TileSpec {
  url: string;
  ix: number;
  iy: number;
}

export function cloudTileUrls(src: CloudSource, timeIso: string): TileSpec[] {
  const H = src.width / 2;
  const nx = src.width / src.tile;
  const ny = H / src.tile;
  const dLon = 360 / nx;
  const dLat = 180 / ny;
  const out: TileSpec[] = [];
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const maxLat = 90 - iy * dLat;
      const minLon = -180 + ix * dLon;
      const p = new URLSearchParams({
        service: 'WMS',
        version: '1.3.0',
        request: 'GetMap',
        layers: src.layer,
        styles: '',
        crs: 'EPSG:4326',
        bbox: `${maxLat - dLat},${minLon},${maxLat},${minLon + dLon}`,
        width: String(src.tile),
        height: String(src.tile),
        format: 'image/png',
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
