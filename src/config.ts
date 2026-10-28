// Zentrale Einstellungen: Datenquellen, Zeitfenster, Darstellung.

export const TIME = {
  /** Standard-Rückspulzeitraum in Tagen */
  defaultRangeDays: 7,
  maxRangeDays: 30,
  /** Wie weit die Zeitleiste in die Zukunft reicht (Satelliten/Planeten/Flüge) */
  futureHours: 24,
};

/** Erdoberfläche bei Tag: Sentinel-2 cloudless (EOX, 10 m, CC BY-NC-SA 4.0 – privat erlaubt) */
export const BASE_MAP = {
  url: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025/default/WGS84/{z}/{y}/{x}.jpg',
  maximumLevel: 16,
  credit: 'Sentinel-2 cloudless 2025 by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2025)',
};

/** Erdoberfläche bei Nacht: NASA Black Marble (VIIRS, Public Domain) */
export const NIGHT_LIGHTS = {
  url: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png',
  maximumLevel: 8,
  credit: 'NASA Black Marble (VIIRS) via NASA GIBS',
};

/**
 * Woher die stündlich erneuerten Daten (Wolken-/Farbbild-Archiv, Bahndaten) kommen:
 * im Browser relativ zur Seite, in der Desktop-App von der veröffentlichten GitHub-Pages-Seite
 * (gesetzt über .env.desktop).
 */
export const DATA_BASE: string = import.meta.env.VITE_DATA_BASE ?? '.';

/** Beschreibung einer zeitabhängigen Bildebene (Wolken, Echtfarben) */
export interface TimeLayerSpec {
  id: string;
  name: string;
  wms: string;
  layer: string;
  format: 'image/png' | 'image/jpeg';
  /** Abstand der Bilder in Minuten */
  stepMinutes: number;
  /** Typische Verzögerung, bis ein Bild verfügbar ist (wird per GetCapabilities präzisiert) */
  typicalLatencyMinutes: number;
  /** Abgedecktes Gebiet in Grad */
  rect: { west: number; south: number; east: number; north: number };
  /** Größe des zusammengesetzten Bildes (Desktop; Handys bekommen die halbe Größe) */
  width: number;
  height: number;
  /** Anzahl paralleler WMS-Kacheln – viele kleine Kacheln sind beim EUMETSAT-Server am schnellsten */
  tilesX: number;
  tilesY: number;
  /** Fertiges Bild wird für Cesium in so viele Spalten geteilt (max. 4096 px je Textur) */
  splitX: number;
  /** ir = Infrarot → weiße Wolken; color = Echtfarbenbild mit weichem Rand */
  mode: 'ir' | 'color';
  /** Sichtbarkeit auf der Nachtseite (0 = nur am Tag) */
  nightAlpha: number;
  /** Stapelreihenfolge: höher liegt oben */
  zIndex: number;
  /** Eigenes Archiv (von GitHub Actions befüllt), relativ zur Seite */
  archive: string;
  credit: string;
  /** Woher die Bilder kommen: WMS-Kacheln (Standard) oder NOAA-Vollscheibe in Satellitenperspektive */
  source?: 'wms' | 'noaa-fd';
  /** Nur Echtfarben: welche der COLOR_REGIONS dieses Bild ist */
  region?: number;
  /** Nur Wolken: Echtfarben-Gebiete, in denen die Wolken tagsüber zurücktreten */
  cutouts?: ColorRegion[];
}

export type Rect = { west: number; south: number; east: number; north: number };

/** Ein Echtfarben-Gebiet: Ausschnitt und Standort des geostationären Satelliten */
export interface ColorRegion {
  rect: Rect;
  satLon: number;
}

/**
 * Echtfarben-Gebiete. Wo sie sich überlappen (Atlantik), teilen sie sich das Bild weich auf;
 * die Gewichte aller Gebiete und der Infrarot-Wolken ergeben überall zusammen 100 %.
 */
