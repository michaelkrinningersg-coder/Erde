#!/usr/bin/env python3
"""Baut die Daten für die politische Ansicht.

Quellen (werden heruntergeladen):
  - Natural Earth 1:10 Mio. Länder, Seen und Orte (Hauptstädte)  – Public Domain
  - GeoNames cities1000 (alle Orte ab 1.000 Einwohnern) + countryInfo  – CC BY 4.0
  - Wikidata (deutscher Name + Link zur deutschen Wikipedia, für Städte ab 50.000) – CC0

Ausgabe:
  public/data/political/countries.json  Länderflächen (vereinfacht), Farben, Beschriftungspunkte, Seen
  public/data/political/cities.json     Städte ab 10.000 Einwohnern (Deutschland ab 5.000) mit Rängen (Land, Kontinent, Welt)
  data/staedte.csv                      Datenbank: alle Orte ab 5.000 Einwohnern weltweit mit Rängen

Aufruf:  python3 scripts/build_political.py [--cache VERZEICHNIS] [--no-wikidata]
"""
import argparse
import csv
import io
import json
import os
import sys
import time
import urllib.parse
import urllib.request
import zipfile
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/'
SOURCES = {
    'countries': NE + 'ne_10m_admin_0_countries.geojson',
    'lakes': NE + 'ne_10m_lakes.geojson',
    'places': NE + 'ne_10m_populated_places.geojson',
    'cities': 'https://download.geonames.org/export/dump/cities1000.zip',
    'countryinfo': 'https://download.geonames.org/export/dump/countryInfo.txt',
}
UA = {'User-Agent': 'Erde-Kinderprojekt/1.0 (privat, github.com/michaelkrinningersg-coder/Erde)'}

APP_MIN_POP = 10_000  # Städte in der App …
APP_MIN_POP_LOCAL = {'DE': 5_000}  # … in Deutschland noch kleinere
CSV_MIN_POP = 5_000  # Datenbank-Datei
WIKI_MIN_POP = 50_000  # Wikidata-Abgleich (deutscher Name, Wikipedia-Link)
# Ortsteile, Ruinen, verlassene Orte usw. sind keine eigenen Städte
SKIP_FCODES = {'PPLX', 'PPLH', 'PPLQ', 'PPLW', 'PPLCH'}

CONTINENTS = {'EU': 'Europa', 'AS': 'Asien', 'AF': 'Afrika', 'NA': 'Nordamerika', 'SA': 'Südamerika', 'OC': 'Ozeanien', 'AN': 'Antarktis'}

# Natural Earth führt einige „alternative Hauptstädte“, die nur historisch oder umstritten sind
SKIP_CAPITALS = {'Kyoto', 'Baguio', 'Lagos', 'Quezon City', 'Tel Aviv', 'Bir Lehlou', 'Laayoune'}
# Länder mit mehreren Sitzen: genaue Rolle (Schlüssel = Natural-Earth-Name)
CAPITAL_ROLES = {
    'Amsterdam': 'Hauptstadt',
    'The Hague': 'Regierungssitz',
    'Sucre': 'Hauptstadt (Verfassung)',
    'La Paz': 'Regierungssitz',
    'Pretoria': 'Regierungssitz',
    'Cape Town': 'Parlamentssitz',
    'Bloemfontein': 'Sitz des Obersten Gerichts',
    'Yamoussoukro': 'Hauptstadt',
    'Abidjan': 'Regierungssitz',
    'Kuala Lumpur': 'Hauptstadt',
    'Putrajaya': 'Regierungssitz',
    'Sri Jayawardenepura Kotte': 'Hauptstadt (Parlament)',
    'Colombo': 'Regierungssitz',
    'Dodoma': 'Hauptstadt',
    'Dar es Salaam': 'Regierungssitz',
    'Porto-Novo': 'Hauptstadt',
    'Cotonou': 'Regierungssitz',
    'Santiago': 'Hauptstadt',
    'Valparaíso': 'Parlamentssitz',
    'Lobamba': 'Königssitz und Parlament',
    'Mbabane': 'Regierungssitz',
    'Bern': 'Bundesstadt',
    'Hargeisa': 'Hauptstadt von Somaliland (nicht anerkannt)',
}


def fetch(name, cache):
    path = os.path.join(cache, os.path.basename(SOURCES[name]))
    if not os.path.exists(path):
        print('lade', SOURCES[name], file=sys.stderr)
        with urllib.request.urlopen(urllib.request.Request(SOURCES[name], headers=UA), timeout=120) as r, open(path, 'wb') as f:
            f.write(r.read())
    return path


# ── Länder ────────────────────────────────────────────────────────────────

