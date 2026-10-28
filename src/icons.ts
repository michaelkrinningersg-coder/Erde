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
