// Einfärben der Länder: bunt (Nachbarn verschieden), nach Werten, nach Gruppen oder nach Bündnissen.
import type { CountryData } from './geo';

export const PALETTE = ['#f39a8f', '#f7c46c', '#f2e27a', '#a9d873', '#7fd0b0', '#c3a6ea', '#f0a6d2', '#d9b98f', '#9fd4e6'];
export const NO_DATA = '#e6e2da';
const SEQ = ['#fff3c4', '#fdd98a', '#f9b45f', '#ef8448', '#d9533b', '#a8263a']; // hell → dunkel
const CATS = ['#6fa8dc', '#f6b26b', '#93c47d', '#e06666', '#b4a7d6', '#ffd966', '#76a5af', '#d5a6bd', '#c9a77b'];
const MEMBER = '#e8833a';
const OTHER = '#e9e6df';

/** Bündnisse und Organisationen (Stand 2026), ISO-Codes der Mitglieder */
export const ALLIANCES: Record<string, { name: string; info: string; members: string }> = {
  eu: { name: 'Europäische Union', info: '27 Länder', members: 'AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE' },
  euro: { name: 'Euro-Länder', info: 'Länder mit dem Euro als Währung (Eurozone, 21 Länder)', members: 'AT BE BG HR CY EE FI FR DE GR IE IT LV LT LU MT NL PT SK SI ES' },
  schengen: { name: 'Schengen-Raum', info: 'Reisen ohne Grenzkontrollen (29 Länder)', members: 'AT BE BG HR CZ DK EE FI FR DE GR HU IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO CH' },
  nato: { name: 'NATO', info: 'Verteidigungsbündnis (32 Länder)', members: 'AL BE BG CA HR CZ DK EE FI FR DE GR HU IS IT LV LT LU ME NL MK NO PL PT RO SK SI ES SE TR GB US' },
  un: {
    name: 'Vereinte Nationen',
    info: '193 Mitgliedstaaten',
    members:
      'AF AL DZ AD AO AG AR AM AU AT AZ BS BH BD BB BY BE BZ BJ BT BO BA BW BR BN BG BF BI CV KH CM CA CF TD CL CN CO KM CG CD CR CI HR CU CY CZ DK DJ DM DO EC EG SV GQ ER EE SZ ET FJ FI FR GA GM GE DE GH GR GD GT GN GW GY HT HN HU IS IN ID IR IQ IE IL IT JM JP JO KZ KE KI KP KR KW KG LA LV LB LS LR LY LI LT LU MG MW MY MV ML MT MH MR MU MX FM MD MC MN ME MA MZ MM NA NR NP NL NZ NI NE NG MK NO OM PK PW PA PG PY PE PH PL PT QA RO RU RW KN LC VC WS SM ST SA SN RS SC SL SG SK SI SB SO ZA SS ES LK SD SR SE CH SY TJ TZ TH TL TG TO TT TN TR TM TV UG UA AE GB US UY UZ VU VE VN YE ZM ZW',
  },
  g7: { name: 'G7', info: 'Gruppe der Sieben (große Industrieländer)', members: 'CA FR DE IT JP GB US' },
  g20: { name: 'G20', info: 'Gruppe der Zwanzig (dazu EU und Afrikanische Union)', members: 'AR AU BR CA CN FR DE IN ID IT JP KR MX RU SA ZA TR GB US' },
  commonwealth: {
    name: 'Commonwealth of Nations',
    info: '56 Länder, meist frühere britische Kolonien',
    members:
      'AG AU BS BD BB BZ BW BN CM CA CY DM SZ FJ GA GM GH GD GY IN JM KE KI LS MW MY MV MT MU MZ NA NR NZ NG PK PG RW KN LC VC WS SC SL SG SB ZA LK TZ TO TT TV UG GB VU ZM TG',
  },
  opec: { name: 'OPEC', info: 'Organisation Erdöl exportierender Länder (12 Länder)', members: 'DZ CG GQ GA IR IQ KW LY NG SA AE VE' },
  brics: { name: 'BRICS', info: 'Brasilien, Russland, Indien, China, Südafrika und neue Mitglieder', members: 'BR RU IN CN ZA EG ET IR AE ID' },
  au: {
    name: 'Afrikanische Union',
    info: '55 Mitglieder',
    members:
      'DZ AO BJ BW BF BI CV CM CF TD KM CG CD CI DJ EG GQ ER SZ ET GA GM GH GN GW KE LS LR LY MG MW ML MR MU MA MZ NA NE NG RW EH ST SN SC SL SO ZA SS SD TZ TG TN UG ZM ZW',
  },
  asean: { name: 'ASEAN', info: 'Verband Südostasiatischer Nationen (11 Länder)', members: 'BN KH ID LA MY MM PH SG TH VN TL' },
};

