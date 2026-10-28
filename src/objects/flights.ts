import {
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  Ellipsoid,
  EllipsoidGeodesic,
  Entity,
  JulianDate,
  LabelStyle,
  PolylineDashMaterialProperty,
  SampledPositionProperty,
  TimeInterval,
  TimeIntervalCollection,
  VelocityVectorProperty,
  VerticalOrigin,
  type Viewer,
} from 'cesium';
import { planeIcon } from '../icons';

export interface Airport {
  code: string;
  city: string;
  lat: number;
  lon: number;
}

export const AIRPORTS: Airport[] = [
  { code: 'FRA', city: 'Frankfurt', lat: 50.0379, lon: 8.5622 },
  { code: 'JFK', city: 'New York', lat: 40.6413, lon: -73.7781 },
  { code: 'MUC', city: 'München', lat: 48.3537, lon: 11.775 },
  { code: 'BER', city: 'Berlin', lat: 52.3667, lon: 13.5033 },
  { code: 'LHR', city: 'London', lat: 51.47, lon: -0.4543 },
  { code: 'CDG', city: 'Paris', lat: 49.0097, lon: 2.5479 },
  { code: 'MAD', city: 'Madrid', lat: 40.4983, lon: -3.5676 },
  { code: 'IST', city: 'Istanbul', lat: 41.2753, lon: 28.7519 },
  { code: 'DXB', city: 'Dubai', lat: 25.2532, lon: 55.3657 },
  { code: 'DEL', city: 'Delhi', lat: 28.5562, lon: 77.1 },
  { code: 'SIN', city: 'Singapur', lat: 1.3644, lon: 103.9915 },
  { code: 'PEK', city: 'Peking', lat: 40.0799, lon: 116.6031 },
  { code: 'HND', city: 'Tokio', lat: 35.5494, lon: 139.7798 },
  { code: 'SYD', city: 'Sydney', lat: -33.9399, lon: 151.1753 },
  { code: 'LAX', city: 'Los Angeles', lat: 33.9416, lon: -118.4085 },
  { code: 'SFO', city: 'San Francisco', lat: 37.6213, lon: -122.379 },
  { code: 'ORD', city: 'Chicago', lat: 41.9742, lon: -87.9073 },
  { code: 'MIA', city: 'Miami', lat: 25.7959, lon: -80.287 },
  { code: 'YYZ', city: 'Toronto', lat: 43.6777, lon: -79.6248 },
  { code: 'GRU', city: 'São Paulo', lat: -23.4356, lon: -46.4731 },
  { code: 'JNB', city: 'Johannesburg', lat: -26.1367, lon: 28.2411 },
  { code: 'CAI', city: 'Kairo', lat: 30.1219, lon: 31.4056 },
  { code: 'KEF', city: 'Reykjavík', lat: 63.985, lon: -22.6056 },
  { code: 'ANC', city: 'Anchorage', lat: 61.1743, lon: -149.9963 },
];

export interface Flight {
  id: string;
  from: Airport;
  to: Airport;
  departure: JulianDate;
  arrival: JulianDate;
  distanceKm: number;
  plane: Entity;
  route: Entity;
}

const CRUISE_ALT = 11_000; // m
const CRUISE_SPEED = 250; // m/s ≈ 900 km/h
const CLIMB_DIST = 180_000; // m bis Reiseflughöhe
const DESCENT_DIST = 220_000; // m Sinkflug

/** Geschwindigkeit und Höhe entlang der Strecke (einfaches Flugprofil) */
function profile(d: number, total: number) {
  const climb = Math.min(CLIMB_DIST, total * 0.4);
  const descent = Math.min(DESCENT_DIST, total * 0.45);
  if (d < climb) {
    const f = d / climb;
    return { alt: CRUISE_ALT * Math.sin((f * Math.PI) / 2), speed: 120 + (CRUISE_SPEED - 120) * f };
  }
  if (d > total - descent) {
    const f = (total - d) / descent;
    return { alt: CRUISE_ALT * Math.sin((f * Math.PI) / 2), speed: 110 + (CRUISE_SPEED - 110) * f };
  }
  return { alt: CRUISE_ALT, speed: CRUISE_SPEED };
}