Q = 2000  # Koordinaten in 1/2000 Grad (≈ 50 m) speichern
FINE_TOL = 0.0012  # Vereinfachung der genauen Grenzen (Grad, ≈ 130 m) – für nahes Heranzoomen
COARSE_TOL = 0.04  # grobe Grenzen (≈ 4 km) – für den Blick auf die ganze Erde


def quantize_ring(ring):
    out = []
    for lon, lat in ring:
        p = (round(lon * Q), round(lat * Q))
        if not out or out[-1] != p:
            out.append(p)
    if len(out) > 1 and out[0] == out[-1]:
        out.pop()
    return out if len(out) >= 3 else None


def polygons(geom):
    polys = geom['coordinates'] if geom['type'] == 'MultiPolygon' else [geom['coordinates']]
    res = []
    for poly in polys:
        rings = [r for r in (quantize_ring(r) for r in poly) if r]
        if rings:
            res.append(rings)
    return res


def simplify(ring, tol):
    """Douglas-Peucker für einen geschlossenen Ring (quantisierte Punkte)."""
    t = tol * Q
    n = len(ring)
    if n < 4:
        return ring
    # Ring am entferntesten Punkt vom Start teilen
    x0, y0 = ring[0]
    far = max(range(n), key=lambda i: (ring[i][0] - x0) ** 2 + (ring[i][1] - y0) ** 2)
    keep = [False] * (n + 1)
    keep[0] = keep[far] = keep[n] = True
    pts = ring + [ring[0]]
    stack = [(0, far), (far, n)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        (ax, ay), (bx, by) = pts[i], pts[j]
        dx, dy = bx - ax, by - ay
        L = (dx * dx + dy * dy) ** 0.5
        best, bi = -1.0, -1
        for k in range(i + 1, j):
            px, py = pts[k]
            d = abs(dy * (px - ax) - dx * (py - ay)) / L if L else ((px - ax) ** 2 + (py - ay) ** 2) ** 0.5
            if d > best:
                best, bi = d, k
        if best > t:
            keep[bi] = True
            stack += [(i, bi), (bi, j)]
    out = [pts[k] for k in range(n) if keep[k]]
    return out if len(out) >= 3 else None


def encode(polys, tol, min_size=0):
    """Polygone vereinfachen und als Differenzen speichern: [x0, y0, dx1, dy1, …] je Ring."""
    res = []
    for poly in polys:
        outer = poly[0]
        xs = [p[0] for p in outer]
        ys = [p[1] for p in outer]
        if max(xs) - min(xs) < min_size * Q and max(ys) - min(ys) < min_size * Q:
            continue  # Inselchen, die in dieser Stufe unsichtbar wären
        rings = []
        for ring in poly:
            r = simplify(ring, tol)
            if not r:
                continue
            flat = [r[0][0], r[0][1]]
            for (ax, ay), (bx, by) in zip(r, r[1:]):
                flat += [bx - ax, by - ay]
            rings.append(flat)
        if rings:
            res.append(rings)
    return res


def neighbours(feats):
    """Nachbarländer: gemeinsame Grenzpunkte (Natural Earth nutzt an Grenzen identische Stützpunkte)."""
    owner = defaultdict(set)
    for i, f in enumerate(feats):
        for poly in f['polys']:
            for ring in poly:
                for p in ring:
                    owner[p].add(i)
    nb = defaultdict(set)
    for s in owner.values():
        if len(s) > 1:
            for a in s:
                nb[a] |= s - {a}
    return nb


def color_countries(feats):
    """Farbe aus MAPCOLOR9 (für Nachbarschaft entworfen), Konflikte gierig auflösen."""
    nb = neighbours(feats)
    colors = [f['mapcolor'] - 1 for f in feats]
    fixed = 0
    for i in sorted(range(len(feats)), key=lambda i: -len(nb[i])):
        used = {colors[j] for j in nb[i]}
        if colors[i] in used:
            free = [c for c in range(9) if c not in used]
            if free:
                colors[i] = free[0]
                fixed += 1
    clash = sum(1 for i in range(len(feats)) for j in nb[i] if colors[i] == colors[j]) // 2
    print(f'Länder: {len(feats)}, Nachbarpaare: {sum(len(v) for v in nb.values()) // 2}, umgefärbt: {fixed}, gleiche Farbe: {clash}', file=sys.stderr)
    return colors


def dp_open(pts, tol):
    """Douglas-Peucker für eine offene Linie."""
    t = tol * Q
    n = len(pts)
    if n < 3:
        return pts
    keep = [False] * n
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        (ax, ay), (bx, by) = pts[i], pts[j]
        dx, dy = bx - ax, by - ay
        L = (dx * dx + dy * dy) ** 0.5
        best, bi = -1.0, -1
        for k in range(i + 1, j):
            px, py = pts[k]
            d = abs(dy * (px - ax) - dx * (py - ay)) / L if L else ((px - ax) ** 2 + (py - ay) ** 2) ** 0.5
            if d > best:
                best, bi = d, k
        if best > t:
            keep[bi] = True
            stack += [(i, bi), (bi, j)]
    return [pts[k] for k in range(n) if keep[k]]


def border_lines(feats):
    """Landgrenzen (ohne Küsten): Kanten, die zu zwei verschiedenen Ländern gehören, zu Linien verkettet."""
    owner = defaultdict(set)
    for i, f in enumerate(feats):
        for poly in f['polys']:
            for ring in poly:
                for a, b in zip(ring, ring[1:] + ring[:1]):
                    owner[(a, b) if a < b else (b, a)].add(i)
    adj = defaultdict(list)
    for (a, b), who in owner.items():
        if len(who) > 1:
            adj[a].append(b)
            adj[b].append(a)
    used = set()
    lines = []

    def walk(start, nxt):
        line = [start]
        prev, cur = start, nxt
        while True:
            used.add((prev, cur) if prev < cur else (cur, prev))
            line.append(cur)
            if len(adj[cur]) != 2:
                break
            n2 = adj[cur][0] if adj[cur][1] == prev else adj[cur][1]
            if ((cur, n2) if cur < n2 else (n2, cur)) in used:
                break
            prev, cur = cur, n2
        return line

    # zuerst an Enden/Kreuzungen beginnen, danach geschlossene Ringe (z. B. Enklaven)
    for start in sorted(adj, key=lambda p: len(adj[p]) == 2):
        for nxt in adj[start]:
            if ((start, nxt) if start < nxt else (nxt, start)) not in used:
                lines.append(walk(start, nxt))
    return lines


def encode_lines(lines, tol):
    res = []
    for line in lines:
        r = dp_open(line, tol)
        flat = [r[0][0], r[0][1]]
        for (ax, ay), (bx, by) in zip(r, r[1:]):
            flat += [bx - ax, by - ay]
        res.append(flat)
    return res


def highest_points(feats, cache, use_wikidata):
    """Höchster Punkt je Land aus Wikidata (P610) mit Höhe (P2044) und Lage (P625)."""
    path = os.path.join(cache, 'wikidata_peaks.json')
    if os.path.exists(path):
        known = json.load(open(path, encoding='utf-8'))
    elif use_wikidata:
        ids = ' '.join(f"wd:{f['wikidata']}" for f in feats if f['wikidata'])
        q = ('SELECT ?c ?hp ?hpLabel ?coord ?elev ?a WHERE { VALUES ?c {' + ids + '} ?c wdt:P610 ?hp . '
             '?hp wdt:P625 ?coord . ?hp wdt:P2044 ?elev . '
             'OPTIONAL { ?a schema:about ?hp; schema:isPartOf <https://de.wikipedia.org/> } '
             'OPTIONAL { ?b schema:about ?hp; schema:isPartOf <https://en.wikipedia.org/> } '
             'SERVICE wikibase:label { bd:serviceParam wikibase:language "de,en". } }')
        rows = sparql(q)
        known = {}
        for row in rows:
            c = row['c']['value'].rsplit('/', 1)[1]
            lon, lat = map(float, row['coord']['value'][6:-1].split())
            elev = round(float(row['elev']['value']))
            name = row['hpLabel']['value']
            if re_qid(name):
                name = ''  # kein Name (nur Wikidata-Nummer)
            wiki = (urllib.parse.unquote(row['a']['value'].rsplit('/wiki/', 1)[1]) if 'a' in row
                    else 'en:' + urllib.parse.unquote(row['b']['value'].rsplit('/wiki/', 1)[1]) if 'b' in row else '')
            if c not in known or elev > known[c][3]:
                known[c] = [name, round(lon, 5), round(lat, 5), elev, wiki]
        json.dump(known, open(path, 'w', encoding='utf-8'), ensure_ascii=False)
    else:
        known = {}
    print(f'Höchste Punkte: {len(known)} Länder', file=sys.stderr)
    return known


CONTINENTS_NE = {'Europe': 'Europa', 'Asia': 'Asien', 'Africa': 'Afrika', 'North America': 'Nordamerika',
                 'South America': 'Südamerika', 'Oceania': 'Ozeanien', 'Antarctica': 'Antarktis',
                 'Seven seas (open ocean)': 'Ozeane'}


def country_facts(feats, cache, use_wikidata):
    """Steckbrief-Daten je Land aus Wikidata: Fläche, Amtssprachen, Währung, Vorwahl, Kfz-Kennzeichen,
    Fahrseite, tiefster Punkt (Name, Lage, Höhe, Wikipedia)."""
    path = os.path.join(cache, 'wikidata_countries.json')
    if os.path.exists(path):
        return json.load(open(path, encoding='utf-8'))
    if not use_wikidata:
        return {}
    ids = ' '.join(f"wd:{f['wikidata']}" for f in feats if f['wikidata'])
    facts = defaultdict(dict)
    qid = lambda v: v.rsplit('/', 1)[1]
    # Fläche (normiert in m²): bevorzugter Wert, sonst größter normaler
    areas = defaultdict(list)
    for r in sparql('SELECT ?c ?a ?r WHERE { VALUES ?c {' + ids + '} ?c p:P2046 ?st . ?st psn:P2046/wikibase:quantityAmount ?a ; wikibase:rank ?r }'):
        areas[qid(r['c']['value'])].append((r['r']['value'].endswith('PreferredRank'), float(r['a']['value'])))
    for c, vals in areas.items():
        pref = [a for p_, a in vals if p_]
        facts[c]['area'] = round((max(pref) if pref else max(a for _, a in vals)) / 1e6)
    for r in sparql('SELECT ?c ?tel ?kfz ?drive WHERE { VALUES ?c {' + ids + '} OPTIONAL { ?c wdt:P474 ?tel } OPTIONAL { ?c wdt:P395 ?kfz } OPTIONAL { ?c wdt:P1622 ?drive } }'):
        f = facts[qid(r['c']['value'])]
        if 'tel' in r:
            f.setdefault('tel', r['tel']['value'])
        if 'kfz' in r:
            f.setdefault('kfz', r['kfz']['value'])
        if 'drive' in r:
            f.setdefault('drive', 'rechts' if qid(r['drive']['value']) == 'Q14565199' else 'links')
    for prop, key in (('P37', 'lang'), ('P38', 'cur')):
        for r in sparql('SELECT ?c ?l WHERE { VALUES ?c {' + ids + '} ?c wdt:' + prop + ' ?x . ?x rdfs:label ?l FILTER(lang(?l) = "de") }'):
            lst = facts[qid(r['c']['value'])].setdefault(key, [])
            if r['l']['value'] not in lst:
                lst.append(r['l']['value'])
    q = ('SELECT ?c ?lo ?loLabel ?coord ?elev ?a ?b WHERE { VALUES ?c {' + ids + '} ?c wdt:P1589 ?lo . ?lo wdt:P625 ?coord . ?lo wdt:P2044 ?elev . '
         'FILTER NOT EXISTS { ?lo wdt:P31 ?t . VALUES ?t { wd:Q165 wd:Q9430 wd:Q1322134 wd:Q39594 wd:Q37901 wd:Q4022 wd:Q187223 } } '
         'OPTIONAL { ?a schema:about ?lo; schema:isPartOf <https://de.wikipedia.org/> } '
         'OPTIONAL { ?b schema:about ?lo; schema:isPartOf <https://en.wikipedia.org/> } '
         'SERVICE wikibase:label { bd:serviceParam wikibase:language "de,en". } }')
    for r in sparql(q):
        c = qid(r['c']['value'])
        try:
            lon, lat = map(float, r['coord']['value'][6:-1].split())
        except ValueError:
            continue
        elev = round(float(r['elev']['value']))
        name = '' if re_qid(r['loLabel']['value']) else r['loLabel']['value']
        wiki = (urllib.parse.unquote(r['a']['value'].rsplit('/wiki/', 1)[1]) if 'a' in r
                else 'en:' + urllib.parse.unquote(r['b']['value'].rsplit('/wiki/', 1)[1]) if 'b' in r else '')
        if 'lo' not in facts[c] or elev < facts[c]['lo'][3]:
            facts[c]['lo'] = [name, round(lon, 5), round(lat, 5), elev, wiki]
    json.dump(facts, open(path, 'w', encoding='utf-8'), ensure_ascii=False)
    print(f"Länder-Steckbriefe: {len(facts)}, tiefste Punkte: {sum(1 for f in facts.values() if 'lo' in f)}", file=sys.stderr)
    return facts


def main_languages(feats, cache, use_wikidata):
    """Hauptsprachen je Land aus GeoNames (Reihenfolge = Verbreitung), deutsche Namen über Wikidata (ISO 639-1)."""
    info = {}
    for line in open(fetch('countryinfo', cache), encoding='utf-8'):
        if line.startswith('#') or not line.strip():
            continue
        c = line.rstrip('\n').split('\t')
        info[c[0]] = [x.split('-')[0] for x in c[15].split(',') if x]
    path = os.path.join(cache, 'wikidata_languages.json')
    if os.path.exists(path):
        names = json.load(open(path, encoding='utf-8'))
    elif use_wikidata:
        names = {}
        for r in sparql('SELECT ?code ?l WHERE { ?x wdt:P218 ?code . ?x rdfs:label ?l FILTER(lang(?l) = "de") }'):
            names.setdefault(r['code']['value'], r['l']['value'])
        json.dump(names, open(path, 'w', encoding='utf-8'), ensure_ascii=False)
    else:
        names = {}
    res = {}
    for f in feats:
        langs = []
        for code in info.get(f['iso2'], []):
            n = names.get(code)
            if n and n not in langs:
                langs.append(n)
        res[f['iso2']] = langs[:3]
    return res


def re_qid(s):
    return len(s) > 1 and s[0] == 'Q' and s[1:].isdigit()


def build_countries(cache, use_wikidata=True):
    data = json.load(open(fetch('countries', cache), encoding='utf-8'))
    feats = []
    for f in data['features']:
        p = f['properties']
        feats.append({
            'name': p['NAME_DE'] or p['NAME'],
            'iso2': p['ISO_A2_EH'] if p['ISO_A2_EH'] != '-99' else '',
            'mapcolor': int(p['MAPCOLOR9']),
            'label': [round(p['LABEL_X'], 2), round(p['LABEL_Y'], 2)],
            'minLabel': p['MIN_LABEL'],
            'pop': int(p['POP_EST'] or 0),
            'wikidata': p['WIKIDATAID'] or '',
            'continent': CONTINENTS_NE.get(p['CONTINENT'], p['CONTINENT']),
            'polys': polygons(f['geometry']),
        })
    colors = color_countries(feats)
    nb = neighbours(feats)
    facts = country_facts(feats, cache, use_wikidata)
    langs = main_languages(feats, cache, use_wikidata)
    # Wikidata nennt für Neuendorf-Sachsenbande die Ortshöhe, nicht den tiefsten Punkt (−3,54 m)
    if 'Q183' in facts and facts['Q183'].get('lo', [''])[0] == 'Neuendorf-Sachsenbande':
        facts['Q183']['lo'][3] = -3.54
    for f in feats:
        x = facts.setdefault(f['wikidata'], {}) if f['wikidata'] else {}
        if langs.get(f['iso2']):
            x['lang'] = langs[f['iso2']]  # GeoNames: Hauptsprachen zuerst (Wikidata nennt teils nur Regionalsprachen)
    borders = border_lines(feats)
    peaks = highest_points(feats, cache, use_wikidata)
    print(f'Grenzlinien: {len(borders)}', file=sys.stderr)
    lakes = json.load(open(fetch('lakes', cache), encoding='utf-8'))
    lake_polys = []
    for f in lakes['features']:
        if f['properties'].get('scalerank', 9) <= 7:  # Seen ab mittlerer Größe
            lake_polys += polygons(f['geometry'])
    return {
        'scale': Q,
        'countries': [
            {'n': f['name'], 'i': f['iso2'], 'c': c, 'l': f['label'], 'z': f['minLabel'], 'e': f['pop'], 'q': f['wikidata'],
             'p': encode(f['polys'], FINE_TOL), 'g': encode(f['polys'], COARSE_TOL, 0.08), 'h': peaks.get(f['wikidata']),
             'k': f['continent'], 'x': facts.get(f['wikidata'], {}), 'nb': sorted(nb[i])}
            for i, (f, c) in enumerate(zip(feats, colors))
        ],
        'lakes': encode(lake_polys, FINE_TOL),
        'lakesCoarse': encode(lake_polys, COARSE_TOL, 0.3),
        'borders': encode_lines(borders, FINE_TOL),
        'bordersCoarse': encode_lines(borders, COARSE_TOL),
    }, {f['iso2']: f['name'] for f in feats if f['iso2']}


# ── Städte ────────────────────────────────────────────────────────────────

def wikidata(geonames_ids, cache):
    path = os.path.join(cache, 'wikidata_cities.json')
    known = json.load(open(path, encoding='utf-8')) if os.path.exists(path) else {}
    todo = [g for g in geonames_ids if g not in known]
    for k in range(0, len(todo), 400):
        batch = todo[k:k + 400]
        values = ' '.join(f'"{g}"' for g in batch)
        q = ('SELECT ?gn ?item ?l ?a WHERE { VALUES ?gn {' + values + '} ?item wdt:P1566 ?gn . '
             'OPTIONAL { ?item rdfs:label ?l FILTER(lang(?l) = "de") } '
             'OPTIONAL { ?a schema:about ?item; schema:isPartOf <https://de.wikipedia.org/> } }')
        req = urllib.request.Request('https://query.wikidata.org/sparql', data=urllib.parse.urlencode({'query': q, 'format': 'json'}).encode(), headers=UA)
        for attempt in range(4):
            try:
                with urllib.request.urlopen(req, timeout=120) as r:
                    rows = json.load(r)['results']['bindings']
                break
            except Exception as e:  # noqa: BLE001
                print('Wikidata-Fehler, neuer Versuch', e, file=sys.stderr)
                time.sleep(5 * (attempt + 1))
        else:
            rows = []
        for g in batch:
            known.setdefault(g, {})
        for row in rows:
            e = known[row['gn']['value']]
            e.setdefault('q', row['item']['value'].rsplit('/', 1)[1])
            if 'l' in row:
                e.setdefault('de', row['l']['value'])
            if 'a' in row:
                e.setdefault('wiki', urllib.parse.unquote(row['a']['value'].rsplit('/wiki/', 1)[1]))
        print(f'Wikidata {k + len(batch)}/{len(todo)}', file=sys.stderr)
        json.dump(known, open(path, 'w', encoding='utf-8'), ensure_ascii=False)
        time.sleep(1)
    # Ohne deutschen Artikel: englischen Artikel suchen (gespeichert als „en:Titel“)
    todo = [g for g in geonames_ids if known.get(g, {}).get('q') and not known[g].get('wiki') and not known[g].get('en_checked')]
    for k in range(0, len(todo), 400):
        batch = todo[k:k + 400]
        by_q = {known[g]['q']: g for g in batch}
        q = ('SELECT ?item ?a WHERE { VALUES ?item {' + ' '.join(f'wd:{x}' for x in by_q) + '} '
             '?a schema:about ?item; schema:isPartOf <https://en.wikipedia.org/> }')
        rows = sparql(q)
        for g in batch:
            known[g]['en_checked'] = True
        for row in rows:
            g = by_q.get(row['item']['value'].rsplit('/', 1)[1])
            if g:
                known[g]['wiki'] = 'en:' + urllib.parse.unquote(row['a']['value'].rsplit('/wiki/', 1)[1])
        print(f'Wikidata englisch {k + len(batch)}/{len(todo)}', file=sys.stderr)
        json.dump(known, open(path, 'w', encoding='utf-8'), ensure_ascii=False)
        time.sleep(1)
    return known


def sparql(q):
    req = urllib.request.Request('https://query.wikidata.org/sparql', data=urllib.parse.urlencode({'query': q, 'format': 'json'}).encode(), headers=UA)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                return json.load(r)['results']['bindings']
        except Exception as e:  # noqa: BLE001
            print('Wikidata-Fehler, neuer Versuch', e, file=sys.stderr)
            time.sleep(5 * (attempt + 1))
    return []


def wiki_url(title):
    if not title:
        return ''
    lang, t = ('en', title[3:]) if title.startswith('en:') else ('de', title)
    return f"https://{lang}.wikipedia.org/wiki/{t.replace(' ', '_')}"


def fix_populations(rows, ne_by_gn):
    """GeoNames zählt teils das ganze Verwaltungsgebiet (v. a. China: Stadt mit Umland, z. B. Chongqing 22 Mio.).
    - Liegt die Zahl deutlich über dem Ballungsraum laut UN-Prognose 2025 (Natural Earth), gilt der Ballungsraum.
    - Stadtbezirke in China (Pudong, Haidian …) und New York (Brooklyn …) zählen nicht als eigene Städte."""
    fixed = 0
    for c in rows:
        ne = ne_by_gn.get(c['gn'])
        un = int((ne or {}).get('POP2025') or 0) * 1000
        if un:
            c['agglo'] = un
            if c['pop'] > 1.5 * un:
                c['admin_pop'], c['pop'] = c['pop'], un
                fixed += 1
    parents = defaultdict(list)
    for c in rows:
        if c['cc'] == 'CN' and c['fcode'] in ('PPLA', 'PPLC', 'PPLA2') and c['a2']:
            parents[(c['a1'], c['a2'])].append(c)
    nyc = next((c for c in rows if c['gn'] == '5128581'), None)
    parts = 0
    for c in rows:
        if c['cc'] == 'CN' and c['fcode'] in ('PPLA3', 'PPLA4'):
            for p in parents.get((c['a1'], c['a2']), []):
                d2 = (p['lat'] - c['lat']) ** 2 + ((p['lon'] - c['lon']) * 0.85) ** 2
                if p['pop'] >= 1_000_000 and p['pop'] > c['pop'] and d2 < 0.27 ** 2:  # ≈ 30 km um eine Millionenstadt
                    c['part_of'] = p
                    parts += 1
                    break
        elif nyc and c['cc'] == 'US' and c['a1'] == 'NY' and c['name'] in ('Brooklyn', 'Queens', 'The Bronx', 'Manhattan', 'Staten Island'):
            c['part_of'] = nyc
            parts += 1
    print(f'Einwohner auf Ballungsraum korrigiert: {fixed}, Stadtbezirke: {parts}', file=sys.stderr)


def build_cities(cache, country_names, use_wikidata):
    # Länder → Kontinent und englischer Name als Rückfall
    info = {}
    for line in open(fetch('countryinfo', cache), encoding='utf-8'):
        if line.startswith('#') or not line.strip():
            continue
        c = line.rstrip('\n').split('\t')
        info[c[0]] = {'name': c[4], 'cont': c[8]}

    # Hauptstädte und deutsche Namen aus Natural Earth (über die GeoNames-Nummer)
    ne_by_gn, capitals = {}, []
    for f in json.load(open(fetch('places', cache), encoding='utf-8'))['features']:
        p = f['properties']
        gn = str(p['GEONAMESID'])
        ne_by_gn[gn] = p
        if (p['ADM0CAP'] == 1 or p['CAPALT'] == 1) and p['NAME'] not in SKIP_CAPITALS and p['FEATURECLA'].startswith('Admin-0'):
            capitals.append(p)

    with zipfile.ZipFile(fetch('cities', cache)) as z:
        text = z.read('cities1000.txt').decode('utf-8')
    rows = []
    for r in csv.reader(io.StringIO(text), delimiter='\t', quoting=csv.QUOTE_NONE):
        if r[7] in SKIP_FCODES:
            continue
        cc = r[8]
        rows.append({
            'gn': r[0], 'name': r[1], 'lat': float(r[4]), 'lon': float(r[5]), 'cc': cc,
            'pop': int(r[14] or 0), 'cont': info.get(cc, {}).get('cont', ''),
            'fcode': r[7], 'a1': r[10], 'a2': r[11], 'tz': r[17],
            # Höhe über dem Meer: gemessener Wert, sonst Geländemodell (SRTM/GTOPO30) am Ortspunkt
            'elev': int(r[15]) if r[15].lstrip('-').isdigit() else (int(r[16]) if r[16].lstrip('-').isdigit() and r[16] != '-9999' else None),
        })

    # Hauptstädte zuordnen: gleiche GeoNames-Nummer, sonst nächster Ort im selben Land
    by_gn = {c['gn']: c for c in rows}
    for p in capitals:
        city = by_gn.get(str(p['GEONAMESID']))
        if city and p['ISO_A2'] != '-99' and city['cc'] != p['ISO_A2']:
            city = None  # falsche Nummer in Natural Earth (z. B. Colombo in Brasilien statt Sri Lanka)
        if not city:
            best = None
            for c in rows:
                if c['cc'] != p['ISO_A2']:
                    continue
                d = (c['lat'] - p['LATITUDE']) ** 2 + (c['lon'] - p['LONGITUDE']) ** 2
                if d < 0.05 and (best is None or d < best[0]):
                    best = (d, c)
            city = best[1] if best else None
        # Nummer zeigt manchmal auf einen Stadtteil (z. B. Žižkov statt Prag): gleichnamigen größeren Ort in ≈ 20 km nehmen
        if city:
            near = [c for c in rows if c['cc'] == city['cc'] and (c['lat'] - p['LATITUDE']) ** 2 + (c['lon'] - p['LONGITUDE']) ** 2 < 0.04]
            biggest = max(near, key=lambda c: c['pop'], default=city)
            names = {str(p.get(k) or '').lower() for k in ('NAME', 'NAMEASCII', 'NAME_EN')} - {''}
            if biggest['pop'] > 2 * city['pop'] and biggest['name'].lower() in names and city['name'].lower() not in names:
                print(f"Hauptstadt {p['NAME']}: {city['name']} → {biggest['name']}", file=sys.stderr)
                city = biggest
        if not city:  # sehr kleine Hauptstadt (< 1.000 Einwohner): aus Natural Earth übernehmen
            iso = p['ISO_A2'] if p['ISO_A2'] != '-99' else ''
            city = {'gn': str(p['GEONAMESID']), 'name': p['NAME'], 'lat': p['LATITUDE'], 'lon': p['LONGITUDE'],
                    'cc': iso, 'pop': int(p['POP_MIN'] or 0), 'cont': info.get(iso, {}).get('cont', ''), 'small': True}
            rows.append(city)
            by_gn[city['gn']] = city
        city['cap'] = CAPITAL_ROLES.get(p['NAME'], 'Hauptstadt')
        city.setdefault('ne', p)

    fix_populations(rows, ne_by_gn)
    rows.sort(key=lambda c: -c['pop'])
    # Ränge unter allen Orten ab 1.000 Einwohnern (GeoNames)
    n_world, n_cont, n_country = 0, defaultdict(int), defaultdict(int)
    for c in rows:
        if c.get('small') or c.get('part_of'):
            continue
        n_world += 1
        n_cont[c['cont']] += 1
        n_country[c['cc']] += 1
        c['rw'], c['rk'], c['rc'] = n_world, n_cont[c['cont']], n_country[c['cc']]

    wiki = wikidata([c['gn'] for c in rows if c['pop'] >= WIKI_MIN_POP or c.get('cap')], cache) if use_wikidata else {}
    for c in rows:
        ne = c.get('ne') or ne_by_gn.get(c['gn'])
        w = wiki.get(c['gn'], {})
        c['de'] = w.get('de') or (ne and ne.get('NAME_DE')) or c['name']
        for prefix in ('Stadtgemeinde ', 'Stadt ', 'Gemeinde ', 'Kreisfreie Stadt '):
            if c['de'].startswith(prefix) and len(c['de']) > len(prefix) + 2:
                c['de'] = c['de'][len(prefix):]
        c['wiki'] = w.get('wiki', '')
        c['country'] = country_names.get(c['cc']) or info.get(c['cc'], {}).get('name', c['cc'])

    countries = sorted({c['cc'] for c in rows})
    timezones = []
    tz_pos = {}

    def tz_index(tz):
        if tz not in tz_pos:
            tz_pos[tz] = len(timezones)
            timezones.append(tz)
        return tz_pos[tz]

    app = {
        'source': 'GeoNames (CC BY 4.0), Natural Earth, Wikidata',
        'continents': CONTINENTS,
        'countries': {cc: [country_names.get(cc) or info.get(cc, {}).get('name', cc), info.get(cc, {}).get('cont', ''), n_country[cc]] for cc in countries},
        'continentCount': dict(n_cont),
        'worldCount': n_world,
        'timezones': timezones,
        # [Name, Land, Einwohner, Breite, Länge, Rang Land, Rang Kontinent, Rang Welt, Hauptstadt-Rolle, Wikipedia-Titel,
        #  Höhe (m), Ballungsraum (UN 2025, 0 = unbekannt), Verwaltungsgebiet (0 = nicht korrigiert),
        #  Zeitzone (Index in timezones), Hauptstadt eines Bundeslands/einer Provinz (1/0)]
        'cities': [
            [c['de'], c['cc'], c['pop'], round(c['lat'], 3), round(c['lon'], 3), c.get('rc', 0), c.get('rk', 0), c.get('rw', 0), c.get('cap', ''), c['wiki'],
             c['elev'], c.get('agglo', 0), c.get('admin_pop', 0), tz_index(c.get('tz', '')), 1 if c.get('fcode') == 'PPLA' else 0]
            for c in rows if (c['pop'] >= APP_MIN_POP_LOCAL.get(c['cc'], APP_MIN_POP) or c.get('cap')) and not c.get('part_of')
        ],
    }
    return app, rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cache', default=os.path.join(ROOT, '.cache', 'political'))
    ap.add_argument('--no-wikidata', action='store_true')
    a = ap.parse_args()
    os.makedirs(a.cache, exist_ok=True)

    countries, names = build_countries(a.cache, not a.no_wikidata)
    app, rows = build_cities(a.cache, names, not a.no_wikidata)

    out = os.path.join(ROOT, 'public', 'data', 'political')
    os.makedirs(out, exist_ok=True)
    json.dump(countries, open(os.path.join(out, 'countries.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    json.dump(app, open(os.path.join(out, 'cities.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))

    os.makedirs(os.path.join(ROOT, 'data'), exist_ok=True)
    with open(os.path.join(ROOT, 'data', 'staedte.csv'), 'w', encoding='utf-8', newline='') as f:
        w = csv.writer(f)
        w.writerow(['stadt', 'name_original', 'land_code', 'land', 'kontinent', 'einwohner', 'breite', 'laenge',
                    'rang_land', 'rang_kontinent', 'rang_welt', 'hauptstadt', 'wikipedia', 'geonames_id',
                    'hoehe_m', 'ballungsraum_un2025', 'einwohner_verwaltungsgebiet', 'stadtbezirk_von'])
        for c in rows:
            if c['pop'] < CSV_MIN_POP and not c.get('cap'):
                continue
            w.writerow([c['de'], c['name'], c['cc'], c['country'], CONTINENTS.get(c['cont'], ''), c['pop'], round(c['lat'], 5), round(c['lon'], 5),
                        c.get('rc', ''), c.get('rk', ''), c.get('rw', ''), c.get('cap', ''),
                        wiki_url(c['wiki']), c['gn'],
                        '' if c['elev'] is None else c['elev'], c.get('agglo') or '', c.get('admin_pop') or '',
                        c['part_of']['de'] if c.get('part_of') else ''])
    print(f"App-Städte: {len(app['cities'])}, Orte gesamt (Rangliste): {len(rows)}", file=sys.stderr)


if __name__ == '__main__':
    main()
