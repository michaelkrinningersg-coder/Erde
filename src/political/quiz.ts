// Länder-Quiz für Kinder: „Wo ist Italien?“ – Frage wird vorgelesen, das Kind tippt auf das Land.
import { icon } from '../svgIcons';
import type { BBox, CountryData } from './geo';

export interface QuizCountry {
  idx: number;
  data: CountryData;
  bbox: BBox;
}

/** Was das Quiz von der Kartenansicht braucht */
export interface QuizHost {
  quizCountries(): QuizCountry[];
  /** Länder einfärben (Index → Farbe); undefined = normale Farben */
  paint(colors: Map<number, string> | undefined): void;
  flyToCountry(idx: number): void;
  /** Hervorhebung blinken lassen (abgedunkelt/voll) */
  blink(dim: boolean): void;
  flyTo(lon: number, lat: number, height: number): void;
  /** Namen ausblenden, Steckbriefe aus, Länderkarte als Grundkarte */
  setQuizMode(on: boolean): void;
}

export const QUIZ_REGIONS: { id: string; name: string; view: [number, number, number] }[] = [
  { id: 'Europa', name: 'Europa', view: [15, 52, 5.5e6] },
  { id: 'Afrika', name: 'Afrika', view: [20, 2, 9e6] },
  { id: 'Asien', name: 'Asien', view: [90, 32, 1.1e7] },
  { id: 'Nordamerika', name: 'Nordamerika', view: [-95, 40, 9e6] },
  { id: 'Südamerika', name: 'Südamerika', view: [-60, -18, 8e6] },
  { id: 'Ozeanien', name: 'Australien & Ozeanien', view: [150, -22, 8e6] },
  { id: 'Welt', name: 'Ganze Welt', view: [10, 25, 2e7] },
];

export const QUIZ_LEVELS = [
  { id: 'leicht', name: 'Leicht – große Länder', count: 12, minArea: 0 },
  { id: 'mittel', name: 'Mittel', count: 25, minArea: 2000 },
  { id: 'schwer', name: 'Schwer – alle Länder', count: 999, minArea: 100 },
];

const ROUND = 10;
const GREEN = '#1fa64a';
const RED = '#e5383b';
const HINT = '#ffb300';

/** Vorlesen auf Deutsch (Sprachausgabe des Browsers) */
function speak(text: string) {
  try {
    const s = window.speechSynthesis;
    if (!s) return;
    s.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'de-DE';
    u.rate = 0.95;
    const voice = s.getVoices().find((v) => v.lang.startsWith('de'));
    if (voice) u.voice = voice;
    s.speak(u);
  } catch {
    /* ohne Sprachausgabe */
  }
}

let audio: AudioContext | undefined;

/** Kurze Töne: aufsteigend bei richtig, tief bei falsch */
function tone(kind: 'good' | 'bad' | 'done') {
  try {
    audio ??= new AudioContext();
    const notes = kind === 'good' ? [523, 659, 784] : kind === 'done' ? [523, 659, 784, 1047] : [220, 175];
    notes.forEach((f, i) => {
      const o = audio!.createOscillator();
      const g = audio!.createGain();
      o.type = kind === 'bad' ? 'triangle' : 'sine';
      o.frequency.value = f;
      const t = audio!.currentTime + i * 0.12;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      o.connect(g).connect(audio!.destination);
      o.start(t);
      o.stop(t + 0.32);
    });
  } catch {
    /* ohne Ton */
  }
}

const STAR_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z" fill="currentColor"/></svg>';

export class CountryQuiz {
  active = false;
  voice = true;
  sound = true;
  private pool: QuizCountry[] = [];
  private queue: QuizCountry[] = [];
  private current?: QuizCountry;
  private asked = 0;
  private score = 0;
  private tries = 0;
  private busy = false;
  private paintMap = new Map<number, string>();
  private timers: number[] = [];
  private regionView: [number, number, number] = QUIZ_REGIONS[0].view;
  private moved = false;

  private readonly box = document.createElement('div');
  private readonly flag = document.createElement('img');
  private readonly question = document.createElement('div');
  private readonly feedback = document.createElement('div');
  private readonly progress = document.createElement('div');
  private readonly actions = document.createElement('div');

