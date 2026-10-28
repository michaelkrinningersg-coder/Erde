import {
  ArcType,
  CallbackPositionProperty,
  CallbackProperty,
  Cartesian2,
  Cartesian3,
  Color,
  ConstantProperty,
  DistanceDisplayCondition,
  Entity,
  JulianDate,
  LabelStyle,
  NearFarScalar,
  PolylineGlowMaterialProperty,
  VelocityOrientationProperty,
  VerticalOrigin,
  type Viewer,
} from 'cesium';
import { eciToEcf, gstime, json2satrec, propagate, type OMMJsonObject, type SatRec } from 'satellite.js';
import { satelliteIcon } from '../icons';

interface Omm extends OMMJsonObject {
  DISPLAY_NAME?: string;
}

export interface SatGroupData {
  id: string;
  name: string;
  color: string;
  defaultOn: boolean;
  objects: Omm[];
}

export interface SatItem {
  id: string;
  name: string;
  entity: Entity;
  orbit: Entity;
  satrec: SatRec;
}

export interface SatGroup {
  id: string;
  name: string;
  color: string;
  items: SatItem[];
  show: boolean;
}

const MU = 398600.4418; // km³/s²
const RE = 6378.137; // km

/** Erdfeste Position (Meter) eines Satelliten zu einem Zeitpunkt */
function positionAt(satrec: SatRec, date: Date, result: Cartesian3): Cartesian3 | undefined {
  const pv = propagate(satrec, date);
  if (!pv || typeof pv.position !== 'object') return undefined;
  const ecf = eciToEcf(pv.position, gstime(date));
  return Cartesian3.fromElements(ecf.x * 1000, ecf.y * 1000, ecf.z * 1000, result);
}

function orbitFacts(o: Omm) {
  const n = Number(o.MEAN_MOTION); // Umläufe pro Tag
  const e = Number(o.ECCENTRICITY);
  const periodMin = 1440 / n;
  const nRad = (n * 2 * Math.PI) / 86400;
  const a = Math.cbrt(MU / (nRad * nRad));
  return {
    periodMin,
    perigee: a * (1 - e) - RE,
    apogee: a * (1 + e) - RE,
    speedKmh: Math.sqrt(MU / a) * 3600,
  };
}

const fmt = (v: number, d = 0) => v.toLocaleString('de-DE', { maximumFractionDigits: d });

function describe(o: Omm, group: string) {
  const f = orbitFacts(o);
  const height =
    Math.abs(f.apogee - f.perigee) < 100
      ? `ca. ${fmt(f.perigee)} km`
      : `${fmt(f.perigee)} – ${fmt(f.apogee)} km`;
  const period = f.periodMin < 180 ? `${fmt(f.periodMin)} Minuten` : `${fmt(f.periodMin / 60, 1)} Stunden`;
  return `
    <table class="cesium-infoBox-defaultTable"><tbody>
      <tr><th>Gruppe</th><td>${group}</td></tr>
      <tr><th>Höhe über der Erde</th><td>${height}</td></tr>
      <tr><th>Einmal um die Erde</th><td>${period}</td></tr>
      <tr><th>Geschwindigkeit</th><td>ca. ${fmt(Math.round(f.speedKmh / 100) * 100)} km/h</td></tr>
      <tr><th>NORAD-Nummer</th><td>${o.NORAD_CAT_ID}</td></tr>
      <tr><th>Bahndaten vom</th><td>${new Date(String(o.EPOCH).slice(0, 23) + 'Z').toLocaleString('de-DE')}</td></tr>
    </tbody></table>`;
}

/** 3D-Modelle (Blender, tools/blender/raumfahrt.py) je NORAD-Nummer; Länge in Metern für den Kameraabstand */
const MODELS: Record<string, { file: string; size: number }> = {
  '25544': { file: 'iss', size: 110 },
  '48274': { file: 'tiangong', size: 55 },
  '20580': { file: 'hubble', size: 17 },
  '25867': { file: 'chandra', size: 20 },
  '25989': { file: 'xmm', size: 16 },
  '28485': { file: 'swift', size: 7 },
  '33053': { file: 'fermi', size: 10 },
  '38358': { file: 'nustar', size: 13 },
};
/** Ab dieser Entfernung (m) wird statt des Modells das Symbol gezeigt */
const MODEL_RANGE = 3e6;

const prettyName = (o: Omm) => o.DISPLAY_NAME ?? o.OBJECT_NAME.replace(/\s+\(.*\)$/, '').trim();

export class Satellites {
  readonly groups: SatGroup[] = [];
  generated?: Date;
  private orbitsFor = new Set<string>();

  constructor(private readonly viewer: Viewer) {}

  async load(url: string) {
    const data: { generated: string; groups: SatGroupData[] } = await (await fetch(url)).json();
    this.generated = new Date(data.generated);
    for (const g of data.groups) {
      const important = g.id === 'stations' || g.id === 'telescopes';
      const items: SatItem[] = [];
      for (const o of g.objects) {
        let satrec: SatRec;
        try {
          satrec = json2satrec(o);
        } catch {
          continue;
        }
        items.push(this.createItem(o, satrec, g, important));
      }
      const group: SatGroup = { id: g.id, name: g.name, color: g.color, items, show: g.defaultOn };
      this.groups.push(group);
      this.setGroupVisible(group, g.defaultOn);
    }
    // Die ISS-Bahn ist standardmäßig sichtbar
    const iss = this.find('25544');
    if (iss) this.setOrbitVisible(iss, true);
  }

