// Datentypen und Geometrie-Helfer der politischen Karte (Daten aus scripts/build_political.py und build_extras.py).

/** Ring/Linie als Differenzen: [x0, y0, dx1, dy1, …] in 1/scale Grad */
export type Encoded = number[];
export type BBox = [number, number, number, number]; // W S O N in 1/scale Grad

/** Höchster/tiefster Punkt: Name, Länge, Breite, Höhe, Wikipedia */
export type PointInfo = [string, number, number, number, string];

export interface CountryFacts {
  area?: number; // km²
  tel?: string;
  kfz?: string;
  drive?: 'links' | 'rechts';
  lang?: string[];
  cur?: string[];
  lo?: PointInfo;
}

export interface CountryData {
  n: string; // Name
  i: string; // ISO-Code
  c: number; // Farbe 0…8 (Nachbarn verschieden)
  l: [number, number]; // Beschriftungspunkt
  z: number; // Zoomstufe, ab der Natural Earth den Namen zeigt
  e: number; // Einwohner (Schätzung)
  q: string; // Wikidata
  p: Encoded[][]; // genaue Polygone (Außenring + Löcher), Natural Earth 1:10 Mio.
  g: Encoded[][]; // grobe Polygone für den Blick auf die ganze Erde
  h: PointInfo | null; // höchster Punkt
  k: string; // Kontinent
  x: CountryFacts;
  nb: number[]; // Nachbarländer (Index)
}

export interface CountriesFile {
  scale: number;
  countries: CountryData[];
  lakes: Encoded[][];
  lakesCoarse: Encoded[][];
  borders: Encoded[];
  bordersCoarse: Encoded[];
}

/**
 * [Name, Land, Einwohner, Breite, Länge, Rang Land, Rang Kontinent, Rang Welt, Hauptstadt-Rolle, Wikipedia-Titel,
 *  Höhe in m (null = unbekannt), Ballungsraum UN 2025 (0 = unbekannt), Verwaltungsgebiet (0 = Zahl nicht korrigiert),
 *  Zeitzone (Index), Hauptstadt eines Bundeslands/einer Provinz (1/0)]
 */
export type CityRow = [string, string, number, number, number, number, number, number, string, string, number | null, number, number, number, number];
export interface CitiesFile {
  continents: Record<string, string>;
  countries: Record<string, [string, string, number]>;
  continentCount: Record<string, number>;
  worldCount: number;
  timezones: string[];
  cities: CityRow[];
}

/** Ein Polygon (Außenring + Löcher) mit fertigem Zeichenpfad */
export interface Poly {
  rings: Int32Array[]; // x, y abwechselnd
  path: Path2D;
  bbox: BBox;
}

export interface Line {
  path: Path2D;
  bbox: BBox;
  pts: Int32Array;
}

const emptyBox = (): BBox => [Infinity, Infinity, -Infinity, -Infinity];

function grow(b: BBox, x: number, y: number) {
  if (x < b[0]) b[0] = x;
  if (y < b[1]) b[1] = y;
  if (x > b[2]) b[2] = x;
  if (y > b[3]) b[3] = y;
}

function unpack(enc: Encoded, path: Path2D, bbox: BBox, close: boolean) {
  const pts = new Int32Array(enc.length);
  let x = 0;
  let y = 0;
  for (let i = 0; i < enc.length; i += 2) {
    x += enc[i];
    y += enc[i + 1];
    pts[i] = x;
    pts[i + 1] = y;
    if (i === 0) path.moveTo(x, -y);
    else path.lineTo(x, -y);
    grow(bbox, x, y);
  }
  if (close) path.closePath();
  return pts;
}

/** Differenzen auspacken und Zeichenpfad bauen (y = −Breite, damit Norden oben ist) */
export function decodePolys(polys: Encoded[][]): Poly[] {
  return polys.map((poly) => {
    const path = new Path2D();
    const bbox = emptyBox();
    const rings = poly.map((enc) => unpack(enc, path, bbox, true));
    return { rings, path, bbox };
  });
}

export function decodeLines(lines: Encoded[]): Line[] {
  return lines.map((enc) => {
    const path = new Path2D();
    const bbox = emptyBox();
    const pts = unpack(enc, path, bbox, false);
    return { path, bbox, pts };
  });
}

export function unionBox(polys: { bbox: BBox }[]): BBox {
  const b = emptyBox();
  for (const p of polys) {
    grow(b, p.bbox[0], p.bbox[1]);
    grow(b, p.bbox[2], p.bbox[3]);
  }
  return b;
}

export const inBox = (b: BBox, x: number, y: number, pad = 0) => x >= b[0] - pad && x <= b[2] + pad && y >= b[1] - pad && y <= b[3] + pad;

/** Punkt-in-Polygon (gerade/ungerade über alle Ringe eines Polygons) */
export function insidePolys(polys: Poly[], x: number, y: number) {
  for (const poly of polys) {
    if (!inBox(poly.bbox, x, y)) continue;
    let c = false;
    for (const r of poly.rings) {
      const n = r.length;
      for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
        const xi = r[i];
        const yi = r[i + 1];
        const xj = r[j];
        const yj = r[j + 1];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
      }
    }
    if (c) return true;
  }
  return false;
}

/** Kleinster Abstand eines Punkts zu einer Linie (gleiche Einheit wie die Koordinaten) */
export function distToLine(pts: Int32Array, x: number, y: number) {
  let best = Infinity;
  for (let i = 2; i < pts.length; i += 2) {
    const ax = pts[i - 2];
    const ay = pts[i - 1];
    const dx = pts[i] - ax;
    const dy = pts[i + 1] - ay;
    const len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len)) : 0;
    const d = Math.hypot(x - ax - t * dx, y - ay - t * dy);
    if (d < best) best = d;
  }
  return best;
}

export const fmt = (v: number, digits = 0) => v.toLocaleString('de-DE', { maximumFractionDigits: digits });

/** Link zum Wikipedia-Artikel („en:“ = nur auf Englisch vorhanden), sonst Suche */
export function wikiLink(title: string, search: string) {
  if (!title) return `https://de.wikipedia.org/w/index.php?search=${encodeURIComponent(search)}`;
  if (title.startsWith('http')) return title;
  const m = /^([a-z]{2,3}):(.*)$/.exec(title);
  const lang = m ? m[1] : 'de';
  const t = m ? m[2] : title;
  return `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(t.replace(/ /g, '_'))}`;
}

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Grob passende Kamerahöhe, um ein Gebiet ganz zu sehen (m) */
export function heightForBox(b: BBox, scale: number) {
  const span = Math.max((b[2] - b[0]) / scale, (b[3] - b[1]) / scale);
  return Math.min(2.2e7, Math.max(2.5e5, span * 111e3 * 1.6));
}
