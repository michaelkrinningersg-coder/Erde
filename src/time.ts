import { ClockRange, ClockStep, JulianDate, type Viewer } from 'cesium';
import { TIME } from './config';

const dayFmt = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
const timeFmt = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });
const fullFmt = new Intl.DateTimeFormat('de-DE', {
  weekday: 'short',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** Zeitachse: alles (Sonne, Wolken, Satelliten, Flüge) läuft auf derselben Simulationszeit. */
export class TimeControl {
  rangeDays = TIME.defaultRangeDays;
  onRangeChange?: (start: JulianDate) => void;

  constructor(private readonly viewer: Viewer) {
    const { clock, timeline } = viewer;
    clock.clockStep = ClockStep.SYSTEM_CLOCK_MULTIPLIER;
    clock.clockRange = ClockRange.CLAMPED;
    // Zeitleiste auf Deutsch beschriften
    (timeline as unknown as { makeLabel: (d: JulianDate) => string }).makeLabel = (d) => {
      const date = JulianDate.toDate(d);
      return `${dayFmt.format(date)} ${timeFmt.format(date)}`;
    };
    this.applyRange(this.rangeDays);
    this.goLive();
    // Bei langer Laufzeit das Fenster mitwandern lassen
    setInterval(() => this.updateBounds(), 5 * 60_000);
  }

  private updateBounds() {
    const now = JulianDate.now();
    const { clock } = this.viewer;
    clock.startTime = JulianDate.addDays(now, -this.rangeDays, new JulianDate());
    clock.stopTime = JulianDate.addHours(now, TIME.futureHours, new JulianDate());
    this.onRangeChange?.(clock.startTime);
  }

  applyRange(days: number) {
    this.rangeDays = Math.min(TIME.maxRangeDays, Math.max(1, days));
    this.updateBounds();
    const { clock } = this.viewer;
    if (JulianDate.lessThan(clock.currentTime, clock.startTime)) clock.currentTime = clock.startTime.clone();
    this.viewer.timeline.zoomTo(clock.startTime, clock.stopTime);
  }

  goLive() {
    const { clock } = this.viewer;
    clock.currentTime = JulianDate.now();
    clock.multiplier = 1;
    clock.shouldAnimate = true;
  }

  setSpeed(multiplier: number) {
    const { clock } = this.viewer;
    if (multiplier === 0) {
      clock.shouldAnimate = false;
      return;
    }
    clock.multiplier = multiplier;
    clock.shouldAnimate = true;
  }

  isLive() {
    const { clock } = this.viewer;
    return (
      clock.shouldAnimate &&
      clock.multiplier === 1 &&
      Math.abs(JulianDate.secondsDifference(clock.currentTime, JulianDate.now())) < 30
    );
  }

  label() {
    return fullFmt.format(JulianDate.toDate(this.viewer.clock.currentTime));
  }
}
