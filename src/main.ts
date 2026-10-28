import 'cesium/Build/Cesium/Widgets/widgets.css';
import './style.css';
import { JulianDate, TimeInterval, Transforms } from 'cesium';
import { CameraControl } from './camera';
import { TimeImageLayer } from './clouds/timeLayer';
import { CLOUDS, COLOR_EUROPE, TIME } from './config';
import { createViewer } from './globe';
import { Flights } from './objects/flights';
import { Satellites } from './objects/satellites';
import { Sky } from './objects/sky';
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
  const setEarliest = (start: JulianDate) => {
    const ms = JulianDate.toDate(start).getTime();
    clouds.setEarliest(ms);
    color.setEarliest(ms);
  };
  setEarliest(viewer.clock.startTime);
  time.onRangeChange = setEarliest;
  viewer.clock.onTick.addEventListener((clock) => {
    clouds.update(clock.currentTime, clock.multiplier);
    // Echtfarbenbild (~2–3 km) beim nahen Reinzoomen ausblenden → darunter die scharfe 10-m-Karte
    const h = viewer.camera.positionCartographic.height;
    color.alphaScale = Math.min(1, Math.max(0, (h - 150e3) / (700e3 - 150e3)));
    color.update(clock.currentTime, clock.multiplier);
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

  viewer.selectedEntityChanged.addEventListener((e) => satellites.highlight(e));

  buildUi({ viewer, layers, clouds, color, sky, satellites, flights, camera, time });

  // Für Experimente in der Browser-Konsole
  Object.assign(window, { erde: { viewer, clouds, color, sky, satellites, flights, camera, time } });
}

void main();
