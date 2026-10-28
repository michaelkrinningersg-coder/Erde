/// <reference lib="webworker" />
// Lädt ein weltweites Infrarot-Wolkenbild (EUMETSAT WMS) in Kacheln, setzt es zusammen
// und rechnet es in eine weiße Wolkenschicht mit Transparenz um.
//
// Infrarot zeigt Temperatur: kalt (= hohe Wolken) ist hell, warm (= Boden/Meer) ist dunkel.
// Der „wolkenfreie“ Grauwert hängt stark vom Breitengrad ab (Tropen warm, Polargebiete kalt),
// deshalb wird pro Bildzeile ein eigener Hintergrundwert geschätzt.

import { cloudTileUrls, type CloudSource } from './cloudUrls';

export interface CloudRequest extends CloudSource {
  id: number;
  time: string; // ISO-Zeit des Wolkenbildes
  /** Fertiges Graustufenbild aus dem eigenen Archiv (GitHub Pages); sonst Kacheln vom WMS */
  archiveUrl?: string;
}

export type CloudResponse =
  | { id: number; ok: true; left: ImageBitmap; right: ImageBitmap; coverage: number }
  | { id: number; ok: false; error: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (ev: MessageEvent<CloudRequest>) => {
  const req = ev.data;
  try {
    const result = await buildCloudTexture(req);
    ctx.postMessage(result, result.ok ? [result.left, result.right] : []);
  } catch (e) {
    ctx.postMessage({ id: req.id, ok: false, error: String((e as Error)?.message ?? e) } satisfies CloudResponse);
  }
};

async function fetchTile(url: string) {
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

async function buildCloudTexture(req: CloudRequest): Promise<CloudResponse> {
  const W = req.width;
  const H = W / 2;

  const canvas = new OffscreenCanvas(W, H);
  const g = canvas.getContext('2d', { willReadFrequently: true })!;

  if (req.archiveUrl) {
    const bmp = await fetchTile(req.archiveUrl);
    g.drawImage(bmp, 0, 0, W, H);
    bmp.close();
  } else {
    const jobs = cloudTileUrls(req, req.time).map(({ url, ix, iy }) =>
      fetchTile(url).then((bmp) => {
        g.drawImage(bmp, ix * req.tile, iy * req.tile);
        bmp.close();
      }),
    );
    await Promise.all(jobs);
  }

  const img = g.getImageData(0, 0, W, H);
  const coverage = toCloudLayer(img.data, W, H);
  g.putImageData(img, 0, 0);

  // Zwei Hälften (westlich / östlich von 0°) – passt zum Kachelschema des Globus.
  // Cesium erwartet ImageBitmaps bereits vertikal gespiegelt (WebGL spiegelt sie nicht selbst).
  const flip = { imageOrientation: 'flipY' } as const;
  const [left, right] = await Promise.all([
    createImageBitmap(canvas, 0, 0, H, H, flip),
    createImageBitmap(canvas, H, 0, H, H, flip),
  ]);
  return { id: req.id, ok: true, left, right, coverage };
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Wandelt Graustufen-IR in RGBA-Wolken um (in-place). Gibt den Anteil gültiger Pixel zurück. */
function toCloudLayer(d: Uint8ClampedArray, W: number, H: number): number {
  // 1) Hintergrund (wolkenfreie Oberfläche) je Zeile: 15-%-Perzentil der gültigen Pixel
  const bgRow = new Float32Array(H).fill(NaN);
  const hist = new Uint32Array(256);
  let valid = 0;
  for (let y = 0; y < H; y++) {
    hist.fill(0);
    let n = 0;
    for (let x = 0, i = y * W * 4; x < W; x++, i += 4) {
      if (d[i + 3] > 0 && d[i] > 0) {
        hist[d[i]]++;
        n++;
      }
    }
    valid += n;
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

  // 2) Gültigkeitsmaske weichzeichnen → sanftes Ausblenden am Rand der Satellitenabdeckung
  const mask = new Float32Array(W * H);
  // Gültig: nicht transparent (WMS) und nicht 0 (Archiv: 0 = keine Daten)
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
  return valid / (W * H);
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
