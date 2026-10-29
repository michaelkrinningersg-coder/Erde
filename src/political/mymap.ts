// „Meine Karte“: eigene Orte (mit Notiz und Foto) und besuchte Länder.
// Gespeichert im Browser; zum Sichern oder Mitnehmen als Datei speichern bzw. laden.

export interface OwnPlace {
  id: string;
  name: string;
  note: string;
  lon: number;
  lat: number;
  /** verkleinertes Foto als data:-URL */
  photo?: string;
}

export interface MyMapData {
  version: 1;
  places: OwnPlace[];
  /** Ländernamen (eindeutig, auch für Gebiete ohne ISO-Code) */
  visited: string[];
}

const KEY = 'erde.meineKarte';

export class MyMap {
  data: MyMapData = { version: 1, places: [], visited: [] };
  onChange?: () => void;

  constructor() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) this.data = { ...this.data, ...(JSON.parse(raw) as Partial<MyMapData>) };
    } catch {
      /* privates Fenster o. ä.: dann eben nur bis zum Neuladen */
    }
  }

  private save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch (e) {
      console.warn('Meine Karte konnte nicht im Browser gespeichert werden (zu groß?) – bitte als Datei sichern.', e);
    }
    this.onChange?.();
  }

  isVisited(country: string) {
    return this.data.visited.includes(country);
  }

  setVisited(country: string, v: boolean) {
    const set = new Set(this.data.visited);
    if (v) set.add(country);
    else set.delete(country);
    this.data.visited = [...set].sort();
    this.save();
  }

  addPlace(p: Omit<OwnPlace, 'id'>) {
    const place = { ...p, id: Math.random().toString(36).slice(2, 10) };
    this.data.places.push(place);
    this.save();
    return place;
  }

  updatePlace(id: string, patch: Partial<OwnPlace>) {
    const p = this.data.places.find((x) => x.id === id);
    if (p) Object.assign(p, patch);
    this.save();
  }

  removePlace(id: string) {
    this.data.places = this.data.places.filter((x) => x.id !== id);
    this.save();
  }

  /** Als Datei herunterladen */
  download() {
    const blob = new Blob([JSON.stringify(this.data, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `meine-erde-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  /** Datei laden (ersetzt den Stand im Browser) */
  async load(file: File) {
    const d = JSON.parse(await file.text()) as Partial<MyMapData>;
    if (!Array.isArray(d.places) || !Array.isArray(d.visited)) throw new Error('Keine „Meine Erde“-Datei');
    this.data = { version: 1, places: d.places, visited: d.visited };
    this.save();
  }
}

/** Foto verkleinern (längste Seite 480 px, JPEG), damit es in den Browser-Speicher passt */
export function shrinkPhoto(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, 480 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * s);
      c.height = Math.round(img.height * s);
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}
