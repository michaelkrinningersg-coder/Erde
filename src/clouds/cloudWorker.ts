/// <reference lib="webworker" />
// Lädt ein zeitabhängiges Satellitenbild (eigenes Archiv oder EUMETSAT-WMS in Kacheln),
// setzt es zusammen und bereitet es für den Globus auf:
//
//  - mode 'ir':    Infrarot → weiße Wolkenschicht mit Transparenz.
//                  Infrarot zeigt Temperatur: kalt (= hohe Wolken) ist hell, warm (= Boden/Meer) dunkel.
//                  Der „wolkenfreie“ Grauwert hängt stark vom Breitengrad ab (Tropen warm, Polargebiete
//                  kalt), deshalb wird pro Bildzeile ein eigener Hintergrundwert geschätzt.
//  - mode 'color': Echtfarbenbild; zum Rand der Satellitensicht und des Ausschnitts weich ausgeblendet,
//                  damit es ohne Kante in die weltweite Darstellung übergeht.

import type { ColorRegion, Rect } from '../config';
import { noaaFileName, regionWeights, wmsTileUrls, type ImageSource } from './cloudUrls';

export interface ImageRequest extends ImageSource {
  id: number;
  time: string; // ISO-Zeit des Bildes
  mode: 'ir' | 'color';
  splitX: number;
  /** Fertiges Bild aus dem eigenen Archiv (GitHub Pages); sonst Kacheln vom WMS */
  archiveUrl?: string;
  /** Alle Echtfarben-Gebiete (für die gemeinsame Gewichtung) */
  regions?: ColorRegion[];
  /** Nur 'color': welches Gebiet dieses Bild ist */
  region?: number;
  /** Nur 'ir': in den Echtfarben-Gebieten wird die Wolkenschicht aufgeteilt (s. u.) */
  splitRegions?: boolean;
  /** NOAA-Vollscheibe statt WMS (nur wenn kein Archivbild da ist) */
  noaa?: { base: string; product: string; satLon: number };
}

type Inner = { bitmap: ImageBitmap; rect: Rect };

