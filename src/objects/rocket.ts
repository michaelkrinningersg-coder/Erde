import {
  CallbackPositionProperty,
  Cartesian2,
  Cartesian3,
  Color,
  DistanceDisplayCondition,
  Entity,
  JulianDate,
  LabelStyle,
  LagrangePolynomialApproximation,
  NearFarScalar,
  SampledPositionProperty,
  TimeInterval,
  TimeIntervalCollection,
  VelocityVectorProperty,
  VerticalOrigin,
  type Viewer,
} from 'cesium';
import { degreesToRadians, eciToEcf, geodeticToEcf, gstime, propagate, type SatRec } from 'satellite.js';
import { launchPadIcon, rocketIcon } from '../icons';

// Raketenstart zu einer Raumstation – vereinfachte, aber physikalisch plausible Mission:
//  1. Start, wenn der Startplatz unter der Bahnebene der Station hindurchläuft (in-plane launch)
//  2. Aufstieg in ~9 min auf 200 km (Parkbahn)
//  3. Parkbahn: tiefer = schneller → die Rakete holt auf, bis die Station ~12° voraus ist
//  4. Bahnanhebung (halbe Umlaufbahn) auf Stationshöhe
//  5. Annäherung (15 min) und Andocken – danach fliegt sie mit der Station mit
// Gerechnet wird im erdmittelpunktfesten, nicht mitdrehenden System (TEME, wie SGP4),
// dargestellt im erdfesten System.

export interface LaunchSite {
  id: string;
  name: string;
  lat: number;
  lon: number;
  rocket: string;
}

export const LAUNCH_SITES: LaunchSite[] = [
  { id: 'ksc', name: 'Cape Canaveral (USA)', lat: 28.6083, lon: -80.6041, rocket: 'Falcon 9' },
  { id: 'baikonur', name: 'Baikonur (Kasachstan)', lat: 45.92, lon: 63.342, rocket: 'Sojus' },
  { id: 'wenchang', name: 'Wenchang (China)', lat: 19.6145, lon: 110.951, rocket: 'Langer Marsch 7' },
  { id: 'jiuquan', name: 'Jiuquan (China)', lat: 40.958, lon: 100.291, rocket: 'Langer Marsch 2F' },
  { id: 'kourou', name: 'Kourou (Franz.-Guayana)', lat: 5.236, lon: -52.775, rocket: 'Ariane 6' },
  { id: 'tanegashima', name: 'Tanegashima (Japan)', lat: 30.4, lon: 130.975, rocket: 'H3' },
];

export interface RocketTarget {
  id: string;
  name: string;
  satrec: SatRec;
  /** Erdfeste Position der Station (für die Zeit nach dem Andocken) */
  entity: Entity;
}

export type Phase = 'countdown' | 'ascent' | 'parking' | 'transfer' | 'approach' | 'docked';

export interface Mission {
  id: string;
  site: LaunchSite;
  target: RocketTarget;
  launch: JulianDate;
  times: Record<Phase, JulianDate>; // Beginn der jeweiligen Phase
  entity: Entity;
  pad: Entity;
}

const MU = 398600.4418; // km³/s²
const RE = 6378.137; // km
const ASCENT_S = 540;
const PARK_ALT = 200; // km
const TRANSFER_GAP = (12 * Math.PI) / 180; // Station so weit voraus → Bahnanhebung beginnt
const APPROACH_S = 900;

type V = [number, number, number];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale = (a: V, s: number): V => [a[0] * s, a[1] * s, a[2] * s];
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const norm = (a: V): V => scale(a, 1 / Math.hypot(...a));
const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const wrap = (a: number) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

function stationEci(satrec: SatRec, ms: number): { r: V; v: V } | undefined {
  const pv = propagate(satrec, new Date(ms));
  if (!pv || typeof pv.position !== 'object') return undefined;
  const p = pv.position;
  const v = pv.velocity;
  return { r: [p.x, p.y, p.z], v: [v.x, v.y, v.z] };
}

function siteEci(site: LaunchSite, ms: number): V {
  const ecf = geodeticToEcf({ latitude: degreesToRadians(site.lat), longitude: degreesToRadians(site.lon), height: 0 });
  const g = gstime(new Date(ms));
  return [ecf.x * Math.cos(g) - ecf.y * Math.sin(g), ecf.x * Math.sin(g) + ecf.y * Math.cos(g), ecf.z];
}

