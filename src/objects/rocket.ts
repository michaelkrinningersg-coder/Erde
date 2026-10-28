import {
  CallbackPositionProperty,
  CallbackProperty,
  Cartographic,
  Matrix3,
  Quaternion,
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
import { MODEL_AXIS_FIX } from './modelAxes';

// Raketenstart zu einer Raumstation – vereinfachte, aber physikalisch plausible Mission:
//  1. Start, wenn der Startplatz unter der Bahnebene der Station hindurchläuft (in-plane launch)
//  2. Aufstieg in ~9 min auf 200 km (Parkbahn)
//  3. Parkbahn: tiefer = schneller → die Rakete holt auf, bis die Station ~12° voraus ist
//  4. Bahnanhebung (halbe Umlaufbahn) auf Stationshöhe
//  5. Annäherung (15 min) und Andocken – danach fliegt sie mit der Station mit
//  6. Nach 2 h: Abdocken, Bremszündung, Wiedereintritt (Hitzeschild voraus), Fallschirme, Landung
// Unterwegs fallen die Stufen ab: Stufe 1 nach 2½ min (stürzt ballistisch zurück), Stufe 2 im Orbit,
// der Versorgungsteil (Trunk) vor dem Wiedereintritt.
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

export type Phase =
  | 'countdown'
  | 'ascent'
  | 'parking'
  | 'transfer'
  | 'approach'
  | 'docked'
  | 'undock'
  | 'deorbit'
  | 'reentry'
  | 'parachute'
  | 'landed';

/** Reihenfolge der Phasen */
export const PHASES: Phase[] = ['countdown', 'ascent', 'parking', 'transfer', 'approach', 'docked', 'undock', 'deorbit', 'reentry', 'parachute', 'landed'];

export interface Mission {
  id: string;
  site: LaunchSite;
  target: RocketTarget;
  launch: JulianDate;
  times: Record<Phase, JulianDate>; // Beginn der jeweiligen Phase
  entity: Entity;
  /** Abfallende Teile, Fallschirm, Glühen */
  parts: Entity[];
  pad: Entity;
  /** Zeitpunkt der Trennung der ersten Stufe */
  meco: JulianDate;
}

const MU = 398600.4418; // km³/s²
const RE = 6378.137; // km
const ASCENT_S = 540;
const PARK_ALT = 200; // km
const TRANSFER_GAP = (12 * Math.PI) / 180; // Station so weit voraus → Bahnanhebung beginnt
const APPROACH_S = 900;
const MECO_S = 150; // Brennschluss/Trennung der ersten Stufe
const STAY_S = 2 * 3600; // so lange bleibt die Kapsel an der Station
const UNDOCK_S = 600;
const DEORBIT_S = 2700; // Bremszündung bis Eintritt in die Atmosphäre (100 km)
const REENTRY_S = 480; // 100 km → 10 km
const CHUTE_S = 720; // 10 km → Boden

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
  // Andockstutzen vorne an der Station (km vor der Stationsmitte)
  const dockOffset = target.id === '25544' ? 0.036 : 0.026;

  const position = new SampledPositionProperty();
  position.setInterpolationOptions({ interpolationDegree: 3, interpolationAlgorithm: LagrangePolynomialApproximation });
  const sample = (ms: number, r: V) => position.addSample(JulianDate.fromDate(new Date(ms)), toFixed(r, ms));

  // 1) Aufstieg: senkrecht hoch, dann zunehmend waagerecht; ~1.800 km weit, auf 200 km Höhe
  const theta1 = 1800 / RE;
  for (let t = 0; t <= ASCENT_S; t += 2) {
    const x = t / ASCENT_S;
    // + Höhe der Kapsel über dem Boden, solange der ganze Stapel steht (58 m)
    const alt = PARK_ALT * Math.pow(smooth(x), 0.6) + STACK_H * (1 - x);
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

  // 4) Annäherung: eigene Bahn weich in die Position des Andockstutzens überblenden
  let rOwn = stationRadius - 5;
  for (let s = 10; s <= APPROACH_S; s += 10) {
    theta += Math.sqrt(MU / rOwn ** 3) * 10;
    rOwn = stationRadius - 5 * (1 - s / APPROACH_S);
    const ms = approachStart + s * 1000;
    const st = stationEci(target.satrec, ms)!;
    const w = smooth(s / APPROACH_S);
    // Ziel: Andockstutzen vorne an der Station; die letzten 50 m von vorn heranfliegen
    const port = add(st.r, scale(norm(st.v), dockOffset + 0.05 * (1 - w)));
    const own = inPlane(theta, rOwn);
    sample(ms, add(scale(own, 1 - w), scale(port, w)));
  }
  const dockMs = approachStart + APPROACH_S * 1000;

  // 5) Rückflug: abdocken (nach hinten wegdrücken), Bahn absenken, Wiedereintritt, Fallschirm
  const ret = new SampledPositionProperty();
  ret.setInterpolationOptions({ interpolationDegree: 3, interpolationAlgorithm: LagrangePolynomialApproximation });
  const undockMs = dockMs + STAY_S * 1000;
  const deorbitMs = undockMs + UNDOCK_S * 1000;
  let last: V = [0, 0, 0];
  for (let s = 0; s <= UNDOCK_S; s += 10) {
    const ms = undockMs + s * 1000;
    const st = stationEci(target.satrec, ms)!;
    const d = 2 * smooth(s / UNDOCK_S); // km nach vorn weg
    last = add(add(st.r, scale(norm(st.v), dockOffset + d)), scale(norm(st.r), -0.3 * smooth(s / UNDOCK_S)));
    ret.addSample(JulianDate.fromDate(new Date(ms)), toFixed(last, ms));
  }
  // Bahnebene beim Abdocken
  const stU = stationEci(target.satrec, deorbitMs)!;
  const nU = norm(cross(stU.r, stU.v));
  const f1 = norm(last);
  const f2 = cross(nU, f1);
  let th = 0;
  const r0 = Math.hypot(...last);
  for (let s = 10; s <= DEORBIT_S; s += 10) {
    const r = r0 + (RE + 100 - r0) * smooth(s / DEORBIT_S);
    th += Math.sqrt(MU / r ** 3) * 10;
    const ms = deorbitMs + s * 1000;
    last = add(scale(f1, r * Math.cos(th)), scale(f2, r * Math.sin(th)));
    ret.addSample(JulianDate.fromDate(new Date(ms)), toFixed(last, ms));
  }
  // Wiedereintritt: im erdfesten System weiter in Flugrichtung, stark abbremsen
  const reentryMs = deorbitMs + DEORBIT_S * 1000;
  const pA = toFixed(last, reentryMs);
  const pB = ret.getValue(JulianDate.fromDate(new Date(reentryMs - 10_000)))!;
  const groundDir = Cartesian3.normalize(Cartesian3.subtract(pA, pB, new Cartesian3()), new Cartesian3());
  const cA = Cartographic.fromCartesian(pA);
  const up = Cartesian3.normalize(pA, new Cartesian3());
  const horiz = Cartesian3.normalize(
    Cartesian3.subtract(groundDir, Cartesian3.multiplyByScalar(up, Cartesian3.dot(groundDir, up), new Cartesian3()), new Cartesian3()),
    new Cartesian3(),
  );
  const v0 = Cartesian3.distance(pA, pB) / 10; // m/s (erdfest)
  const geoAt = (dist: number, alt: number) => {
    // Kreisbogen über die Erdoberfläche in Richtung `horiz`
    const a = dist / (RE * 1000);
    const dir = Cartesian3.add(
      Cartesian3.multiplyByScalar(up, Math.cos(a), new Cartesian3()),
      Cartesian3.multiplyByScalar(horiz, Math.sin(a), new Cartesian3()),
      new Cartesian3(),
    );
    const g = Cartographic.fromCartesian(Cartesian3.multiplyByScalar(dir, RE * 1000, new Cartesian3()));
    return Cartesian3.fromRadians(g.longitude, g.latitude, alt);
  };
  let landing = pA;
  for (let s = 10; s <= REENTRY_S; s += 10) {
    const x = s / REENTRY_S;
    const dist = v0 * REENTRY_S * (x - x * x / 2) * 0.9; // gleichmäßig abbremsen
    const alt = cA.height + (10_000 - cA.height) * smooth(x);
    landing = geoAt(dist, alt);
    ret.addSample(JulianDate.fromDate(new Date(reentryMs + s * 1000)), landing);
  }
  const chuteMs = reentryMs + REENTRY_S * 1000;
  const lg = Cartographic.fromCartesian(landing);
  for (let s = 10; s <= CHUTE_S; s += 10) {
    const alt = 10_000 * (1 - Math.pow(s / CHUTE_S, 0.8));
    ret.addSample(JulianDate.fromDate(new Date(chuteMs + s * 1000)), Cartesian3.fromRadians(lg.longitude, lg.latitude, alt));
  }
  const landedMs = chuteMs + CHUTE_S * 1000;

  const launch = JulianDate.fromDate(new Date(launchMs));
  const jd = (ms: number) => JulianDate.fromDate(new Date(ms));
  const times: Record<Phase, JulianDate> = {
    countdown: JulianDate.addSeconds(launch, -10, new JulianDate()),
    ascent: launch,
    parking: jd(parkStart),
    transfer: jd(transferStart),
    approach: jd(approachStart),
    docked: jd(dockMs),
    undock: jd(undockMs),
    deorbit: jd(deorbitMs),
    reentry: jd(reentryMs),
    parachute: jd(chuteMs),
    landed: jd(landedMs),
  };
  const end = JulianDate.addSeconds(times.landed, 3600, new JulianDate());
  const landedPos = Cartesian3.fromRadians(lg.longitude, lg.latitude, 0);

  // Kapsel-Position über die ganze Mission
  const stationPos = target.entity.position!;
  const dockedPosition = (time: JulianDate, result?: Cartesian3) => {
    const p = stationPos.getValue(time, result);
    const p1 = stationPos.getValue(JulianDate.addSeconds(time, 1, new JulianDate()), new Cartesian3());
    if (!p || !p1) return p;
    const dir = Cartesian3.normalize(Cartesian3.subtract(p1, p, new Cartesian3()), new Cartesian3());
    return Cartesian3.add(p, Cartesian3.multiplyByScalar(dir, dockOffset * 1000, dir), p);
  };
  const capsulePos = new CallbackPositionProperty((time, result) => {
    if (!time) return undefined;
    if (JulianDate.lessThan(time, launch)) return padPosition(site, result);
    if (JulianDate.lessThan(time, times.docked)) return position.getValue(time, result);
    if (JulianDate.lessThan(time, times.undock)) return dockedPosition(time, result);
    if (JulianDate.lessThan(time, times.landed)) return ret.getValue(time, result);
    return Cartesian3.clone(landedPos, result);
  }, false);

  // Ausrichtung der Kapsel (+X = Spitze): auf der Rampe senkrecht, im Flug in Flugrichtung,
  // beim Wiedereintritt Hitzeschild voraus, am Fallschirm wieder senkrecht
  const capsuleOrientation = orientationProperty(capsulePos, (time) => {
    const ph = phaseAt0(times, time);
    if (ph === 'waiting' || ph === 'countdown' || ph === 'parachute' || ph === 'landed') return 'up';
    if (ph === 'reentry') return 'back';
    if (ph === 'docked' || ph === 'undock') return { along: stationPos };
    return 'forward';
  });

  const meco = JulianDate.addSeconds(launch, MECO_S, new JulianDate());
  const label = `${site.rocket} → ${target.name}`;
  const entity = new Entity({
    id,
    name: label,
    availability: new TimeIntervalCollection([new TimeInterval({ start: times.countdown, stop: end })]),
    position: capsulePos,
    orientation: capsuleOrientation,
    model: { uri: './models/kapsel.glb', distanceDisplayCondition: new DistanceDisplayCondition(0, MODEL_RANGE) },
    billboard: {
      image: rocketIcon(),
      alignedAxis: new VelocityVectorProperty(capsulePos, true),
      scaleByDistance: new NearFarScalar(5e4, 1.3, 2e7, 0.7),
      distanceDisplayCondition: new DistanceDisplayCondition(MODEL_RANGE, Number.MAX_VALUE),
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
      distanceDisplayCondition: new DistanceDisplayCondition(MODEL_RANGE, Number.MAX_VALUE),
    },
    path: {
      leadTime: 0,
      trailTime: 5400,
      width: 3,
      resolution: 30,
      material: Color.fromCssColorString('#ff9f43').withAlpha(0.9),
    },
    // Kamera beim Mitfliegen: schräg hinten oben, nah genug für die echte Größe
    viewFrom: new Cartesian3(-140, -110, 60),
  });

  // Abfallende Teile: bis zur Trennung im gemeinsamen Stapel-Koordinatensystem an der Kapsel,
  // danach eigene Bahn
  const parts: Entity[] = [];
  const attachedUntil = (sep: JulianDate, after: (time: JulianDate, result?: Cartesian3) => Cartesian3 | undefined) =>
    new CallbackPositionProperty((time, result) => {
      if (!time) return undefined;
      return JulianDate.lessThan(time, sep) ? capsulePos.getValue(time, result) : after(time, result);
    }, false);
  const partEntity = (name: string, file: string, pos: CallbackPositionProperty, from: JulianDate, to: JulianDate, ori = capsuleOrientation) => {
    const e = new Entity({
      id: `${id}-${file}`,
      name,
      availability: new TimeIntervalCollection([new TimeInterval({ start: from, stop: to })]),
      position: pos,
      orientation: ori,
      model: { uri: `./models/${file}.glb`, distanceDisplayCondition: new DistanceDisplayCondition(0, MODEL_RANGE) },
    });
    parts.push(e);
    return e;
  };

  // Stufe 1: ballistisch zurück (Schwerkraft, ohne Luftwiderstand), bis zum Boden
  const s1 = ballistic(position, meco, 900);
  const s1Pos = attachedUntil(meco, (time, result) => s1.getValue(time, result));
  partEntity('Erste Stufe', 'rakete_stufe1', s1Pos, times.countdown, s1.end, frozenAfter(capsuleOrientation, meco, s1Pos));
  // Stufe 2: trennt sich im Orbit und bleibt langsam zurück
  const s2Pos = attachedUntil(times.parking, (time, result) => drift(capsulePos, times.parking, time, 4, 1.5, result));
  partEntity('Zweite Stufe', 'rakete_stufe2', s2Pos, times.countdown, JulianDate.addSeconds(times.parking, 1800, new JulianDate()), frozenAfter(capsuleOrientation, times.parking, s2Pos));
  // Versorgungsteil (Trunk): bleibt bis zur Bremszündung an der Kapsel
  const trunkPos = attachedUntil(times.deorbit, (time, result) => drift(capsulePos, times.deorbit, time, -3, 2, result));
  partEntity('Versorgungsteil', 'kapsel_trunk', trunkPos, times.countdown, JulianDate.addSeconds(times.deorbit, 1500, new JulianDate()), frozenAfter(capsuleOrientation, times.deorbit, trunkPos));
  // Glühen beim Wiedereintritt, Fallschirme am Ende
  partEntity('Wiedereintritt', 'kapsel_gluehen', capsulePos, times.reentry, times.parachute);
  partEntity('Fallschirme', 'fallschirm', capsulePos, JulianDate.addSeconds(times.parachute, 20, new JulianDate()), JulianDate.addSeconds(times.landed, 60, new JulianDate()));

  const pad = new Entity({
    id: `${id}-pad`,
    name: `Startplatz ${site.name}`,
    position: padPosition(site, undefined, 0),
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
  for (const p of parts) viewer.entities.add(p);
  return { id, site, target, launch, times, entity, parts, pad, meco };
}

/** Bis zu dieser Entfernung (m) Modelle zeigen, darüber das Raketensymbol */
const MODEL_RANGE = 60_000;

type Aim = 'up' | 'forward' | 'back' | { along: CallbackPositionProperty | import('cesium').PositionProperty };

const scratchA = new Cartesian3();
const scratchB = new Cartesian3();

/** Ausrichtung aus einer Richtung (+X) und der Senkrechten (+Z möglichst nach oben) */
function quatFromX(pos: Cartesian3, x: Cartesian3): Quaternion {
  const X = Cartesian3.normalize(x, new Cartesian3());
  const upv = Cartesian3.normalize(pos, new Cartesian3());
  let ref = upv;
  if (Math.abs(Cartesian3.dot(X, upv)) > 0.98) ref = Cartesian3.normalize(Cartesian3.cross(Cartesian3.UNIT_Z, upv, new Cartesian3()), new Cartesian3()); // senkrecht: Bezug nach Osten
  const Z = Cartesian3.normalize(
    Cartesian3.subtract(ref, Cartesian3.multiplyByScalar(X, Cartesian3.dot(ref, X), new Cartesian3()), new Cartesian3()),
    new Cartesian3(),
  );
  const Y = Cartesian3.cross(Z, X, new Cartesian3());
  const m = new Matrix3(X.x, Y.x, Z.x, X.y, Y.y, Z.y, X.z, Y.z, Z.z);
  // Cesiums glTF-Achsenkorrektur ausgleichen (siehe modelAxes.ts)
  return Quaternion.multiply(Quaternion.fromRotationMatrix(m), MODEL_AXIS_FIX, new Quaternion());
}

function orientationProperty(pos: CallbackPositionProperty, aim: (t: JulianDate) => Aim) {
  return new CallbackProperty((time) => {
    if (!time) return undefined;
    const p = pos.getValue(time, scratchA);
    if (!p) return undefined;
    const a = aim(time);
    if (a === 'up') return quatFromX(p, p);
    const src = typeof a === 'object' ? a.along : pos;
    const p0 = src.getValue(JulianDate.addSeconds(time, -0.5, new JulianDate()), new Cartesian3());
    const p1 = src.getValue(JulianDate.addSeconds(time, 0.5, new JulianDate()), scratchB);
    if (!p0 || !p1) return quatFromX(p, p);
    const v = Cartesian3.subtract(p1, p0, new Cartesian3());
    if (Cartesian3.magnitude(v) < 0.5) return quatFromX(p, p);
    return quatFromX(p, a === 'back' ? Cartesian3.negate(v, v) : v);
  }, false);
}

/** Nach der Trennung behält ein Teil die letzte Ausrichtung bei (taumelt nicht wild herum) */
function frozenAfter(ori: CallbackProperty, sep: JulianDate, pos: CallbackPositionProperty) {
  let frozen: Quaternion | undefined;
  return new CallbackProperty((time) => {
    if (!time) return undefined;
    if (JulianDate.lessThan(time, sep)) return ori.getValue(time);
    if (!frozen) frozen = ori.getValue(sep) as Quaternion;
    // Langsam kippen, damit es lebendig wirkt
    const dt = JulianDate.secondsDifference(time, sep);
    const p = pos.getValue(time, scratchA);
    if (!p) return frozen;
    const spin = Quaternion.fromAxisAngle(Cartesian3.UNIT_Y, dt * 0.02);
    return Quaternion.multiply(frozen, spin, new Quaternion());
  }, false);
}

/** Ballistische Flugbahn ab `from` (Startgeschwindigkeit aus der Bahn davor), bis zum Boden */
function ballistic(path: SampledPositionProperty, from: JulianDate, maxS: number) {
  const out = new SampledPositionProperty();
  const p = path.getValue(from)!.clone();
  const pPrev = path.getValue(JulianDate.addSeconds(from, -1, new JulianDate()))!;
  const v = Cartesian3.subtract(p, pPrev, new Cartesian3());
  const GM = MU * 1e9;
  let end = from;
  for (let s = 0; s <= maxS; s += 2) {
    const t = JulianDate.addSeconds(from, s, new JulianDate());
    out.addSample(t, p.clone());
    end = t;
    if (Cartographic.fromCartesian(p).height < 0) break;
    const r = Cartesian3.magnitude(p);
    const g = Cartesian3.multiplyByScalar(p, -GM / r ** 3, new Cartesian3());
    Cartesian3.add(v, Cartesian3.multiplyByScalar(g, 2, g), v);
    Cartesian3.add(p, Cartesian3.multiplyByScalar(v, 2, new Cartesian3()), p);
  }
  return Object.assign(out, { end });
}

/** Teil treibt nach der Trennung langsam zurück (−) oder vor (+) und nach unten (m/s) */
function drift(base: CallbackPositionProperty, sep: JulianDate, time: JulianDate, back: number, down: number, result?: Cartesian3) {
  const dt = JulianDate.secondsDifference(time, sep);
  const p = base.getValue(time, result);
  if (!p) return undefined;
  const p1 = base.getValue(JulianDate.addSeconds(time, 1, new JulianDate()), new Cartesian3())!;
  const dir = Cartesian3.normalize(Cartesian3.subtract(p1, p, new Cartesian3()), new Cartesian3());
  const upv = Cartesian3.normalize(p, new Cartesian3());
  Cartesian3.add(p, Cartesian3.multiplyByScalar(dir, -back * dt, new Cartesian3()), p);
  return Cartesian3.add(p, Cartesian3.multiplyByScalar(upv, -down * dt, new Cartesian3()), p);
}

function phaseAt0(times: Record<Phase, JulianDate>, time: JulianDate): Phase | 'waiting' {
  for (let i = PHASES.length - 1; i >= 0; i--) if (!JulianDate.lessThan(time, times[PHASES[i]])) return PHASES[i];
  return 'waiting';
}

/** Kapselmitte über dem Boden, wenn die ganze Rakete auf der Rampe steht (km) */
const STACK_H = 0.0585;

function padPosition(site: LaunchSite, result?: Cartesian3, height = STACK_H * 1000) {
  return Cartesian3.fromDegrees(site.lon, site.lat, height, undefined, result);
}

/** In welcher Phase ist die Mission zu diesem Zeitpunkt? */
export function phaseAt(m: Mission, time: JulianDate): Phase | 'waiting' {
  return phaseAt0(m.times, time);
}