  constructor(private readonly host: QuizHost) {
    this.box.id = 'quiz-box';
    this.box.className = 'glass hidden';
    this.flag.className = 'quiz-flag';
    this.flag.alt = '';
    this.flag.addEventListener('error', () => this.flag.classList.add('hidden'));
    this.question.className = 'quiz-question';
    this.feedback.className = 'quiz-feedback';
    this.progress.className = 'quiz-progress';
    this.actions.className = 'quiz-actions';
    this.box.append(this.progress, this.flag, this.question, this.feedback, this.actions);
    document.body.append(this.box);
  }

  start(region: string, level: string) {
    const lv = QUIZ_LEVELS.find((l) => l.id === level) ?? QUIZ_LEVELS[0];
    const all = this.host
      .quizCountries()
      .filter((c) => c.data.i && c.data.k !== 'Ozeane' && c.data.k !== 'Antarktis' && (region === 'Welt' || c.data.k === region))
      .filter((c) => (c.data.x.area ?? 0) >= lv.minArea);
    // „bekannt“ ≈ groß und viele Einwohner
    const fame = (c: QuizCountry) => Math.log10((c.data.x.area ?? 1) + 1) + 0.6 * Math.log10(c.data.e + 1);
    let pool = [...all].sort((a, b) => fame(b) - fame(a)).slice(0, region === 'Welt' ? lv.count * 2 : lv.count);
    // Deutschland ist für die Kinder immer dabei
    const de = all.find((c) => c.data.i === 'DE');
    if (de && !pool.includes(de)) pool = [...pool.slice(0, -1), de];
    if (!pool.length) return;
    this.pool = pool;
    this.queue = shuffle([...pool]).slice(0, Math.min(ROUND, pool.length));
    this.asked = 0;
    this.score = 0;
    this.active = true;
    this.host.setQuizMode(true);
    const r = QUIZ_REGIONS.find((x) => x.id === region) ?? QUIZ_REGIONS[0];
    this.regionView = r.view;
    this.moved = false;
    this.host.flyTo(...r.view);
    this.box.classList.remove('hidden');
    this.next();
  }

  stop() {
    this.clearTimers();
    this.active = false;
    this.busy = false;
    window.speechSynthesis?.cancel();
    this.paintMap.clear();
    this.host.paint(undefined);
    this.host.setQuizMode(false);
    this.box.classList.add('hidden');
  }

  private clearTimers() {
    this.timers.forEach((t) => window.clearTimeout(t));
    this.timers = [];
  }

  private later(ms: number, fn: () => void) {
    this.timers.push(window.setTimeout(fn, ms));
  }

  private say(text: string) {
    if (this.voice) speak(text);
  }

  private beep(kind: 'good' | 'bad' | 'done') {
    if (this.sound) tone(kind);
  }

  private next() {
    this.clearTimers();
    this.paintMap.clear();
    this.host.paint(this.paintMap);
    this.current = this.queue[this.asked];
    if (!this.current) return this.finish();
    this.tries = 0;
    this.busy = false;
    // nach einem Hinweis wieder das ganze Quiz-Gebiet zeigen
    if (this.moved) {
      this.moved = false;
      this.host.flyTo(...this.regionView);
    }
    const c = this.current.data;
    this.progress.innerHTML = `Frage ${this.asked + 1} von ${this.queue.length} · <span class="quiz-score">${STAR_SVG} ${this.score}</span>`;
    this.flag.classList.remove('hidden');
    this.flag.src = `./flags/${c.i.toLowerCase()}.svg`;
    this.question.textContent = `Wo ist ${c.n}?`;
    this.feedback.textContent = 'Tippe auf das Land!';
    this.feedback.className = 'quiz-feedback';
    this.renderActions([
      this.button('play', 'Nochmal vorlesen', () => this.say(`Wo ist ${c.n}?`)),
      this.button('forward', 'Überspringen', () => this.reveal(true)),
      this.button('close', 'Beenden', () => this.stop()),
    ]);
    this.say(`Wo ist ${c.n}?`);
  }