export type ImageResponse =
  | { id: number; ok: true; parts: ImageBitmap[]; inner: Inner[] }
  | { id: number; ok: false; error: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (ev: MessageEvent<ImageRequest>) => {
  const req = ev.data;
  try {
    const result = await buildTexture(req);
    ctx.postMessage(result, result.ok ? [...result.parts, ...result.inner.map((i) => i.bitmap)] : []);
  } catch (e) {
    ctx.postMessage({ id: req.id, ok: false, error: String((e as Error)?.message ?? e) } satisfies ImageResponse);
  }
};

async function fetchImage(url: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      if (!blob.type.startsWith('image/')) throw new Error(`Antwort ist kein Bild (${blob.type})`);
      return await createImageBitmap(blob);
    } catch (e) {
      lastError = e;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function buildTexture(req: ImageRequest): Promise<ImageResponse> {
  const W = req.width;
  const H = req.height;
  const canvas = new OffscreenCanvas(W, H);
  const g = canvas.getContext('2d', { willReadFrequently: true })!;

  let img: ImageData | undefined;
  if (req.archiveUrl) {
    const bmp = await fetchImage(req.archiveUrl);
    g.drawImage(bmp, 0, 0, W, H);
    bmp.close();
  } else if (req.noaa) {
    const ms = Date.parse(req.time);
    const bmp = await fetchImage(`${req.noaa.base}/${noaaFileName(ms, req.noaa.product)}`);
    img = reprojectGeos(bmp, req.noaa.satLon, req.rect, W, H);
    bmp.close();
  } else {
    const tw = W / req.tilesX;
    const th = H / req.tilesY;
    await Promise.all(
      wmsTileUrls(req, req.time).map(({ url, ix, iy }) =>
        fetchImage(url).then((bmp) => {
          g.drawImage(bmp, ix * tw, iy * th, tw, th);
          bmp.close();
        }),
      ),
    );
  }

  img ??= g.getImageData(0, 0, W, H);
  let inner: Inner[] = [];
  if (req.mode === 'ir') {
    toCloudLayer(img.data, W, H);
    if (req.splitRegions && req.regions) inner = await splitRegions(img, req.rect, req.regions);
  } else fadeColorEdges(img.data, W, H, req.rect, req.regions ?? [], req.region ?? 0);
  g.putImageData(img, 0, 0);

  // In Spalten teilen (passt zum Kachelschema auf dem Globus).
  // Cesium erwartet ImageBitmaps bereits vertikal gespiegelt (WebGL spiegelt sie nicht selbst).
  const pw = W / req.splitX;
  const parts = await Promise.all(
    Array.from({ length: req.splitX }, (_, i) => createImageBitmap(canvas, i * pw, 0, pw, H, { imageOrientation: 'flipY' })),
  );
  return { id: req.id, ok: true, parts, inner };
}

/**
 * Teilt die Wolkenschicht in den Echtfarben-Gebieten auf, damit dort keine Wolken doppelt liegen:
 *  - Hauptbild: Deckkraft × (1 − Σ wᵢ) – immer sichtbar
 *  - Innenbild je Gebiet i: Deckkraft × wᵢ – tagsüber nur so weit gezeigt, wie das Farbbild i fehlt
 *    (nachts voll); wᵢ = Gewicht des Farbbildes i an dieser Stelle.
 * So ergeben Farbbilder und Wolken überall genau 100 % – ohne milchigen Übergangsstreifen.
 */
async function splitRegions(img: ImageData, rect: Rect, regions: ColorRegion[]): Promise<Inner[]> {
  const W = img.width;
  const d = img.data;
  const maps = weightMaps(rect, W, img.height, regions);
  // Erst die Innenbilder aus der ursprünglichen Deckkraft …
  const inner = await Promise.all(
    maps.boxes.map(async (b, k) => {
      const bw = b.x1 - b.x0;
      const bh = b.y1 - b.y0;
      const out = new ImageData(bw, bh);
      const o = out.data;
      const wk = maps.per[k];
      for (let y = 0; y < bh; y++) {
        for (let x = 0, q = y * bw; x < bw; x++, q++) {
          if (!wk[q]) continue;
          const i = ((y + b.y0) * W + x + b.x0) * 4;
          const j = q * 4;
          o[j] = d[i];
          o[j + 1] = d[i + 1];
          o[j + 2] = d[i + 2];
          o[j + 3] = (d[i + 3] * wk[q]) / 255;
        }
      }
      const c = new OffscreenCanvas(bw, bh);
      c.getContext('2d')!.putImageData(out, 0, 0);
      return { bitmap: await createImageBitmap(c, { imageOrientation: 'flipY' }), rect: b.rect };
    }),
  );
  // … dann im Hauptbild um die Summe der Gewichte zurücknehmen
  const total = maps.total;
  for (let p = 0, i = 3; p < total.length; p++, i += 4) if (total[p]) d[i] = (d[i] * (255 - total[p])) / 255;
  return inner;
}

interface WeightMaps {
  /** Summe aller Gebietsgewichte je Pixel des Gesamtbilds (0…255) */
  total: Uint8Array;
  /** Gewicht je Gebiet, nur in dessen Ausschnitt (0…255) */
  per: Uint8Array[];
  boxes: { x0: number; x1: number; y0: number; y1: number; rect: Rect }[];
}

const weightCache = new Map<string, WeightMaps>();

/** Gewichtskarten hängen nur von Ort und Bildgröße ab → einmal rechnen, dann wiederverwenden */
function weightMaps(rect: Rect, W: number, H: number, regions: ColorRegion[]): WeightMaps {
  const key = JSON.stringify([rect, W, H, regions]);
  const hit = weightCache.get(key);
  if (hit) return hit;
  const px = (rect.east - rect.west) / W;
  const py = (rect.north - rect.south) / H;
  const boxes = regions.map(({ rect: c }) => {
    const x0 = Math.max(0, Math.floor((c.west - rect.west) / px));
    const x1 = Math.min(W, Math.ceil((c.east - rect.west) / px));
    const y0 = Math.max(0, Math.floor((rect.north - c.north) / py));
    const y1 = Math.min(H, Math.ceil((rect.north - c.south) / py));
    return { x0, x1, y0, y1, rect: { west: rect.west + x0 * px, east: rect.west + x1 * px, north: rect.north - y0 * py, south: rect.north - y1 * py } };
  });
  const total = new Uint8Array(W * H);
  const per = boxes.map((b) => new Uint8Array((b.x1 - b.x0) * (b.y1 - b.y0)));
  const w: number[] = [];
  for (const [k, b] of boxes.entries()) {
    for (let y = b.y0; y < b.y1; y++) {
      const lat = rect.north - (y + 0.5) * py;
      for (let x = b.x0; x < b.x1; x++) {
        const lon = rect.west + (x + 0.5) * px;
        regionWeights(lat, lon, regions, w);
        const v = Math.round(w[k] * 255);
        per[k][(y - b.y0) * (b.x1 - b.x0) + (x - b.x0)] = v;
        total[y * W + x] = Math.min(255, total[y * W + x] + v);
      }
    }
  }
  const maps = { total, per, boxes };
  weightCache.set(key, maps);
  return maps;
}

/**
 * Rechnet eine GOES-Vollscheibe (Blick des Satelliten aus 35.786 km Höhe) auf ein
 * Längen-/Breitengrad-Raster um (Formeln aus dem GOES-R Product User Guide).
 */
function reprojectGeos(bmp: ImageBitmap, satLon: number, rect: Rect, W: number, H: number): ImageData {
  const N = bmp.width;
  const src = new OffscreenCanvas(N, N);
  const sg = src.getContext('2d', { willReadFrequently: true })!;
  sg.drawImage(bmp, 0, 0);
  const s = sg.getImageData(0, 0, N, N).data;
  const map = geosMap(N, satLon, rect, W, H);
  const out = new ImageData(W, H);
  const o = out.data;
  for (let p = 0, j = 0; p < map.length; p++, j += 4) {
    const i = map[p];
    if (i < 0) continue;
    o[j] = s[i];
    o[j + 1] = s[i + 1];
    o[j + 2] = s[i + 2];
    o[j + 3] = 255;
  }
  return out;
}

const geosCache = new Map<string, Int32Array>();

/** Für jedes Zielpixel: Index im Satellitenbild (−1 = Rückseite der Erde). Einmal rechnen, dann wiederverwenden. */
function geosMap(N: number, satLon: number, rect: Rect, W: number, H: number): Int32Array {
  const key = JSON.stringify([N, satLon, rect, W, H]);
  const hit = geosCache.get(key);
  if (hit) return hit;
  const map = new Int32Array(W * H).fill(-1);
  const D = Math.PI / 180;
  const req = 6378137;
  const rpol = 6356752.31414;
  const Hs = 42164160; // Abstand Satellit – Erdmittelpunkt
  const e2 = 0.0066943800699785;
  const ext = 0.151872; // halbe Bildbreite in Radiant (Vollscheibe)
  for (let y = 0; y < H; y++) {
    const lat = (rect.north - ((y + 0.5) / H) * (rect.north - rect.south)) * D;
    const latc = Math.atan(((rpol * rpol) / (req * req)) * Math.tan(lat));
    const rc = rpol / Math.sqrt(1 - e2 * Math.cos(latc) ** 2);
    for (let x = 0; x < W; x++) {
      const dl = (rect.west + ((x + 0.5) / W) * (rect.east - rect.west) - satLon) * D;
      const sx = Hs - rc * Math.cos(latc) * Math.cos(dl);
      const sy = -rc * Math.cos(latc) * Math.sin(dl);
      const sz = rc * Math.sin(latc);
      if (Hs * (Hs - sx) < sy * sy + ((req * req) / (rpol * rpol)) * sz * sz) continue; // Rückseite
      const sxScan = Math.asin(-sy / Math.sqrt(sx * sx + sy * sy + sz * sz));
      const syScan = Math.atan(sz / sx);
      const col = Math.floor(((sxScan + ext) / (2 * ext)) * N);
      const row = Math.floor(((ext - syScan) / (2 * ext)) * N);
      if (col < 0 || col >= N || row < 0 || row >= N) continue;
      map[y * W + x] = (row * N + col) * 4;
    }
  }
  geosCache.set(key, map);
  return map;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Wandelt Graustufen-IR in RGBA-Wolken um (in-place). */
function toCloudLayer(d: Uint8ClampedArray, W: number, H: number) {
  // 1) Hintergrund (wolkenfreie Oberfläche) je Zeile: 15-%-Perzentil der gültigen Pixel
  const bgRow = new Float32Array(H).fill(NaN);
  const hist = new Uint32Array(256);
  for (let y = 0; y < H; y++) {
    hist.fill(0);
    let n = 0;
    for (let x = 0, i = y * W * 4; x < W; x++, i += 4) {
      if (d[i + 3] > 0 && d[i] > 0) {
        hist[d[i]]++;
        n++;
      }
    }
    if (n < W * 0.05) continue;
    const target = n * 0.15;
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc >= target) {
        bgRow[y] = v;
        break;
      }
    }
  }
  // Lücken auffüllen und über ±2 % der Bildhöhe glätten
  const bg = new Float32Array(H);
  const r = Math.max(4, Math.round(H * 0.02));
  for (let y = 0; y < H; y++) {
    let s = 0;
    let c = 0;
    for (let k = -r; k <= r; k++) {
      const v = bgRow[y + k];
      if (v === v && y + k >= 0 && y + k < H) {
        s += v;
        c++;
      }
    }
    bg[y] = c ? s / c : 120;
  }

  // 2) Gültigkeitsmaske weichzeichnen → sanftes Ausblenden am Rand der Satellitenabdeckung.
  //    Gültig: nicht transparent (WMS) und nicht 0 (Archiv: 0 = keine Daten)
  const mask = new Float32Array(W * H);
  for (let p = 0; p < W * H; p++) mask[p] = d[p * 4 + 3] > 0 && d[p * 4] > 0 ? 1 : 0;
  boxBlur(mask, W, H, Math.round(W / 256));

  // 3) Grauwert → Deckkraft und Helligkeit
  for (let y = 0; y < H; y++) {
    const b = bg[y];
    const lo = b + 10;
    const hi = b + 85;
    for (let x = 0, p = y * W, i = p * 4; x < W; x++, p++, i += 4) {
      const v = d[i];
      let a = smoothstep(lo, hi, v);
      a = Math.pow(a, 0.85) * smoothstep(0.5, 1.0, mask[p]);
      const shade = 0.82 + 0.18 * smoothstep(b + 30, b + 140, v);
      d[i] = 255 * shade;
      d[i + 1] = 255 * shade;
      d[i + 2] = 255 * Math.min(1, shade * 1.02);
      d[i + 3] = 255 * a * 0.97;
    }
  }
}

/** Echtfarben: Deckkraft = Gewicht dieses Gebiets (gleiche Gewichtung wie bei der Aufteilung der Wolken) */
function fadeColorEdges(d: Uint8ClampedArray, W: number, H: number, rect: Rect, regions: ColorRegion[], region: number) {
  const maps = weightMaps(rect, W, H, regions);
  const b = maps.boxes[region];
  const wk = maps.per[region];
  const bw = b.x1 - b.x0;
  for (let y = 0; y < H; y++) {
    for (let x = 0, i = y * W * 4; x < W; x++, i += 4) {
      const inside = x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1;
      const w = inside ? wk[(y - b.y0) * bw + (x - b.x0)] : 0;
      d[i + 3] = Math.max(d[i], d[i + 1], d[i + 2]) < 4 ? 0 : w;
    }
  }
}

/** Separierbarer Kastenfilter (zweimal → annähernd Gauß), Längengrad wird umlaufend behandelt */
function boxBlur(a: Float32Array, W: number, H: number, radius: number) {
  if (radius < 1) return;
  const tmp = new Float32Array(Math.max(W, H));
  const norm = 1 / (2 * radius + 1);
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < H; y++) {
      const o = y * W;
      let s = 0;
      for (let k = -radius; k <= radius; k++) s += a[o + ((k + W) % W)];
      for (let x = 0; x < W; x++) {
        tmp[x] = s * norm;
        s += a[o + ((x + radius + 1) % W)] - a[o + ((x - radius + W) % W)];
      }
      a.set(tmp.subarray(0, W), o);
    }
    for (let x = 0; x < W; x++) {
      let s = 0;
      for (let k = -radius; k <= radius; k++) s += a[Math.min(H - 1, Math.max(0, k)) * W + x];
      for (let y = 0; y < H; y++) {
        tmp[y] = s * norm;
        s += a[Math.min(H - 1, y + radius + 1) * W + x] - a[Math.max(0, y - radius) * W + x];
      }
      for (let y = 0; y < H; y++) a[y * W + x] = tmp[y];
    }
  }
}
