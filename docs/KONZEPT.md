# Erde – Konzept & Tech-Stack (Entwurf v0.1)

Stand: 2026-10-28 · Status: **Vorschlag, offene Punkte siehe Abschnitt 8**

## 1. Ziel in einem Satz

Interaktive 3D-Erde im Browser mit echten Wolkenbildern (inkl. Zeitachse zum
Zurückspulen), realem Tag/Nacht-Verlauf und Sonneneinstrahlung, echten Positionen
von Sonne, Mond, Planeten und Satelliten (ISS, Starlink, …) sowie startbaren
Szenarien (Flug FRA→JFK, später Raketenstart zur ISS).

## 2. Machbarkeit – kurze Antwort

**Ja, machbar.** Alle Kerndaten gibt es kostenlos. Die echten Grenzen setzen die
Daten, nicht die Technik:

| Wunsch | Realistisch erreichbar |
|---|---|
| Aktuelle Wolken | ca. 10–20 min alt (geostationäre Satelliten), 1–2 km Auflösung |
| Zurückspulen 1 Tag | Ja, in 10-min-Schritten |
| Zurückspulen länger | ~30 Tage in 10-min-Schritten (NASA GIBS), **Jahre** als Tagesmosaik (MODIS/VIIRS) |
| Wolken an den Polen | Nur eingeschränkt (geostationär sieht nichts oberhalb von ~70° Breite) |
| Reale Satellitenpositionen | Ja, Genauigkeit ~1 km (SGP4 + TLE/OMM), Starlink komplett (~10 000 Objekte) |
| Sonne/Mond/Planeten | Ja, Genauigkeit im Bogenminutenbereich |
| „Keine Aussetzer“ | Kostenlose Quellen haben **keine Garantie** → eigener Cache + Ausweichquellen nötig |

## 3. Tech-Stack-Empfehlung

### Empfehlung: **CesiumJS + TypeScript + Vite (Web-App)**

| Baustein | Wahl | Begründung |
|---|---|---|
| 3D-Globus | **CesiumJS** (Apache 2.0) | Echter WGS84-Globus, eingebaute Zeitachse/Uhr (`Clock`, `Timeline`), Sonnenbeleuchtung, Atmosphäre, Kachel-Streaming (WMTS/WMS), zeitabhängige Layer, `SampledPositionProperty` für Flugbahnen, gelöste Präzisionsprobleme (RTC-Rendering) bei Erdgröße |
| Sprache/Build | TypeScript + Vite | Schnell, typsicher, einfaches Deployment als statische Seite |
| UI | Leichtgewichtig (Svelte oder React) | Layer-Panel, Objektliste mit Ein/Aus, Zeitregler |
| Bahnberechnung Satelliten | **satellite.js** (SGP4) im **Web Worker** | Standard für TLE/OMM, 10 000 Objekte in einem Worker problemlos |
| Sonne/Mond/Planeten | **astronomy-engine** (MIT) | Präzise, klein, ohne Server; optional JPL Horizons für Sonderfälle (z. B. JWST) |
| Cache/Proxy (optional, empfohlen) | Kleine Cloudflare Worker / Node-Funktion | Kacheln zwischenspeichern, TLEs bündeln, Ausfälle abfedern, CORS |

### Warum nicht …?

- **Blender** – ist ein Modellierwerkzeug, keine Laufzeit-Engine. Gut, um später
  ein ISS- oder Raketenmodell zu bauen (Export als glTF), aber nicht für die App.
- **Godot** – sehr gute Spiele-Engine, aber kein Geo-Unterstützung: Globus-Kacheln,
  Koordinatensysteme, Kartenprojektionen, Zeitlayer, Präzision (32-bit-Floats bei
  6 371 km Radius → Zittern) müssten wir **alles selbst bauen**. Monate an Arbeit,
  die Cesium schon erledigt hat.