function toFixed(r: V, ms: number): Cartesian3 {
  const ecf = eciToEcf({ x: r[0], y: r[1], z: r[2] }, gstime(new Date(ms)));
  return new Cartesian3(ecf.x * 1000, ecf.y * 1000, ecf.z * 1000);
}

/** Bahnneigung der Station in Grad */
function inclination(satrec: SatRec): number {
  return (satrec.inclo * 180) / Math.PI;
}

/** Kann dieser Startplatz die Bahn der Station überhaupt erreichen? */
export function reachable(site: LaunchSite, target: RocketTarget) {
  return Math.abs(site.lat) < inclination(target.satrec) - 0.3;
}

/** Nächster Zeitpunkt (ab `from`), zu dem der Startplatz in der Bahnebene der Station liegt */
export function nextWindow(site: LaunchSite, target: RocketTarget, from: number): number | undefined {
  const f = (ms: number) => {
    const st = stationEci(target.satrec, ms);
    if (!st) return NaN;
    return dot(norm(siteEci(site, ms)), norm(cross(st.r, st.v)));
  };
  const step = 60_000;
  let a = from + 60_000;
  let fa = f(a);
  for (let t = a + step; t < from + 2 * 86_400_000; t += step) {
    const ft = f(t);
    if (fa * ft <= 0) {
      let lo = t - step;
      let hi = t;
      for (let i = 0; i < 20; i++) {
        const mid = (lo + hi) / 2;
        if (f(lo) * f(mid) <= 0) hi = mid;
        else lo = mid;
      }
      return Math.round(lo / 1000) * 1000;
    }
    a = t;
    fa = ft;
  }
  return undefined;
}

