#!/usr/bin/env python3
"""Zusatzdaten für die politische Karte: Wasser, Bundesländer, umstrittene Gebiete, historische Grenzen,
besondere Orte, Flaggen.

Quellen (werden heruntergeladen, Zwischenstände im Cache):
  - Natural Earth 1:10 Mio. (Public Domain): Meere, Seen, Flüsse, Bundesländer/Provinzen, umstrittene Gebiete,
    Landschaften (Wüsten, Gebirge, Inseln, Halbinseln, Kaps), Häfen
  - Wikidata (CC0): deutsche Namen, Wikipedia-Links, Längen/Flächen/Höhen/Tiefen, UNESCO-Welterbe, Nationalparks
  - Smithsonian Global Volcanism Program: Vulkane (Holozän)
  - OurAirports (Public Domain): große Flughäfen
  - historical-basemaps von A. Ourednik (GPL-3.0): historische Grenzen
  - flag-icons (MIT): Flaggen als SVG

Ausgabe in public/data/political/: water.json, admin1.json, disputed.json, places.json, history/<jahr>.json
und public/flags/<iso2>.svg

Aufruf:  python3 scripts/build_extras.py [--cache VERZEICHNIS]
"""
import argparse
import csv
import glob
import json
import os
import shutil
import sys
import tarfile
import urllib.parse
import urllib.request
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_political import COARSE_TOL, FINE_TOL, Q, UA, dp_open, encode, polygons, re_qid, sparql  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'public', 'data', 'political')
NE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/'
HIST = 'https://raw.githubusercontent.com/aourednik/historical-basemaps/master/geojson/world_{}.geojson'
HIST_YEARS = [1815, 1880, 1900, 1914, 1920, 1938, 1945, 1960, 1994]
SRC = {
    'marine': NE + 'ne_10m_geography_marine_polys.geojson',
    'lakes': NE + 'ne_10m_lakes.geojson',
    'rivers': NE + 'ne_10m_rivers_lake_centerlines.geojson',
    'regions': NE + 'ne_10m_geography_regions_polys.geojson',
    'regionpts': NE + 'ne_10m_geography_regions_points.geojson',
    'admin1': NE + 'ne_10m_admin_1_states_provinces.geojson',
    'admin1lines': NE + 'ne_10m_admin_1_states_provinces_lines.geojson',
    'disputed': NE + 'ne_10m_admin_0_disputed_areas.geojson',
    'geolines': NE + 'ne_10m_geographic_lines.geojson',
    'ports': NE + 'ne_10m_ports.geojson',
    'countries': NE + 'ne_10m_admin_0_countries.geojson',
    'airports': 'https://davidmegginson.github.io/ourairports-data/airports.csv',
    'volcanoes': ('https://webservices.volcano.si.edu/geoserver/GVP-VOTW/ows?service=WFS&version=2.0.0&request=GetFeature'
                  '&typeName=GVP-VOTW:Smithsonian_VOTW_Holocene_Volcanoes&outputFormat=application/json'),
}
CACHE = ''


def fetch(name, url=None, filename=None):
    url = url or SRC[name]
    path = os.path.join(CACHE, filename or (name + '.json' if name == 'volcanoes' else os.path.basename(url.split('?')[0])))
    if not os.path.exists(path):
        print('lade', url[:100], file=sys.stderr)
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=300) as r, open(path, 'wb') as f:
            f.write(r.read())
    return path


def load(name):
    return json.load(open(fetch(name), encoding='utf-8'))['features']


def prop(p, key):
    return p.get(key, p.get(key.upper(), p.get(key.lower())))


def cached(name, fn):
    """Ergebnis einer Wikidata-Abfrage im Cache halten (erneut abfragen: Datei löschen)."""
    path = os.path.join(CACHE, f'wd_{name}.json')
    if os.path.exists(path):
        return json.load(open(path, encoding='utf-8'))
    data = fn()
    json.dump(data, open(path, 'w', encoding='utf-8'), ensure_ascii=False)
    return data


def title(url):
    return urllib.parse.unquote(url.rsplit('/wiki/', 1)[1])


def chunks(lst, n):
    for i in range(0, len(lst), n):
        yield lst[i:i + n]


# ── Wikidata-Helfer ───────────────────────────────────────────────────────

FACTS = {'area': 'P2046', 'length': 'P2043', 'height': 'P2048', 'depth': 'P4511', 'elev': 'P2044'}


def wd_facts(qids, tag):
    """Deutscher Name, Wikipedia (de, sonst „en:…“), Lage und Maße (normiert auf m bzw. m²) je Wikidata-Nummer."""
    qids = sorted({q for q in qids if q and re_qid(q)})
    path = os.path.join(CACHE, f'wd_facts_{tag}.json')
    known = json.load(open(path, encoding='utf-8')) if os.path.exists(path) else {}
    missing = [q for q in qids if q not in known]

    def run():
        res = {q: {} for q in missing}
        for part in chunks(missing, 250):
            values = ' '.join(f'wd:{q}' for q in part)
            rows = sparql('SELECT ?x ?l ?a ?b ?coord WHERE { VALUES ?x {' + values + '} '
                          'OPTIONAL { ?x rdfs:label ?l FILTER(lang(?l) = "de") } '
                          'OPTIONAL { ?a schema:about ?x; schema:isPartOf <https://de.wikipedia.org/> } '
                          'OPTIONAL { ?b schema:about ?x; schema:isPartOf <https://en.wikipedia.org/> } '
                          'OPTIONAL { ?x wdt:P625 ?coord } }')
            for r in rows:
                e = res.setdefault(r['x']['value'].rsplit('/', 1)[1], {})
                if 'l' in r:
                    e.setdefault('de', r['l']['value'])
                if 'a' in r:
                    e.setdefault('wiki', title(r['a']['value']))
                elif 'b' in r and 'wiki' not in e:
                    e['wiki'] = 'en:' + title(r['b']['value'])
                if 'coord' in r and 'coord' not in e:
                    try:
                        lon, lat = map(float, r['coord']['value'][6:-1].split())
                        e['coord'] = [round(lon, 4), round(lat, 4)]
                    except ValueError:
                        pass
            for key, pid in FACTS.items():
                rows = sparql('SELECT ?x ?v WHERE { VALUES ?x {' + values + '} ?x p:' + pid + ' ?st . '
                              '?st psn:' + pid + '/wikibase:quantityAmount ?v . ?st wikibase:rank ?r FILTER(?r != wikibase:DeprecatedRank) }')
                for r in rows:
                    e = res.setdefault(r['x']['value'].rsplit('/', 1)[1], {})
                    v = float(r['v']['value'])
                    # mehrere Angaben: größte Fläche/Länge/Höhe/Tiefe, bei der Höhe über dem Meer die extremste
                    if key not in e or abs(v) > abs(e[key]):
                        e[key] = v
            print(f'Wikidata {tag}: {len(res)}/{len(missing)}', file=sys.stderr)
        return res
    if missing:
        known.update(run())
        json.dump(known, open(path, 'w', encoding='utf-8'), ensure_ascii=False)
    return known


def wd_by_titles(titles, tag):
    """Wikidata-Nummer zu deutschen Wikipedia-Titeln."""
    def run():
        res = {}
        for part in chunks(titles, 150):
            values = ' '.join('"' + t.replace('"', '\\"') + '"@de' for t in part)
            for r in sparql('SELECT ?t ?x WHERE { VALUES ?t {' + values + '} ?a schema:name ?t ; schema:about ?x ; '
                            'schema:isPartOf <https://de.wikipedia.org/> }'):
                res[r['t']['value']] = r['x']['value'].rsplit('/', 1)[1]
        return res
    found = cached('titles_' + tag, run)
    missing = [t for t in titles if t not in found]
    if missing:
        print(f'  nicht gefunden ({tag}):', ', '.join(missing), file=sys.stderr)
    return found


