import {
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  DistanceDisplayCondition,
  Entity,
  HeightReference,
  LabelStyle,
  Math as CMath,
  NearFarScalar,
  VerticalOrigin,
  type Viewer,
} from 'cesium';
import type { CameraControl } from './camera';
import { homeIcon } from './icons';

export interface Home {
  name: string;
  lat: number;
  lon: number;
}

const KEY = 'erde.home';

export const HOME_CITIES: Home[] = [
  { name: 'Berlin', lat: 52.52, lon: 13.405 },
  { name: 'Hamburg', lat: 53.551, lon: 9.994 },
  { name: 'München', lat: 48.137, lon: 11.575 },
  { name: 'Köln', lat: 50.938, lon: 6.96 },
  { name: 'Frankfurt am Main', lat: 50.11, lon: 8.682 },
  { name: 'Stuttgart', lat: 48.776, lon: 9.183 },
  { name: 'Düsseldorf', lat: 51.227, lon: 6.773 },
  { name: 'Leipzig', lat: 51.34, lon: 12.375 },
  { name: 'Dortmund', lat: 51.514, lon: 7.465 },
  { name: 'Essen', lat: 51.456, lon: 7.012 },
  { name: 'Bremen', lat: 53.079, lon: 8.802 },
  { name: 'Dresden', lat: 51.05, lon: 13.738 },
  { name: 'Hannover', lat: 52.375, lon: 9.732 },
  { name: 'Nürnberg', lat: 49.452, lon: 11.077 },
  { name: 'Augsburg', lat: 48.371, lon: 10.898 },
  { name: 'Regensburg', lat: 49.013, lon: 12.102 },
  { name: 'Freiburg', lat: 47.999, lon: 7.842 },
  { name: 'Mannheim', lat: 49.488, lon: 8.466 },
  { name: 'Karlsruhe', lat: 49.007, lon: 8.404 },
  { name: 'Würzburg', lat: 49.791, lon: 9.953 },
  { name: 'Wien', lat: 48.208, lon: 16.373 },
  { name: 'Zürich', lat: 47.377, lon: 8.541 },
];

/** „Zuhause“: ein Ort, den die Familie selbst festlegt – gespeichert nur im eigenen Browser. */
export class HomeControl {
  private home?: Home;
  private readonly marker: Entity;
  onChange?: () => void;

  constructor(
    private readonly viewer: Viewer,
    private readonly camera: CameraControl,
  ) {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) this.home = JSON.parse(raw);
    } catch {
      /* ohne Speicher */
    }
    this.marker = viewer.entities.add({
      id: 'home',
      name: 'Zuhause',
      show: false,
      billboard: {
        image: homeIcon(),
        verticalOrigin: VerticalOrigin.BOTTOM,
        heightReference: HeightReference.NONE,
        scaleByDistance: new NearFarScalar(2e5, 1.2, 2e7, 0.6),
        distanceDisplayCondition: new DistanceDisplayCondition(0, 2.5e7),
      },
      label: {
        text: 'Zuhause',
        font: 'bold 15px system-ui, sans-serif',
        fillColor: Color.fromCssColorString('#ffd166'),
        outlineColor: Color.BLACK,
        outlineWidth: 3,
        style: LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: VerticalOrigin.TOP,
        pixelOffset: new Cartesian2(0, 4),
        distanceDisplayCondition: new DistanceDisplayCondition(0, 2.5e7),
      },
    });
    this.updateMarker();
  }

  get current() {
    return this.home;
  }

  set(home: Home) {
    this.home = home;
    try {
      localStorage.setItem(KEY, JSON.stringify(home));
    } catch {
      /* ohne Speicher */
    }
    this.updateMarker();
    this.onChange?.();
  }

  private updateMarker() {
    if (!this.home) return;
    this.marker.position = Cartesian3.fromDegrees(this.home.lon, this.home.lat) as never;
    this.marker.label!.text = `Zuhause (${this.home.name})` as never;
    this.marker.show = true;
  }

  /** Kamera fliegt nach Hause; die Erde dreht sich danach um diesen Punkt */
  goHome() {
    if (!this.home) return false;
    this.camera.focus({ name: this.home.name, lat: this.home.lat, lon: this.home.lon, range: 1.2e6 });
    return true;
  }

  /** Punkt in der Bildmitte (für „Bildmitte übernehmen“) */
  centerOfView(): Home | undefined {
    const c = this.viewer.canvas;
    const hit = this.viewer.camera.pickEllipsoid(new Cartesian2(c.clientWidth / 2, c.clientHeight / 2));
    if (!hit) return undefined;
    const g = Cartographic.fromCartesian(hit);
    const lat = CMath.toDegrees(g.latitude);
    const lon = CMath.toDegrees(g.longitude);
    return { name: `${lat.toFixed(2)}°, ${lon.toFixed(2)}°`, lat, lon };
  }
}
