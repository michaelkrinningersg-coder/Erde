import {
  Color,
  Credit,
  GeographicTilingScheme,
  ImageryLayer,
  Matrix3,
  Transforms,
  UrlTemplateImageryProvider,
  Viewer,
  WebMercatorTilingScheme,
  type JulianDate,
  type Cartesian3,
} from 'cesium';
import { BASE_MAP, MAX_ZOOM_OUT_M, NIGHT_LIGHTS } from './config';

export interface GlobeLayers {
  day: ImageryLayer;
  night: ImageryLayer;
}

export function createViewer(container: HTMLElement): { viewer: Viewer; layers: GlobeLayers } {
  const viewer = new Viewer(container, {
    baseLayer: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    animation: false,
    timeline: true,
    infoBox: true,
    selectionIndicator: true,
    shouldAnimate: true,
    msaaSamples: 4,
    contextOptions: { webgl: { powerPreference: 'high-performance' } },
  });

  const { scene } = viewer;
  const globe = scene.globe;

  // Tag/Nacht: echte Sonnenposition, Beleuchtung bleibt auch beim Reinzoomen erhalten
  globe.enableLighting = true;
  globe.dynamicAtmosphereLighting = true;
  globe.dynamicAtmosphereLightingFromSun = true;
  globe.lightingFadeOutDistance = 1;
  globe.lightingFadeInDistance = 2;
  // Atmosphäre über der Nachtseite nicht „zudecken“ lassen, sonst verschwinden die Stadtlichter
  globe.nightFadeInDistance = 0;
  globe.nightFadeOutDistance = 1;
  globe.baseColor = Color.BLACK;
  globe.showGroundAtmosphere = true;
  globe.maximumScreenSpaceError = 1.5; // etwas schärfere Kacheln
  globe.tileCacheSize = 300;

  // Weit genug sehen für Mond, Planeten-Marker und James-Webb-Teleskop
  viewer.camera.frustum.far = 1e11;
  scene.screenSpaceCameraController.maximumZoomDistance = MAX_ZOOM_OUT_M;
  scene.screenSpaceCameraController.minimumZoomDistance = 50;

  // Tagseite: Sentinel-2 cloudless
  const day = new ImageryLayer(
    new UrlTemplateImageryProvider({
      url: BASE_MAP.url,
      tilingScheme: new GeographicTilingScheme(),
      maximumLevel: BASE_MAP.maximumLevel,
      credit: new Credit(BASE_MAP.credit),
    }),
    // Nachts nur schwach sichtbar – füllt die Polkappe, die die Nachtkarte (bis 85°) nicht abdeckt
    { nightAlpha: 0.3 },
  );
  // Nachtseite: Black Marble (Stadtlichter) – nur dort, wo Nacht ist
  const night = new ImageryLayer(
    new UrlTemplateImageryProvider({
      url: NIGHT_LIGHTS.url,
      tilingScheme: new WebMercatorTilingScheme(),
      maximumLevel: NIGHT_LIGHTS.maximumLevel,
      credit: new Credit(NIGHT_LIGHTS.credit),
    }),
    { dayAlpha: 0, nightAlpha: 1, brightness: 2.6, gamma: 0.9 },
  );
  viewer.imageryLayers.add(day);
  viewer.imageryLayers.add(night);

  // Startansicht: Europa
  viewer.camera.setView({
    destination: { x: 1.62e7, y: 0.45e7, z: 1.55e7 } as Cartesian3,
  });

  return { viewer, layers: { day, night } };
}

const scratch = new Matrix3();
/** Drehmatrix vom himmelsfesten (ICRF/J2000) ins erdfeste System; mit Rückfall ohne EOP-Daten. */
export function icrfToFixed(time: JulianDate): Matrix3 {
  return Transforms.computeIcrfToFixedMatrix(time, scratch) ?? Transforms.computeTemeToPseudoFixedMatrix(time, scratch);
}
