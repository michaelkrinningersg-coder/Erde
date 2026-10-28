#!/usr/bin/env python3
"""Wolken-Archiv für die Erde-App.

Lädt das weltweite Infrarot-Wolkenmosaik von EUMETSAT („Geostationary Ring IR10.8 µm –
Multimission“, alle 3 Stunden) und legt es als kompakte Graustufen-WebP-Dateien in
public/clouds/ ab, plus public/clouds/index.json mit der Liste aller Bilder.

Läuft stündlich in GitHub Actions. Bereits vorhandene Bilder werden übersprungen,
Bilder älter als --days werden gelöscht. Der Browser lädt dann ein fertiges Bild
(~1 MB, schnell über GitHub Pages) statt 32 langsamer Einzelkacheln.

Grauwert 0 bedeutet „keine Daten“ (z. B. an den Polen).
"""
import argparse
import concurrent.futures as cf
import datetime as dt
import io
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

from PIL import Image

WMS = "https://view.eumetsat.int/geoserver/wms"
LAYER = "mumi:worldcloudmap_ir108"
STEP = dt.timedelta(hours=3)
WIDTH, TILES_X, TILES_Y = 4096, 8, 4
TILE = WIDTH // TILES_X  # 512 px; kleine Kacheln parallel sind beim Server am schnellsten
UA = {"User-Agent": "Erde-Visualisierung (privates Projekt; GitHub Actions)"}


def iso(t: dt.datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def http_get(url: str, timeout: int = 120) -> bytes:
    last = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001 – Netzwerkfehler aller Art erneut versuchen
            last = e
            time.sleep(2 * 2**attempt)
    raise RuntimeError(f"{url[:120]}…: {last}")


def latest_available() -> dt.datetime:
    xml = http_get(f"{WMS}?service=WMS&version=1.3.0&request=GetCapabilities").decode("utf-8", "replace")
    at = xml.find(f"<Name>{LAYER}</Name>")
    m = re.search(r'<Dimension name="time"[^>]*>([^<]+)</Dimension>', xml[at:])
    if at < 0 or not m:
        raise RuntimeError("Zeitangabe im Capabilities-Dokument nicht gefunden")
    last = m.group(1).strip().split(",")[-1]
    end = last.split("/")[1] if "/" in last else last
    t = dt.datetime.fromisoformat(end.replace("Z", "+00:00"))
    return t.replace(minute=0, second=0, microsecond=0, hour=t.hour - t.hour % 3)


def fetch_tile(t: dt.datetime, ix: int, iy: int) -> tuple[int, int, Image.Image]:
    d_lon, d_lat = 360 / TILES_X, 180 / TILES_Y
    max_lat, min_lon = 90 - iy * d_lat, -180 + ix * d_lon
    q = urllib.parse.urlencode(
        {
            "service": "WMS",
            "version": "1.3.0",
            "request": "GetMap",
            "layers": LAYER,
            "styles": "",
            "crs": "EPSG:4326",
            "bbox": f"{max_lat - d_lat},{min_lon},{max_lat},{min_lon + d_lon}",
            "width": TILE,
            "height": TILE,
            "format": "image/png",
            "transparent": "true",
            "time": iso(t),
        }
    )
    img = Image.open(io.BytesIO(http_get(f"{WMS}?{q}"))).convert("RGBA")
    return ix, iy, img


def fetch_frame(t: dt.datetime) -> tuple[Image.Image, float]:
    canvas = Image.new("L", (WIDTH, WIDTH // 2), 0)
    with cf.ThreadPoolExecutor(max_workers=16) as pool:
        jobs = [pool.submit(fetch_tile, t, ix, iy) for iy in range(TILES_Y) for ix in range(TILES_X)]
        for job in cf.as_completed(jobs):
            ix, iy, img = job.result()
            r, _g, _b, a = img.split()
            gray = r.point(lambda v: max(1, v))  # 0 ist für „keine Daten“ reserviert
            canvas.paste(Image.composite(gray, Image.new("L", img.size, 0), a), (ix * TILE, iy * TILE))
    hist = canvas.histogram()
    coverage = 1 - hist[0] / (canvas.width * canvas.height)
    return canvas, coverage


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="public/clouds")
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--max-new", type=int, default=60, help="höchstens so viele neue Bilder pro Lauf")
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    latest = latest_available()
    oldest = latest - dt.timedelta(days=args.days)
    print(f"Neuestes Bild beim Dienst: {iso(latest)}")

    wanted = []
    t = latest
    while t >= oldest:
        wanted.append(t)
        t -= STEP

    name = lambda t: t.strftime("%Y%m%dT%H%MZ") + ".webp"  # noqa: E731
    new = 0
    for t in wanted:  # neueste zuerst
        f = out / name(t)
        if f.exists():
            continue
        if new >= args.max_new:
            print(f"Limit von {args.max_new} neuen Bildern erreicht – Rest beim nächsten Lauf")
            break
        try:
            start = time.time()
            img, coverage = fetch_frame(t)
            if coverage < 0.5:
                print(f"✖ {iso(t)}: nur {coverage:.0%} Abdeckung – übersprungen")
                continue
            img.save(f, "WEBP", quality=82, method=5)
            new += 1
            print(f"✔ {iso(t)}  {f.stat().st_size / 1e6:.2f} MB  {time.time() - start:.0f} s")
        except Exception as e:  # noqa: BLE001
            print(f"✖ {iso(t)}: {e}")

    # Aufräumen und Index schreiben
    frames = []
    for f in sorted(out.glob("*.webp")):
        t = dt.datetime.strptime(f.stem, "%Y%m%dT%H%MZ").replace(tzinfo=dt.timezone.utc)
        if t < oldest - STEP:
            f.unlink()
            continue
        frames.append(iso(t))
    (out / "index.json").write_text(
        json.dumps({"updated": iso(dt.datetime.now(dt.timezone.utc)), "stepHours": 3, "width": WIDTH, "frames": frames})
    )
    print(f"{len(frames)} Bilder im Archiv, {new} neu")
    return 0 if frames else 1


if __name__ == "__main__":
    sys.exit(main())