export interface LegendEntry {
  color: string;
  label: string;
}

export interface ColorMode {
  id: string;
  name: string;
  group: 'Karte' | 'Werte' | 'Gruppen' | 'Bündnisse';
}

export const COLOR_MODES: ColorMode[] = [
  { id: 'neighbors', name: 'Bunt (Nachbarn verschieden)', group: 'Karte' },
  { id: 'pop', name: 'Einwohner', group: 'Werte' },
  { id: 'area', name: 'Fläche', group: 'Werte' },
  { id: 'density', name: 'Einwohner pro km²', group: 'Werte' },
  { id: 'continent', name: 'Kontinent', group: 'Gruppen' },
  { id: 'language', name: 'Hauptsprache', group: 'Gruppen' },
  { id: 'currency', name: 'Währung', group: 'Gruppen' },
  ...Object.entries(ALLIANCES).map(([id, a]) => ({ id: `alliance:${id}`, name: a.name, group: 'Bündnisse' as const })),
];

const classes = (bounds: number[], unit: (v: number) => string) =>
  bounds.map((b, i) => ({ color: SEQ[i], label: i === 0 ? `unter ${unit(bounds[1])}` : i === bounds.length - 1 ? `über ${unit(b)}` : `${unit(b)} – ${unit(bounds[i + 1])}` }));

const big = (v: number) => (v >= 1e9 ? `${v / 1e9} Mrd.` : v >= 1e6 ? `${v / 1e6} Mio.` : v >= 1e3 ? `${(v / 1e3).toLocaleString('de-DE')}.000` : String(v));

function classify(v: number | undefined, bounds: number[]) {
  if (v === undefined || !Number.isFinite(v) || v <= 0) return NO_DATA;
  let i = 0;
  while (i + 1 < bounds.length && v >= bounds[i + 1]) i++;
  return SEQ[i];
}

/** Größte Gruppen bekommen eigene Farben, der Rest „andere“ */
function categories(countries: CountryData[], key: (c: CountryData) => string | undefined, max = 8) {
  const count = new Map<string, number>();
  for (const c of countries) {
    const k = key(c);
    if (k) count.set(k, (count.get(k) ?? 0) + 1);
  }
  const top = [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([k]) => k);
  const colorOf = new Map(top.map((k, i) => [k, CATS[i]]));
  const legend: LegendEntry[] = top.map((k, i) => ({ color: CATS[i], label: k }));
  legend.push({ color: '#d8d4cc', label: 'andere' });
  return { fn: (c: CountryData) => (key(c) ? colorOf.get(key(c)!) ?? '#d8d4cc' : NO_DATA), legend };
}

const currencyGroup = (c: CountryData) => {
  const cur = c.x.cur?.[0];
  if (!cur) return undefined;
  return /CFA/i.test(cur) ? 'CFA-Franc' : cur;
};

/** Farbe je Land und Legende für einen Einfärbe-Modus */
export function colorScheme(mode: string, countries: CountryData[]): { fn: (c: CountryData) => string; legend: LegendEntry[]; info?: string } {
  if (mode.startsWith('alliance:')) {
    const a = ALLIANCES[mode.slice(9)];
    const set = new Set(a.members.split(' '));
    return {
      fn: (c) => (set.has(c.i) ? MEMBER : OTHER),
      legend: [
        { color: MEMBER, label: `Mitglied (${set.size})` },
        { color: OTHER, label: 'kein Mitglied' },
      ],
      info: a.info,
    };
  }
  switch (mode) {
    case 'pop': {
      const b = [0, 1e6, 1e7, 5e7, 1e8, 3e8];
      return { fn: (c) => classify(c.e, b), legend: classes(b, big) };
    }
    case 'area': {
      const b = [0, 1e3, 1e5, 5e5, 1e6, 5e6];
      return { fn: (c) => classify(c.x.area, b), legend: classes(b, (v) => `${big(v)} km²`) };
    }
    case 'density': {
      const b = [0, 10, 50, 100, 300, 1000];
      return { fn: (c) => classify(c.x.area ? c.e / c.x.area : undefined, b), legend: classes(b, (v) => String(v)) };
    }
    case 'continent':
      return categories(countries, (c) => (c.k === 'Ozeane' ? undefined : c.k), 8);
    case 'language':
      return categories(countries, (c) => c.x.lang?.[0], 8);
    case 'currency':
      return categories(countries, currencyGroup, 8);
    default:
      return { fn: (c) => PALETTE[c.c % PALETTE.length], legend: [] };
  }
}
