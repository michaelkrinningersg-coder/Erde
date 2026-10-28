// Lädt aktuelle Bahndaten (OMM/JSON) von CelesTrak und schreibt einen kompakten
// Schnappschuss nach public/data/satellites.json.
// Läuft in GitHub Actions alle 6 Stunden. Schlägt eine Gruppe fehl, bleibt der
// alte Stand dieser Gruppe erhalten – die App hat also immer Daten.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const OUT = new URL('../public/data/satellites.json', import.meta.url);
const BASE = 'https://celestrak.org/NORAD/elements/gp.php';

// Weltraumteleskope mit Bahndaten (JWST steht am Lagrangepunkt L2 und wird separat behandelt)
const TELESCOPES = [
  [20580, 'Hubble'],
  [25867, 'Chandra'],
  [25989, 'XMM-Newton'],
  [28485, 'Swift'],
  [33053, 'Fermi'],
  [38358, 'NuSTAR'],
  [43435, 'TESS'],
];

const KEEP = [
  'OBJECT_NAME', 'OBJECT_ID', 'EPOCH', 'MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION',
  'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'EPHEMERIS_TYPE',
  'CLASSIFICATION_TYPE', 'NORAD_CAT_ID', 'ELEMENT_SET_NO', 'REV_AT_EPOCH', 'BSTAR',
  'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT',
];
const slim = (o, name) => {
  const r = Object.fromEntries(KEEP.filter((k) => k in o).map((k) => [k, o[k]]));
  if (name) r.DISPLAY_NAME = name;
  return r;
};

async function get(query) {
  const url = `${BASE}?${query}&FORMAT=json`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Erde-Visualisierung (privates Projekt)' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (!text.trim().startsWith('[')) throw new Error(`Keine JSON-Liste: ${text.slice(0, 80)}`);
      return JSON.parse(text);
    } catch (e) {
      if (attempt === 4) throw new Error(`${url}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000 * 2 ** (attempt - 1)));
    }
  }
}

// Gleichmäßige Stichprobe über die Bahnebenen (sortiert nach Knotenlänge)
function sample(list, n) {
  const sorted = [...list].sort((a, b) => a.RA_OF_ASC_NODE - b.RA_OF_ASC_NODE);
  if (sorted.length <= n) return sorted;
  return Array.from({ length: n }, (_, i) => sorted[Math.floor((i * sorted.length) / n)]);
}

const GROUPS = [
  {
    id: 'stations', name: 'Raumstationen', color: '#ffd166', defaultOn: true,
    load: async () => {
      const all = await get('GROUP=stations');
      const pick = { 25544: 'ISS', 48274: 'Tiangong' };
      return all.filter((o) => pick[o.NORAD_CAT_ID]).map((o) => slim(o, pick[o.NORAD_CAT_ID]));
    },
  },
  {
    id: 'telescopes', name: 'Weltraumteleskope', color: '#c77dff', defaultOn: true,
    load: async () => {
      const out = [];
      for (const [id, name] of TELESCOPES) {
        try {
          const [o] = await get(`CATNR=${id}`);
          if (o) out.push(slim(o, name));
        } catch (e) {
          console.warn(`  (${name} übersprungen: ${e.message})`);
        }
      }
      return out;
    },
  },
  {
    id: 'gps', name: 'GPS', color: '#06d6a0', defaultOn: true,
    load: async () => (await get('GROUP=gps-ops')).map((o) => slim(o)),
  },
  {
    id: 'galileo', name: 'Galileo', color: '#4cc9f0', defaultOn: true,
    load: async () => (await get('GROUP=galileo')).map((o) => slim(o)),
  },
  {
    id: 'starlink', name: 'Starlink (Beispiele)', color: '#e5e5e5', defaultOn: true,
    load: async () => {
      // Nur Satelliten auf Betriebshöhe (> 15 Umläufe/Tag ≈ unter 600 km)
      const all = (await get('GROUP=starlink')).filter((o) => o.MEAN_MOTION > 15);
      return sample(all, 40).map((o) => slim(o));
    },
  },
  {
    id: 'sentinel', name: 'Sentinel (Copernicus)', color: '#90be6d', defaultOn: false,
    load: async () =>
      (await get('NAME=SENTINEL'))
        .filter((o) => /^SENTINEL-\d/.test(o.OBJECT_NAME))
        .map((o) => slim(o)),
  },
  {
    id: 'oneweb', name: 'OneWeb (Beispiele)', color: '#f9844a', defaultOn: false,
    load: async () => sample(await get('GROUP=oneweb'), 24).map((o) => slim(o)),
  },
];

let previous = { groups: [] };
try {
  previous = JSON.parse(await readFile(OUT, 'utf8'));
} catch {
  /* erster Lauf */
}

const groups = [];
let failures = 0;
for (const g of GROUPS) {
  const { load, ...meta } = g;
  try {
    const objects = await load();
    if (!objects.length) throw new Error('leer');
    groups.push({ ...meta, objects });
    console.log(`✔ ${g.name}: ${objects.length}`);
  } catch (e) {
    failures++;
    const old = previous.groups.find((p) => p.id === g.id);
    if (old) groups.push({ ...meta, objects: old.objects });
    console.warn(`✖ ${g.name}: ${e.message}${old ? ' (alter Stand bleibt)' : ''}`);
  }
}

await mkdir(dirname(OUT.pathname), { recursive: true });
await writeFile(OUT, JSON.stringify({ generated: new Date().toISOString(), groups }));
console.log(`Gespeichert: ${OUT.pathname} (${failures} Fehler)`);
if (failures === GROUPS.length) process.exit(1);
