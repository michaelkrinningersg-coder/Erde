import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import * as Astronomy from 'astronomy-engine';
import { ClockRange, JulianDate, type Viewer } from 'cesium';
import { PLANETS } from '../objects/sky';
import type { TimeControl } from '../time';

// Kindgerechte Sonnensystem-Ansicht: Die Planeten stehen in ihrer ECHTEN Richtung um die Sonne
// (Position zum aktuellen Simulationszeitpunkt), aber Abstände und Größen sind zusammengerückt,
// damit alles auf einen Bildschirm passt.

interface BodySpec {
  id: string;
  name: string;
  body: Astronomy.Body;
  texture: string;
  radius: number; // Darstellungsgröße
  orbit: number; // Darstellungsabstand zur Sonne
  dayHours: number; // Eigendrehung (Sterntag), negativ = rückläufig
  tilt: number; // Achsneigung in Grad
  fact: string;
}

const factOf = (id: string) => PLANETS.find((p) => p.id === id)?.fact ?? '';

const BODIES: BodySpec[] = [
  { id: 'mercury', name: 'Merkur', body: Astronomy.Body.Mercury, texture: 'mercury', radius: 0.9, orbit: 13, dayHours: 1407.6, tilt: 0, fact: factOf('mercury') },
  { id: 'venus', name: 'Venus', body: Astronomy.Body.Venus, texture: 'venus', radius: 1.4, orbit: 19, dayHours: -5832.5, tilt: 177, fact: factOf('venus') },
  { id: 'earth', name: 'Erde', body: Astronomy.Body.Earth, texture: 'earth', radius: 1.5, orbit: 26, dayHours: 23.93, tilt: 23.4, fact: 'Unser Zuhause – der einzige Planet, auf dem wir Leben kennen. Einmal um die Sonne dauert ein Jahr.' },
  { id: 'mars', name: 'Mars', body: Astronomy.Body.Mars, texture: 'mars', radius: 1.15, orbit: 33, dayHours: 24.62, tilt: 25.2, fact: factOf('mars') },
  { id: 'jupiter', name: 'Jupiter', body: Astronomy.Body.Jupiter, texture: 'jupiter', radius: 3.4, orbit: 45, dayHours: 9.93, tilt: 3.1, fact: factOf('jupiter') },
  { id: 'saturn', name: 'Saturn', body: Astronomy.Body.Saturn, texture: 'saturn', radius: 2.9, orbit: 58, dayHours: 10.7, tilt: 26.7, fact: factOf('saturn') },
  { id: 'uranus', name: 'Uranus', body: Astronomy.Body.Uranus, texture: 'uranus', radius: 2.0, orbit: 70, dayHours: -17.2, tilt: 97.8, fact: factOf('uranus') },
  { id: 'neptune', name: 'Neptun', body: Astronomy.Body.Neptune, texture: 'neptune', radius: 2.0, orbit: 81, dayHours: 16.1, tilt: 28.3, fact: factOf('neptune') },
];

const SPEEDS: [string, number][] = [
  ['⏸', 0],
  ['▶ Echtzeit', 1],
  ['1 Tag/s', 86400],
  ['1 Woche/s', 7 * 86400],
  ['1 Monat/s', 30 * 86400],
];

const AU_KM = 149_597_870.7;
const fmtKm = (km: number) =>
  km > 1e9
    ? `${(km / 1e9).toLocaleString('de-DE', { maximumFractionDigits: 2 })} Mrd. km`
    : `${Math.round(km / 1e6).toLocaleString('de-DE')} Mio. km`;

interface Planet {
  spec: BodySpec;
  group: THREE.Group; // Position (dreht sich nicht)
  mesh: THREE.Mesh; // Eigendrehung
}

export class SolarSystemView {
  readonly root: HTMLDivElement;
  onExit?: () => void;
  private active = false;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly labels = new CSS2DRenderer();
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(50, 1, 0.1, 5000);
  private readonly controls: OrbitControls;
  private readonly planets: Planet[] = [];
  private readonly moon: THREE.Mesh;
  private readonly sun: THREE.Mesh;
  private readonly info: HTMLDivElement;
  private readonly speedBar: HTMLDivElement;
  private readonly dateLabel: HTMLDivElement;
  private selected?: { id: string; obj: THREE.Object3D };
  private readonly lastFocus = new THREE.Vector3();
  private readonly eclRot = Astronomy.Rotation_EQJ_ECL();

