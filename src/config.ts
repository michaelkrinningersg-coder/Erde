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
 * Wolken: EUMETSAT „Geostationary Ring IR10.8 µm – Multimission“.
 * Ein bereits nahtlos zusammengesetztes, weltweites Infrarot-Mosaik aus allen
 * geostationären Wettersatelliten (Meteosat, GOES, Himawari …), alle 3 Stunden.
 * Infrarot funktioniert Tag UND Nacht.
 */
export const CLOUDS = {
  wms: 'https://view.eumetsat.int/geoserver/wms',
  layer: 'mumi:worldcloudmap_ir108',
  stepHours: 3,
  /** Typische Verzögerung, bis ein Bild verfügbar ist (wird beim Start per GetCapabilities präzisiert) */
  typicalLatencyHours: 4,
  /** Auflösung des zusammengesetzten Wolkenbildes (Breite; Höhe = Breite / 2) */
  textureWidth: 4096,
  /**
   * Das Bild wird in 8 × 4 = 32 Kacheln parallel angefragt – das ist beim EUMETSAT-Server
   * deutlich schneller (gemessen ~11 s für 4096 px) als wenige große Kacheln (~45 s).
   */
  tilesAcross: 8,
  /** Eigenes Archiv (von GitHub Actions befüllt), relativ zur Seite */
  archive: './clouds',
  credit: 'Wolken: © EUMETSAT (Geostationary Ring IR10.8, Multimission)',
};

/** Darstellungs-Entfernung der Planeten-Marker (Richtung stimmt, Entfernung ist symbolisch) */
export const PLANET_MARKER_DISTANCE_M = 2.0e10;

/** Wie weit man maximal herauszoomen kann (Meter vom Erdmittelpunkt) */
export const MAX_ZOOM_OUT_M = 2.0e9;
