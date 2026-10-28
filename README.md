# 🌍 Erde

Interaktive 3D-Erde im Browser – für mich und meine Kinder.

- **Echte Wolken** (EUMETSAT-Infrarot-Weltmosaik, alle 3 h, Tag und Nacht), bis zu **30 Tage zurückspulen** (Standard 7)
- **Echtfarben-Satellitenbild für Europa & Afrika** (Meteosat-12, stündlich, ~2–3 km) auf der Tagseite – mit weichem Übergang zum Rest der Welt
- **Tag/Nacht** mit echtem Sonnenstand, **Stadtlichter** auf der Nachtseite – sichtbar, wo der Himmel klar ist
- **Satelliten** an ihrer echten Position: ISS, Tiangong, Hubble & weitere Weltraumteleskope, GPS, Galileo, Starlink-Beispiele; optional Sentinel und OneWeb
- **Sonne, Mond, Planeten** (Marker in echter Richtung, vergrößert), James-Webb-Teleskop, **Flug zum Mond** mit echter Mondphase
- **Fokuspunkt**: Doppelklick auf die Erde → die Erde dreht sich um diesen Punkt
- **Flugzeug-Simulation** zwischen 24 Städten (z. B. Frankfurt ⇄ New York)
- Jedes Objekt einzeln ein-/ausblendbar

Konzept, Datenquellen und Fahrplan: [docs/KONZEPT.md](docs/KONZEPT.md)

## Starten

```bash
npm install
npm run dev          # http://localhost:5173
```

Optional, um die Satelliten-Bahndaten lokal zu erneuern: `npm run fetch:sats`.
Ohne Wolkenarchiv lädt die App die Wolken direkt bei EUMETSAT (langsamer, ~30 s pro Bild).

## Veröffentlichen (kostenlos über GitHub)

Einmalig: **Settings → Pages → Build and deployment → Source: „GitHub Actions“**.

Danach baut der Workflow [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) die Seite bei jedem Push
und **stündlich** neu. Dabei holt er neue Wolkenbilder (Archiv der letzten 30 Tage, ~0,5 MB pro Bild),
Echtfarbenbilder für Europa/Afrika (7 Tage, ~2 MB pro Bild) und
alle 6 Stunden frische Bahndaten. Die Seite ist dann unter `https://<benutzer>.github.io/Erde/` erreichbar.
Beim allerersten Lauf füllt sich das Wolkenarchiv schrittweise (60 Bilder pro Lauf).

## Aufbau

| Pfad | Inhalt |
|---|---|
| `src/globe.ts` | Cesium-Viewer, Tag-/Nachtkarten, Beleuchtung |
| `src/clouds/` | Zeitabhängige Bildebenen (Wolken, Echtfarben): Laden (Archiv oder EUMETSAT), Aufbereitung im Web Worker, Überblendung |
| `src/objects/satellites.ts` | Satelliten (SGP4 mit satellite.js), Bahnlinien |
| `src/objects/sky.ts` | Sonne, Mond, Planeten, James Webb (astronomy-engine) |
| `src/objects/flights.ts` | Flugsimulation auf dem Großkreis |
| `src/camera.ts` | Fokuspunkt, „Blick aus dem All“, Mondflug |
| `src/ui.ts`, `src/style.css` | Bedienfeld, Zeitleiste |
| `scripts/fetch_imagery.py` | Bildarchiv für Wolken und Echtfarben (läuft in GitHub Actions) |
| `scripts/fetch-satellites.mjs` | Bahndaten von CelesTrak |

## Datenquellen & Lizenzen

- Wolken: © EUMETSAT – Geostationary Ring IR10.8 µm (Multimission)
- Echtfarben Europa/Afrika: © EUMETSAT – Meteosat-12 GeoColour
- Erde bei Tag: Sentinel-2 cloudless 2025 by EOX IT Services GmbH (CC BY-NC-SA 4.0, nicht-kommerziell)
- Erde bei Nacht: NASA Black Marble (VIIRS) via NASA GIBS
- Mond: NASA LRO / CGI Moon Kit (Public Domain)
- Bahndaten: CelesTrak
- 3D-Globus: [CesiumJS](https://cesium.com/platform/cesiumjs/) (Apache 2.0)
