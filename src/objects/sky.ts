import {
  CallbackPositionProperty,
  CallbackProperty,
  Cartesian2,
  Cartesian3,
  Color,
  DistanceDisplayCondition,
  Entity,
  JulianDate,
  LabelStyle,
  Matrix3,
  Moon,
  VerticalOrigin,
  type Viewer,
} from 'cesium';
import * as Astronomy from 'astronomy-engine';
import { PLANET_MARKER_DISTANCE_M } from '../config';
import { icrfToFixed } from '../globe';
import { planetIcon, type PlanetStyle } from '../icons';

const AU = 149_597_870_700; // Meter

interface BodyDef {
  id: string;
  body: Astronomy.Body;
  name: string;
  style: PlanetStyle;
  fact: string;
}

export const PLANETS: BodyDef[] = [
  { id: 'mercury', body: Astronomy.Body.Mercury, name: 'Merkur', style: { colors: ['#e2ddd5', '#77716a'], size: 20 }, fact: 'Der kleinste Planet und der Sonne am nächsten. Ein Jahr dauert nur 88 Tage.' },
  { id: 'venus', body: Astronomy.Body.Venus, name: 'Venus', style: { colors: ['#fff4cc', '#c49b52'], size: 26 }, fact: 'Der heißeste Planet – dichte Wolken halten die Wärme fest. Oft als hellster „Stern“ am Abend- oder Morgenhimmel zu sehen.' },
  { id: 'mars', body: Astronomy.Body.Mars, name: 'Mars', style: { colors: ['#ffa375', '#9c3a1a'], size: 24 }, fact: 'Der rote Planet. Ein Tag dauert dort 24 Stunden und 37 Minuten.' },
  { id: 'jupiter', body: Astronomy.Body.Jupiter, name: 'Jupiter', style: { colors: ['#f6e3c6', '#a9774a'], size: 38, bands: true }, fact: 'Der größte Planet – über 1.300 Erden würden hineinpassen.' },
  { id: 'saturn', body: Astronomy.Body.Saturn, name: 'Saturn', style: { colors: ['#f7e9bd', '#b39556'], size: 32, ring: true }, fact: 'Der Planet mit den schönsten Ringen aus Eis und Gestein.' },
  { id: 'uranus', body: Astronomy.Body.Uranus, name: 'Uranus', style: { colors: ['#dcfcff', '#62b0be'], size: 26 }, fact: 'Ein Eisriese, der auf der Seite liegend um die Sonne rollt.' },
  { id: 'neptune', body: Astronomy.Body.Neptune, name: 'Neptun', style: { colors: ['#a4c8ff', '#2c50c4'], size: 26 }, fact: 'Der äußerste Planet mit den stärksten Winden im Sonnensystem.' },
];

export interface SkyItem {
  id: string;
  name: string;
  entity: Entity;
}

const fmtDist = (m: number) => {
  const km = m / 1000;
  if (km > 1e8) return `${(km / 1e9).toLocaleString('de-DE', { maximumFractionDigits: 2 })} Mrd. km`;
  if (km > 1e6) return `${Math.round(km / 1e6).toLocaleString('de-DE')} Mio. km`;
  return `${Math.round(km).toLocaleString('de-DE')} km`;
};

/** Positionen von Sonne, Mond und Planeten – echte Richtung, Planeten in symbolischer Entfernung */
export class Sky {
  readonly planets: SkyItem[] = [];
  sun!: SkyItem;
  moon!: SkyItem;
  jwst!: SkyItem;

  private stamp = new JulianDate(0, 0);
  private rot = new Matrix3();
  private readonly eqj = new Map<string, Cartesian3>(); // geozentrisch, ICRF, Meter
  private eqjStamp = Number.NaN;

  constructor(private readonly viewer: Viewer) {
    // Hochauflösende Mondoberfläche (NASA LRO, Public Domain); Phase wird von der Sonne beleuchtet
    viewer.scene.moon = new Moon({ textureUrl: './textures/moon-4k.jpg', onlySunLighting: true });
    this.sun = this.add('sun', 'Sonne', Astronomy.Body.Sun, undefined, 'Unser Stern. Ihr Licht braucht gut 8 Minuten bis zur Erde.', true);
    this.moon = this.add('moon', 'Mond', Astronomy.Body.Moon, undefined, 'Unser Begleiter. Er zeigt der Erde immer dieselbe Seite.', false);
    for (const p of PLANETS) this.planets.push(this.add(p.id, p.name, p.body, p.style, p.fact, true));
    this.jwst = this.addJwst();
  }

  /** Aktualisiert die Lage aller Himmelskörper für den Zeitpunkt (einmal pro Bild) */
  private ensure(time: JulianDate) {
    if (JulianDate.equals(time, this.stamp)) return;
    JulianDate.clone(time, this.stamp);
    Matrix3.clone(icrfToFixed(time), this.rot);
    const ms = JulianDate.toDate(time).getTime();
    // Bahnen ändern sich langsam: alle 60 s Simulationszeit neu rechnen
    if (!(Math.abs(ms - this.eqjStamp) < 60_000)) {
      this.eqjStamp = ms;
      const date = new Date(ms);
      for (const b of [Astronomy.Body.Sun, Astronomy.Body.Moon, ...PLANETS.map((p) => p.body)]) {
        const v = b === Astronomy.Body.Moon ? Astronomy.GeoMoon(date) : Astronomy.GeoVector(b, date, true);
        this.eqj.set(b, new Cartesian3(v.x * AU, v.y * AU, v.z * AU));
      }
    }
  }

