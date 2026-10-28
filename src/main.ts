import 'cesium/Build/Cesium/Widgets/widgets.css';
import './style.css';
import { JulianDate, TimeInterval, Transforms } from 'cesium';
import { CameraControl } from './camera';
import { CloudLayer } from './clouds/cloudLayer';
import { TIME } from './config';
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
  const clouds = new CloudLayer(viewer);
  clouds.setEarliest(JulianDate.toDate(viewer.clock.startTime).getTime());
  time.onRangeChange = (start) => clouds.setEarliest(JulianDate.toDate(start).getTime());
  viewer.clock.onTick.addEventListener((clock) => clouds.update(clock.currentTime, clock.multiplier));

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

  buildUi({ viewer, layers, clouds, sky, satellites, flights, camera, time });

  // Für Experimente in der Browser-Konsole
  Object.assign(window, { erde: { viewer, clouds, sky, satellites, flights, camera, time } });
}

void main();
