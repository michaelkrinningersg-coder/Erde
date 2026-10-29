import { Cartesian2, Cartographic, Ellipsoid, EllipsoidGeodesic, type Viewer } from 'cesium';

/** Maßstab unten rechts: erscheint beim Heranzoomen (normale Erde und politische Karte) */
export class ScaleBar {
  private readonly el = document.createElement('div');
  private readonly bar = document.createElement('i');
  private readonly label = document.createElement('span');
  private last = 0;

  constructor(private readonly viewer: Viewer) {
    this.el.id = 'scale-bar';
    this.el.className = 'glass hidden';
    this.el.title = 'Maßstab';
    this.el.append(this.bar, this.label);
    document.body.append(this.el);
    viewer.scene.postRender.addEventListener(() => this.update());
  }

  private update() {
    const now = performance.now();
    if (now - this.last < 200) return;
    this.last = now;
    const scene = this.viewer.scene;
    const w = scene.canvas.clientWidth;
    const h = scene.canvas.clientHeight;
    const pick = (x: number) => {
      const ray = this.viewer.camera.getPickRay(new Cartesian2(x, h - 70));
      const p = ray && scene.globe.pick(ray, scene);
      return p ? Cartographic.fromCartesian(p) : undefined;
    };
    const a = pick(w / 2 - 50);
    const b = pick(w / 2 + 50);
    // weit draußen sagt ein Maßstab auf der Kugel nichts aus
    if (!a || !b || this.viewer.camera.positionCartographic.height > 7e6) {
      this.el.classList.add('hidden');
      return;
    }
    const mpp = new EllipsoidGeodesic(a, b, Ellipsoid.WGS84).surfaceDistance / 100;
    // runde Länge (1, 2, 5 × 10ⁿ), höchstens 130 Pixel breit
    const max = mpp * 130;
    const pow = Math.pow(10, Math.floor(Math.log10(max)));
    const nice = [5, 2, 1].map((f) => f * pow).find((v) => v <= max) ?? pow;
    this.bar.style.width = `${(nice / mpp).toFixed(0)}px`;
    this.label.textContent = nice >= 1000 ? `${(nice / 1000).toLocaleString('de-DE')} km` : `${nice.toLocaleString('de-DE')} m`;
    this.el.classList.remove('hidden');
  }
}