const fmtTime = (d: JulianDate) =>
  JulianDate.toDate(d).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export class Flights {
  readonly list: Flight[] = [];
  onChange?: () => void;
  private counter = 0;

  constructor(private readonly viewer: Viewer) {}

  /** Simuliert einen Flug auf dem Großkreis (kürzester Weg über die Erdkugel) */
  create(from: Airport, to: Airport, departure: JulianDate): Flight {
    const id = `flight-${++this.counter}`;
    const a = Cartographic.fromDegrees(from.lon, from.lat);
    const b = Cartographic.fromDegrees(to.lon, to.lat);
    const geo = new EllipsoidGeodesic(a, b, Ellipsoid.WGS84);
    const total = geo.surfaceDistance;

    const position = new SampledPositionProperty();
    const routePoints: Cartesian3[] = [];
    const step = 5_000; // m
    let t = 0;
    let d = 0;
    const carto = new Cartographic();
    while (true) {
      const { alt, speed } = profile(d, total);
      geo.interpolateUsingSurfaceDistance(d, carto);
      const p = Cartesian3.fromRadians(carto.longitude, carto.latitude, alt);
      position.addSample(JulianDate.addSeconds(departure, t, new JulianDate()), p);
      if (Math.round(d / step) % 10 === 0) routePoints.push(p);
      if (d >= total) break;
      const next = Math.min(total, d + step);
      t += (next - d) / speed;
      d = next;
    }
    routePoints.push(Cartesian3.fromDegrees(to.lon, to.lat, 0));
    const arrival = JulianDate.addSeconds(departure, t, new JulianDate());

    const durationMin = Math.round(t / 60);
    const flight: Flight = {
      id,
      from,
      to,
      departure,
      arrival,
      distanceKm: Math.round(total / 1000),
      route: new Entity({
        id: `${id}-route`,
        polyline: {
          positions: routePoints,
          width: 2,
          material: new PolylineDashMaterialProperty({ color: Color.fromCssColorString('#ffd166').withAlpha(0.85), dashLength: 18 }),
        },
      }),
      plane: new Entity({
        id,
        name: `${from.city} → ${to.city}`,
        availability: new TimeIntervalCollection([new TimeInterval({ start: departure, stop: arrival })]),
        position,
        // Kamera beim Mitfliegen: schräg von hinten oben, damit man Flugzeug und Erde sieht
        viewFrom: new Cartesian3(0, -450_000, 380_000),
        billboard: {
          image: planeIcon('#ffffff', 34),
          alignedAxis: new VelocityVectorProperty(position, true),
        },
        label: {
          text: `${from.code} → ${to.code}`,
          font: 'bold 14px system-ui, sans-serif',
          fillColor: Color.fromCssColorString('#ffd166'),
          outlineColor: Color.BLACK,
          outlineWidth: 3,
          style: LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: VerticalOrigin.TOP,
          pixelOffset: new Cartesian2(0, 20),
        },
        path: {
          leadTime: 0,
          trailTime: t,
          width: 3,
          material: Color.fromCssColorString('#ffd166'),
          resolution: 120,
        },
        description: `
          <p>Simulierter Flug auf dem kürzesten Weg über die Erdkugel (Großkreis).
          Echte Flüge weichen je nach Wind und Flugrouten etwas davon ab.</p>
          <table class="cesium-infoBox-defaultTable"><tbody>
            <tr><th>Strecke</th><td>${from.city} (${from.code}) → ${to.city} (${to.code})</td></tr>
            <tr><th>Entfernung</th><td>${Math.round(total / 1000).toLocaleString('de-DE')} km</td></tr>
            <tr><th>Flugzeit</th><td>${Math.floor(durationMin / 60)} h ${durationMin % 60} min</td></tr>
            <tr><th>Abflug</th><td>${fmtTime(departure)}</td></tr>
            <tr><th>Ankunft</th><td>${fmtTime(arrival)}</td></tr>
            <tr><th>Reiseflughöhe</th><td>11.000 m</td></tr>
          </tbody></table>`,
      }),
    };
    this.viewer.entities.add(flight.route);
    this.viewer.entities.add(flight.plane);
    this.list.push(flight);
    this.onChange?.();
    return flight;
  }

  remove(f: Flight) {
    if (this.viewer.trackedEntity === f.plane) this.viewer.trackedEntity = undefined;
    this.viewer.entities.remove(f.plane);
    this.viewer.entities.remove(f.route);
    this.list.splice(this.list.indexOf(f), 1);
    this.onChange?.();
  }
}