  /** Erdfeste Position; symbolic = Richtung stimmt, Entfernung = Marker-Abstand */
  private fixedPosition(body: string, time: JulianDate, symbolic: boolean, result?: Cartesian3) {
    this.ensure(time);
    const v = this.eqj.get(body)!;
    const out = Matrix3.multiplyByVector(this.rot, v, result ?? new Cartesian3());
    if (symbolic) Cartesian3.multiplyByScalar(Cartesian3.normalize(out, out), PLANET_MARKER_DISTANCE_M, out);
    return out;
  }

  distance(body: string, time: JulianDate) {
    this.ensure(time);
    return Cartesian3.magnitude(this.eqj.get(body)!);
  }

  private add(id: string, name: string, body: Astronomy.Body, style: PlanetStyle | undefined, fact: string, symbolic: boolean): SkyItem {
    let lastLabel = '';
    const entity = new Entity({
      id: `sky-${id}`,
      name,
      position: new CallbackPositionProperty((time, result) => (time ? this.fixedPosition(body, time, symbolic, result) : undefined), false),
      description: new CallbackProperty((time) => {
        const d = time ? fmtDist(this.distance(body, time)) : '';
        return `<p>${fact}</p><table class="cesium-infoBox-defaultTable"><tbody><tr><th>Entfernung zur Erde</th><td>${d}</td></tr></tbody></table>
          ${symbolic && id !== 'sun' ? '<p><i>Hinweis: Die Richtung stimmt, der Planet ist zur besseren Sichtbarkeit aber viel größer und näher gezeichnet.</i></p>' : ''}`;
      }, false),
      billboard: style ? { image: planetIcon(id, style) } : undefined,
      label: {
        text: new CallbackProperty((time) => {
          if (!time) return lastLabel;
          lastLabel = id === 'moon' ? name : `${name}\n${fmtDist(this.distance(body, time))}`;
          return lastLabel;
        }, false),
        font: 'bold 15px system-ui, sans-serif',
        fillColor: id === 'sun' ? Color.fromCssColorString('#ffd166') : Color.WHITE,
        outlineColor: Color.BLACK,
        outlineWidth: 3,
        style: LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: VerticalOrigin.TOP,
        pixelOffset: new Cartesian2(0, style ? Math.round(style.size * (style.ring ? 0.75 : 0.65)) : 26),
        // Mond-Beschriftung ausblenden, wenn man direkt davor ist
        distanceDisplayCondition: id === 'moon' ? new DistanceDisplayCondition(4e7, Number.MAX_VALUE) : undefined,
      },
      // „Zum Mond fliegen“: Kamera steht auf der Erdseite (lokales „oben“ zeigt von der Erde weg),
      // so sieht man die Mondphase genau wie von zu Hause
      viewFrom: id === 'moon' ? new Cartesian3(0, -2.0e6, -7.5e6) : undefined,
    });
    this.viewer.entities.add(entity);
    return { id, name, entity };
  }

  /** James-Webb-Teleskop: am Lagrangepunkt L2, ca. 1,5 Mio. km auf der sonnenabgewandten Seite (Näherung) */
  private addJwst(): SkyItem {
    const L2 = 1.5e9;
    const entity = new Entity({
      id: 'sky-jwst',
      name: 'James-Webb-Teleskop',
      position: new CallbackPositionProperty((time, result) => {
        if (!time) return undefined;
        const sun = this.fixedPosition(Astronomy.Body.Sun, time, false, result);
        return Cartesian3.multiplyByScalar(Cartesian3.normalize(sun, sun), -L2, sun);
      }, false),
      description:
        '<p>Das größte Weltraumteleskop. Es steht etwa 1,5 Millionen km von der Erde entfernt – immer auf der Seite, die von der Sonne abgewandt ist (Lagrangepunkt L2). Die Position ist eine Näherung.</p>',
      billboard: { image: planetIcon('jwst', { colors: ['#ffe08a', '#c79a1e'], size: 18 }) },
      label: {
        text: 'James Webb\n1,5 Mio. km',
        font: 'bold 14px system-ui, sans-serif',
        fillColor: Color.fromCssColorString('#ffe08a'),
        outlineColor: Color.BLACK,
        outlineWidth: 3,
        style: LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: VerticalOrigin.TOP,
        pixelOffset: new Cartesian2(0, 14),
      },
    });
    this.viewer.entities.add(entity);
    return { id: 'jwst', name: 'James-Webb-Teleskop', entity };
  }

  set showSunDisc(v: boolean) {
    if (this.viewer.scene.sun) this.viewer.scene.sun.show = v;
    this.sun.entity.show = v;
  }

  set showMoonDisc(v: boolean) {
    if (this.viewer.scene.moon) this.viewer.scene.moon.show = v;
    this.moon.entity.show = v;
  }
}
