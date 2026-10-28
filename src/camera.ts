import {
  BoundingSphere,
  Cartesian3,
  Cartographic,
  HeadingPitchRange,
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
 * Kamera-Steuerung:
 *  - Fokuspunkt: Die Erde dreht sich beim Ziehen um einen gewählten Punkt.
 *  - Blick aus dem All: Kamera steht still im Weltraum, die Erde dreht sich darunter.
 */
export class CameraControl {
  focusName?: string;
  onChange?: () => void;
  private spaceView = false;
  private focusCenter?: Cartesian3;

  constructor(private readonly viewer: Viewer) {
    const { scene } = viewer;
    // Doppelklick: auf ein Objekt → verfolgen; auf die Erde → Fokuspunkt setzen
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
      const range = Math.min(Cartesian3.distance(viewer.camera.positionWC, cart) * 0.6, 8e6);
      this.focus({
        name: `${CMath.toDegrees(c.latitude).toFixed(1)}°, ${CMath.toDegrees(c.longitude).toFixed(1)}°`,
        lat: CMath.toDegrees(c.latitude),
        lon: CMath.toDegrees(c.longitude),
        range,
      });
    }, ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

    scene.postUpdate.addEventListener((_s, time) => {
      if (!this.spaceView || this.focusCenter || viewer.trackedEntity) return;
      // Kamera im himmelsfesten System halten → Erde dreht sich sichtbar
      const offset = Cartesian3.clone(viewer.camera.position);
      viewer.camera.lookAtTransform(Matrix4.fromRotationTranslation(icrfToFixed(time)), offset);
    });
  }

  focus(t: FocusTarget) {
    const { camera } = this.viewer;
    this.viewer.trackedEntity = undefined;
    camera.lookAtTransform(Matrix4.IDENTITY);
    const center = Cartesian3.fromDegrees(t.lon, t.lat);
    const offset = new HeadingPitchRange(0, CMath.toRadians(-55), t.range ?? 3e6);
    this.focusCenter = center;
    this.focusName = t.name;
    this.onChange?.();
    camera.flyToBoundingSphere(new BoundingSphere(center, 1), {
      offset,
      duration: 2.2,
      complete: () => {
        // Ab jetzt dreht sich die Ansicht beim Ziehen um diesen Punkt
        if (this.focusCenter === center) camera.lookAt(center, offset);
      },
    });
  }

  release() {
    this.focusCenter = undefined;
    this.focusName = undefined;
    this.viewer.camera.lookAtTransform(Matrix4.IDENTITY);
    this.onChange?.();
  }

  setSpaceView(on: boolean) {
    this.spaceView = on;
    if (!on) this.viewer.camera.lookAtTransform(Matrix4.IDENTITY);
    else this.release();
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
    this.viewer.camera.flyTo({ destination: Cartesian3.fromDegrees(10, 35, 2.2e7), duration: 2 });
  }
}
