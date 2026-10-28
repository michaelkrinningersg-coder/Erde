# 🌍 Erde

Interaktive 3D-Erde im Browser – für mich und meine Kinder.

- **Echte Wolken** (EUMETSAT-Infrarot-Weltmosaik, alle 3 h, Tag und Nacht), bis zu **30 Tage zurückspulen** (Standard 7)
- **Echtfarben-Satellitenbilder** für Europa & Afrika (Meteosat-12) und Amerika (GOES-19) auf der Tagseite – mit weichen Übergängen; die letzten 6 Stunden im 10-Minuten-Takt (beim Start direkt geladen), davor stündlich aus dem Archiv
- **Tag/Nacht** mit echtem Sonnenstand, **Stadtlichter** auf der Nachtseite – sichtbar, wo der Himmel klar ist
- **Satelliten** an ihrer echten Position: ISS, Tiangong, Hubble & weitere Weltraumteleskope, GPS, Galileo, Starlink-Beispiele; optional Sentinel und OneWeb
- **Sonne, Mond, Planeten** (Marker in echter Richtung, vergrößert), James-Webb-Teleskop, **Flug zum Mond** mit echter Mondphase
- **Sonnensystem-Ansicht** (kindgerecht zusammengerückt, Planeten in echter Richtung, anklickbar, Zeitraffer bis 1 Monat/s) – per Knopf oder einfach ganz weit rauszoomen
- **Zuhause-Knopf** 🏠: Ort einmal festlegen (Standort, Stadt oder Bildmitte), gespeichert nur im Browser
- **Immer eingenordet**: Ziehen dreht, Mausrad zoomt; Kompass-Knopf zum Einnorden; Doppelklick fliegt hin
- **Flugzeug-Simulation** zwischen 24 Städten (z. B. Frankfurt ⇄ New York)
- **Rakete zur ISS/Tiangong** von echten Startplätzen: Startfenster, Stufentrennung, Parkbahn, Andocken, nach 2 h Rückflug mit glühendem Wiedereintritt und Fallschirmen
- **3D-Modelle** (per Blender-Skript gebaut): ISS, Tiangong, Hubble, James Webb, Chandra, XMM-Newton, Swift, Fermi, NuSTAR, Rakete mit Stufen und Kapsel
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
Echtfarbenbilder für Europa/Afrika und Amerika (je 5 Tage, ~2 MB pro Bild) und
alle 6 Stunden frische Bahndaten. Die Seite ist dann unter `https://<benutzer>.github.io/Erde/` erreichbar.
Beim allerersten Lauf füllt sich das Wolkenarchiv schrittweise (60 Bilder pro Lauf).

## Windows-Programm (Erde.exe)

Wie bei Schienenland: eine einzelne `.exe`, gebaut **nur auf Wunsch** in GitHub
(**Actions → „Windows-Programm bauen“ → „Run workflow“**, danach unter „Artifacts“ herunterladen).

- **Erde-Windows**: `Erde.exe` direkt starten (braucht das in Windows 10/11 eingebaute Edge-WebView2)
- **Erde-Installer**: Setup mit Startmenü-Eintrag; installiert WebView2 bei Bedarf nach

Technik: [Tauri](https://tauri.app) – die Web-App läuft im Windows-eigenen Browser-Fenster, daher ist die
Datei klein (kein Electron). Wolken- und Bahndaten holt das Programm von der GitHub-Pages-Seite
(`.env.desktop`), deshalb muss Pages eingeschaltet sein. Lokal: `npm run tauri dev` bzw. `npm run tauri build`
(braucht Rust).

## Aufbau

| Pfad | Inhalt |
|---|---|
| `src/globe.ts` | Cesium-Viewer, Tag-/Nachtkarten, Beleuchtung |
| `src/clouds/` | Zeitabhängige Bildebenen (Wolken, Echtfarben): Laden (Archiv oder EUMETSAT), Aufbereitung im Web Worker, Überblendung |
| `src/objects/satellites.ts` | Satelliten (SGP4 mit satellite.js), Bahnlinien |
| `src/objects/sky.ts` | Sonne, Mond, Planeten, James Webb (astronomy-engine) |
| `src/objects/flights.ts` | Flugsimulation auf dem Großkreis |
| `src/objects/rocket.ts`, `rocketControl.ts` | Raketenmission (Bahnmechanik, Stufen, Rückflug), Autopilot-Zeitraffer, Anzeige |
| `src/svgIcons.ts` | Eigener Symbolsatz |
| `tools/blender/raumfahrt.py` | 3D-Modelle (Blender-Python), Ausgabe nach `public/models/` |
| `src/solar/solarSystem.ts` | Sonnensystem-Ansicht (Three.js) |
| `src/home.ts` | Zuhause-Ort und Marker |
| `src/camera.ts` | Fokuspunkt, „Blick aus dem All“, Mondflug |
| `src/ui.ts`, `src/style.css` | Bedienfeld, Zeitleiste |
| `scripts/fetch_imagery.py` | Bildarchiv für Wolken und Echtfarben (läuft in GitHub Actions) |
| `scripts/fetch-satellites.mjs` | Bahndaten von CelesTrak |
| `src-tauri/` | Windows-Programm (Tauri-Hülle, Icon) |

## Datenquellen & Lizenzen

- Wolken: © EUMETSAT – Geostationary Ring IR10.8 µm (Multimission)
- Echtfarben Europa/Afrika: © EUMETSAT – Meteosat-12 GeoColour
- Echtfarben Amerika: NOAA/NESDIS/STAR – GOES-19 GeoColor
- Erde bei Tag: Sentinel-2 cloudless 2025 by EOX IT Services GmbH (CC BY-NC-SA 4.0, nicht-kommerziell)
- Erde bei Nacht: NASA Black Marble (VIIRS) via NASA GIBS
- Mond: NASA LRO / CGI Moon Kit (Public Domain)
- Planeten-Texturen (Sonnensystem): [Solar System Scope](https://www.solarsystemscope.com/textures/) (CC BY 4.0)
- Bahndaten: CelesTrak
- 3D-Globus: [CesiumJS](https://cesium.com/platform/cesiumjs/) (Apache 2.0), Sonnensystem: [three.js](https://threejs.org) (MIT)
