#!/usr/bin/env python3
"""Bild-Archiv für die Erde-App (läuft stündlich in GitHub Actions).

Produkte:
  ir     Weltweites Infrarot-Wolkenmosaik von EUMETSAT („Geostationary Ring IR10.8 µm –
         Multimission“, alle 3 h) → Graustufen-WebP in public/clouds/ (Grauwert 0 = keine Daten)
  color  Echtfarbenbild Europa/Afrika von Meteosat-12 („GeoColour“, stündlich) → Farb-WebP
         in public/color/

Bereits vorhandene Bilder werden übersprungen, ältere als --days gelöscht; dazu eine
index.json mit der Liste aller Bilder. Der Browser lädt dann ein fertiges Bild
(~0,5–2 MB, schnell über GitHub Pages) statt vieler langsamer Einzelkacheln.
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
# Kleine Kacheln (512 px) parallel sind beim EUMETSAT-Server am schnellsten (mehr als ~32 gleichzeitig → Fehler 500)
PRODUCTS = {
    "ir": dict(
        layer="mumi:worldcloudmap_ir108", step_h=3, rect=(-180, -90, 180, 90),
        width=4096, height=2048, tiles=(8, 4), fmt="image/png", gray=True, quality=82,
        out="public/clouds", days=30,
    ),
    "color": dict(
        layer="mtg_fd:rgb_geocolour", step_h=1, rect=(-48, -38, 64, 72),  # wie COLOR_RECT in src/config.ts
        width=4096, height=4096, tiles=(8, 8), fmt="image/jpeg", gray=False, quality=80,
        out="public/color", days=7,
    ),
}
P: dict = {}
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
    at = xml.find(f"<Name>{P['layer']}</Name>")
    m = re.search(r'<Dimension name="time"[^>]*>([^<]+)</Dimension>', xml[at:])
    if at < 0 or not m:
        raise RuntimeError("Zeitangabe im Capabilities-Dokument nicht gefunden")
    last = m.group(1).strip().split(",")[-1]
    end = last.split("/")[1] if "/" in last else last
    t = dt.datetime.fromisoformat(end.replace("Z", "+00:00"))
    return t.replace(minute=0, second=0, microsecond=0, hour=t.hour - t.hour % P["step_h"])


def fetch_tile(t: dt.datetime, ix: int, iy: int) -> tuple[int, int, Image.Image]:
    west, south, east, north = P["rect"]
    tx, ty = P["tiles"]
    d_lon, d_lat = (east - west) / tx, (north - south) / ty
    max_lat, min_lon = north - iy * d_lat, west + ix * d_lon
    q = urllib.parse.urlencode(
        {
            "service": "WMS",
            "version": "1.3.0",
            "request": "GetMap",
            "layers": P["layer"],
            "styles": "",
            "crs": "EPSG:4326",
            "bbox": f"{max_lat - d_lat},{min_lon},{max_lat},{min_lon + d_lon}",
            "width": P["width"] // P["tiles"][0],
            "height": P["height"] // P["tiles"][1],
            "format": P["fmt"],
            "transparent": "true",
            "time": iso(t),
        }
    )
    img = Image.open(io.BytesIO(http_get(f"{WMS}?{q}"))).convert("RGBA")
    return ix, iy, img


def fetch_frame(t: dt.datetime) -> tuple[Image.Image, float]:
    tx, ty = P["tiles"]
    tw, th = P["width"] // tx, P["height"] // ty
    canvas = Image.new("L" if P["gray"] else "RGB", (P["width"], P["height"]), 0)
    with cf.ThreadPoolExecutor(max_workers=24) as pool:
        jobs = [pool.submit(fetch_tile, t, ix, iy) for iy in range(ty) for ix in range(tx)]
        for job in cf.as_completed(jobs):
            ix, iy, img = job.result()
            if P["gray"]:
                r, _g, _b, a = img.split()
                gray = r.point(lambda v: max(1, v))  # 0 ist für „keine Daten“ reserviert
                canvas.paste(Image.composite(gray, Image.new("L", img.size, 0), a), (ix * tw, iy * th))
            else:
                canvas.paste(img.convert("RGB"), (ix * tw, iy * th))
    hist = canvas.convert("L").histogram()
    coverage = 1 - sum(hist[:2]) / (canvas.width * canvas.height)
    return canvas, coverage


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("product", choices=PRODUCTS)
    ap.add_argument("--out", help="Zielordner (Standard je Produkt)")
    ap.add_argument("--days", type=int, help="Archivdauer in Tagen (Standard je Produkt)")
    ap.add_argument("--max-new", type=int, default=60, help="höchstens so viele neue Bilder pro Lauf")
    args = ap.parse_args()
    P.update(PRODUCTS[args.product])
    STEP = dt.timedelta(hours=P["step_h"])
    args.days = args.days or P["days"]

    out = Path(args.out or P["out"])
    out.mkdir(parents=True, exist_ok=True)
    # Ausschnitt geändert? Dann passen die alten Bilder nicht mehr → Archiv neu anfangen
    idx_file = out / "index.json"
    if idx_file.exists():
        old = json.loads(idx_file.read_text()).get("rect")
        if old is not None and list(old) != list(P["rect"]):
            print("Ausschnitt geändert – altes Archiv wird geleert")
            for f in out.glob("*.webp"):
                f.unlink()
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
            img.save(f, "WEBP", quality=P["quality"], method=5)
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
        json.dumps(
            {"updated": iso(dt.datetime.now(dt.timezone.utc)), "stepHours": P["step_h"], "rect": list(P["rect"]), "frames": frames}
        )
    )
    print(f"{len(frames)} Bilder im Archiv, {new} neu")
    return 0 if frames else 1


if __name__ == "__main__":
    sys.exit(main())
