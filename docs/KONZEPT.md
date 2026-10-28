# Erde – Konzept & Tech-Stack (v0.2)

Stand: 2026-10-28 · Status: **erste lauffähige Version gebaut**

## 1. Ziel

Interaktive 3D-Erde für ein privates Projekt (Papa + zwei Kinder, 3 und 6 Jahre): echte Wolkenbilder
mit Zeitachse, realer Tag/Nacht-Verlauf mit Stadtlichtern, echte Positionen von Sonne, Mond,
Planeten und Satelliten, startbare Flugzeug-Szenarien. **Keine Spielmechanik – reine Visualisierung.**

## 2. Entscheidungen (geklärt)

| Thema | Entscheidung |
|---|---|
| Plattform | Browser zuerst. Später Desktop-„EXE“ als Hülle um dieselbe Web-App, danach evtl. Handy |
| Nutzung | Rein privat, nicht-kommerziell (erlaubt z. B. Sentinel-2 cloudless von EOX) |
| Zurückspulen | bis 30 Tage, Standard 7 Tage |
| Planeten | Marker in echter Richtung, vergrößert und näher gezeichnet; später eigene Sonnensystem-Ansicht |
| Pole | Wolken dürfen dort fehlen/abweichen (geostationäre Satelliten sehen die Pole nicht) |
| Flugzeug | Simulation (Großkreis + Flugprofil), beliebige Städtepaare |
| Satelliten | ISS, Tiangong, Hubble + Weltraumteleskope, GPS, Galileo, Starlink-Beispiele; Sentinel/OneWeb optional |
| Rakete zur ISS | eigenes, späteres Projekt |
| Server | kein eigener Server: **GitHub Actions + GitHub Pages** (kostenlos, Repo ist öffentlich) |

## 3. Tech-Stack

| Baustein | Wahl | Warum |
|---|---|---|
| 3D-Globus | **CesiumJS 1.146** | Echter WGS84-Globus, Zeitachse, Sonnenlicht, Tag/Nacht-Ebenen, Kachel-Streaming, Mond |
| Sprache/Build | TypeScript + Vite | schnell, statische Seite, läuft überall |
| Satellitenbahnen | satellite.js (SGP4) | Standard für TLE/OMM-Bahndaten |
| Himmelskörper | astronomy-engine | präzise Positionen von Sonne, Mond, Planeten ohne Server |
| Wolken-Aufbereitung | Web Worker (OffscreenCanvas) | Infrarot → Wolkenschicht, ohne die Darstellung zu bremsen |
| „Server“ | GitHub Actions (stündlich) + GitHub Pages | Wolkenarchiv + Bahndaten vorab laden, schnell ausliefern |

Nicht gewählt: Blender (Modellierwerkzeug, keine Laufzeit), Godot (keine Geo-Funktionen, alles selbst
bauen), Unreal (schwer, Desktop-only).

## 4. Datenquellen (alle getestet)

### Wolken – EUMETSAT „Geostationary Ring IR10.8 µm – Multimission“

- **Ein bereits nahtlos zusammengesetztes Weltbild** aus allen geostationären Wettersatelliten
  (Meteosat, GOES, Himawari …) → saubere Übergänge zwischen den Regionen.
- Infrarot → funktioniert **Tag und Nacht**. Die App rechnet die Temperatur in eine weiße,
  durchscheinende Wolkenschicht um; wo der Himmel klar ist, sieht man nachts die Stadtlichter.
- Alle 3 Stunden, Verzögerung ca. 1 Stunde, Archiv seit 2021, Auflösung ca. 5–10 km.
- Gemessen: Direktabruf im Browser ~30 s pro Bild (Server kann nur 6 parallele Verbindungen) →
  deshalb **eigenes Archiv**: GitHub Actions lädt stündlich neue Bilder, speichert sie als
  Graustufen-WebP (~0,5 MB) → im Browser in **unter 4 s** geladen. Direktabruf bleibt als Rückfall.
- Übergang zwischen zwei Zeitpunkten wird weich überblendet; die nächsten Bilder in Abspielrichtung
  werden vorab geladen.

### Echtfarben Europa & Afrika – Meteosat-12 „GeoColour“

- Echtes Farbbild vom Tag (Wolken, Sand, Schnee, Rauch), Ausschnitt 48° W – 64° O, 38° S – 72° N.
- Stündlich im Archiv (5 Tage, ~1,9 MB pro Bild, 4096 × 4096 px ≈ 2–3 km), nur auf der Tagseite.
- Rand weich ausgeblendet (zum Ausschnittsrand und zur Kante der Satellitensicht), darunter
  das weltweite Infrarot-Wolkenbild → keine harte Kante.
- Beim nahen Reinzoomen (unter ~700 km Höhe) blendet es aus, damit die 10-m-Karte sichtbar wird.
- Kein doppelter Wolkenschleier: Im Übergang treten die Infrarot-Wolken tagsüber genau um den Anteil
  zurück, den das Farbbild übernimmt (gleiche Gewichtsfunktion für beide; nachts volle Infrarot-Wolken).