/** Plant die komplette Flugbahn und legt die Rakete auf den Globus. */
export function planMission(viewer: Viewer, site: LaunchSite, target: RocketTarget, launchMs: number, id: string): Mission {
  const st0 = stationEci(target.satrec, launchMs)!;
  const n = norm(cross(st0.r, st0.v)); // Bahnebene der Station
  const s0 = norm(siteEci(site, launchMs));
  const e1 = norm(add(s0, scale(n, -dot(s0, n)))); // Startplatz in der Bahnebene
  const e2 = cross(n, e1); // Flugrichtung
  const inPlane = (theta: number, radius: number): V => add(scale(e1, radius * Math.cos(theta)), scale(e2, radius * Math.sin(theta)));
  const stationAngle = (ms: number) => {
    const r = stationEci(target.satrec, ms)!.r;
    return Math.atan2(dot(r, e2), dot(r, e1));
  };
  const stationRadius = Math.hypot(...st0.r);

  const position = new SampledPositionProperty();
  position.setInterpolationOptions({ interpolationDegree: 3, interpolationAlgorithm: LagrangePolynomialApproximation });
  const sample = (ms: number, r: V) => position.addSample(JulianDate.fromDate(new Date(ms)), toFixed(r, ms));

  // 1) Aufstieg: senkrecht hoch, dann zunehmend waagerecht; ~1.800 km weit, auf 200 km Höhe
  const theta1 = 1800 / RE;
  for (let t = 0; t <= ASCENT_S; t += 2) {
    const x = t / ASCENT_S;
    const alt = PARK_ALT * Math.pow(smooth(x), 0.6);
    sample(launchMs + t * 1000, inPlane(theta1 * x * x, RE + alt));
  }

  // 2) Parkbahn bis die Station ~12° voraus ist (mindestens ein Umlauf)
  const rPark = RE + PARK_ALT;
  const wPark = Math.sqrt(MU / rPark ** 3);
  const parkStart = launchMs + ASCENT_S * 1000;
  let theta = theta1;
  let t = parkStart;
  const minPark = parkStart + ((2 * Math.PI) / wPark) * 1000;
  while (t < parkStart + 3 * 86_400_000) {
    const gap = wrap(stationAngle(t) - theta);
    if (t >= minPark && gap <= TRANSFER_GAP) break;
    t += 10_000;
    theta += wPark * 10;
    sample(t, inPlane(theta, rPark));
  }

  // 3) Bahnanhebung über eine halbe Umlaufbahn
  const transferStart = t;
  const transferS = Math.PI * Math.sqrt(((rPark + stationRadius) / 2) ** 3 / MU);
  for (let s = 10; s <= transferS; s += 10) {
    const r = rPark + (stationRadius - 5 - rPark) * (1 - Math.cos((Math.PI * s) / transferS)) / 2;
    theta += Math.sqrt(MU / r ** 3) * 10;
    sample(transferStart + s * 1000, inPlane(theta, r));
  }
  const approachStart = transferStart + transferS * 1000;

  // 4) Annäherung: eigene Bahn weich in die Position der Station überblenden (von hinten, unten)
  let rOwn = stationRadius - 5;
  for (let s = 10; s <= APPROACH_S; s += 10) {
    theta += Math.sqrt(MU / rOwn ** 3) * 10;
    rOwn = stationRadius - 5 * (1 - s / APPROACH_S);
    const ms = approachStart + s * 1000;
    const st = stationEci(target.satrec, ms)!;
    const w = smooth(s / APPROACH_S);
    const behind = scale(norm(st.v), -0.05 * (1 - w)); // die letzten 50 m von hinten
    const own = inPlane(theta, rOwn);
    sample(ms, add(add(scale(own, 1 - w), scale(st.r, w)), behind));
  }
  const dockMs = approachStart + APPROACH_S * 1000;

  const launch = JulianDate.fromDate(new Date(launchMs));
  const jd = (ms: number) => JulianDate.fromDate(new Date(ms));
  const times: Record<Phase, JulianDate> = {
    countdown: JulianDate.addSeconds(launch, -10, new JulianDate()),
    ascent: launch,
    parking: jd(parkStart),
    transfer: jd(transferStart),
    approach: jd(approachStart),
    docked: jd(dockMs),
  };

  // Nach dem Andocken: mit der Station mitfliegen
  const dockJd = times.docked;
  const stationPos = target.entity.position!;
  const combined = new CallbackPositionProperty((time, result) => {
    if (!time) return undefined;
    if (JulianDate.lessThan(time, launch)) return padPosition(site, result);
    if (JulianDate.lessThan(time, dockJd)) return position.getValue(time, result);
    return stationPos.getValue(time, result);
  }, false);

  const end = JulianDate.addDays(dockJd, 1, new JulianDate());
  const label = `${site.rocket} → ${target.name}`;
  const entity = new Entity({
    id,
    name: label,
    availability: new TimeIntervalCollection([new TimeInterval({ start: times.countdown, stop: end })]),
    position: combined,
    billboard: {
      image: rocketIcon(),
      alignedAxis: new VelocityVectorProperty(combined, true),
      scaleByDistance: new NearFarScalar(5e4, 1.3, 2e7, 0.7),
    },
    label: {
      text: label,
      font: 'bold 14px system-ui, sans-serif',
      fillColor: Color.fromCssColorString('#ff9f43'),
      outlineColor: Color.BLACK,
      outlineWidth: 3,
      style: LabelStyle.FILL_AND_OUTLINE,
      verticalOrigin: VerticalOrigin.TOP,
      pixelOffset: new Cartesian2(0, 22),
    },
    path: {
      leadTime: 0,
      trailTime: 5400,
      width: 3,
      resolution: 30,
      material: Color.fromCssColorString('#ff9f43').withAlpha(0.9),
    },
    // Kamera beim Mitfliegen: schräg hinten oben
    viewFrom: new Cartesian3(-60_000, -60_000, 35_000),
  });
  const pad = new Entity({
    id: `${id}-pad`,
    name: `Startplatz ${site.name}`,
    position: padPosition(site),
    billboard: { image: launchPadIcon(), verticalOrigin: VerticalOrigin.BOTTOM, scaleByDistance: new NearFarScalar(5e4, 1, 2e7, 0.6) },
    label: {
      text: site.name.replace(/ \(.*\)$/, ''),
      font: '13px system-ui, sans-serif',
      fillColor: Color.WHITE,
      outlineColor: Color.BLACK,
      outlineWidth: 3,
      style: LabelStyle.FILL_AND_OUTLINE,
      verticalOrigin: VerticalOrigin.TOP,
      pixelOffset: new Cartesian2(0, 4),
      distanceDisplayCondition: new DistanceDisplayCondition(0, 8e6),
    },
  });
  viewer.entities.add(pad);
  viewer.entities.add(entity);
  return { id, site, target, launch, times, entity, pad };
}

function padPosition(site: LaunchSite, result?: Cartesian3) {
  return Cartesian3.fromDegrees(site.lon, site.lat, 0, undefined, result);
}

/** In welcher Phase ist die Mission zu diesem Zeitpunkt? */
export function phaseAt(m: Mission, time: JulianDate): Phase | 'waiting' {
  const order: Phase[] = ['docked', 'approach', 'transfer', 'parking', 'ascent', 'countdown'];
  for (const p of order) if (!JulianDate.lessThan(time, m.times[p])) return p;
  return 'waiting';
}