- **Unreal Engine + Cesium for Unreal** – fotorealistischer, aber schweres
  Desktop-Programm (GBs), hohe Hardwareanforderungen, langsamere Entwicklung. Sinnvoll
  nur, wenn Kino-Optik wichtiger ist als Reichweite. Später als Option denkbar.
- **Three.js (eigener Globus)** – maximale Kontrolle über Optik, aber Kachel-Streaming,
  Zeitachse und Geodäsie müssten selbst gebaut werden. Fallback, falls Cesium
  optisch nicht reicht (Wolken-Shader, Atmosphäre lassen sich in Cesium aber anpassen).

## 4. Datenquellen

> ⚠️ Lizenzen sind vor dem ersten öffentlichen Release nochmals einzeln zu prüfen
> (hängt davon ab, ob das Projekt privat, öffentlich oder kommerziell ist – siehe offene Punkte).

### 4.1 Erdoberfläche (Grundkarte)

| Quelle | Auflösung | Lizenz | Kommentar |
|---|---|---|---|
| NASA Blue Marble NG | 500 m, monatlich (Schnee/Vegetation) | Public Domain | Robuster Standard, selbst hostbar |
| NASA Black Marble | 500 m | Public Domain | Stadtlichter für die Nachtseite |
| Sentinel-2 cloudless (EOX) | 10 m | 2016: CC BY 4.0; neuere Jahre: CC BY-NC-SA | Schärfer beim Reinzoomen; Nutzungsbedingungen des Kachel-Dienstes prüfen |
| Cesium ion (Bing Aerial, World Terrain) | sehr hoch | Free-Tier, nur nicht-kommerziell / Kontingent | Bequem, aber Abhängigkeit + Account |

### 4.2 Wolken (Kernfeature)

Strategie: **Mosaik aus geostationären Satelliten** für „live“ + Zeitachse,
**polarumlaufende** Satelliten für Langzeit-Archiv und Pole.

| Quelle | Abdeckung | Intervall | Archiv | Lizenz |
|---|---|---|---|---|
| NASA GIBS – GOES-East (Amerika/Atlantik) | ~75° W | 10 min | rollierend ~30 Tage | frei, Quellenangabe |
| NASA GIBS – GOES-West (Pazifik) | ~137° W | 10 min | rollierend ~30 Tage | frei, Quellenangabe |
| NASA GIBS – Himawari (Asien/Australien) | ~140° O | 10 min | rollierend ~30 Tage | frei, Quellenangabe |
| EUMETSAT EUMETView – Meteosat 0° + IODC (Europa/Afrika/Indien) | 0° / 45.5° O | 15 min | Lizenz/Bedingungen prüfen | stündlich frei, volle Auflösung nach 3 h frei (laut Datenpolitik) |
| NASA GIBS – VIIRS/MODIS Corrected Reflectance | global, Tagesmosaik | 1×/Tag | Jahre | frei, Quellenangabe |

Wichtig: Für die **Nachtseite** braucht es **Infrarot-Kanäle** (Wolkentemperatur),
weil das sichtbare Bild nachts schwarz ist. Wir rechnen IR im Shader in eine
Wolkenmaske (Alpha) um und legen sie über die Erde – dann sieht man Wolken auch
nachts, und die Tag/Nacht-Beleuchtung macht der Shader.

### 4.3 Satelliten

| Quelle | Inhalt | Lizenz/Bedingungen |
|---|---|---|
| **CelesTrak GP** (OMM/JSON/TLE) | ISS, Starlink, GPS, Galileo, Wetter-Satelliten, Stationen, … | frei; max. ~1 Abruf pro Gruppe alle 2 h → über unseren Cache |
| Space-Track.org | historische TLEs (für weites Zurückspulen) | kostenloser Account nötig |
| JPL Horizons API | Objekte ohne TLE (z. B. JWST am L2, Raumsonden) | frei |

### 4.4 Himmelskörper