  find(norad: string) {
    for (const g of this.groups) for (const it of g.items) if (it.id === norad) return it;
    return undefined;
  }

  private createItem(o: Omm, satrec: SatRec, g: SatGroupData, important: boolean): SatItem {
    const name = prettyName(o);
    const isIss = String(o.NORAD_CAT_ID) === '25544';
    let lastTime = new JulianDate(0, 0);
    let lastPos: Cartesian3 | undefined = new Cartesian3();
    const cached = new Cartesian3();

    const position = new CallbackPositionProperty((time, result) => {
      if (!time) return undefined;
      if (!JulianDate.equals(time, lastTime)) {
        lastTime = JulianDate.clone(time, lastTime);
        lastPos = positionAt(satrec, JulianDate.toDate(time), cached);
      }
      return lastPos ? Cartesian3.clone(lastPos, result) : undefined;
    }, false);

    const color = Color.fromCssColorString(g.color);
    const model = MODELS[String(o.NORAD_CAT_ID)];
    const entity = new Entity({
      id: `sat-${o.NORAD_CAT_ID}`,
      name,
      position,
      // Mitfliegen: mit Modell ganz nah dran (schräg hinten oben), sonst aus der Ferne
      viewFrom: model ? new Cartesian3(-model.size * 2.2, -model.size * 1.6, model.size * 0.9) : new Cartesian3(0, -1_800_000, 900_000),
      description: describe(o, g.name),
      // +X des Modells zeigt in Flugrichtung, +Z von der Erde weg
      orientation: model ? new VelocityOrientationProperty(position) : undefined,
      model: model
        ? {
            uri: `./models/${model.file}.glb`,
            minimumPixelSize: 72,
            maximumScale: 20000,
            distanceDisplayCondition: new DistanceDisplayCondition(0, MODEL_RANGE),
          }
        : undefined,
      billboard: {
        image: satelliteIcon(g.color, isIss ? 34 : important ? 26 : 20, isIss || important),
        scaleByDistance: new NearFarScalar(1.5e6, 1.4, 6e7, 0.6),
        distanceDisplayCondition: model ? new DistanceDisplayCondition(MODEL_RANGE, Number.MAX_VALUE) : undefined,
      },
      label: {
        text: name,
        font: important ? 'bold 15px system-ui, sans-serif' : '13px system-ui, sans-serif',
        fillColor: important ? Color.WHITE : color,
        outlineColor: Color.BLACK,
        outlineWidth: 3,
        style: LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: VerticalOrigin.TOP,
        pixelOffset: new Cartesian2(0, 16),
        distanceDisplayCondition: important ? undefined : new DistanceDisplayCondition(0, 9e6),
      },
    });

    // Bahnlinie: eine Umlaufzeit, mittig um den aktuellen Zeitpunkt (erdfest gezeichnet)
    const periodSec = orbitFacts(o).periodMin * 60;
    let orbitStamp = Number.NaN;
    let orbitPositions: Cartesian3[] = [];
    const orbit = new Entity({
      id: `orbit-${o.NORAD_CAT_ID}`,
      show: false,
      polyline: {
        positions: new CallbackProperty((time) => {
          if (!time) return orbitPositions;
          const t = JulianDate.toDate(time).getTime();
          // Nur neu berechnen, wenn sich die Zeit um mehr als 1/200 Umlauf geändert hat
          if (!(Math.abs(t - orbitStamp) < (periodSec * 1000) / 200)) {
            orbitStamp = t;
            const pts: Cartesian3[] = [];
            const n = 240;
            for (let i = 0; i <= n; i++) {
              const p = positionAt(satrec, new Date(t + ((i / n - 0.5) * periodSec * 1000)), new Cartesian3());
              if (p) pts.push(p);
            }
            orbitPositions = pts;
          }
          return orbitPositions;
        }, false),
        width: isIss ? 3 : 2,
        material: new PolylineGlowMaterialProperty({ color: color.withAlpha(0.8), glowPower: 0.15 }),
        arcType: ArcType.NONE, // gerade Segmente zwischen den Bahnpunkten
      },
    });

    this.viewer.entities.add(entity);
    this.viewer.entities.add(orbit);
    return { id: String(o.NORAD_CAT_ID), name, entity, orbit, satrec };
  }

  setGroupVisible(group: SatGroup, show: boolean) {
    group.show = show;
    for (const it of group.items) this.setItemVisible(it, show);
  }

  setItemVisible(item: SatItem, show: boolean) {
    item.entity.show = show;
    item.orbit.show = show && this.orbitsFor.has(item.id);
  }

  setOrbitVisible(item: SatItem, show: boolean) {
    if (show) this.orbitsFor.add(item.id);
    else this.orbitsFor.delete(item.id);
    item.orbit.show = show && item.entity.show;
  }

  /** Beim Anklicken eines Satelliten dessen Bahn zeigen */
  highlight(entity: Entity | undefined) {
    for (const g of this.groups) {
      for (const it of g.items) {
        const selected = it.entity === entity;
        it.orbit.show = it.entity.show && (selected || this.orbitsFor.has(it.id));
        if (it.entity.label) it.entity.label.distanceDisplayCondition = new ConstantProperty(
          selected || g.id === 'stations' || g.id === 'telescopes' ? undefined : new DistanceDisplayCondition(0, 9e6),
        );
      }
    }
  }
}