export const COLOR_REGIONS: ColorRegion[] = [
  { rect: { west: -48, south: -38, east: 64, north: 72 }, satLon: 0 }, // Meteosat-12: Europa & Afrika
  { rect: { west: -140, south: -60, east: -20, north: 62 }, satLon: -75.2 }, // GOES-19: Amerika
];

/**
 * Wolken weltweit: EUMETSAT „Geostationary Ring IR10.8 µm – Multimission“.
 * Ein bereits nahtlos zusammengesetztes Infrarot-Mosaik aus allen geostationären
 * Wettersatelliten (Meteosat, GOES, Himawari …), alle 3 Stunden. Funktioniert Tag UND Nacht.
 */
export const CLOUDS: TimeLayerSpec = {
  id: 'clouds',
  name: 'Wolken',
  wms: 'https://view.eumetsat.int/geoserver/wms',
  layer: 'mumi:worldcloudmap_ir108',
  format: 'image/png',
  stepMinutes: 180,
  typicalLatencyMinutes: 180,
  rect: { west: -180, south: -90, east: 180, north: 90 },
  width: 4096,
  height: 2048,
  tilesX: 8,
  tilesY: 4,
  splitX: 2,
  mode: 'ir',
  nightAlpha: 1,
  zIndex: 1,
  archive: `${DATA_BASE}/clouds`,
  credit: 'Wolken: © EUMETSAT (Geostationary Ring IR10.8, Multimission)',
  cutouts: COLOR_REGIONS,
};

/**
 * Echtfarben Europa/Afrika: Meteosat-12 (MTG-I1) „GeoColour“, 1 km, alle 10 min, ~20 min Verzögerung.
 * Wir nutzen stündliche Bilder (Archiv) und nur auf der Tagseite – nachts übernehmen
 * unsere eigenen Stadtlichter und die Infrarot-Wolken.
 */
export const COLOR_EUROPE: TimeLayerSpec = {
  id: 'color',
  name: 'Echtfarben',
  wms: 'https://view.eumetsat.int/geoserver/wms',
  layer: 'mtg_fd:rgb_geocolour',
  format: 'image/jpeg',
  stepMinutes: 60,
  typicalLatencyMinutes: 40,
  rect: COLOR_REGIONS[0].rect,
  region: 0,
  width: 4096,
  height: 4096,
  tilesX: 8,
  tilesY: 8,
  splitX: 1,
  mode: 'color',
  nightAlpha: 0,
  zIndex: 2,
  archive: `${DATA_BASE}/color`,
  credit: 'Echtfarben: © EUMETSAT (Meteosat-12 GeoColour)',
};

/**
 * Echtfarben Amerika: GOES-19 (GOES-East, 75,2° W) „GeoColor“ von NOAA, alle 10 min, ~20 min Verzögerung.
 * Kommt als Vollscheibe in Satellitenperspektive und wird auf Längen-/Breitengrade umgerechnet.
 */
export const COLOR_AMERICA: TimeLayerSpec = {
  id: 'color-america',
  name: 'Echtfarben Amerika',
  source: 'noaa-fd',
  wms: 'https://cdn.star.nesdis.noaa.gov/GOES19/ABI/FD/GEOCOLOR',
  layer: 'GOES19-ABI-FD-GEOCOLOR-5424x5424',
  format: 'image/jpeg',
  stepMinutes: 60,
  typicalLatencyMinutes: 40,
  rect: COLOR_REGIONS[1].rect,
  region: 1,
  width: 3072,
  height: 3072,
  tilesX: 1,
  tilesY: 1,
  splitX: 1,
  mode: 'color',
  nightAlpha: 0,
  zIndex: 2,
  archive: `${DATA_BASE}/color-america`,
  credit: 'Echtfarben Amerika: NOAA/NESDIS/STAR, GOES-19 GeoColor',
};

/** Darstellungs-Entfernung der Planeten-Marker (Richtung stimmt, Entfernung ist symbolisch) */
export const PLANET_MARKER_DISTANCE_M = 2.0e10;

/** Wie weit man maximal herauszoomen kann (Meter vom Erdmittelpunkt) */
export const MAX_ZOOM_OUT_M = 2.0e9;
