// Formate der Zusatzdaten (scripts/build_extras.py) und Laden mit Zwischenspeicher.
import type { Encoded } from './geo';

/** [Name, Länge, Breite, Art, Zoomstufe, Wikipedia, Fläche km², Tiefe m] */
export type Sea = [string, number, number, string, number, string, number, number];
/** [Name, Länge, Breite, Zoomstufe, Wikipedia, Fläche km², Tiefe m] */
export type Lake = [string, number, number, number, string, number, number];
export interface River {
  n: string;
  r: number; // Rang (0 = wichtig)
  z: number; // Zoomstufe für den Namen
  w: string; // Wikipedia
  len: number; // km
  l: [number, number];
  p: Encoded[];
  g: Encoded[];
}
/** [Name, Länge, Breite, Höhe (negativ = Tiefe), Wikipedia] */
export type Deep = [string, number, number, number, string];

export interface WaterFile {
  scale: number;
  seas: Sea[];
  lakes: Lake[];
  rivers: River[];
  deeps: Deep[];
}

export interface Admin1File {
  scale: number;
  lines: Encoded[];
  coarse: Encoded[];
  /** [Name, Länge, Breite, ISO, Art, Zoomstufe, Wikipedia] */
  labels: [string, number, number, string, string, number, string][];
}

export interface DisputedFile {
  scale: number;
  areas: { n: string; note: string; w: string; l: [number, number]; z: number; p: Encoded[][] }[];
}

export interface HistoryFile {
  scale: number;
  year: number;
  countries: { n: string; s: string; c: number; l: [number, number]; p: Encoded[][]; g: Encoded[][] }[];
}

export interface PlacesFile {
  wonders: [string, number, number, string, string][];
  buildings: [string, number, number, number, string][];
  waterfalls: [string, number, number, number, string][];
  summits: [string, number, number, number, string][];
  canals: [string, number, number, number, string][];
  extremes: [string, number, number, string, string][];
  unesco: [string, number, number, string, string][];
  parks: [string, number, number, number, string, number][];
  deserts: [string, number, number, number, string, number][];
  ranges: [string, number, number, number, string, number][];
  islands: [string, number, number, number, string][];
  peninsulas: [string, number, number, number, string][];
  capes: [string, number, number, number, string][];
  /** [Name, Länge, Breite, Art, Höhe, letzter Ausbruch (Jahr, negativ = v. Chr.), Land, GVP-Nummer] */
  volcanoes: [string, number, number, string, number, number | null, string, number][];
  /** [Name, Länge, Breite, IATA, Stadt, Land, Wikipedia] */
  airports: [string, number, number, string, string, string, string][];
  ports: [string, number, number, number][];
  geolines: { n: string; k: string; p: [number, number][] }[];
}

const cache = new Map<string, Promise<unknown>>();

export function loadJson<T>(name: string): Promise<T> {
  let p = cache.get(name);
  if (!p) {
    p = fetch(`./data/political/${name}`).then((r) => {
      if (!r.ok) throw new Error(`${name}: ${r.status}`);
      return r.json();
    });
    p.catch(() => cache.delete(name));
    cache.set(name, p);
  }
  return p as Promise<T>;
}

export const HISTORY_YEARS = [1994, 1960, 1945, 1938, 1920, 1914, 1900, 1880, 1815];