  constructor(
    private readonly viewer: Viewer,
    private readonly time: TimeControl,
  ) {
    this.root = document.createElement('div');
    this.root.id = 'solar';
    this.root.className = 'hidden';
    document.body.append(this.root);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.root.append(this.renderer.domElement);
    this.labels.domElement.className = 'solar-labels';
    this.root.append(this.labels.domElement);

    this.controls = new OrbitControls(this.camera, this.labels.domElement);
    this.controls.enableDamping = true;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 400;
    this.camera.position.set(0, 75, 115);

    const tex = new THREE.TextureLoader();
    const load = (name: string) => {
      const t = tex.load(`./textures/planets/${name}`);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      return t;
    };

    // Licht von der Sonne, dazu etwas Grundhelligkeit, damit die Nachtseite nicht ganz schwarz ist
    this.scene.add(new THREE.PointLight(0xffffff, 3.2, 0, 0));
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.14));
    this.scene.add(this.makeStars());

    // Sonne mit Leuchten
    this.sun = new THREE.Mesh(new THREE.SphereGeometry(5.5, 64, 32), new THREE.MeshBasicMaterial({ map: load('sun.jpg') }));
    this.sun.name = 'sun';
    this.scene.add(this.sun);
    const glow = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.glowTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }),
    );
    glow.scale.setScalar(34);
    this.scene.add(glow);
    this.addLabel(this.sun, 'Sonne', 'sun', 7.5);

    for (const spec of BODIES) {
      // Umlaufbahn
      const pts = Array.from({ length: 181 }, (_, i) => {
        const a = (i / 180) * Math.PI * 2;
        return new THREE.Vector3(Math.cos(a) * spec.orbit, 0, Math.sin(a) * spec.orbit);
      });
      const orbit = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: spec.id === 'earth' ? 0x4cc9f0 : 0x51627a, transparent: true, opacity: 0.55 }),
      );
      this.scene.add(orbit);

      const group = new THREE.Group();
      const tilt = new THREE.Group();
      tilt.rotation.z = THREE.MathUtils.degToRad(spec.tilt);
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(spec.radius, 64, 32),
        new THREE.MeshStandardMaterial({ map: load(`${spec.texture}.jpg`), roughness: 1, metalness: 0 }),
      );
      mesh.name = spec.id;
      tilt.add(mesh);
      group.add(tilt);
      if (spec.id === 'saturn') tilt.add(this.makeRing(spec.radius, load('saturn_ring.png')));
      this.scene.add(group);
      this.addLabel(group, spec.id === 'earth' ? 'Erde – hier wohnen wir!' : spec.name, spec.id, spec.radius + 1.4);
      this.planets.push({ spec, group, mesh });
    }

    // Mond um die Erde
    const earth = this.planets.find((p) => p.spec.id === 'earth')!;
    this.moon = new THREE.Mesh(
      new THREE.SphereGeometry(0.34, 32, 16),
      new THREE.MeshStandardMaterial({ map: load('moon.jpg'), roughness: 1 }),
    );
    this.moon.name = 'moon';
    earth.group.add(this.moon);

    // Bedienelemente
    const head = document.createElement('div');
    head.className = 'solar-head glass';
    head.innerHTML = '<h2>🪐 Sonnensystem</h2><p>Die Planeten stehen dort, wo sie gerade wirklich sind – nur viel näher zusammen und größer gezeichnet.</p>';
    const back = document.createElement('button');
    back.className = 'primary';
    back.textContent = '🌍 Zurück zur Erde';
    back.addEventListener('click', () => this.close());
    head.append(back);
    this.speedBar = document.createElement('div');
    this.speedBar.className = 'solar-speeds';
    for (const [label, m] of SPEEDS) {
      const b = document.createElement('button');
      b.textContent = label;
      b.dataset.speed = String(m);
      b.addEventListener('click', () => this.time.setSpeed(m));
      this.speedBar.append(b);
    }
    head.append(this.speedBar);
    this.dateLabel = document.createElement('div');
    this.dateLabel.className = 'solar-date';
    head.append(this.dateLabel);
    this.info = document.createElement('div');
    this.info.className = 'solar-info glass hidden';
    this.root.append(head, this.info);

    // Planeten anklicken
    const ray = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let down = { x: 0, y: 0 };
    this.labels.domElement.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
    this.labels.domElement.addEventListener('pointerup', (e) => {
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return; // war ein Ziehen
      const label = (e.target as HTMLElement).closest<HTMLElement>('.solar-label');
      if (label?.dataset.id) return this.select(label.dataset.id);
      const r = this.renderer.domElement.getBoundingClientRect();
      pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(pointer, this.camera);
      const hit = ray.intersectObjects([this.sun, this.moon, ...this.planets.map((p) => p.mesh)])[0];
      if (hit) this.select(hit.object.name);
    });

    addEventListener('resize', () => this.resize());
  }

  get isActive() {
    return this.active;
  }

  open() {
    if (this.active) return;
    this.active = true;
    this.root.classList.remove('hidden');
    document.body.classList.add('solar-mode');
    // Cesium pausiert; die Uhr läuft weiter über unsere Schleife und darf in die Zukunft
    this.viewer.useDefaultRenderLoop = false;
    this.viewer.clock.clockRange = ClockRange.UNBOUNDED;
    this.resize();
    this.selected = undefined;
    this.info.classList.add('hidden');
    this.controls.target.set(0, 0, 0);
    this.camera.position.set(0, 85, 125);
    this.loop();
  }

  close() {
    if (!this.active) return;
    this.active = false;
    this.root.classList.add('hidden');
    document.body.classList.remove('solar-mode');
    const { clock } = this.viewer;
    clock.clockRange = ClockRange.CLAMPED;
    if (JulianDate.greaterThan(clock.currentTime, clock.stopTime) || JulianDate.lessThan(clock.currentTime, clock.startTime)) {
      this.time.goLive();
    } else if (Math.abs(clock.multiplier) > 3600) {
      this.time.setSpeed(1);
    }
    this.viewer.useDefaultRenderLoop = true;
    this.onExit?.();
  }

  private resize() {
    const w = innerWidth;
    const h = innerHeight;
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private loop = () => {
    if (!this.active) return;
    requestAnimationFrame(this.loop);
    this.viewer.clock.tick();
    this.updatePositions(JulianDate.toDate(this.viewer.clock.currentTime));

    // Ausgewählten Himmelskörper mit der Kamera begleiten
    if (this.selected) {
      const p = this.selected.obj.getWorldPosition(new THREE.Vector3());
      const delta = p.clone().sub(this.lastFocus);
      this.camera.position.add(delta);
      this.controls.target.add(delta);
      this.lastFocus.copy(p);
    }
    for (const b of this.speedBar.querySelectorAll<HTMLButtonElement>('button')) {
      const m = Number(b.dataset.speed);
      const { clock } = this.viewer;
      b.classList.toggle('on', m === 0 ? !clock.shouldAnimate : clock.shouldAnimate && clock.multiplier === m);
    }
    this.dateLabel.textContent = this.time.label().replace(/, \d\d:\d\d:\d\d$/, '');
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  };

  /** Echte Richtung (ekliptikale Länge) jedes Planeten, zusammengerückter Abstand */
  private updatePositions(date: Date) {
    const hours = date.getTime() / 3_600_000;
    for (const p of this.planets) {
      const v = Astronomy.RotateVector(this.eclRot, Astronomy.HelioVector(p.spec.body, date));
      const lon = Math.atan2(v.y, v.x);
      p.group.position.set(Math.cos(lon) * p.spec.orbit, 0, -Math.sin(lon) * p.spec.orbit);
      p.mesh.rotation.y = ((hours / p.spec.dayHours) % 1) * Math.PI * 2;
    }
    this.sun.rotation.y = ((hours / 609) % 1) * Math.PI * 2;
    const m = Astronomy.RotateVector(this.eclRot, Astronomy.GeoMoon(date));
    const mlon = Math.atan2(m.y, m.x);
    this.moon.position.set(Math.cos(mlon) * 3, 0, -Math.sin(mlon) * 3);
    if (this.selected && !this.info.classList.contains('hidden')) this.renderInfo(this.selected.id, date);
  }

  private select(id: string) {
    const obj =
      id === 'sun' ? this.sun : id === 'moon' ? this.moon : this.planets.find((p) => p.spec.id === id)?.group;
    if (!obj) return;
    this.selected = { id, obj };
    const target = obj.getWorldPosition(new THREE.Vector3());
    const size = id === 'sun' ? 6 : id === 'moon' ? 0.34 : this.planets.find((p) => p.spec.id === id)!.spec.radius;
    // Kamera zum Objekt bringen: aus der aktuellen Blickrichtung, Abstand passend zur Größe
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.controls.target.copy(target);
    this.camera.position.copy(target).add(dir.multiplyScalar(size * 7 + 4));
    this.lastFocus.copy(target);
    this.info.classList.remove('hidden');
    this.renderInfo(id, JulianDate.toDate(this.viewer.clock.currentTime));
  }

  private renderInfo(id: string, date: Date) {
    const spec = BODIES.find((b) => b.id === id);
    let title = spec?.name ?? (id === 'sun' ? 'Sonne' : 'Mond');
    let text = spec?.fact ?? '';
    const rows: string[] = [];
    if (id === 'sun') text = 'Unser Stern – eine riesige Kugel aus glühendem Gas. Über eine Million Erden würden hineinpassen.';
    if (id === 'moon') {
      text = 'Unser Begleiter. Er braucht etwa 27 Tage, um einmal um die Erde zu laufen.';
      rows.push(['Entfernung zur Erde', `${Math.round(Astronomy.GeoMoon(date).Length() * AU_KM).toLocaleString('de-DE')} km`].join(':'));
    }
    if (spec) {
      rows.push(`Entfernung zur Sonne:${fmtKm(Astronomy.HelioVector(spec.body, date).Length() * AU_KM)}`);
      if (id !== 'earth') rows.push(`Entfernung zur Erde:${fmtKm(Astronomy.GeoVector(spec.body, date, true).Length() * AU_KM)}`);
    }
    if (id === 'earth') title = 'Erde';
    const html =
      `<button class="small ghost close" title="Schließen">✕</button><h3>${title}</h3><p>${text}</p>` +
      (rows.length
        ? `<table>${rows.map((r) => `<tr><th>${r.split(':')[0]}</th><td>${r.split(':').slice(1).join(':')}</td></tr>`).join('')}</table>`
        : '') +
      (id === 'earth' ? '<button class="primary go-earth">🌍 Zur Erde fliegen</button>' : '');
    if (this.info.dataset.html === html) return;
    this.info.dataset.html = html;
    this.info.innerHTML = html;
    this.info.querySelector('.close')!.addEventListener('click', () => {
      this.info.classList.add('hidden');
      this.selected = undefined;
    });
    this.info.querySelector('.go-earth')?.addEventListener('click', () => this.close());
  }

  private addLabel(parent: THREE.Object3D, text: string, id: string, below: number) {
    const div = document.createElement('div');
    div.className = 'solar-label';
    div.textContent = text;
    div.dataset.id = id;
    const label = new CSS2DObject(div);
    label.position.set(0, -below, 0);
    label.center.set(0.5, 0);
    parent.add(label);
  }

  private makeRing(r: number, map: THREE.Texture) {
    const inner = r * 1.25;
    const outer = r * 2.3;
    const geo = new THREE.RingGeometry(inner, outer, 128, 1);
    // Textur verläuft von innen nach außen
    const pos = geo.attributes.position;
    const uv = geo.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      const d = Math.hypot(pos.getX(i), pos.getY(i));
      uv.setXY(i, (d - inner) / (outer - inner), 0.5);
    }
    const ring = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ map, transparent: true, side: THREE.DoubleSide, roughness: 1, depthWrite: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    return ring;
  }

  private makeStars() {
    const n = 4000;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(1200 + Math.random() * 600);
      pos.set([v.x, v.y, v.z], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    return new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0.8 }));
  }

  private glowTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    grad.addColorStop(0, 'rgba(255,220,140,0.9)');
    grad.addColorStop(0.25, 'rgba(255,170,60,0.45)');
    grad.addColorStop(1, 'rgba(255,120,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 256);
    return new THREE.CanvasTexture(c);
  }
}
