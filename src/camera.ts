import {
  Cartesian2,
  Cartesian3,
  Cartographic,
  Math as CMath,
  Matrix4,
  ScreenSpaceEventType,
  defined,
  type Entity,
  type Viewer,
} from 'cesium';
import { icrfToFixed } from './globe';

export interface FocusTarget {
  name: string;
  lat: number;
  lon: number;
  range?: number; // Abstand der Kamera in Metern
}

export const FOCUS_TARGETS: FocusTarget[] = [
  { name: 'Deutschland', lat: 51.1, lon: 10.4, range: 2.6e6 },
  { name: 'Europa', lat: 50, lon: 12, range: 7e6 },
  { name: 'Frankfurt', lat: 50.11, lon: 8.68, range: 4e5 },
  { name: 'New York', lat: 40.71, lon: -74.0, range: 4e5 },
  { name: 'Alpen', lat: 46.5, lon: 10.5, range: 8e5 },
  { name: 'Nordpol', lat: 89.9, lon: 0, range: 7e6 },
  { name: 'Südpol', lat: -89.9, lon: 0, range: 7e6 },
  { name: 'Sahara', lat: 23, lon: 12, range: 4e6 },
  { name: 'Amazonas', lat: -4, lon: -62, range: 4e6 },
  { name: 'Himalaya', lat: 28, lon: 86.9, range: 1.5e6 },
  { name: 'Australien', lat: -25, lon: 134, range: 6e6 },
];

/**
 * Kamera-Steuerung. Die Erde bleibt immer eingenordet (Norden oben):
 * Ziehen dreht sie, das Mausrad zoomt – kein Kippen, kein Verdrehen.
 *  - Fokus: fliegt senkrecht über einen Ort.
 *  - Blick aus dem All: Kamera steht still im Weltraum, die Erde dreht sich darunter.
 */
export class CameraControl {
  onChange?: () => void;
  private spaceView = false;

  constructor(private readonly viewer: Viewer) {
    const { scene } = viewer;
    // Doppelklick: auf ein Objekt → mitfliegen; auf die Erde → dorthin fliegen
    viewer.screenSpaceEventHandler.setInputAction((ev: { position: { x: number; y: number } }) => {
      const picked = scene.pick(ev.position as never);
      const entity = picked?.id as Entity | undefined;
      if (entity && defined(entity.position)) {
        this.release();
        viewer.trackedEntity = entity;
        return;
      }
      const cart = viewer.camera.pickEllipsoid(ev.position as never);
      if (!cart) return;
      const c = Cartographic.fromCartesian(cart);
      const range = Math.max(2e4, viewer.camera.positionCartographic.height * 0.5);
      this.focus({ name: '', lat: CMath.toDegrees(c.latitude), lon: CMath.toDegrees(c.longitude), range });
    }, ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

    scene.postUpdate.addEventListener((_s, time) => {
      if (!this.spaceView || viewer.trackedEntity) return;
      // Kamera im himmelsfesten System halten → Erde dreht sich sichtbar
      const offset = Cartesian3.clone(viewer.camera.position);
      viewer.camera.lookAtTransform(Matrix4.fromRotationTranslation(icrfToFixed(time)), offset);
    });
  }

  /** Senkrecht über einen Ort fliegen, Norden oben */
  focus(t: FocusTarget) {
    this.release();
    this.viewer.trackedEntity = undefined;
    this.viewer.camera.flyTo({
      destination: Cartesian3.fromDegrees(t.lon, t.lat, t.range ?? 3e6),
      orientation: { heading: 0, pitch: -CMath.PI_OVER_TWO, roll: 0 },
      duration: 2,
    });
  }

  /** Einnorden: Norden nach oben, senkrechter Blick auf die Bildmitte, Abstand bleibt */
  north() {
    const { camera, canvas } = this.viewer;
    this.viewer.trackedEntity = undefined;
    this.release();
    const center = camera.pickEllipsoid(new Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2));
    const height = camera.positionCartographic.height;
    const c = center ? Cartographic.fromCartesian(center) : camera.positionCartographic;
    const dist = center ? Cartesian3.distance(camera.positionWC, center) : height;
    camera.flyTo({
      destination: Cartesian3.fromRadians(c.longitude, c.latitude, dist),
      orientation: { heading: 0, pitch: -CMath.PI_OVER_TWO, roll: 0 },
      duration: 1,
    });
  }

  release() {
    this.viewer.camera.lookAtTransform(Matrix4.IDENTITY);
    this.onChange?.();
  }

  setSpaceView(on: boolean) {
    this.spaceView = on;
    if (!on) this.viewer.camera.lookAtTransform(Matrix4.IDENTITY);
  }

  get isSpaceView() {
    return this.spaceView;
  }

  /** Kamera fliegt zum Mond und folgt ihm */
  flyToMoon(moon: Entity) {
    this.release();
    this.viewer.trackedEntity = moon;
  }

  home() {
    this.release();
    this.viewer.trackedEntity = undefined;
    this.viewer.camera.flyTo({
      destination: Cartesian3.fromDegrees(10, 35, 2.2e7),
      orientation: { heading: 0, pitch: -CMath.PI_OVER_TWO, roll: 0 },
      duration: 2,
    });
  }
}
