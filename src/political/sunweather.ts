// Sonnenaufgang/-untergang (astronomy-engine, ohne Server) und aktuelles Wetter (Open-Meteo, nur auf Wunsch).
import * as Astronomy from 'astronomy-engine';

export interface SunTimes {
  rise?: Date;
  set?: Date;
  /** Polartag oder Polarnacht */
  polar?: 'Polartag' | 'Polarnacht';
}

/** Sonnenzeiten für einen Kalendertag (yyyy-mm-dd) am Ort; gerechnet ab Ortsmitternacht (mittlere Sonnenzeit) */
export function sunTimes(date: string, lat: number, lon: number): SunTimes {
  const [y, m, d] = date.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, d) - (lon / 15) * 3600e3);
  const obs = new Astronomy.Observer(lat, lon, 0);
  const rise = Astronomy.SearchRiseSet(Astronomy.Body.Sun, obs, +1, start, 1);
  const set = Astronomy.SearchRiseSet(Astronomy.Body.Sun, obs, -1, start, 1);
  if (!rise && !set) {
    const noon = new Date(start.getTime() + 12 * 3600e3);
    const eq = Astronomy.Equator(Astronomy.Body.Sun, noon, obs, true, true);
    const hor = Astronomy.Horizon(noon, obs, eq.ra, eq.dec, 'normal');
    return { polar: hor.altitude > 0 ? 'Polartag' : 'Polarnacht' };
  }
  return { rise: rise?.date, set: set?.date };
}

export const timeIn = (d: Date | undefined, tz: string | undefined) =>
  d ? d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: tz || undefined }) : '–';

export function dayLength(t: SunTimes) {
  if (t.polar) return t.polar === 'Polartag' ? '24 h' : '0 h';
  if (!t.rise || !t.set) return '–';
  let ms = t.set.getTime() - t.rise.getTime();
  if (ms < 0) ms += 24 * 3600e3;
  const h = Math.floor(ms / 3600e3);
  const min = Math.round((ms % 3600e3) / 60e3);
  return `${h} h ${min} min`;
}

export function todayIn(tz?: string) {
  // yyyy-mm-dd im Zeitzonen-Kalender des Orts
  return new Date().toLocaleDateString('sv-SE', { timeZone: tz || undefined });
}

/** WMO-Wettercodes → kurze deutsche Beschreibung */
const WEATHER: [number[], string][] = [
  [[0], 'klar'],
  [[1], 'überwiegend klar'],
  [[2], 'teils bewölkt'],
  [[3], 'bedeckt'],
  [[45, 48], 'Nebel'],
  [[51, 53, 55], 'Nieselregen'],
  [[56, 57], 'gefrierender Nieselregen'],
  [[61, 63, 65], 'Regen'],
  [[66, 67], 'gefrierender Regen'],
  [[71, 73, 75, 77], 'Schnee'],
  [[80, 81, 82], 'Regenschauer'],
  [[85, 86], 'Schneeschauer'],
  [[95, 96, 99], 'Gewitter'],
];

export interface Weather {
  temp: number;
  wind: number;
  text: string;
  day: boolean;
}

export async function fetchWeather(lat: number, lon: number): Promise<Weather> {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}&current=temperature_2m,weather_code,wind_speed_10m,is_day`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Wetter: ${r.status}`);
  const j = (await r.json()) as { current: { temperature_2m: number; weather_code: number; wind_speed_10m: number; is_day: number } };
  const c = j.current;
  return {
    temp: c.temperature_2m,
    wind: c.wind_speed_10m,
    text: WEATHER.find(([codes]) => codes.includes(c.weather_code))?.[1] ?? '',
    day: !!c.is_day,
  };
}
