// Kleine, selbst gezeichnete Symbole (keine externen Bilddateien nötig).

const cache = new Map<string, HTMLCanvasElement>();

function canvas(size: number, draw: (g: CanvasRenderingContext2D, s: number) => void, key: string) {
  const hit = cache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  const dpr = 2;
  c.width = c.height = size * dpr;
  const g = c.getContext('2d')!;
  g.scale(dpr, dpr);
  draw(g, size);
  cache.set(key, c);
  return c;
}

/** Satellit: Körper mit zwei Solarflügeln */
export function satelliteIcon(color: string, size = 22, big = false) {
  return canvas(
    size,
    (g, s) => {
      g.translate(s / 2, s / 2);
      g.rotate(-Math.PI / 4);
      const panelW = s * (big ? 0.34 : 0.3);
      const panelH = s * (big ? 0.26 : 0.22);
      g.fillStyle = big ? '#3a6ea5' : '#2f4f7a';
      g.strokeStyle = color;
      g.lineWidth = 1.2;
      for (const sx of [-1, 1]) {
        g.fillRect(sx > 0 ? s * 0.14 : -s * 0.14 - panelW, -panelH / 2, panelW, panelH);
        g.strokeRect(sx > 0 ? s * 0.14 : -s * 0.14 - panelW, -panelH / 2, panelW, panelH);
      }
      g.fillStyle = color;
      g.beginPath();
      g.roundRect(-s * 0.13, -s * 0.13, s * 0.26, s * 0.26, s * 0.05);
      g.fill();
      g.strokeStyle = 'rgba(0,0,0,.6)';
      g.stroke();
    },
    `sat-${color}-${size}-${big}`,
  );
}

/** Flugzeug von oben, Nase zeigt nach oben */
export function planeIcon(color = '#ffffff', size = 34) {
  return canvas(
    size,
    (g, s) => {
      g.translate(s / 2, s / 2);
      g.scale(s / 100, s / 100);
      g.fillStyle = color;
      g.strokeStyle = 'rgba(0,0,0,.7)';
      g.lineWidth = 3;
      g.beginPath();
      // Rumpf, Flügel, Leitwerk
      g.moveTo(0, -46);
      g.bezierCurveTo(6, -46, 7, -36, 7, -28);
      g.lineTo(7, -10);
      g.lineTo(46, 10);
      g.lineTo(46, 18);
      g.lineTo(7, 8);
      g.lineTo(6, 30);
      g.lineTo(18, 40);
      g.lineTo(18, 46);
      g.lineTo(0, 41);
      g.lineTo(-18, 46);
      g.lineTo(-18, 40);
      g.lineTo(-6, 30);
      g.lineTo(-7, 8);
      g.lineTo(-46, 18);
      g.lineTo(-46, 10);
      g.lineTo(-7, -10);
      g.lineTo(-7, -28);
      g.bezierCurveTo(-7, -36, -6, -46, 0, -46);
      g.closePath();
      g.stroke();
      g.fill();
    },
    `plane-${color}-${size}`,
  );
}

export interface PlanetStyle {
  colors: [string, string]; // hell, dunkel
  size: number;
  ring?: boolean;
  bands?: boolean;
}

/** Planet als beleuchtete Kugel (optional mit Ring/Bändern) */
export function planetIcon(name: string, st: PlanetStyle) {
  const pad = st.ring ? 1.9 : 1.15;
  return canvas(
    Math.round(st.size * pad),
    (g, s) => {
      const r = st.size / 2;
      g.translate(s / 2, s / 2);
      const drawRing = (front: boolean) => {
        g.save();
        g.scale(1, 0.32);
        g.beginPath();
        g.ellipse(0, 0, r * 1.75, r * 1.75, 0, front ? 0 : Math.PI, front ? Math.PI : 2 * Math.PI);
        g.strokeStyle = 'rgba(230,210,160,.95)';
        g.lineWidth = r * 0.35;
        g.stroke();
        g.restore();
      };
      if (st.ring) drawRing(false);
      const grad = g.createRadialGradient(-r * 0.35, -r * 0.35, r * 0.1, 0, 0, r);
      grad.addColorStop(0, st.colors[0]);
      grad.addColorStop(1, st.colors[1]);
      g.fillStyle = grad;
      g.beginPath();
      g.arc(0, 0, r, 0, Math.PI * 2);
      g.fill();
      if (st.bands) {
        g.save();
        g.clip();
        g.strokeStyle = 'rgba(120,70,40,.35)';
        g.lineWidth = r * 0.14;
        for (const y of [-0.45, -0.1, 0.25, 0.55]) {
          g.beginPath();
          g.moveTo(-r, y * r);
          g.lineTo(r, y * r);
          g.stroke();
        }
        g.restore();
      }
      if (st.ring) drawRing(true);
      g.strokeStyle = 'rgba(255,255,255,.35)';
      g.lineWidth = 1;
      g.beginPath();
      g.arc(0, 0, r, 0, Math.PI * 2);
      g.stroke();
    },
    `planet-${name}`,
  );
}

