import 'cesium/Build/Cesium/Widgets/widgets.css';
import './style.css';
import { Cartesian3, JulianDate, TimeInterval, Transforms } from 'cesium';
import { CameraControl } from './camera';
import { TimeImageLayer } from './clouds/timeLayer';
import { CLOUDS, COLOR_AMERICA, COLOR_EUROPE, MAX_ZOOM_OUT_M, TIME } from './config';
import { createViewer } from './globe';
import { HomeControl } from './home';
import { Flights } from './objects/flights';
import { Satellites } from './objects/satellites';
import { Sky } from './objects/sky';
import { SolarSystemView } from './solar/solarSystem';
import { TimeControl } from './time';
import { buildUi } from './ui';

async function main() {
  const { viewer, layers } = createViewer(document.getElementById('globe')!);

  // Genaue Erdrotation (Präzession/Nutation) für den ganzen Zeitraum vorladen
  const now = JulianDate.now();
  void Transforms.preloadIcrfFixed(
    new TimeInterval({
      start: JulianDate.addDays(now, -TIME.maxRangeDays - 1, new JulianDate()),
      stop: JulianDate.addDays(now, 3, new JulianDate()),
    }),
  ).catch(() => undefined);

  const time = new TimeControl(viewer);
  const clouds = new TimeImageLayer(viewer, CLOUDS);
  const color = new TimeImageLayer(viewer, COLOR_EUROPE);
  const colorAmerica = new TimeImageLayer(viewer, COLOR_AMERICA);
  const colorLayers = [color, colorAmerica]; // Reihenfolge wie COLOR_REGIONS
  const setEarliest = (start: JulianDate) => {
    const ms = JulianDate.toDate(start).getTime();
    for (const l of [clouds, ...colorLayers]) l.setEarliest(ms);
  };
  setEarliest(viewer.clock.startTime);
  time.onRangeChange = setEarliest;
  viewer.clock.onTick.addEventListener((clock) => {
    // Echtfarbenbild (~2–3 km) beim nahen Reinzoomen ausblenden → darunter die scharfe 10-m-Karte
    const h = viewer.camera.positionCartographic.height;
    const fade = Math.min(1, Math.max(0, (h - 150e3) / (700e3 - 150e3)));
    for (const l of colorLayers) {
      l.alphaScale = fade;
      l.update(clock.currentTime, clock.multiplier);
    }
    // Wolken in den Echtfarben-Gebieten treten tagsüber genau so weit zurück, wie das jeweilige Farbbild sichtbar ist
    clouds.innerDayAlpha = colorLayers.map((l) => 1 - l.effectiveAlpha());
    clouds.update(clock.currentTime, clock.multiplier);
  });

  const sky = new Sky(viewer);
  const satellites = new Satellites(viewer);
  try {
    await satellites.load('./data/satellites.json');
  } catch (e) {
    console.warn('Satellitendaten konnten nicht geladen werden', e);
  }
  const flights = new Flights(viewer);
  const camera = new CameraControl(viewer);
  const home = new HomeControl(viewer, camera);

  viewer.selectedEntityChanged.addEventListener((e) => satellites.highlight(e));

  // Sonnensystem: per Knopf oder durch weiteres Rauszoomen, wenn man schon ganz weit draußen ist
  const solar = new SolarSystemView(viewer, time);
  solar.onExit = () => camera.home();
  let outwardTicks = 0;
  viewer.canvas.addEventListener(
    'wheel',
    (e) => {
      const far = Cartesian3.magnitude(viewer.camera.positionWC) > MAX_ZOOM_OUT_M * 0.9;
      outwardTicks = e.deltaY > 0 && far && !viewer.trackedEntity ? outwardTicks + 1 : 0;
      if (outwardTicks >= 3) {
        outwardTicks = 0;
        solar.open();
      }
    },
    { passive: true },
  );

  buildUi({ viewer, layers, clouds, color, colorAmerica, solar, home, sky, satellites, flights, camera, time });

  // Für Experimente in der Browser-Konsole
  Object.assign(window, { erde: { viewer, clouds, color, colorAmerica, sky, satellites, flights, camera, time } });
}

void main();