astronomy-engine lokal (keine Netzabfrage nötig). Sonne, Mond (inkl. Mondphase),
Merkur bis Neptun.

### 4.5 Flugzeug-Szenario

- Basis: **Großkreis** (`EllipsoidGeodesic`) mit realistischem Profil (Steigflug,
  Reiseflug FL350–FL390, ~900 km/h, Sinkflug), Startzeit frei wählbar.
- Ausbaustufe: Route über die tagesaktuellen **North Atlantic Tracks** (werden
  täglich veröffentlicht) – das ist näher am „realen Weg“.
- Optional später: echte Live-Flugzeuge über **OpenSky Network**
  (nur nicht-kommerziell erlaubt).

### 4.6 Raketen-Szenario (später)

Startplätze (Kennedy, Baikonur, Kourou, Wenchang, …) als Datenliste. Start zum
Zeitpunkt, an dem die ISS-Bahnebene über den Startplatz läuft; vereinfachtes
Aufstiegsprofil + Annäherung. Nutzt dieselbe **Szenario-Schnittstelle** wie das
Flugzeug → die Architektur muss das von Anfang an vorsehen, gebaut wird es später.

## 5. Architektur (grob)

```
Browser
├── UI (Layer-Panel, Objektliste, Zeitregler, Szenario-Dialog)
├── Zeitdienst (eine Simulationszeit für ALLES, Echtzeit / Zeitraffer / Rückspulen)
├── Cesium Viewer
│   ├── Grundkarte (Blue Marble / Sentinel-2) + Nachtlichter
│   ├── Wolken-Layer (zeitabhängige Kacheln, Shader: IR→Alpha, Tag/Nacht)
│   ├── Sonneneinstrahlung-Overlay (Sonnenzenitwinkel → W/m²)
│   ├── Himmelskörper (astronomy-engine)
│   └── Satelliten (PointPrimitiveCollection, Labels nur bei Auswahl/Zoom)
├── Web Worker: SGP4-Propagation (~10 000 Objekte)
└── Szenario-Engine (Flug, später Rakete) → SampledPositionProperty

Cache/Proxy (klein, optional)
├── Wolkenkacheln zwischenspeichern + Ausweichquelle bei Ausfall
└── TLE-Bündel aus CelesTrak alle 2–4 h
```

### Performance-Plan

- Satelliten: Propagation im Worker mit 1–2 Hz, Interpolation pro Frame,
  Darstellung als GPU-Punkte, nicht als Einzel-Entities.
- Wolken-Animation: beim Abspielen gröbere Zoomstufe + Vorabladen der nächsten
  Frames; beim Pausieren volle Auflösung nachladen.
- Ziel: 60 FPS auf einem normalen Laptop mit integrierter Grafik, 30 FPS auf
  Mittelklasse-Smartphone.

## 6. Kritische Begutachtung („Grill & Roast“)

1. **Planeten „mit realer Position“ sind auf einer Erdansicht unsichtbar.** Die
   Sonne ist 150 Mio. km weg, Jupiter ein Pixel-Bruchteil. Echter Maßstab = man sieht
   nichts. Es braucht eine Entscheidung: (a) Planeten als Marker am Himmel in
   korrekter *Richtung*, (b) eigener „Sonnensystem-Zoom“ mit logarithmischer
   Skala, oder beides. → offene Frage.
2. **„Höchste Auflösung“ + „Performance“ + „kostenlos“ ist ein Dreieck, kein
   Wunschzettel.** Globale Wolkendaten gibt es mit 0,5–2 km, nicht besser.
   10-m-Erdbilder darunter sind schön beim Reinzoomen, aber die Wolken werden dann
   matschig. Das ist physikalisch so, nicht ein Fehler.
3. **„Keine Aussetzer“ gibt es bei Gratisdaten nicht.** Satelliten fallen aus
   (Wartung, Sonnenfinsternis-Saison, Wechsel GOES-/Himawari-Generation), Dienste
   haben keine SLA. Ohne eigenen Cache und Ausweichkette (geostationär → Tagesmosaik
   → letztes gutes Bild) wird es Lücken geben.