/** Haus-Symbol für „Zuhause“ (Stecknadel mit Haus) */
export function homeIcon(size = 40) {
  return canvas(
    size,
    (g, s) => {
      // Stecknadel
      g.fillStyle = '#ffd166';
      g.strokeStyle = 'rgba(0,0,0,.7)';
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(s / 2, s * 0.38, s * 0.34, Math.PI * 0.82, Math.PI * 0.18);
      g.lineTo(s / 2, s * 0.98);
      g.closePath();
      g.fill();
      g.stroke();
      // Haus
      g.fillStyle = '#1b2433';
      const cx = s / 2;
      const cy = s * 0.4;
      const w = s * 0.34;
      g.beginPath();
      g.moveTo(cx - w * 0.62, cy);
      g.lineTo(cx, cy - w * 0.62);
      g.lineTo(cx + w * 0.62, cy);
      g.closePath();
      g.fill();
      g.fillRect(cx - w * 0.42, cy - 1, w * 0.84, w * 0.62);
      g.fillStyle = '#ffd166';
      g.fillRect(cx - w * 0.1, cy + w * 0.22, w * 0.2, w * 0.4);
    },
    `home-${size}`,
  );
}

/** Rakete von der Seite, Spitze zeigt nach oben (wird entlang der Flugrichtung gedreht) */
export function rocketIcon(size = 40) {
  return canvas(
    size,
    (g, s) => {
      g.translate(s / 2, s / 2);
      g.scale(s / 100, s / 100);
      // Flamme
      const fl = g.createLinearGradient(0, 28, 0, 50);
      fl.addColorStop(0, '#fff3b0');
      fl.addColorStop(0.4, '#ffb347');
      fl.addColorStop(1, 'rgba(255,90,40,0)');
      g.fillStyle = fl;
      g.beginPath();
      g.moveTo(-7, 28);
      g.quadraticCurveTo(0, 60, 7, 28);
      g.fill();
      // Körper
      g.fillStyle = '#f4f6f8';
      g.strokeStyle = 'rgba(0,0,0,.7)';
      g.lineWidth = 2.5;
      g.beginPath();
      g.moveTo(0, -46);
      g.bezierCurveTo(9, -34, 10, -18, 10, 0);
      g.lineTo(10, 28);
      g.lineTo(-10, 28);
      g.lineTo(-10, 0);
      g.bezierCurveTo(-10, -18, -9, -34, 0, -46);
      g.closePath();
      g.fill();
      g.stroke();
      // Finnen
      g.fillStyle = '#ff6b3d';
      for (const sx of [-1, 1]) {
        g.beginPath();
        g.moveTo(sx * 10, 8);
        g.lineTo(sx * 22, 26);
        g.lineTo(sx * 22, 32);
        g.lineTo(sx * 10, 26);
        g.closePath();
        g.fill();
        g.stroke();
      }
      // Fenster
      g.fillStyle = '#3a86ff';
      g.beginPath();
      g.arc(0, -16, 5, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    },
    `rocket-${size}`,
  );
}

/** Startplatz: Startturm mit Rampe */
export function launchPadIcon(size = 30) {
  return canvas(
    size,
    (g, s) => {
      g.translate(s / 2, s);
      g.scale(s / 30, s / 30);
      g.strokeStyle = '#ff9f43';
      g.fillStyle = 'rgba(20,24,32,.85)';
      g.lineWidth = 1.6;
      g.fillRect(-12, -5, 24, 5);
      g.strokeRect(-12, -5, 24, 5);
      g.beginPath();
      g.moveTo(-5, -5);
      g.lineTo(-5, -27);
      g.lineTo(-1, -27);
      g.lineTo(-1, -5);
      for (let y = -9; y > -27; y -= 4) {
        g.moveTo(-5, y);
        g.lineTo(-1, y - 4);
      }
      g.moveTo(-1, -20);
      g.lineTo(4, -20);
      g.stroke();
      g.fillStyle = '#f4f6f8';
      g.beginPath();
      g.moveTo(7, -24);
      g.lineTo(9, -19);
      g.lineTo(9, -6);
      g.lineTo(5, -6);
      g.lineTo(5, -19);
      g.closePath();
      g.fill();
    },
    `pad-${size}`,
  );
}