  /** Antwort: angetipptes Land (oder Meer = undefined) */
  answer(idx: number | undefined, name?: string) {
    if (!this.active || this.busy || !this.current) return;
    const target = this.current;
    if (idx === target.idx) {
      this.busy = true;
      if (this.tries === 0) this.score++;
      this.paintMap.set(idx, GREEN);
      this.host.paint(this.paintMap);
      this.feedback.textContent = this.tries === 0 ? `Super! Das ist ${target.data.n}!` : `Richtig! Das ist ${target.data.n}.`;
      this.feedback.className = 'quiz-feedback good';
      this.beep('good');
      this.say(this.tries === 0 ? `Super! Das ist ${target.data.n}!` : `Richtig, das ist ${target.data.n}.`);
      this.celebrate();
      this.progress.querySelector('.quiz-score')!.innerHTML = `${STAR_SVG} ${this.score}`;
      this.asked++;
      this.later(2200, () => this.next());
      return;
    }
    this.tries++;
    this.beep('bad');
    if (idx !== undefined) {
      this.paintMap.set(idx, RED);
      this.host.paint(this.paintMap);
      this.later(1400, () => {
        if (this.paintMap.get(idx) === RED) {
          this.paintMap.delete(idx);
          this.host.paint(this.paintMap);
        }
      });
    }
    const wrong = idx !== undefined && name ? `Das ist ${name}.` : 'Das ist das Meer.';
    if (this.tries >= 2) {
      this.feedback.textContent = `${wrong} Schau mal, hier ist ${target.data.n}!`;
      this.feedback.className = 'quiz-feedback bad';
      this.say(`${wrong} Schau mal, hier ist ${target.data.n}.`);
      this.reveal(false);
    } else {
      this.feedback.textContent = `${wrong} Versuch es nochmal!`;
      this.feedback.className = 'quiz-feedback bad';
      this.say(`${wrong} Versuch es nochmal.`);
    }
  }

  /** Lösung zeigen: Land blinkt, Kamera fliegt hin, dann nächste Frage */
  private reveal(skip: boolean) {
    if (!this.current) return;
    this.busy = true;
    const target = this.current;
    if (skip) {
      this.feedback.textContent = `Hier ist ${target.data.n}.`;
      this.feedback.className = 'quiz-feedback';
      this.say(`Hier ist ${target.data.n}.`);
    }
    this.host.flyToCountry(target.idx);
    this.moved = true;
    this.paintMap.set(target.idx, HINT);
    this.host.paint(this.paintMap);
    for (let i = 0; i < 8; i++) this.later(300 + i * 320, () => this.host.blink(i % 2 === 0));
    this.later(300 + 8 * 320, () => this.host.blink(false));
    this.asked++;
    this.later(4200, () => this.next());
  }

  private finish() {
    this.busy = true;
    const total = this.queue.length;
    const stars = Math.round((this.score / total) * 5);
    this.flag.classList.add('hidden');
    this.progress.textContent = 'Geschafft!';
    this.question.innerHTML = `<div class="quiz-stars">${Array.from({ length: 5 }, (_, i) => `<span class="${i < stars ? 'on' : ''}">${STAR_SVG}</span>`).join('')}</div>`;
    const text = this.score === total ? 'Alles richtig! Du bist ein Länder-Profi!' : this.score >= total / 2 ? 'Toll gemacht!' : 'Gut geübt!';
    this.feedback.textContent = `${this.score} von ${total} richtig. ${text}`;
    this.feedback.className = 'quiz-feedback good';
    this.beep('done');
    this.say(`${this.score} von ${total} richtig. ${text}`);
    if (stars >= 3) this.celebrate();
    this.renderActions([
      this.button('rewind', 'Nochmal spielen', () => {
        this.queue = shuffle([...this.pool]).slice(0, Math.min(ROUND, this.pool.length));
        this.asked = 0;
        this.score = 0;
        this.next();
      }),
      this.button('close', 'Beenden', () => this.stop()),
    ]);
  }

  private celebrate() {
    for (let i = 0; i < 12; i++) {
      const s = document.createElement('span');
      s.className = 'quiz-burst';
      s.innerHTML = STAR_SVG;
      const a = (i / 12) * Math.PI * 2;
      s.style.setProperty('--dx', `${Math.cos(a) * (90 + Math.random() * 60)}px`);
      s.style.setProperty('--dy', `${Math.sin(a) * (60 + Math.random() * 40)}px`);
      s.style.color = ['#ffd166', '#ff8c1a', '#7fd0b0', '#f0a6d2'][i % 4];
      this.box.append(s);
      window.setTimeout(() => s.remove(), 1300);
    }
  }

  private renderActions(btns: HTMLButtonElement[]) {
    this.actions.replaceChildren(...btns);
  }

  private button(ico: Parameters<typeof icon>[0], text: string, onClick: () => void) {
    const b = document.createElement('button');
    b.className = 'icon-btn';
    b.append(icon(ico, 20), text);
    b.addEventListener('click', onClick);
    return b;
  }
}

function shuffle<T>(a: T[]) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