4. **Nähte im Wolkenmosaik.** Vier bis fünf verschiedene Satelliten mit
   unterschiedlicher Farbe, Blickwinkel und Zeitpunkt ergeben sichtbare Kanten.
   Gegenmittel: IR-basierte einheitliche Darstellung + weiche Überblendung. Perfekt
   wird es nicht.
5. **Pole bleiben ein Loch** bei Live-Wolken (geostationär sieht dort nichts).
6. **„Der reale Weg FRA→JFK“ existiert nicht als feste Linie.** Die Route ändert sich
   täglich mit Jetstream und North Atlantic Tracks. Wir simulieren – das sollten wir
   auch so benennen.
7. **Zurückspulen bei Satelliten:** Ein aktueller TLE rückwärts gerechnet ist für
   1 Tag ok (km-Fehler), für Wochen nicht. Weiter zurück braucht historische TLEs
   (Space-Track-Account).
8. **Ist es ein Spiel oder eine Visualisierung?** Bisher gibt es keine
   Spielmechanik (Ziel, Punkte, Herausforderung). Das ist völlig okay, aber dann
   heißt das Produkt „interaktiver Globus“, und wir planen danach.
9. **Scope-Creep-Gefahr.** Rakete zur ISS mit Rendezvous ist allein schon ein
   Projekt. Nur die Schnittstelle vorsehen, nicht bauen.
10. **10 000 Starlink-Labels = Buchstabensuppe.** Labels nur bei Auswahl, Hover
    oder nahem Zoom; Starlink standardmäßig als Gruppe ein-/ausblendbar.

## 7. Meilensteine (Vorschlag)

| # | Inhalt | Ergebnis |
|---|---|---|
| M0 | Projektgerüst (Vite + TS + Cesium), Deployment (GitHub Pages) | Leerer, drehbarer Globus online |
| M1 | Grundkarte + Tag/Nacht + Nachtlichter + Zeitregler | Realer Terminator, Zeitraffer |
| M2 | Wolken: ein geostationärer Satellit, dann Mosaik + IR-Nacht | Live-Wolken + 24 h zurückspulen |
| M3 | Satelliten: ISS, Stationen, dann Starlink im Worker; Objektliste Ein/Aus | Echte Positionen, Bahnlinien |
| M4 | Sonne, Mond, Planeten (Darstellungsart nach Entscheidung) | Himmelskörper |
| M5 | Sonneneinstrahlung als Overlay (W/m²) | Einstrahlungskarte |
| M6 | Szenario-Engine + Flug FRA→JFK | Flugzeug startbar |
| M7 | Cache/Proxy + Ausweichquellen | Robustheit |
| später | Rakete zur ISS, Live-Flugverkehr, Langzeit-Archiv | — |

## 8. Offene Punkte (zu klären)

1. Plattform: Browser (empfohlen), Desktop-App, Mobile, VR?
2. Privat / öffentlich / kommerziell? (entscheidet über Cesium ion, EOX, OpenSky)
3. Planeten: Marker am Himmel, Sonnensystem-Zoom oder beides?
4. Wie weit zurückspulen? 1 Tag, 30 Tage (10-min-Raster) oder Jahre (Tagesbild)?
5. Ist ein kleiner Server/Cache ok (kostenlos-Tier Cloudflare o. ä.) oder soll es
   rein statisch laufen?
6. Flugzeug: nur Simulation, oder auch echte Live-Flüge anzeigen?
7. Spiel-Elemente gewünscht, oder reine Visualisierung?
8. Welche Satelliten gelten als „bedeutsam“? (Vorschlag: ISS, Tiangong, Hubble,
   GPS/Galileo/GLONASS/BeiDou, Wettersatelliten, Sentinel, Starlink, OneWeb)
