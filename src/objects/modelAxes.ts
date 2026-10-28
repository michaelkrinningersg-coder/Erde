import { CallbackProperty, Cartesian3, Math as CMath, Quaternion, type Property } from 'cesium';

// Cesium dreht glTF-Modelle beim Laden (glTF: +Y oben, +Z vorne → Cesium: +Z oben, +X vorne).
// Unsere Blender-Modelle haben +X vorne und +Z oben; nach Cesiums Korrektur landet ihr +X auf +Y.
// Diese Drehung (−90° um die Hochachse) gleicht das aus.
export const MODEL_AXIS_FIX = Quaternion.fromAxisAngle(Cartesian3.UNIT_Z, -CMath.PI_OVER_TWO);

/** Ausrichtung (z. B. Flugrichtung) so umrechnen, dass das Blender-+X tatsächlich nach vorn zeigt */
export function fixModelAxes(orientation: Property): CallbackProperty {
  return new CallbackProperty((time, result) => {
    const q = orientation.getValue(time!) as Quaternion | undefined;
    return q ? Quaternion.multiply(q, MODEL_AXIS_FIX, result ?? new Quaternion()) : undefined;
  }, false);
}