def km(v):
    return round(v / 1000) if v else 0


def km2(v):
    return round(v / 1e6) if v else 0


# ── Geometrie ─────────────────────────────────────────────────────────────

def inside(ring, x, y):
    c = False
    for i in range(len(ring)):
        (xi, yi), (xj, yj) = ring[i], ring[i - 1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            c = not c
    return c


def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))) if dx or dy else 0
    return ((px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2) ** 0.5


def label_point(geom):
    """Punkt tief im Inneren der größten Teilfläche (grobe Näherung an „polylabel“)."""
    polys = geom['coordinates'] if geom['type'] == 'MultiPolygon' else [geom['coordinates']]
    best_poly = max(polys, key=lambda p: (max(q[0] for q in p[0]) - min(q[0] for q in p[0])) * (max(q[1] for q in p[0]) - min(q[1] for q in p[0])))
    ring = best_poly[0]
    step = max(1, len(ring) // 400)
    ring_s = ring[::step]
    xs = [q[0] for q in ring]
    ys = [q[1] for q in ring]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    best, bp = -1.0, [(x0 + x1) / 2, (y0 + y1) / 2]
    n = 24
    for i in range(1, n):
        for j in range(1, n):
            x = x0 + (x1 - x0) * i / n
            y = y0 + (y1 - y0) * j / n
            if not inside(ring_s, x, y):
                continue
            d = min(seg_dist(x, y, *ring_s[k - 1], *ring_s[k]) for k in range(len(ring_s)))
            if d > best:
                best, bp = d, [x, y]
    return [round(bp[0], 3), round(bp[1], 3)]


def quantize_line(coords):
    out = []
    for lon, lat in coords:
        p = (round(lon * Q), round(lat * Q))
        if not out or out[-1] != p:
            out.append(p)
    return out


def encode_line(line, tol):
    r = dp_open(line, tol)
    flat = [r[0][0], r[0][1]]
    for (ax, ay), (bx, by) in zip(r, r[1:]):
        flat += [bx - ax, by - ay]
    return flat


def lines_of(geom):
    if not geom:
        return []
    if geom['type'] == 'LineString':
        return [geom['coordinates']]
    if geom['type'] == 'MultiLineString':
        return geom['coordinates']
    return []


# ── Wasser: Meere, Seen, Flüsse, Meerestiefen ─────────────────────────────

SEA_KIND = {'ocean': 'Ozean', 'sea': 'Meer', 'gulf': 'Golf', 'bay': 'Bucht', 'strait': 'Meerenge', 'sound': 'Sund',
            'channel': 'Kanal', 'lagoon': 'Lagune', 'fjord': 'Fjord', 'reef': 'Riff', 'inlet': 'Meeresarm', 'generic': 'Meeresgebiet',
            'river': 'Mündung'}

OCEAN_DEEPS = [  # Wikipedia-Titel, Name in der Karte, Tiefe (m, Rückfall), Lage (Rückfall)
    ('Challengertief', 'Challengertief (Marianengraben)', 10935, (142.20, 11.37)),
    ('Tongagraben', 'Horizon-Tief (Tongagraben)', 10800, (-174.73, -23.26)),
    ('Philippinengraben', 'Galatheatief (Philippinengraben)', 10540, (126.65, 10.43)),
    ('Kurilengraben', 'Kurilengraben', 10542, (152.0, 45.0)),
    ('Kermadecgraben', 'Kermadecgraben', 10047, (-177.0, -31.0)),
    ('Izu-Ogasawara-Graben', 'Izu-Bonin-Graben', 9810, (142.5, 29.0)),
    ('Puerto-Rico-Graben', 'Milwaukeetief (Puerto-Rico-Graben)', 8376, (-66.5, 19.77)),
    ('Südsandwichgraben', 'Meteortief (Südsandwichgraben)', 8265, (-25.3, -55.7)),
    ('Sundagraben', 'Sundagraben (Java)', 7290, (110.0, -10.3)),
    ('Molloytief', 'Molloytief (Nordpolarmeer)', 5550, (2.8, 79.1)),
    ('Calypsotief', 'Calypsotief (Mittelmeer)', 5267, (21.1, 36.57)),
    ('Atacamagraben', 'Richardstief (Atacamagraben)', 8065, (-71.6, -23.3)),
]


def build_water():
    seas = []
    feats = load('marine')
    facts = wd_facts([prop(f['properties'], 'wikidataid') for f in feats], 'marine')
    for f in feats:
        p = f['properties']
        name = p.get('name_de') or p.get('name')
        if not name or p['featurecla'] == 'river':
            continue
        q = p.get('wikidataid') or ''
        x = facts.get(q, {})
        seas.append([name, *label_point(f['geometry']), SEA_KIND.get(p['featurecla'], ''), float(p.get('min_label') or 5),
                     x.get('wiki', ''), km2(x.get('area')), round(abs(x.get('depth', 0)))])

    lakes = []
    feats = [f for f in load('lakes') if f['properties'].get('name') and (f['properties'].get('scalerank') or 9) <= 7]
    facts = wd_facts([f['properties'].get('wikidataid') for f in feats], 'lakes')
    seen = set()
    for f in feats:
        p = f['properties']
        name = p.get('name_de') or p['name']
        if name in seen:
            continue
        seen.add(name)
        x = facts.get(p.get('wikidataid') or '', {})
        lakes.append([name, *label_point(f['geometry']), float(p.get('min_label') or 6), x.get('wiki', ''),
                      km2(x.get('area')), round(abs(x.get('depth', 0)))])

    # Flüsse: Abschnitte gleichen Namens zusammenfassen, über den englischen Namen in Wikidata finden
    groups = defaultdict(list)
    for f in load('rivers'):
        p = f['properties']
        if p['featurecla'] != 'River' or not p.get('name'):
            continue
        groups[p['name']].append(f)
    names = sorted(groups)

    def find_rivers():
        res = {}
        for part in chunks(names, 120):
            values = ' '.join('"' + n.replace('"', '\\"') + '"@en' for n in part)
            rows = sparql('SELECT ?n ?x ?links WHERE { VALUES ?n {' + values + '} ?x rdfs:label ?n ; wdt:P31 ?t ; wikibase:sitelinks ?links . '
                          'VALUES ?t { wd:Q4022 wd:Q573344 wd:Q47521 wd:Q1437299 } }')
            for r in rows:
                n, links = r['n']['value'], int(r['links']['value'])
                if n not in res or links > res[n][1]:
                    res[n] = [r['x']['value'].rsplit('/', 1)[1], links]
        # zweiter Versuch: „… River“ und Alternativnamen (z. B. Amazon → Amazon River)
        missing = [n for n in names if n not in res]
        for part in chunks(missing, 80):
            alts = {}
            for n in part:
                alts[n] = n
                alts[n + ' River'] = n
            values = ' '.join('"' + a.replace('"', '\\"') + '"@en' for a in alts)
            rows = sparql('SELECT ?n ?x ?links WHERE { VALUES ?n {' + values + '} ?x rdfs:label|skos:altLabel ?n ; wdt:P31 ?t ; wikibase:sitelinks ?links . '
                          'VALUES ?t { wd:Q4022 wd:Q573344 wd:Q47521 wd:Q1437299 } }')
            for r in rows:
                n, links = alts[r['n']['value']], int(r['links']['value'])
                if n not in res or links > res[n][1]:
                    res[n] = [r['x']['value'].rsplit('/', 1)[1], links]
        # dritter Versuch: deutscher Name (Natural Earth schreibt manche Flüsse deutsch, z. B. „Rhein“)
        missing = [n for n in names if n not in res]
        for part in chunks(missing, 120):
            values = ' '.join('"' + n.replace('"', '\\"') + '"@de' for n in part)
            rows = sparql('SELECT ?n ?x ?links WHERE { VALUES ?n {' + values + '} ?x rdfs:label ?n ; wdt:P31 ?t ; wikibase:sitelinks ?links . '
                          'VALUES ?t { wd:Q4022 wd:Q573344 wd:Q47521 wd:Q1437299 } }')
            for r in rows:
                n, links = r['n']['value'], int(r['links']['value'])
                if n not in res or links > res[n][1]:
                    res[n] = [r['x']['value'].rsplit('/', 1)[1], links]
        return res
    rq = cached('rivers_by_name', find_rivers)
    facts = wd_facts([v[0] for v in rq.values()], 'rivers')
    # Abschnitte desselben Flusses (gleiche Wikidata-Nummer, verschiedene Schreibweisen) zusammenführen
    merged = defaultdict(list)
    for name in names:
        merged[rq[name][0] if name in rq else 'name:' + name].append(name)
    rivers = []
    for key, members in merged.items():
        name = members[0]
        fs = [f for n in members for f in groups[n]]
        q = key if not key.startswith('name:') else ''
        x = facts.get(q, {})
        rank = min(float(f['properties'].get('scalerank') or 9) for f in fs)
        min_label = min(float(f['properties'].get('min_label') or 8) for f in fs)
        parts = [quantize_line(c) for f in fs for c in lines_of(f['geometry'])]
        parts = [p for p in parts if len(p) >= 2]
        if not parts:
            continue
        longest = max(parts, key=len)
        mid = longest[len(longest) // 2]
        rivers.append({
            'n': x.get('de') or name, 'r': rank, 'z': min_label, 'w': x.get('wiki', ''), 'len': km(x.get('length')),
            'l': [round(mid[0] / Q, 3), round(mid[1] / Q, 3)],
            'p': [encode_line(p, FINE_TOL) for p in parts],
            'g': [encode_line(p, COARSE_TOL) for p in parts if rank <= 6],
        })

    # gleich benannte Abschnitte ohne Wikidata-Treffer dem Fluss mit Treffer zuschlagen
    by_name = {}
    for r in sorted(rivers, key=lambda r: -r['len']):
        main = by_name.get(r['n'])
        if main and not r['w']:
            main['p'] += r['p']
            main['g'] += r['g']
            main['r'] = min(main['r'], r['r'])
            r['drop'] = True
        else:
            by_name.setdefault(r['n'], r)
    rivers = [r for r in rivers if not r.get('drop')]
    titles = [t for t, *_ in OCEAN_DEEPS]
    tq = wd_by_titles(titles, 'deeps')
    facts = wd_facts(tq.values(), 'deeps')
    deeps = []
    for t, name, depth, (lon, lat) in OCEAN_DEEPS:
        x = facts.get(tq.get(t, ''), {})
        d = round(abs(x.get('depth') or x.get('elev') or 0)) or depth
        if d < 1000:
            d = depth
        c = x.get('coord') or [lon, lat]
        deeps.append([name, c[0], c[1], -d, x.get('wiki') or t])
    print(f'Meere {len(seas)}, Seen {len(lakes)}, Flüsse {len(rivers)} (mit Länge {sum(1 for r in rivers if r["len"])}), Tiefen {len(deeps)}', file=sys.stderr)
    return {'scale': Q, 'seas': seas, 'lakes': lakes, 'rivers': rivers, 'deeps': deeps}


# ── Bundesländer / Provinzen ──────────────────────────────────────────────

def build_admin1():
    lines = []
    for f in load('admin1lines'):
        for c in lines_of(f['geometry']):
            q = quantize_line(c)
            if len(q) >= 2:
                lines.append(q)
    labels = []
    for f in load('admin1'):
        p = f['properties']
        name = p.get('name_de') or p.get('name')
        if not name or p.get('latitude') is None:
            continue
        labels.append([name, round(p['longitude'], 3), round(p['latitude'], 3), p.get('iso_a2') or '', p.get('type_de') or p.get('type_en') or '',
                       float(p.get('min_label') or 7), p.get('wikidataid') or ''])
    facts = wd_facts([l[6] for l in labels], 'admin1')
    for l in labels:
        l[6] = facts.get(l[6], {}).get('wiki', '')
    print(f'Bundesländer/Provinzen: {len(labels)}, Grenzlinien {len(lines)}', file=sys.stderr)
    return {'scale': Q, 'lines': [encode_line(l, FINE_TOL) for l in lines], 'coarse': [encode_line(l, COARSE_TOL) for l in lines if len(l) > 3], 'labels': labels}


# ── Umstrittene Gebiete ───────────────────────────────────────────────────

def build_disputed(names_de):
    res = []
    for f in load('disputed'):
        p = f['properties']
        note = p.get('NOTE_BRK') or ''
        for en, de in (('Admin. by', 'Verwaltet von'), ('Claimed by', 'beansprucht von'), ('Self admin.', 'Selbstverwaltet'), (' and ', ' und ')):
            note = note.replace(en, de)
        for en, de in sorted(names_de.items(), key=lambda t: -len(t[0])):
            note = note.replace(en, de)
        res.append({'n': p.get('NAME_DE') or p.get('BRK_NAME') or p.get('NAME'), 'note': note, 'w': p.get('WIKIDATAID') or '',
                    'l': [round(p['LABEL_X'], 3), round(p['LABEL_Y'], 3)], 'z': float(p.get('MIN_LABEL') or 6),
                    'p': encode(polygons(f['geometry']), FINE_TOL)})
    facts = wd_facts([d['w'] for d in res], 'disputed')
    for d in res:
        d['w'] = facts.get(d['w'], {}).get('wiki', '')
    return {'scale': Q, 'areas': res}


# ── Historische Grenzen ───────────────────────────────────────────────────

HIST_DE = {
    'USSR': 'Sowjetunion', 'Russian Empire': 'Russisches Kaiserreich', 'Russia': 'Russland', 'Canada': 'Kanada',
    'United States': 'Vereinigte Staaten', 'United States of America': 'Vereinigte Staaten', 'Manchu Empire': 'Kaiserreich China (Qing)',
    'China': 'China', 'Brazil': 'Brasilien', 'Kingdom of Brazil': 'Königreich Brasilien', 'Viceroyalty of Brazil': 'Vizekönigreich Brasilien',
    'Denmark': 'Dänemark', 'Greenland': 'Grönland', 'Viceroyalty of New Spain': 'Vizekönigreich Neuspanien', 'French West Africa': 'Französisch-Westafrika',
    'Australia': 'Australien', 'British Raj': 'Britisch-Indien', 'Ottoman Empire': 'Osmanisches Reich', 'Viceroyalty of Peru': 'Vizekönigreich Peru',
    'Chinese Warlords': 'China (Warlords)', 'Chinese warlords': 'China (Warlords)', 'India': 'Indien', 'Argentina': 'Argentinien',
    'Kazakhstan': 'Kasachstan', 'Mexico': 'Mexiko', 'French Equatorial Africa': 'Französisch-Äquatorialafrika', 'Empire of Japan': 'Japanisches Kaiserreich',
    'Persia': 'Persien', 'Arabia': 'Arabien', 'Sweden–Norway': 'Schweden-Norwegen', 'Viceroyalty of New Granada': 'Vizekönigreich Neugranada',
    'Algeria': 'Algerien', 'Saudi Arabia': 'Saudi-Arabien', 'British East India Company': 'Britische Ostindien-Kompanie', 'Egypt': 'Ägypten',
    'Dutch East Indies': 'Niederländisch-Indien', 'Netherlands Indies': 'Niederländisch-Indien', 'Indonesia': 'Indonesien', 'Norway': 'Norwegen',
    'Union of South Africa': 'Südafrikanische Union', 'Algeria (France)': 'Algerien (Frankreich)', 'Belgian Congo': 'Belgisch-Kongo',
    'Zaire': 'Zaire', 'Anglo-Egyptian Sudan': 'Anglo-Ägyptischer Sudan', 'Chile': 'Chile', 'Mongolia': 'Mongolei', 'Sudan': 'Sudan',
    'Bolivia': 'Bolivien', 'Iran': 'Iran', 'Manchuria': 'Mandschurei', 'Colombia': 'Kolumbien', 'Peru': 'Peru', 'Mali': 'Mali',
    'Pakistan': 'Pakistan', 'Libya': 'Libyen', 'Libya (IT)': 'Libyen (Italien)', 'South Africa': 'Südafrika', 'Tibet': 'Tibet',
    'Rattanakosin Kingdom': 'Königreich Siam', 'Niger': 'Niger', 'Venezuela': 'Venezuela', 'Sweden': 'Schweden', 'Mozambique': 'Mosambik',
    'Mozambique (Portugal)': 'Mosambik (Portugal)', 'Ethiopia': 'Äthiopien', 'Abyssinia': 'Abessinien', 'Ethiopia (Italy)': 'Äthiopien (Italien)',
    'Rhodesia': 'Rhodesien', 'Chad': 'Tschad', 'Burma': 'Birma', 'German South-West Africa': 'Deutsch-Südwestafrika', 'Namibia': 'Namibia',
    'Portuguese East Africa': 'Portugiesisch-Ostafrika', 'Mauritania': 'Mauretanien', 'Angola': 'Angola', 'Angola (Portugal)': 'Angola (Portugal)',
    'Austro-Hungarian Empire': 'Österreich-Ungarn', 'Austria Hungary': 'Österreich-Ungarn', 'Germany': 'Deutschland', 'German Empire': 'Deutsches Kaiserreich',
    'Uzbekistan': 'Usbekistan', 'Austrian Empire': 'Kaisertum Österreich', 'Ukraine': 'Ukraine', 'Somalia': 'Somalia',
    'British Somaliland': 'Britisch-Somaliland', 'Italian Somaliland': 'Italienisch-Somaliland', 'French Indochina': 'Französisch-Indochina',
    'French Indo-China': 'Französisch-Indochina', 'Dominion of Newfoundland': 'Neufundland', 'Imperial Japan': 'Japanisches Kaiserreich', 'Japan': 'Japan',
    'Afghanistan': 'Afghanistan', 'German E. Africa (Tanganyika)': 'Deutsch-Ostafrika', 'Kamerun': 'Kamerun (deutsche Kolonie)', 'Italy': 'Italien',
    'Turkey': 'Türkei', 'Finland': 'Finnland', 'Siam': 'Siam', 'Thailand': 'Thailand', 'Mesopotamia (GB)': 'Mesopotamien (Großbritannien)',
    'Tanzania, United Republic of': 'Tansania', 'Kingdom of Italy': 'Königreich Italien', 'France': 'Frankreich', 'Zambia': 'Sambia',
    'Northern Rhodesia': 'Nordrhodesien', 'Zanzibar': 'Sansibar', 'Central African Republic': 'Zentralafrikanische Republik', 'Nigeria': 'Nigeria',
    'Vietnam': 'Vietnam', 'Turkmenistan': 'Turkmenistan', 'Morocco': 'Marokko', 'Morocco (France)': 'Marokko (Frankreich)', 'Spain': 'Spanien',
    'Madagascar': 'Madagaskar', 'Madagascar (France)': 'Madagaskar (Frankreich)', 'Cape Colony': 'Kapkolonie',
    'United Kingdom of Great Britain and Ireland': 'Vereinigtes Königreich Großbritannien und Irland', 'British East Africa': 'Britisch-Ostafrika',
    'Sultanate of Zanzibar': 'Sultanat Sansibar', 'Poland': 'Polen', 'New Zealand': 'Neuseeland', 'Botswana': 'Botswana', 'Papua New Guinea': 'Papua-Neuguinea',
    'French Cameroons': 'Französisch-Kamerun', 'Cameroon': 'Kamerun', 'Prussia': 'Preußen', 'Iraq': 'Irak', 'Kenya': 'Kenia', 'Malaya': 'Malaya',
    'Malaysia': 'Malaysia', 'United Kingdom': 'Vereinigtes Königreich', 'Ecuador': 'Ecuador', 'Paraguay': 'Paraguay', 'Oman': 'Oman',
    'Muscat and Oman': 'Maskat und Oman', 'Syria (France)': 'Syrien (Frankreich)', 'Yemen': 'Jemen', 'Laos': 'Laos', 'Congo': 'Kongo',
    'West Germany': 'Bundesrepublik Deutschland', 'East Germany': 'DDR', 'Yugoslavia': 'Jugoslawien', 'Romania': 'Rumänien', 'Korea': 'Korea',
    'Zimbabwe': 'Simbabwe', 'Southern Rhodesia': 'Südrhodesien', 'Greece': 'Griechenland', 'Western Sahara': 'Westsahara', 'Philippines': 'Philippinen',
    'Byelarus': 'Weißrussland', 'White Russia': 'Weißrussland', 'Burkina Faso': 'Burkina Faso', 'Kyrgyzstan': 'Kirgisistan', 'Guinea': 'Guinea',
    'Uganda': 'Uganda', 'Ottoman Sultanate': 'Osmanisches Reich', 'Eritrea': 'Eritrea', 'Ivory Coast': 'Elfenbeinküste', 'Czechoslovakia': 'Tschechoslowakei',
    'Bulgaria': 'Bulgarien', 'Syria': 'Syrien', 'Gabon': 'Gabun', 'Cuba': 'Kuba', 'Iceland': 'Island', "Korea, Democratic People's Republic of": 'Nordkorea',
    'Korea, Republic of': 'Südkorea', 'Korea (USSR)': 'Korea (sowjetisch besetzt)', 'Korea (USA)': 'Korea (amerikanisch besetzt)', 'Guyana': 'Guyana',
    'Nepal': 'Nepal', 'Tajikistan': 'Tadschikistan', 'Kingdom of the Two Sicilies': 'Königreich beider Sizilien', 'Gold Coast': 'Goldküste', 'Ghana': 'Ghana',
    'Tunisia': 'Tunesien', 'Senegal': 'Senegal', 'Azerbaijan': 'Aserbaidschan', 'Uruguay': 'Uruguay', 'Bangladesh': 'Bangladesch', 'Armenia': 'Armenien',
    'Germany (UK)': 'Deutschland (britische Zone)', 'Germany (USA)': 'Deutschland (amerikanische Zone)', 'Germany (France)': 'Deutschland (französische Zone)',
    'Germany (Soviet)': 'Deutschland (sowjetische Zone)', 'Malawi': 'Malawi', 'Nyasaland': 'Njassaland', 'British Guiana': 'Britisch-Guayana',
    'Cambodia': 'Kambodscha', 'Croatia': 'Kroatien', 'Hungary': 'Ungarn', 'Orange Free State': 'Oranje-Freistaat', 'Rwanda': 'Ruanda',
    'United Arab Emirates': 'Vereinigte Arabische Emirate', 'Trucial Oman': 'Vertragsstaaten (Trucial Oman)', 'Austria': 'Österreich', 'Burundi': 'Burundi',
    'Nicaragua': 'Nicaragua', 'Benin': 'Benin', 'Jordan': 'Jordanien', 'Serbia': 'Serbien', 'Dutch Guiana': 'Niederländisch-Guayana', 'Suriname': 'Suriname',
    'Honduras': 'Honduras', 'Portugal': 'Portugal', 'Latvia': 'Lettland', 'Georgia': 'Georgien', 'Ireland': 'Irland', 'Liberia': 'Liberia',
    'Czech Republic': 'Tschechien', 'Bavaria': 'Bayern', 'Guatemala': 'Guatemala', 'Lithuania': 'Litauen', 'Panama': 'Panama', 'Papal States': 'Kirchenstaat',
    'Togoland': 'Togo (deutsche Kolonie)', 'Bosnia-Herzegovina': 'Bosnien-Herzegowina', 'Bosnia and Herzegovina': 'Bosnien und Herzegowina',
    'Kingdom of Sardinia': 'Königreich Sardinien', 'Costa Rica': 'Costa Rica', 'Moldova': 'Moldau', 'French Guiana': 'Französisch-Guayana',
    'Hanover': 'Hannover', 'Slovakia': 'Slowakei', 'Netherlands': 'Niederlande', 'Estonia': 'Estland', 'Togo': 'Togo', 'Switzerland': 'Schweiz',
    'Sierra Leone': 'Sierra Leone', 'Ceylon': 'Ceylon', 'Sri Lanka': 'Sri Lanka', 'Dominican Republic': 'Dominikanische Republik', 'Belgium': 'Belgien',
    'New Caledonia': 'Neukaledonien', 'Venetia': 'Venetien', 'Spanish Morocco': 'Spanisch-Marokko', 'Taiwan': 'Taiwan',
    'Mandatory Palestine (GB)': 'Mandatsgebiet Palästina', 'Israel': 'Israel', 'Haiti': 'Haiti', 'Bhutan': 'Bhutan', 'Albania': 'Albanien',
    'Lesotho': 'Lesotho', 'Basutoland': 'Basutoland', 'Saxony': 'Sachsen', 'Slovenia': 'Slowenien', 'Baden': 'Baden', 'Tuscany': 'Toskana',
    'Lombardy': 'Lombardei', 'Montenegro': 'Montenegro', 'Bahamas': 'Bahamas', 'Macedonia': 'Mazedonien', 'Thuringia': 'Thüringen',
    'Mecklenburg-Schwerin': 'Mecklenburg-Schwerin', 'Djibouti': 'Dschibuti', 'French Somaliland': 'Französisch-Somaliland', 'Württemberg': 'Württemberg',
    'Belize': 'Belize', 'El Salvador': 'El Salvador', 'Kuwait': 'Kuwait', 'East Prussia': 'Ostpreußen', 'Electoral Hesse': 'Kurhessen', 'Cyprus': 'Zypern',
    'Equatorial Guinea': 'Äquatorialguinea', 'Lebanon': 'Libanon', 'Swaziland': 'Swasiland', 'Kingdom of Hawaii': 'Königreich Hawaii',
    'Luxembourg': 'Luxemburg', 'Denmark-Norway': 'Dänemark-Norwegen', 'Sardinia': 'Sardinien', 'Spanish Sahara': 'Spanisch-Sahara', 'Fiji': 'Fidschi',
    'Malta': 'Malta', 'Liechtenstein': 'Liechtenstein', 'Monaco': 'Monaco', 'Andorra': 'Andorra', 'San Marino': 'San Marino', 'Vatican': 'Vatikanstadt',
    'Qatar': 'Katar', 'Bahrain': 'Bahrain', 'Mongolian People\'s Republic': 'Mongolei', 'Manchukuo': 'Mandschukuo', 'Free City of Danzig': 'Freie Stadt Danzig',
    'Danzig': 'Danzig', 'Saar': 'Saargebiet', 'Hejaz': 'Hedschas', 'Nejd': 'Nadschd', 'Transvaal': 'Transvaal', 'Natal': 'Natal', 'Zululand': 'Zululand',
    'Korea (Japan)': 'Korea (Japan)', 'Joseon': 'Korea (Joseon)', 'Annam': 'Annam', 'Tonkin': 'Tonkin', 'Cochin China': 'Kotschinchina',
    'Kingdom of Hungary': 'Königreich Ungarn', 'Kingdom of Prussia': 'Königreich Preußen', 'Kingdom of Bavaria': 'Königreich Bayern',
    'Kingdom of Saxony': 'Königreich Sachsen', 'Grand Duchy of Baden': 'Großherzogtum Baden', 'Kingdom of Württemberg': 'Königreich Württemberg',
    'Kingdom of Hanover': 'Königreich Hannover', 'Swiss Confederation': 'Schweiz', 'United Kingdom of the Netherlands': 'Vereinigtes Königreich der Niederlande',
    'Kingdom of France': 'Königreich Frankreich', 'Kingdom of Spain': 'Königreich Spanien', 'Kingdom of Portugal': 'Königreich Portugal',
}


def build_history(year):
    feats = json.load(open(fetch(f'hist{year}', HIST.format(year), f'world_{year}.geojson'), encoding='utf-8'))['features']
    items = []
    for f in feats:
        p = f['properties']
        name = (p.get('NAME') or '').strip()
        if not name or not f.get('geometry'):
            continue
        polys = polygons(f['geometry'])
        if not polys:
            continue
        subj = (p.get('SUBJECTO') or '').strip()
        items.append({'name': HIST_DE.get(name, name), 'subj': HIST_DE.get(subj, subj) if subj and subj != name else '',
                      'polys': polys, 'label': label_point(f['geometry'])})
    # Nachbarn über gemeinsame (auf ≈ 1 km gerundete) Punkte, dann gierig färben
    owner = defaultdict(set)
    for i, it in enumerate(items):
        for poly in it['polys']:
            for ring in poly:
                for x, y in ring:
                    owner[(x // 20, y // 20)].add(i)
    nb = defaultdict(set)
    for s in owner.values():
        if 1 < len(s) < 8:
            for a in s:
                nb[a] |= s - {a}
    colors = [0] * len(items)
    for i in sorted(range(len(items)), key=lambda i: -len(nb[i])):
        used = {colors[j] for j in nb[i] if j < i or colors[j]}
        colors[i] = next((c for c in range(9) if c not in used), i % 9)
    return {'scale': Q, 'year': year, 'countries': [
        {'n': it['name'], 's': it['subj'], 'c': c, 'l': it['label'], 'p': encode(it['polys'], 0.004), 'g': encode(it['polys'], COARSE_TOL, 0.1)}
        for it, c in zip(items, colors)]}


# ── Orte ──────────────────────────────────────────────────────────────────

WONDERS = [  # (Titel, Gruppe, Rückfall-Lage)
    ('Chinesische Mauer', 'Neue Weltwunder', (117.23, 40.68)), ('Petra (Jordanien)', 'Neue Weltwunder', (35.44, 30.33)),
    ('Cristo Redentor', 'Neue Weltwunder', (-43.21, -22.95)), ('Machu Picchu', 'Neue Weltwunder', (-72.545, -13.163)),
    ('Chichén Itzá', 'Neue Weltwunder', (-88.569, 20.684)), ('Kolosseum', 'Neue Weltwunder', (12.492, 41.890)),
    ('Taj Mahal', 'Neue Weltwunder', (78.042, 27.175)),
    ('Cheops-Pyramide', 'Antike Weltwunder', (31.134, 29.979)), ('Hängende Gärten der Semiramis', 'Antike Weltwunder', (44.42, 32.54)),
    ('Zeusstatue des Phidias', 'Antike Weltwunder', (21.63, 37.638)), ('Tempel der Artemis in Ephesos', 'Antike Weltwunder', (27.364, 37.950)),
    ('Mausoleum von Halikarnassos', 'Antike Weltwunder', (27.424, 37.038)), ('Koloss von Rhodos', 'Antike Weltwunder', (28.227, 36.451)),
    ('Pharos von Alexandria', 'Antike Weltwunder', (29.885, 31.214)),
]
BUILDINGS = ['Eiffelturm', 'Burj Khalifa', 'Freiheitsstatue', 'Big Ben', 'Brandenburger Tor', 'Kölner Dom', 'Schloss Neuschwanstein',
             'Sydney Opera House', 'Golden Gate Bridge', 'Empire State Building', 'Tower Bridge', 'Schiefer Turm von Pisa', 'Sagrada Família',
             'Akropolis (Athen)', 'Petersdom', 'Moskauer Kreml', 'Basilius-Kathedrale', 'Verbotene Stadt', 'Tokyo Skytree', 'CN Tower',
             'Angkor Wat', 'Hagia Sophia', 'Alhambra', 'Stonehenge', 'Mont-Saint-Michel', 'Atomium', 'Taipei 101', 'Petronas Towers',
             'Shanghai Tower', 'Sphinx von Gizeh', 'Abu Simbel', 'Burj al Arab', 'Space Needle', 'Gateway Arch', 'Mount Rushmore National Memorial',
             'Louvre', 'Schloss Versailles', 'Buckingham Palace', 'Elbphilharmonie', 'Berliner Fernsehturm', 'Reichstagsgebäude', 'Frauenkirche (Dresden)',
             'Wiener Riesenrad', 'Schloss Schönbrunn', 'Markusdom', 'Kathedrale Notre-Dame de Paris', 'Arc de Triomphe de l’Étoile', 'Prager Burg',
             'Kapellbrücke', 'Fernsehturm Ostankino', 'Moai', 'Borobudur', 'Potala-Palast', 'Großer Buddha von Leshan',
             'Itsukushima-Schrein', 'Lotustempel', 'Shwedagon-Pagode', 'Opernhaus von Oslo', 'Øresundbrücke', 'Millau-Viadukt', 'Hoover Dam',
             'Drei-Schluchten-Damm', 'Kingdom Centre', 'Merdeka 118', 'Lakhta-Zentrum', 'One World Trade Center', 'Lincoln Memorial', 'Weißes Haus',
             'Kapitol (Washington)', 'Hollywood Sign', 'Chrysler Building', 'Palacio de Bellas Artes', 'Teotihuacán']
WATERFALLS = ['Salto Ángel', 'Niagarafälle', 'Victoriafälle', 'Iguaçu-Wasserfälle', 'Rheinfall', 'Krimmler Wasserfälle', 'Triberger Wasserfälle',
              'Yosemite Falls', 'Kaieteurfall', 'Tugela-Fälle', 'Dettifoss', 'Gullfoss', 'Seljalandsfoss', 'Skógafoss', 'Sutherland Falls',
              'Gocta-Wasserfall', 'Jog Falls', 'Ban-Gioc-Wasserfall', 'Huangguoshu-Wasserfall', 'Vinnufossen', 'Röthbachfall', 'Staubbachfall',
              'Kjelfossen', 'Multnomah Falls', 'Havasu Falls', 'Ruacana-Fälle', 'Murchison Falls', 'Langfoss']
SUMMITS = ['Mount Everest', 'Aconcagua', 'Denali', 'Kilimandscharo', 'Elbrus', 'Mount Vinson', 'Puncak Jaya', 'Mount Kosciuszko', 'Mont Blanc']
CANALS = ['Suezkanal', 'Panamakanal', 'Nord-Ostsee-Kanal', 'Kanal von Korinth', 'Main-Donau-Kanal', 'Mittellandkanal', 'Wolga-Don-Kanal',
          'Kaiserkanal', 'Göta-Kanal', 'Eriekanal', 'Weißmeer-Ostsee-Kanal', 'Canal du Midi', 'Dortmund-Ems-Kanal']
EXTREMES = [  # Name, Länge, Breite, Beschreibung, Wikipedia
    ('Nordpol', 0.0, 90.0, 'Nördlichster Punkt der Erde', 'Nordpol'),
    ('Südpol', 0.0, -90.0, 'Südlichster Punkt der Erde (Amundsen-Scott-Station)', 'Südpol'),
    ('Point Nemo', -123.393, -48.877, 'Ozeanischer Pol der Unzugänglichkeit – der Ort im Meer, der am weitesten von jedem Land entfernt ist (2.688 km)', 'Pol_der_Unzugänglichkeit'),
    ('Kap Morris Jesup', -33.37, 83.66, 'Nördlichster Punkt des Festlands (Grönland)', 'Kap_Morris_Jesup'),
    ('Kap Tscheljuskin', 104.25, 77.72, 'Nördlichster Punkt des eurasischen Festlands', 'Kap_Tscheljuskin'),
    ('Kap Hoorn', -67.27, -55.98, 'Südspitze Südamerikas', 'Kap_Hoorn'),
    ('Ellenbogen (Sylt)', 8.4136, 55.0583, 'Nördlichster Punkt Deutschlands', 'Ellenbogen_(Sylt)'),
    ('Haldenwanger Eck', 10.1785, 47.2703, 'Südlichster Punkt Deutschlands', 'Haldenwanger_Eck'),
    ('Isenbruch', 5.8661, 51.0517, 'Westlichster Punkt Deutschlands', 'Isenbruch'),
    ('Neißeaue bei Zentendorf', 15.0419, 51.2725, 'Östlichster Punkt Deutschlands', 'Zentendorf'),
    ('Niederdorla', 10.4475, 51.1633, 'Geografischer Mittelpunkt Deutschlands', 'Mittelpunkt_Deutschlands'),
    ('Mittelpunkt Europas (Purnuškės)', 25.3194, 54.9006, 'Mittelpunkt Europas nach Berechnung des französischen Instituts IGN (1989)', 'Mittelpunkt_Europas'),
    ('Mittelpunkt der EU (Gadheim)', 9.9003, 49.8436, 'Geografischer Mittelpunkt der Europäischen Union seit 2020', 'Gadheim'),
    ('Mount Everest (höchster Punkt)', 86.925, 27.988, 'Höchster Punkt der Erde, 8.849 m', 'Mount_Everest'),
    ('Totes Meer (tiefster Landpunkt)', 35.48, 31.52, 'Tiefster Punkt an Land, etwa 430 m unter dem Meeresspiegel', 'Totes_Meer'),
    ('Chimborazo', -78.817, -1.469, 'Der Punkt der Erdoberfläche, der am weitesten vom Erdmittelpunkt entfernt ist', 'Chimborazo'),
]
# Rückfall für Einträge, deren deutscher Wikipedia-Titel anders lautet: Name, Länge, Breite, Höhe (m), Wikipedia
MANUAL_BUILDINGS = [
    ('Basilius-Kathedrale', 37.6231, 55.7525, 65, 'Basilius-Kathedrale'), ('Große Sphinx von Gizeh', 31.1376, 29.9753, 20, 'Sphinx_von_Gizeh'),
    ('Shwedagon-Pagode', 96.1497, 16.7983, 99, 'Shwedagon-Pagode'), ('Opernhaus Oslo', 10.7531, 59.9075, 0, 'Opernhaus_Oslo'),
    ('Øresundbrücke', 12.8203, 55.5753, 204, 'Øresundbrücke'), ('Viaduc de Millau', 3.0222, 44.0775, 343, 'Viaduc_de_Millau'),
    ('Drei-Schluchten-Talsperre', 111.0031, 30.8231, 181, 'Drei-Schluchten-Talsperre'), ('Lachta-Zentrum', 30.1776, 59.9871, 462, 'Lachta-Zentrum'),
    ('Kapitol (Washington)', -77.0091, 38.8899, 88, 'Kapitol_der_Vereinigten_Staaten'),
]
MANUAL_WATERFALLS = [
    ('Iguazú-Wasserfälle', -54.4367, -25.6953, 82, 'Iguazú-Wasserfälle'), ('Kaieteur-Fall', -59.48, 5.175, 226, 'en:Kaieteur Falls'),
    ('Tugela-Fälle', 28.8944, -28.7522, 948, 'en:Tugela Falls'), ('Gocta-Wasserfall', -77.8875, -6.0244, 771, 'en:Gocta Cataracts'),
    ('Jog Falls', 74.8125, 14.2294, 253, 'en:Jog Falls'), ('Ban-Gioc-Wasserfall', 106.722, 22.855, 30, 'en:Ban Gioc–Detian Falls'),
    ('Vinnufossen', 8.75, 62.63, 860, 'en:Vinnufossen'), ('Ruacana-Fälle', 14.2181, -17.3983, 120, 'en:Ruacana Falls'),
    ('Langfoss', 6.1928, 59.8475, 612, 'en:Langfossen'),
]
GERMAN_ISLANDS = ['Rügen', 'Usedom', 'Fehmarn', 'Sylt', 'Föhr', 'Pellworm', 'Borkum']

VOLCANO_TYPE = {'Stratovolcano': 'Schichtvulkan', 'Stratovolcano(es)': 'Schichtvulkan', 'Shield': 'Schildvulkan', 'Shield(s)': 'Schildvulkan',
                'Caldera': 'Caldera', 'Caldera(s)': 'Caldera', 'Volcanic field': 'Vulkanfeld', 'Submarine': 'Unterseevulkan',
                'Lava dome': 'Lavadom', 'Lava dome(s)': 'Lavadom', 'Complex': 'Vulkankomplex', 'Compound': 'Vulkankomplex',
                'Pyroclastic cone': 'Schlackenkegel', 'Pyroclastic cone(s)': 'Schlackenkegel', 'Fissure vent': 'Spaltenvulkan',
                'Fissure vent(s)': 'Spaltenvulkan', 'Maar(s)': 'Maar', 'Tuff cone(s)': 'Tuffkegel', 'Lava cone': 'Lavakegel',
                'Lava cone(s)': 'Lavakegel', 'Crater rows': 'Kraterreihe', 'Subglacial': 'Vulkan unter dem Eis', 'Pyroclastic shield': 'Schildvulkan',
                'Tuff ring(s)': 'Tuffring', 'Explosion crater(s)': 'Explosionskrater', 'Lava field': 'Lavafeld'}


def curated(titles, tag, keys=('height',)):
    tq = wd_by_titles(titles, tag)
    facts = wd_facts(tq.values(), tag)
    out = []
    for t in titles:
        q = tq.get(t)
        x = facts.get(q, {}) if q else {}
        if not x.get('coord'):
            continue
        out.append((t, x))
    return out


def build_places(names_de):
    places = {}
    # Weltwunder
    tq = wd_by_titles([t for t, _, _ in WONDERS], 'wonders')
    facts = wd_facts(tq.values(), 'wonders')
    places['wonders'] = []
    for t, group, (lon, lat) in WONDERS:
        x = facts.get(tq.get(t, ''), {})
        c = x.get('coord') or [lon, lat]
        places['wonders'].append([x.get('de') or t.split(' (')[0], c[0], c[1], group, x.get('wiki') or t])
    places['buildings'] = [[x.get('de') or t, *x['coord'], round(x.get('height', 0)), x.get('wiki') or t]
                           for t, x in curated(BUILDINGS, 'buildings')]
    places['buildings'] += [list(m) for m in MANUAL_BUILDINGS]
    seen = set()
    places['buildings'] = [b for b in places['buildings'] if not (b[0] in seen or seen.add(b[0]))]
    places['waterfalls'] = [[x.get('de') or t, *x['coord'], round(x.get('height', 0)), x.get('wiki') or t]
                            for t, x in curated(WATERFALLS, 'waterfalls')]
    places['waterfalls'] += [list(m) for m in MANUAL_WATERFALLS]
    seen = set()
    places['waterfalls'] = [b for b in places['waterfalls'] if not (b[0] in seen or seen.add(b[0]))]
    places['summits'] = [[x.get('de') or t, *x['coord'], round(x.get('elev', 0)), x.get('wiki') or t] for t, x in curated(SUMMITS, 'summits')]
    places['canals'] = [[x.get('de') or t, *x['coord'], km(x.get('length')), x.get('wiki') or t] for t, x in curated(CANALS, 'canals')]
    places['extremes'] = [list(e) for e in EXTREMES]

    # UNESCO-Welterbe
    def unesco():
        rows = sparql('SELECT ?x ?id ?coord ?l ?le ?a ?b ?cl WHERE { ?x wdt:P1435 wd:Q9259 ; wdt:P757 ?id ; wdt:P625 ?coord . '
                      'OPTIONAL { ?x rdfs:label ?l FILTER(lang(?l) = "de") } OPTIONAL { ?x rdfs:label ?le FILTER(lang(?le) = "en") } '
                      'OPTIONAL { ?a schema:about ?x; schema:isPartOf <https://de.wikipedia.org/> } '
                      'OPTIONAL { ?b schema:about ?x; schema:isPartOf <https://en.wikipedia.org/> } '
                      'OPTIONAL { ?x wdt:P17 ?c . ?c rdfs:label ?cl FILTER(lang(?cl) = "de") } }')
        res = {}
        for r in rows:
            sid = r['id']['value']
            if not sid.replace('bis', '').replace('ter', '').isdigit():
                continue  # Teilstücke („123-001“)
            q = r['x']['value'].rsplit('/', 1)[1]
            if q in res:
                continue
            try:
                lon, lat = map(float, r['coord']['value'][6:-1].split())
            except ValueError:
                continue
            name = (r.get('l') or r.get('le') or {}).get('value')
            if not name:
                continue
            wiki = title(r['a']['value']) if 'a' in r else ('en:' + title(r['b']['value']) if 'b' in r else '')
            res[q] = [name, round(lon, 4), round(lat, 4), (r.get('cl') or {}).get('value', ''), wiki]
        return list(res.values())
    places['unesco'] = cached('unesco', unesco)

    # Nationalparks (bekannte: viele Wikipedia-Sprachen)
    def parks():
        rows = sparql('SELECT ?x ?coord ?l ?le ?a ?b ?links ?area WHERE { ?x wdt:P31 wd:Q46169 ; wdt:P625 ?coord ; wikibase:sitelinks ?links . '
                      'FILTER(?links >= 12) OPTIONAL { ?x rdfs:label ?l FILTER(lang(?l) = "de") } OPTIONAL { ?x rdfs:label ?le FILTER(lang(?le) = "en") } '
                      'OPTIONAL { ?a schema:about ?x; schema:isPartOf <https://de.wikipedia.org/> } '
                      'OPTIONAL { ?b schema:about ?x; schema:isPartOf <https://en.wikipedia.org/> } '
                      'OPTIONAL { ?x p:P2046/psn:P2046/wikibase:quantityAmount ?area } }')
        res = {}
        for r in rows:
            q = r['x']['value'].rsplit('/', 1)[1]
            if q in res:
                continue
            try:
                lon, lat = map(float, r['coord']['value'][6:-1].split())
            except ValueError:
                continue
            name = (r.get('l') or r.get('le') or {}).get('value')
            if not name:
                continue
            wiki = title(r['a']['value']) if 'a' in r else ('en:' + title(r['b']['value']) if 'b' in r else '')
            res[q] = [name, round(lon, 4), round(lat, 4), km2(float(r['area']['value'])) if 'area' in r else 0, wiki, int(r['links']['value'])]
        return list(res.values())
    places['parks'] = cached('parks', parks)

    # Landschaften aus Natural Earth: Wüsten, Gebirge, Inseln, Halbinseln; Kaps als Punkte
    regions = load('regions')
    facts = wd_facts([prop(f['properties'], 'wikidataid') for f in regions], 'regions')

    def region(f):
        p = f['properties']
        q = prop(p, 'wikidataid') or ''
        x = facts.get(q, {})
        return [prop(p, 'name_de') or prop(p, 'name'), *label_point(f['geometry']), float(prop(p, 'min_label') or 5), x.get('wiki', ''), km2(x.get('area'))]
    places['deserts'] = [region(f) for f in regions if prop(f['properties'], 'featurecla') == 'Desert']
    places['ranges'] = [region(f) for f in regions if prop(f['properties'], 'featurecla') == 'Range/mtn' and (prop(f['properties'], 'scalerank') or 9) <= 6]
    # Labrador ist in Natural Earth als Insel eingetragen, ist aber eine Halbinsel
    islands = [region(f) for f in regions if prop(f['properties'], 'featurecla') == 'Island' and prop(f['properties'], 'name') != 'Labrador']
    islands += [[x.get('de') or t, *x['coord'], 0, x.get('wiki') or t, km2(x.get('area'))] for t, x in curated(GERMAN_ISLANDS, 'islands_de', ('area',))]
    seen = set()
    islands = [i for i in sorted(islands, key=lambda i: -i[5]) if i[5] and not (i[0] in seen or seen.add(i[0]))]
    places['islands'] = [[i[0], i[1], i[2], i[5], i[4]] for i in islands[:60]] + [[i[0], i[1], i[2], i[5], i[4]] for i in islands[60:] if i[0] in GERMAN_ISLANDS]
    pens = [region(f) for f in regions if prop(f['properties'], 'featurecla') in ('Peninsula', 'Pen/cape')]
    places['peninsulas'] = [[i[0], i[1], i[2], i[5], i[4]] for i in sorted(pens, key=lambda i: -i[5]) if i[5]][:40]
    pts = load('regionpts')
    pfacts = wd_facts([prop(f['properties'], 'wikidataid') for f in pts], 'regionpts')
    capes = []
    for f in pts:
        p = f['properties']
        if prop(p, 'featurecla') != 'cape':
            continue
        x = pfacts.get(prop(p, 'wikidataid') or '', {})
        lon, lat = f['geometry']['coordinates']
        capes.append([prop(p, 'name_de') or prop(p, 'name'), round(lon, 3), round(lat, 3), int(prop(p, 'scalerank') or 9), x.get('wiki', '')])
    places['capes'] = sorted(capes, key=lambda c: c[3])

    # Vulkane
    vol = []
    for f in json.load(open(fetch('volcanoes'), encoding='utf-8'))['features']:
        p = f['properties']
        last = p.get('Last_Eruption_Year')
        vol.append([p['Volcano_Name'], round(p['Longitude'], 3), round(p['Latitude'], 3), VOLCANO_TYPE.get(p.get('Primary_Volcano_Type') or '', p.get('Primary_Volcano_Type') or ''),
                    int(p.get('Elevation') or 0), last if isinstance(last, int) else None, names_de.get(p.get('Country') or '', p.get('Country') or ''),
                    p.get('Volcano_Number')])
    places['volcanoes'] = vol

    # Flughäfen (groß, Linienverkehr, mit IATA-Code)
    air = []
    with open(fetch('airports'), encoding='utf-8') as fh:
        for r in csv.DictReader(fh):
            if r['type'] == 'large_airport' and r['scheduled_service'] == 'yes' and r['iata_code']:
                wiki = r['wikipedia_link'] or ''
                if '/wiki/' in wiki:
                    lang = wiki.split('//')[1].split('.')[0]
                    wiki = ('' if lang == 'de' else f'{lang}:') + title(wiki)
                air.append([r['name'], round(float(r['longitude_deg']), 4), round(float(r['latitude_deg']), 4), r['iata_code'], r['municipality'], r['iso_country'], wiki])
    places['airports'] = air
    # Häfen (die wichtigsten aus Natural Earth)
    places['ports'] = [[f['properties']['name'], round(f['geometry']['coordinates'][0], 3), round(f['geometry']['coordinates'][1], 3), int(f['properties']['scalerank'])]
                       for f in load('ports') if f['properties']['scalerank'] <= 5]
    # Äquator, Wendekreise, Polarkreise, Datumsgrenze
    geolines = []
    for f in load('geolines'):
        p = f['properties']
        for c in lines_of(f['geometry']):
            geolines.append({'n': p.get('name_de') or p['name'], 'k': p['featurecla'], 'p': [[round(x, 3), round(y, 3)] for x, y in c]})
    places['geolines'] = geolines
    print('Orte:', {k: len(v) for k, v in places.items()}, file=sys.stderr)
    return places


# ── Flaggen ───────────────────────────────────────────────────────────────

def build_flags(iso2s):
    pkg = os.path.join(CACHE, 'flag-icons.tgz')
    if not os.path.exists(pkg):
        meta = json.load(urllib.request.urlopen(urllib.request.Request('https://registry.npmjs.org/flag-icons/latest', headers=UA)))
        with urllib.request.urlopen(meta['dist']['tarball']) as r, open(pkg, 'wb') as f:
            f.write(r.read())
    dst = os.path.join(ROOT, 'public', 'flags')
    os.makedirs(dst, exist_ok=True)
    n = 0
    with tarfile.open(pkg) as tar:
        for m in tar.getmembers():
            if m.name.startswith('package/flags/4x3/') and m.name.endswith('.svg'):
                code = os.path.basename(m.name)[:-4]
                if code.upper() in iso2s:
                    with tar.extractfile(m) as src, open(os.path.join(dst, code + '.svg'), 'wb') as out:
                        shutil.copyfileobj(src, out)
                    n += 1
        lic = next((m for m in tar.getmembers() if m.name == 'package/LICENSE'), None)
        if lic:
            with tar.extractfile(lic) as src, open(os.path.join(dst, 'LICENSE.txt'), 'wb') as out:
                shutil.copyfileobj(src, out)
    print(f'Flaggen: {n}', file=sys.stderr)


def main():
    global CACHE
    ap = argparse.ArgumentParser()
    ap.add_argument('--cache', default=os.path.join(ROOT, '.cache', 'political'))
    a = ap.parse_args()
    CACHE = a.cache
    os.makedirs(CACHE, exist_ok=True)
    os.makedirs(os.path.join(OUT, 'history'), exist_ok=True)

    countries = load('countries')
    names_de = {}
    for f in countries:
        p = f['properties']
        for k in ('NAME', 'NAME_EN', 'ADMIN', 'NAME_LONG', 'SOVEREIGNT'):
            if p.get(k):
                names_de.setdefault(p[k], p['NAME_DE'] or p['NAME'])
    iso2s = {f['properties']['ISO_A2_EH'] for f in countries}

    def dump(name, data):
        json.dump(data, open(os.path.join(OUT, name), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))

    dump('water.json', build_water())
    dump('admin1.json', build_admin1())
    dump('disputed.json', build_disputed(names_de))
    dump('places.json', build_places(names_de))
    for y in HIST_YEARS:
        dump(f'history/{y}.json', build_history(y))
    build_flags(iso2s)
    for f in sorted(glob.glob(os.path.join(OUT, '**', '*.json'), recursive=True)):
        print(f'{os.path.relpath(f, OUT)}: {os.path.getsize(f) // 1024} KB', file=sys.stderr)


if __name__ == '__main__':
    main()