- Westrand bis 48° W mit 13° breitem Übergang, damit z. B. Sonnenglanz auf dem Atlantik (echtes
  Phänomen im Satellitenbild) nicht an einer Kante abreißt.

### Echtfarben Amerika – GOES-19 „GeoColor“ (NOAA)

- NOAA-CDN liefert die Vollscheibe alle 10 min mit ~20 min Verzögerung (NASA GIBS hinkt ~6 h).
- Das Bild zeigt die Erde aus Sicht des Satelliten (75,2° W) und wird mit den Formeln aus dem
  GOES-R Product User Guide auf Längen-/Breitengrade umgerechnet (im Archiv-Skript mit numpy,
  als Rückfall auch im Browser mit der kleineren 1808-px-Version).
- Mehrere Echtfarben-Gebiete teilen sich Überlappungen (Atlantik) über eine gemeinsame
  Gewichtung; die Infrarot-Wolken treten je Gebiet genau um dessen Anteil zurück.
- Archiv: stündlich, 5 Tage, 3072 px (~4 km), ~2 MB pro Bild. GitHub Pages bleibt so unter 1 GB.

### Erdoberfläche

- Tag: **Sentinel-2 cloudless 2025** (EOX, 10 m Auflösung, CC BY-NC-SA 4.0 – privat erlaubt)
- Nacht: **NASA Black Marble** (VIIRS, 500 m) – nur auf der Nachtseite sichtbar
- Mond: **NASA LRO**-Farbkarte 4K (Public Domain), Phase durch echte Sonnenbeleuchtung

### Satelliten

CelesTrak (OMM/JSON), alle 6 h über GitHub Actions; Schnappschuss liegt im Repo, damit die App
immer Daten hat. JWST hat keine Bahndaten (steht am L2) → Näherung „1,5 Mio. km von der Sonne weg“.

## 5. Kritische Punkte (aktueller Stand)

1. **Wolken-Auflösung**: Das Weltmosaik hat ~5–10 km. Aus dem All sieht das gut aus, beim nahen
   Reinzoomen (z. B. auf Deutschland) wirken die Wolken weich. → Ausbaustufe: Meteosat-12 (MTG, 1 km,
   alle 10 min, Verzögerung ~20 min) für Europa/Afrika einblenden.
2. **Zeitraster 3 h**: Wolken springen nicht, werden aber nur überblendet (keine echte Bewegung).
   Mit MTG wären es 10-Minuten-Schritte für Europa.
3. **Abhängigkeit von Gratis-Diensten**: EUMETSAT, EOX, NASA GIBS, CelesTrak haben keine Garantie.
   Abgefedert durch: Wolkenarchiv (30 Tage), Bahndaten-Schnappschuss, Direktabruf-Rückfall.
4. **EOX-Kacheln** lieferten im Test vereinzelt Fehler (fehlende CORS-Header bei Fehlerantworten) –
   Cesium zeigt dann kurz die gröbere Stufe. Beobachten.
5. **Planeten** sind bewusst nicht maßstäblich (sonst unsichtbar) – steht als Hinweis in der App.
6. **Flugroute** ist der Großkreis; echte Atlantikrouten weichen täglich je nach Jetstream ab.
7. **Leistung**: Wolkentextur 4096×2048 auf dem Desktop, 2048×1024 auf Handys/schwachen Geräten.

## 6. Fahrplan

| # | Inhalt | Status |
|---|---|---|
| M0 | Projektgerüst, Deployment (GitHub Pages) | ✅ |
| M1 | Erde Tag/Nacht, Stadtlichter, Atmosphäre, Zeitleiste (7/30 Tage) | ✅ |
| M2 | Echte Wolken + Archiv + Überblendung | ✅ |
| M3 | Satelliten mit Bahnen, einzeln schaltbar | ✅ |
| M4 | Sonne, Mond (zoombar), Planeten-Marker, James Webb | ✅ |
| M5 | Fokuspunkt, „Blick aus dem All“, Flugzeug-Simulation | ✅ |
| M6 | Sonnensystem-Ansicht (kindgerecht zusammengerückt, echte Richtungen) | ✅ |
| M7 | Echtfarben Europa/Afrika (Meteosat-12, stündlich) | ✅ |
| M7b | Echtfarben Amerika (GOES-19 GeoColor von NOAA, auf Längen/Breiten umgerechnet) | ✅ |
| M7c | Zuhause-Knopf | ✅ |
| M8 | Desktop-EXE (Tauri oder Electron) | geplant |
| M9 | Handy (PWA oder Capacitor) | geplant |
| M10 | Sonneneinstrahlung als Karte (W/m²) | optional |
| — | Rakete zur ISS | eigenes Projekt |

## 7. Offene Punkte

1. Desktop-Hülle: Welche habt ihr bei den anderen Apps benutzt – **Electron** oder **Tauri**?
