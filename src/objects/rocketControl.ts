import { Cartesian3, Cartographic, JulianDate, type Viewer } from 'cesium';
import type { TimeControl } from '../time';
import { nextWindow, phaseAt, planMission, reachable, type LaunchSite, type Mission, type Phase, type RocketTarget } from './rocket';

/** Zeitraffer, den der Autopilot je Flugphase einstellt (Sekunden Simulationszeit pro Sekunde) */
const SPEED: Record<Phase, number> = {
  countdown: 1,
  ascent: 10,
  parking: 900,
  transfer: 120,
  approach: 10,
  docked: 1,
};

const PHASE_NAME: Record<Phase | 'waiting', string> = {
  waiting: 'Wartet auf Start',
  countdown: 'Countdown',
  ascent: 'Aufstieg',
  parking: 'Parkbahn – holt auf',
  transfer: 'Bahnanhebung',
  approach: 'Annäherung',
  docked: 'Angedockt!',
};

const fmtDur = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
};

/** Startet Raketen, steuert den Zeitraffer und zeigt den Flugstand an. */
export class Rockets {
  readonly missions: Mission[] = [];
  /** Zeitraffer automatisch an die Flugphase anpassen (aus, sobald man selbst die Geschwindigkeit ändert) */
  autopilot = true;
  onChange?: () => void;
  private counter = 0;
  private lastPhase?: Phase | 'waiting';
  private readonly hud: HTMLDivElement;

  constructor(
    private readonly viewer: Viewer,
    private readonly time: TimeControl,
  ) {
    this.hud = document.createElement('div');
    this.hud.id = 'mission-hud';
    this.hud.className = 'glass hidden';
    document.body.append(this.hud);
    viewer.clock.onTick.addEventListener((clock) => this.tick(clock.currentTime));
  }

  canReach(site: LaunchSite, target: RocketTarget) {
    return reachable(site, target);
  }

  /** Nächstes Startfenster suchen, Mission planen, Zeit zum Countdown springen und mitfliegen */
  launch(site: LaunchSite, target: RocketTarget): Mission | string {
    if (!reachable(site, target)) return `${site.name} liegt zu weit nördlich für die Bahn von ${target.name}.`;
    const from = JulianDate.toDate(this.viewer.clock.currentTime).getTime();
    const win = nextWindow(site, target, from);
    if (win === undefined) return 'Kein Startfenster in den nächsten zwei Tagen gefunden.';
    const m = planMission(this.viewer, site, target, win, `rocket-${++this.counter}`);
    this.missions.push(m);
    this.time.extendTo(JulianDate.addHours(m.times.docked, 2, new JulianDate()));
    this.viewer.clock.currentTime = m.times.countdown.clone();
    this.autopilot = true;
    this.time.setSpeed(SPEED.countdown);
    this.viewer.trackedEntity = m.entity;
    this.viewer.selectedEntity = undefined;
    this.onChange?.();
    return m;
  }

  remove(m: Mission) {
    if (this.viewer.trackedEntity === m.entity) this.viewer.trackedEntity = undefined;
    this.viewer.entities.remove(m.entity);
    this.viewer.entities.remove(m.pad);
    this.missions.splice(this.missions.indexOf(m), 1);
    this.onChange?.();
  }

  /** Mission, die gerade verfolgt wird (sonst die neueste) */
  private current(): Mission | undefined {
    return this.missions.find((m) => m.entity === this.viewer.trackedEntity) ?? this.missions[this.missions.length - 1];
  }

  private tick(time: JulianDate) {
    const m = this.current();
    const phase = m ? phaseAt(m, time) : undefined;
    const followed = !!m && this.viewer.trackedEntity === m.entity;
    if (!m || !phase || phase === 'waiting' || (phase === 'docked' && JulianDate.secondsDifference(time, m.times.docked) > 1800)) {
      this.hud.classList.add('hidden');
      this.lastPhase = phase;
      return;
    }
    // Autopilot: beim Phasenwechsel passenden Zeitraffer setzen (nur solange man mitfliegt)
    if (this.autopilot && followed && phase !== this.lastPhase) {
      this.time.setSpeed(SPEED[phase]);
      if (phase === 'docked') this.autopilot = false;
    }
    // Kurz vor der Bahnanhebung abbremsen
    if (this.autopilot && followed && phase === 'parking') {
      const left = JulianDate.secondsDifference(m.times.transfer, time);
      const want = left > 3 * 3600 ? 1800 : left > 600 ? 600 : 60;
      if (this.viewer.clock.multiplier !== want) this.time.setSpeed(want);
    }
    this.lastPhase = phase;
    this.renderHud(m, phase, time);
  }

  private renderHud(m: Mission, phase: Phase, time: JulianDate) {
    const pos = m.entity.position!.getValue(time);
    const later = m.entity.position!.getValue(JulianDate.addSeconds(time, 1, new JulianDate()));
    const station = m.target.entity.position!.getValue(time);
    const parts: string[] = [`<b>${m.site.rocket} → ${m.target.name}</b>`, PHASE_NAME[phase]];
    if (phase === 'countdown') {
      parts.push(`<span class="big">${Math.ceil(JulianDate.secondsDifference(m.times.ascent, time))}</span>`);
    } else if (pos && later && phase !== 'docked') {
      const alt = Cartographic.fromCartesian(pos).height / 1000;
      const kmh = (Cartesian3.distance(pos, later) * 3.6) / 1; // m/s → km/h (Erddrehung nicht abgezogen)
      parts.push(`${Math.round(alt).toLocaleString('de-DE')} km hoch`);
      if (phase === 'ascent') parts.push(`${Math.round(kmh / 100) * 100} km/h`);
      if (station && phase !== 'ascent') {
        const d = Cartesian3.distance(pos, station) / 1000;
        parts.push(d < 10 ? `${d.toLocaleString('de-DE', { maximumFractionDigits: 2 })} km bis ${m.target.name}` : `${Math.round(d).toLocaleString('de-DE')} km bis ${m.target.name}`);
      }
      parts.push(`Andocken in ${fmtDur(JulianDate.secondsDifference(m.times.docked, time))}`);
    }
    this.hud.innerHTML = parts.join(' · ');
    this.hud.classList.remove('hidden');
  }
}
