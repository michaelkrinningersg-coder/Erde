# Möglichst realgetreue Modelle von Raumstationen und Weltraumteleskopen als glTF (.glb) für die Cesium-App.
#
# Aufruf:  python tools/blender/raumfahrt.py <zielordner> [modelle …] [--vorschau <bildordner>] [--ansicht x,y,z]
#     oder blender -b -P tools/blender/raumfahrt.py -- <zielordner> [modelle …] [--vorschau <bildordner>]
#   z. B.  python tools/blender/raumfahrt.py public/models
#
# Maße in Metern, echte Abmessungen. Ursprung = Mitte des Modells (Mitte der Umgebungsbox).
# Blender (Z oben): +X = Flugrichtung, +Z = Zenit (von der Erde weg), +Y = links (backbord).
# Export mit glTF-Standard (+Y oben): glTF +X = Flugrichtung, +Y = Zenit, +Z = rechts (steuerbord).
# Teleskope: Längsachse entlang X, Öffnung nach +X (JWST: Spiegel blickt nach +X, Sonnenschild unten).
# Alle Teile eines Modells werden zu einem Mesh vereint (wenige Zeichenaufrufe), Texturen sind klein
# und prozedural (Solarzellen-Raster, Folienknitter, Paneelfugen) und stecken in der .glb.
import bpy, bmesh, math, sys, os, json
import numpy as np
from mathutils import Vector

X, Y, Z = Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))


def V(*a):
    return Vector(a[0] if len(a) == 1 else a)


# ---------------------------------------------------------------- Materialien und Texturen

def lin(c):
    """sRGB -> linear"""
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


# Farbe (sRGB), Metallisch, Rauheit, Textur, Kachelgröße der Textur in m
MAT = {
    "weiss": dict(c=(0.88, 0.88, 0.86), m=0.0, r=0.55, tex="paneele", tile=2.2),   # Druckmodule (MMOD-Schutz)
    "creme": dict(c=(0.84, 0.82, 0.76), m=0.0, r=0.6, tex="paneele", tile=1.6),    # russische Module
    "radiator": dict(c=(0.94, 0.94, 0.95), m=0.0, r=0.3, tex="paneele", tile=1.1),
    "silber": dict(c=(0.86, 0.87, 0.89), m=0.55, r=0.3, tex="folie", tile=1.2),    # aluminisierte Folie
    "gold": dict(c=(1.0, 0.74, 0.32), m=0.8, r=0.3, tex="folie", tile=1.2),       # Kapton-Isolierfolie
    "spiegel": dict(c=(1.0, 0.80, 0.42), m=1.0, r=0.05),                           # vergoldetes Beryllium
    "zellen": dict(c=(1.0, 1.0, 1.0), m=0.35, r=0.2, tex="zellen", tile=1.0),      # Solarzellen
    "rueck": dict(c=(0.66, 0.44, 0.18), m=0.55, r=0.45),                           # Rückseite Solarflügel
    "grau": dict(c=(0.62, 0.63, 0.65), m=0.85, r=0.38),                            # Gitter, Ringe
    "dunkel": dict(c=(0.20, 0.20, 0.22), m=0.4, r=0.5),
    "schwarz": dict(c=(0.03, 0.03, 0.035), m=0.0, r=0.65),
    "violett": dict(c=(0.82, 0.72, 0.92), m=1.0, r=0.16),                          # JWST-Sonnenschild
    "glas": dict(c=(0.06, 0.09, 0.14), m=0.9, r=0.05),
    "carbon": dict(c=(0.13, 0.13, 0.14), m=0.3, r=0.45),
    "lack": dict(c=(0.93, 0.93, 0.92), m=0.0, r=0.35),                             # Raketenlack
    "russ": dict(c=(0.05, 0.05, 0.05), m=0.0, r=0.85),                             # Hitzeschild, Zwischenstufe
    "duese": dict(c=(0.16, 0.15, 0.15), m=0.9, r=0.4),                             # Triebwerksdüsen
    "rot": dict(c=(0.80, 0.10, 0.08), m=0.0, r=0.8),                               # Fallschirmbahnen
    "stoff": dict(c=(0.95, 0.95, 0.93), m=0.0, r=0.8),
    "leine": dict(c=(0.80, 0.78, 0.72), m=0.0, r=0.7),
    "plasma": dict(c=(1.0, 0.45, 0.12), m=0.0, r=0.5, e=4.0, a=0.35),              # Wiedereintrittsglühen
    "plasma_kern": dict(c=(1.0, 0.70, 0.30), m=0.0, r=0.5, e=10.0, a=0.7),
}
_mats, _tex = {}, {}


def _textur(name):
    """Kleine, kachelbare Texturen (Werte sRGB 0..1)"""
    if name in _tex:
        return _tex[name]
    n = 128
    rng = np.random.default_rng(3)
    if name == "zellen":
        # 8 × 8 Zellen dunkelblau, feine goldbraune Fugen, Kachelrand etwas breiter
        img = np.empty((n, n, 3))
        img[:] = (0.05, 0.09, 0.24)
        yy, xx = np.mgrid[0:n, 0:n]
        img[..., 2] += 0.06 * np.sin(xx / n * 2 * math.pi) * np.sin(yy / n * 2 * math.pi)
        fuge = ((xx % 16) == 0) | ((yy % 16) == 0)
        rand = (xx < 2) | (yy < 2)
        img[fuge] = (0.45, 0.40, 0.33)
        img[rand] = (0.62, 0.48, 0.26)
    elif name == "folie":
        # geknitterte Folie: weiches Rauschen (kreisförmig geglättet, damit es nahtlos kachelt) + feine Falten
        a = rng.random((n, n))
        for _ in range(3):
            a = (a + np.roll(a, 1, 0) + np.roll(a, -1, 0) + np.roll(a, 1, 1) + np.roll(a, -1, 1)) / 5
        a = (a - a.min()) / (a.max() - a.min())
        fein = rng.random((n, n))
        v = 0.80 + 0.17 * a + 0.05 * fein
        for _ in range(14):  # Knickfalten
            y0, ang, ln = rng.integers(0, n), rng.random() * math.pi, rng.integers(20, 70)
            x0 = rng.integers(0, n)
            for t in range(ln):
                xi = int(x0 + t * math.cos(ang)) % n
                yi = int(y0 + t * math.sin(ang)) % n
                v[yi, xi] *= 0.82
        img = np.repeat(np.clip(v, 0, 1)[..., None], 3, axis=2)
    else:  # paneele: Fugen zwischen Schutzblechen, dazu einige Nieten
        img = np.ones((n, n, 3))
        yy, xx = np.mgrid[0:n, 0:n]
        img[(xx < 2) | (yy < 2)] = 0.70
        img[(xx == 64) & (yy > 1)] = 0.86
        img[((xx % 32) == 8) & ((yy % 32) == 8)] = 0.78
    rgba = np.concatenate([img, np.ones((n, n, 1))], axis=2).astype(np.float32)
    im = bpy.data.images.new(name, n, n, alpha=False)
    im.pixels.foreach_set(rgba.ravel())
    im.pack()
    _tex[name] = im
    return im


def material(key):
    if key in _mats:
        return _mats[key]
    s = MAT[key]
    m = bpy.data.materials.new(key)
    try:
        m.use_nodes = True
    except Exception:
        pass
    nt = m.node_tree
    b = nt.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*lin(s["c"]), 1)
    b.inputs["Metallic"].default_value = s["m"]
    b.inputs["Roughness"].default_value = s["r"]
    if s.get("e"):
        b.inputs["Emission Color"].default_value = (*lin(s["c"]), 1)
        b.inputs["Emission Strength"].default_value = s["e"]
    if s.get("a"):
        b.inputs["Alpha"].default_value = s["a"]
        for attr, val in (("surface_render_method", "BLENDED"), ("blend_method", "BLEND")):
            try:
                setattr(m, attr, val)
            except Exception:
                pass
    if s.get("tex"):
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = _textur(s["tex"])
        t.interpolation = "Linear"
        if s["c"] == (1.0, 1.0, 1.0):
            nt.links.new(t.outputs["Color"], b.inputs["Base Color"])
        else:
            # Textur × Grundfarbe (glTF: baseColorTexture × baseColorFactor)
            mix = nt.nodes.new("ShaderNodeMix")
            mix.data_type = "RGBA"
            mix.blend_type = "MULTIPLY"
            mix.inputs[0].default_value = 1.0
            ins = {i.identifier: i for i in mix.inputs}
            ins["B_Color"].default_value = (*lin(s["c"]), 1)
            nt.links.new(t.outputs["Color"], ins["A_Color"])
            outs = {o.identifier: o for o in mix.outputs}
            nt.links.new(outs["Result_Color"], b.inputs["Base Color"])
    _mats[key] = m
    return m


# ---------------------------------------------------------------- Bausteine (alles in ein bmesh)

def basis(d, up=None):
    """Zwei Einheitsvektoren senkrecht zu d (a waagerecht, b „oben“)"""
    d = Vector(d).normalized()
    if up is None:
        up = Z if abs(d.z) < 0.95 else X
    a = Vector(up).cross(d).normalized()
    return a, d.cross(a)


class Bau:
    def __init__(s):
        s.bm = bmesh.new()
        s.uv = s.bm.loops.layers.uv.new("UVMap")
        s.keys = []

    def _mi(s, key):
        if key not in s.keys:
            s.keys.append(key)
        return s.keys.index(key)

    def _face(s, verts, key, uvs, glatt=False):
        try:
            f = s.bm.faces.new(verts)
        except ValueError:
            return None
        f.material_index = s._mi(key)
        f.smooth = glatt
        for lp, uv in zip(f.loops, uvs):
            lp[s.uv].uv = uv
        return f

    def box(s, c, size, key, ax=(X, Y, Z), keys=None, tile=None):
        """Quader um Mittelpunkt c; ax = lokale Achsen; keys z. B. {"+z": "zellen"}; tile je Achse (m)"""
        c = V(c)
        h = [x / 2 for x in size]
        ax = [Vector(a).normalized() for a in ax]
        for a in range(3):
            for sg in (1, -1):
                k = (keys or {}).get(("+" if sg > 0 else "-") + "xyz"[a], key)
                ua, va = ((a + 1) % 3, (a + 2) % 3) if sg > 0 else ((a + 2) % 3, (a + 1) % 3)
                t = tile or (MAT[k].get("tile", 2.0),) * 3
                vs, uvs = [], []
                for u, v in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
                    p = [0, 0, 0]
                    p[a], p[ua], p[va] = sg * h[a], u * h[ua], v * h[va]
                    vs.append(s.bm.verts.new(c + ax[0] * p[0] + ax[1] * p[1] + ax[2] * p[2]))
                    uvs.append(((p[ua] + h[ua]) / t[ua], (p[va] + h[va]) / t[va]))
                s._face(vs, k, uvs)

    def lathe(s, p0, d, prof, key, n=24, glatt=True, phase=0.0, up=None, deckel=(False, False), keys_deckel=None,
              key_seg=None):
        """Drehkörper: prof = [(Abstand entlang d, Radius), …] ab p0"""
        p0, d = V(p0), Vector(d).normalized()
        a, b = basis(d, up)
        t = MAT[key].get("tile", 2.0)
        rings = []
        for x, r in prof:
            r = max(r, 0.002)
            rings.append([s.bm.verts.new(p0 + d * x + (a * math.cos(phase + 2 * math.pi * i / n) +
                                                      b * math.sin(phase + 2 * math.pi * i / n)) * r)
                          for i in range(n)])
        acc = 0.0
        for j in range(len(prof) - 1):
            (x0, r0), (x1, r1) = prof[j], prof[j + 1]
            l = math.hypot(x1 - x0, r1 - r0)
            for i in range(n):
                k = (i + 1) % n
                u0, u1 = i / n, (i + 1) / n
                cu = 2 * math.pi * max(r0, r1, 0.05) / t
                s._face([rings[j][i], rings[j][k], rings[j + 1][k], rings[j + 1][i]], key_seg(i) if key_seg else key,
                        [(u0 * cu, acc / t), (u1 * cu, acc / t), (u1 * cu, (acc + l) / t), (u0 * cu, (acc + l) / t)],
                        glatt)
            acc += l
        kd = keys_deckel or (key, key)
        for idx, on, k in ((0, deckel[0], kd[0]), (-1, deckel[1], kd[1])):
            if on:
                ring = rings[idx] if idx == -1 else list(reversed(rings[idx]))
                r = max(prof[idx][1], 0.002)
                tt = MAT[k].get("tile", 2.0)
                uvs = []
                for v in ring:
                    q = v.co - (p0 + d * prof[idx][0])
                    uvs.append((q.dot(a) / tt + 0.5, q.dot(b) / tt + 0.5))
                s._face(ring, k, uvs)

    def cyl(s, p0, p1, r0, key, r1=None, n=24, deckel=(True, True), glatt=True, phase=0.0, up=None, keys_deckel=None):
        p0, p1 = V(p0), V(p1)
        L = (p1 - p0).length
        if L < 1e-5:
            return
        s.lathe(p0, p1 - p0, [(0, r0), (L, r0 if r1 is None else r1)], key, n, glatt and n > 8, phase, up,
                deckel, keys_deckel)

    def rod(s, p0, p1, w, key):
        """Dünner Stab mit quadratischem Querschnitt (8 Dreiecke)"""
        s.cyl(p0, p1, w * 0.707, key, n=4, deckel=(False, False), glatt=False, phase=math.pi / 4)

    def strut(s, p0, p1, r, key):
        s.cyl(p0, p1, r, key, n=6, deckel=(False, False), glatt=True)

    def sphere(s, c, r, key, n=20, m=10):
        prof = [(-r * math.cos(math.pi * i / m), r * math.sin(math.pi * i / m)) for i in range(m + 1)]
        s.lathe(c, X, prof, key, n)

    def dish(s, c, d, R, depth, key, n=18, m=3, key_back=None):
        """Parabolantenne: Öffnung zeigt in Richtung d, Scheitel bei c"""
        prof = [(depth * (k / m) ** 2, R * k / m) for k in range(m + 1)]
        s.lathe(c, d, prof, key, n)
        if key_back:  # Rückseite etwas versetzt, damit man Vorder- und Rückseite unterscheidet
            s.lathe(V(c) - Vector(d).normalized() * 0.02, d, prof, key_back, n)

    def poly(s, pts, key, tile=None):
        pts = [V(p) for p in pts]
        e1 = (pts[1] - pts[0]).normalized()
        nrm = (pts[1] - pts[0]).cross(pts[2] - pts[0]).normalized()
        e2 = nrm.cross(e1)
        t = tile or MAT[key].get("tile", 2.0)
        s._face([s.bm.verts.new(p) for p in pts], key,
                [((p - pts[0]).dot(e1) / t, (p - pts[0]).dot(e2) / t) for p in pts])

    def fan(s, center, rim, key, tile=None):
        """Fläche als Fächer um einen (höher/tiefer liegenden) Mittelpunkt, z. B. gespannte Folie"""
        center = V(center)
        t = tile or MAT[key].get("tile", 2.0)
        c = s.bm.verts.new(center)
        vs = [s.bm.verts.new(V(p)) for p in rim]
        for i in range(len(vs)):
            j = (i + 1) % len(vs)
            s._face([c, vs[i], vs[j]], key, [(center.x / t, center.y / t), (rim[i][0] / t, rim[i][1] / t),
                                            (rim[j][0] / t, rim[j][1] / t)], glatt=True)

    def prism(s, pts, v, key):
        """Grundfläche pts (eben, Reihenfolge egal) um Vektor v extrudiert"""
        pts = [V(p) for p in pts]
        v = V(v)
        nrm = (pts[1] - pts[0]).cross(pts[2] - pts[0])
        if nrm.dot(v) > 0:
            pts = list(reversed(pts))
        t = MAT[key].get("tile", 2.0)
        lo = [s.bm.verts.new(p) for p in pts]
        hi = [s.bm.verts.new(p + v) for p in pts]
        flat = lambda p: ((p - pts[0]).x / t + (p - pts[0]).z / t, (p - pts[0]).y / t)
        s._face(lo, key, [flat(p) for p in pts])
        s._face(list(reversed(hi)), key, [flat(p) for p in reversed(pts)])
        acc = 0.0
        for i in range(len(pts)):
            j = (i + 1) % len(pts)
            l = (pts[j] - pts[i]).length
            s._face([lo[j], lo[i], hi[i], hi[j]], key,
                    [((acc + l) / t, 0), (acc / t, 0), (acc / t, v.length / t), ((acc + l) / t, v.length / t)])
            acc += l

    def panel(s, c, along, across, L, W, cell=(1.0, 1.0), t=0.05, nach=Z, key="zellen", back="rueck"):
        """Solarpaneel L × W: Zellenseite zeigt (möglichst) in Richtung nach, Rückseite goldbraun"""
        along, across = Vector(along).normalized(), Vector(across).normalized()
        nrm = along.cross(across)
        front = 1 if nrm.dot(Vector(nach)) >= 0 else -1
        s.box(c, (L, W, t), back, ax=(along, across, nrm), keys={("+z" if front > 0 else "-z"): key},
              tile=(cell[0], cell[1], 1.0))

    def truss(s, p0, p1, a, w, h, bays, key, rod=0.16, diag=True):
        """Gitterträger mit Rechteckquerschnitt w × h (w entlang a), Längsstäbe, Rahmen und Diagonalen"""
        p0, p1 = V(p0), V(p1)
        d = (p1 - p0)
        a = Vector(a).normalized()
        b = d.normalized().cross(a).normalized()
        cs = [a * (w / 2 * i) + b * (h / 2 * j) for i, j in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
        for c in cs:
            s.rod(p0 + c, p1 + c, rod * 1.4, key)
        for k in range(bays + 1):
            q = p0 + d * (k / bays)
            for i in range(4):
                s.rod(q + cs[i], q + cs[(i + 1) % 4], rod, key)
            if diag and k < bays:
                q2 = p0 + d * ((k + 1) / bays)
                for i in range(4):
                    j = (i + 1) % 4
                    if k % 2:
                        s.rod(q + cs[i], q2 + cs[j], rod * 0.8, key)
                    else:
                        s.rod(q + cs[j], q2 + cs[i], rod * 0.8, key)

    def fertig(s, name, zentrieren=True):
        """bmesh -> ein Objekt, Ursprung in die Mitte der Umgebungsbox (oder Einbaulage beibehalten)"""
        if zentrieren:
            co = np.array([v.co[:] for v in s.bm.verts])
            mid = (co.min(0) + co.max(0)) / 2
            for v in s.bm.verts:
                v.co -= Vector(mid)
        me = bpy.data.meshes.new(name)
        s.bm.normal_update()
        s.bm.to_mesh(me)
        s.bm.free()
        for k in s.keys:
            me.materials.append(material(k))
        obj = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(obj)
        return obj


# ---------------------------------------------------------------- Wiederkehrende Baugruppen

def iss_saw(b, root, d, y0, irosa=False):
    """Ein ISS-Solarflügel (SAW): Kasten am Truss, Mast in der Mitte, zwei Decken 4,6 m × 32 m"""
    d = Vector(d)
    kz = root.z
    b.box(root + d * 0.7, (1.4, 11.0, 0.9), "grau", ax=(d, Y, Z))                    # Behälter (SABB)
    L, W, gap = 31.5, 4.6, 0.55
    for side in (-1, 1):
        cy = y0 + side * (gap + W / 2)
        b.panel(V(root.x, cy, kz) + d * (1.4 + L / 2), d, Y, L, W, cell=(1.0, 1.15), t=0.04)
    b.rod(root + d * 1.4, root + d * (1.4 + L + 0.3), 0.35, "grau")                   # Mast
    b.box(root + d * (1.6 + L), (0.5, 10.6, 0.3), "grau", ax=(d, Y, Z))               # Endstange
    if irosa:
        # nachgerüsteter Roll-out-Flügel (iROSA, 18,3 m × 6 m) schräg über der inneren Flügelhälfte
        a = (d + Z * 0.09).normalized()
        base = root + d * 1.8 + Z * 0.9
        b.panel(base + a * 9.15, a, Y, 18.3, 6.0, cell=(1.0, 1.0), t=0.04)
        for side in (-1, 1):
            b.rod(root + d * 1.0 + Y * side * 2.0, base + Y * side * 2.4, 0.2, "grau")
            b.rod(root + d * 6.0 + Y * side * 2.4, base + a * 4.0 + Y * side * 2.4, 0.15, "grau")


def soyuz(b, p0, d, wings=True, progress=False):
    """Sojus (bzw. Progress): Bahnmodul/Frachtteil an p0 (angedockt), Richtung d weg von der Station"""
    d = Vector(d).normalized()
    p0 = V(p0)
    if progress:
        b.lathe(p0, d, [(0, 0.5), (0.4, 1.1), (1.2, 1.35), (2.7, 1.35), (3.1, 1.1)], "creme", 20)
        b.cyl(p0 + d * 3.1, p0 + d * 4.4, 1.1, "creme", n=20, deckel=(False, False))
    else:
        b.sphere(p0 + d * 1.2, 1.13, "creme", 16, 8)                                    # Orbitalmodul
        b.lathe(p0 + d * 2.3, d, [(0, 0.95), (2.1, 1.1), (2.2, 1.0)], "dunkel", 18)       # Landekapsel
    q = p0 + d * 4.4
    b.lathe(q, d, [(0, 1.1), (0.3, 1.36), (2.6, 1.36), (2.9, 1.2)], "creme", 20, deckel=(False, True))
    if wings:
        a, _ = basis(d, Z if abs(d.z) < 0.9 else X)
        for sg in (1, -1):
            b.panel(q + d * 1.2 + a * sg * (1.36 + 2.5), a, d, 4.4, 1.2, cell=(0.6, 0.6))


def tuer(b, front_x, r, hinge_z, winkel, key="silber"):
    """Geöffnete Aperturklappe (Scheibe r) an der Vorderkante front_x, Scharnier oben"""
    th = math.radians(winkel)
    v = Vector((math.sin(th), 0, -math.cos(th))) * r      # Scharnier -> Mitte
    nrm = Vector((math.cos(th), 0, math.sin(th)))
    c = Vector((front_x, 0, hinge_z)) + v
    b.cyl(c - nrm * 0.05, c + nrm * 0.05, r, key, n=24, keys_deckel=("gold", key))


# ---------------------------------------------------------------- Modelle

def iss():
    """ISS: Truss entlang Y (backbord +Y), Module entlang X, Destiny-Mitte bei x = 0"""
    b = Bau()
    zt, tw, th = 4.9, 4.4, 3.6                                    # Truss-Höhe (Mitte), Breite (X), Höhe (Z)
    # US-Module (weiß) und Verbindungsringe
    b.cyl((-4.25, 0, 0), (4.25, 0, 0), 2.15, "weiss", keys_deckel=("grau", "grau"))      # Destiny
    b.cyl((4.25, 0, 0), (4.65, 0, 0), 1.0, "grau", deckel=(False, False))
    b.cyl((4.65, 0, 0), (11.85, 0, 0), 2.2, "weiss", keys_deckel=("grau", "grau"))      # Harmony
    b.cyl((11.85, 0, 0), (13.6, 0, 0), 1.25, "grau", r1=0.9)                            # PMA-2 + IDA
    # angedockte Crew Dragon vorn
    b.lathe((13.7, 0, 0), X, [(0, 0.6), (0.4, 0.9), (2.9, 1.95), (3.5, 1.95)], "weiss", 24)
    b.cyl((17.2, 0, 0), (21.6, 0, 0), 1.85, "weiss", deckel=(False, True))
    b.cyl((17.2, 0, 0), (21.6, 0, 0), 1.86, "zellen", n=12, deckel=(False, False))
    b.cyl((-4.25, 0, 0), (-4.65, 0, 0), 1.0, "grau", deckel=(False, False))
    b.cyl((-4.65, 0, 0), (-10.15, 0, 0), 2.28, "weiss", keys_deckel=("grau", "grau"))   # Unity
    b.cyl((-10.15, 0, 0), (-12.5, 0, 0), 1.0, "grau", r1=1.3)                           # PMA-1
    # russisches Segment (cremeweiß)
    b.lathe((-12.5, 0, 0), -X, [(0, 1.3), (1.0, 1.4), (3.4, 2.05), (12.6, 2.05)], "creme", 24,
            deckel=(True, True))                                                        # Zarya
    b.cyl((-25.1, 0, 0), (-25.5, 0, 0), 0.8, "grau", deckel=(False, False))
    b.sphere((-26.6, 0, 0), 1.15, "creme", 18, 9)                                       # Zvezda-Übergangsraum
    b.lathe((-27.6, 0, 0), -X, [(0, 1.45), (3.1, 1.45), (4.1, 2.15), (9.4, 2.15), (9.6, 1.0), (11.0, 1.0)],
            "creme", 24, deckel=(False, True))                                          # Zvezda
    for sg in (1, -1):                                                                  # Zvezda-Solarflügel
        b.rod((-29.2, sg * 1.4, 0), (-29.2, sg * 2.4, 0), 0.25, "grau")
        b.panel((-29.2, sg * (2.4 + 6.2), 0), Y, X, 12.4, 3.0, cell=(0.8, 0.75))
    soyuz(b, (-38.6, 0, 0), -X, progress=True)                                          # Progress achtern
    b.cyl((-26.6, 0, 1.1), (-26.6, 0, 4.8), 1.25, "creme", n=20, keys_deckel=("grau", "grau"))  # Poisk
    soyuz(b, (-26.6, 0, 4.8), Z, progress=True)
    b.lathe((-26.6, 0, -1.1), -Z, [(0, 1.3), (0.8, 2.1), (11.5, 2.1), (12.3, 1.3)], "creme", 24,
            deckel=(False, True))                                                       # Nauka
    for sg in (1, -1):
        b.panel((-26.6, sg * (2.1 + 3.2), -8.0), Y, Z, 5.6, 2.2, cell=(0.8, 0.75))
    b.sphere((-26.6, 0, -14.6), 1.65, "creme", 18, 9)                                    # Prichal
    b.cyl((-20.0, 0, -2.0), (-20.0, 0, -7.6), 1.17, "creme", n=20)                       # Rassvet
    soyuz(b, (-20.0, 0, -7.6), -Z)                                                       # Sojus unten
    # Tranquility (Node 3, backbord an Unity) mit Cupola, Leonardo und BEAM
    b.cyl((-7.4, 2.3, 0), (-7.4, 9.0, 0), 2.25, "weiss", keys_deckel=("grau", "grau"))
    b.lathe((-7.4, 6.2, -2.2), -Z, [(0, 1.48), (1.0, 1.48), (1.5, 1.0)], "grau", 7, glatt=False, deckel=(False, True),
            keys_deckel=("grau", "glas"))
    b.cyl((-5.2, 6.4, 0), (1.2, 6.4, 0), 2.2, "weiss", keys_deckel=("grau", "grau"))     # Leonardo (PMM)
    b.lathe((-9.6, 6.4, 0), -X, [(0, 1.0), (0.4, 1.6), (3.6, 1.6), (4.0, 1.0)], "weiss", 20, deckel=(False, True))
    # Quest-Luftschleuse (steuerbord an Unity)
    b.cyl((-7.4, -2.3, 0), (-7.4, -4.9, 0), 2.0, "weiss")
    b.cyl((-7.4, -4.9, 0), (-7.4, -7.3, 0), 1.0, "weiss")
    # Columbus (steuerbord) und Kibo (backbord) an Harmony
    b.cyl((8.2, -2.2, 0), (8.2, -9.1, 0), 2.25, "weiss", keys_deckel=("grau", "grau"))
    b.box((8.2, -9.6, 0), (2.6, 1.0, 2.6), "gold")                                       # Außenplattformen
    b.cyl((8.2, 2.2, 0), (8.2, 13.4, 0), 2.2, "weiss", keys_deckel=("grau", "grau"))     # Kibo-PM
    b.cyl((8.2, 6.5, 2.0), (8.2, 6.5, 6.2), 2.1, "weiss", keys_deckel=("grau", "grau"))  # Kibo-ELM-PS
    b.box((8.2, 16.6, -0.4), (5.0, 5.6, 0.8), "grau")                                    # Kibo-Exposed Facility
    for i, (dx, dy) in enumerate(((-1.4, -1.6), (1.3, -1.0), (-1.2, 1.4), (1.4, 1.6))):
        b.box((8.2 + dx, 16.6 + dy, 0.5), (1.8, 1.6, 1.0), ("gold", "silber", "weiss", "gold")[i])
    b.cyl((8.2, 0, 2.2), (8.2, 0, 4.0), 1.25, "grau", r1=0.9)                            # PMA-3 oben
    # Integrated Truss Structure
    b.truss((0, -54.5, zt), (0, 54.5, zt), X, tw, th, 48, "grau", rod=0.17)
    b.box((0, 0, zt), (tw * 0.9, 13.4, th * 0.8), "silber")                              # S0
    for sg in (1, -1):
        b.box((0, sg * 13.6, zt), (tw * 0.6, 13.0, th * 0.55), "grau")                    # S1/P1 Ausrüstung
        b.box((0, sg * 23.2, zt), (tw * 0.5, 5.0, th * 0.5), "dunkel")                    # S3/P3
        b.cyl((0, sg * 26.0, zt), (0, sg * 27.0, zt), 2.4, "grau", n=16)                  # SARJ
        for yy in (31.0, 44.5):
            b.box((0, sg * yy, zt), (tw * 0.55, 6.0, th * 0.55), "dunkel")                # Batterien/Elektronik
        b.box((0, sg * 39.9, zt), (tw * 0.8, 3.0, th * 0.8), "grau")                      # S5/P5
        # ELC-Paletten oben/unten auf S3/P3
        b.box((0, sg * 23.2, zt + th / 2 + 0.55), (3.8, 4.4, 1.1), "weiss")
        b.box((0, sg * 23.2, zt - th / 2 - 0.55), (3.8, 4.4, 1.1), "weiss")
        # Hauptradiatoren (HRS) an S1/P1: drei Paneele, nach unten und etwas nach achtern
        tilt = math.radians(25)
        L = Vector((-math.sin(tilt), 0, -math.cos(tilt)))
        nrm = L.cross(Y)
        root = Vector((0, sg * 13.6, zt - th / 2))
        b.box(root + L * 0.6, (1.2, 11.2, 1.2), "grau", ax=(L, Y, nrm))
        for k in (-1, 0, 1):
            b.box(root + L * (1.2 + 11.6) + Y * (k * 3.6), (23.2, 3.3, 0.12), "radiator", ax=(L, Y, nrm),
                  tile=(1.45, 3.3, 1))
        # Solarflügel-Paare (S4/P4 und S6/P6), Flügel entlang ±X, Zellen nach oben
        for yy in (33.5, 47.5):
            y0 = sg * yy
            b.box((0, y0, zt), (tw + 1.0, 2.0, 2.0), "grau")                              # Beta-Gimbal
            for dx in (1, -1):
                # iROSA auf 6 von 8 Flügeln (ohne: 2A auf P4, 3B auf S6)
                ohne = (sg > 0 and yy < 40 and dx > 0) or (sg < 0 and yy > 40 and dx < 0)
                iss_saw(b, V(dx * (tw / 2 + 0.3), y0, zt), (dx, 0, 0), y0, irosa=not ohne)
        # Photovoltaik-Radiatoren zwischen den Paaren (nach unten)
        b.box((0, sg * 40.5, zt - th / 2 - 6.8), (3.3, 0.12, 13.0), "radiator", tile=(3.3, 1, 1.45))
    b.box((0, -27.0 + 3.6, zt + th / 2 + 1.6), (3.0, 3.0, 3.0), "silber")                  # AMS-02 auf S3
    b.cyl((0, -23.4, zt + th / 2 + 3.1), (0, -23.4, zt + th / 2 + 3.6), 1.5, "grau", n=16)
    # Stützen Destiny -> S0
    for dx in (-2.5, 2.5):
        for dy in (-1.2, 1.2):
            b.rod((dx, dy, 1.4), (dx * 0.8, dy * 2, zt - th / 2), 0.25, "grau")
    # Canadarm2 auf der Mobile Base vor dem Truss
    mb = V(tw / 2 + 0.8, -9.0, zt)
    b.box(mb, (1.6, 4.0, 3.0), "grau")
    e = mb + V(4.0, 0.0, 6.2)
    b.cyl(mb + V(0.8, 0, 1.2), e, 0.2, "weiss", n=10)
    b.cyl(e, e + V(6.5, 0.4, -3.0), 0.2, "weiss", n=10)
    b.sphere(e, 0.4, "grau", 10, 5)
    # Kibo-Roboterarm
    b.cyl((8.2, 13.4, 1.8), (8.2, 18.0, 5.0), 0.12, "weiss", n=8)
    return b


def tiangong():
    """Tiangong: Tianhe entlang X (Knoten vorn bei x = 0), Wentian/Mengtian entlang ±Y (T-Form)"""
    b = Bau()
    b.sphere((0, 0, 0), 1.4, "weiss", 20, 10)                                             # Knotenmodul
    b.cyl((1.3, 0, 0), (1.9, 0, 0), 0.8, "grau")
    b.cyl((0, 0, -1.3), (0, 0, -1.9), 0.8, "grau")
    b.lathe((-1.0, 0, 0), -X, [(0, 1.4), (4.2, 1.4), (5.0, 2.1), (9.6, 2.1), (9.9, 1.4), (13.4, 1.4),
                               (13.9, 1.0)], "weiss", 24, deckel=(False, True))           # Tianhe
    for sg in (1, -1):                                                                    # Tianhe-Flügel ±Z
        b.rod((-8.3, 0, sg * 2.1), (-8.3, 0, sg * 2.8), 0.25, "grau")
        b.panel((-8.3, 0, sg * (2.8 + 5.4)), Z, X, 10.8, 2.9, cell=(0.9, 0.725))
    # Tianzhou achtern, Shenzhou vorn
    b.cyl((-14.9, 0, 0), (-16.0, 0, 0), 0.8, "grau", r1=1.0)
    b.cyl((-16.0, 0, 0), (-21.0, 0, 0), 1.675, "weiss", n=20, deckel=(True, False))
    b.cyl((-21.0, 0, 0), (-25.5, 0, 0), 1.675, "gold", n=20, deckel=(False, True))
    for sg in (1, -1):
        b.panel((-23.0, sg * (1.7 + 3.7), 0), Y, X, 7.2, 1.8, cell=(0.6, 0.6))
    b.lathe((1.9, 0, 0), X, [(0, 0.5), (0.3, 1.1), (2.3, 1.1), (2.6, 0.7)], "weiss", 18, deckel=(False, True))
    b.lathe((4.6, 0, 0), X, [(0, 0.8), (2.0, 1.25)], "dunkel", 18, deckel=(False, True))
    b.cyl((6.6, 0, 0), (9.5, 0, 0), 1.4, "weiss", n=18, deckel=(False, True))
    for sg in (1, -1):
        b.panel((8.0, sg * (1.4 + 3.6), 0), Y, X, 7.0, 2.0, cell=(0.7, 0.66))
    # Laborkabinen: Wentian (backbord +Y), Mengtian (steuerbord -Y)
    for sg in (1, -1):
        y = lambda v: sg * v
        b.cyl((0, y(1.3), 0), (0, y(1.9), 0), 0.8, "grau")
        b.lathe((0, y(1.9), 0), (0, sg, 0), [(0, 1.4), (1.0, 2.1), (11.5, 2.1), (12.0, 1.4), (17.0, 1.4),
                                             (17.6, 0.9)], "weiss", 24, deckel=(False, True))
        b.cyl((0, y(14.0), 1.35), (0, y(18.4), 1.35), 0.9, "gold", n=12)                  # Ausrüstung/Luftschleuse
        # große Flügel am äußeren Ende, Spannweite ≈ 55 m entlang X
        root = Vector((0, y(17.0), 0))
        b.box(root, (2.6, 1.2, 1.2), "grau")
        for dx in (1, -1):
            b.rod(root + V(dx * 1.3, 0, 0), root + V(dx * 27.5, 0, 0), 0.25, "grau")
            for half in (-1, 1):
                b.panel(root + V(dx * (1.6 + 12.9), half * 1.42, 0), X, Y, 25.8, 2.6, cell=(1.0, 0.87))
        if sg == 1:  # kleiner Roboterarm an Wentian
            b.cyl((1.6, y(4.0), 1.8), (4.0, y(9.0), 3.2), 0.1, "weiss", n=8)
        else:        # ausklappbare Nutzlastplattform an Mengtian
            b.box((0, y(15.0), -2.2), (3.4, 4.0, 0.4), "grau")
    # großer Roboterarm am Tianhe
    b.cyl((-7.0, 1.6, 2.0), (-2.0, 3.0, 4.5), 0.18, "weiss", n=10)
    b.cyl((-2.0, 3.0, 4.5), (3.0, 1.5, 3.5), 0.18, "weiss", n=10)
    return b


def hubble():
    """Hubble: Achse X, Öffnung bei +X, Flügel seitlich (±Y), Hochgewinnantennen oben/unten"""
    b = Bau()
    b.cyl((-6.6, 0, 0), (-3.2, 0, 0), 2.13, "silber", n=32, keys_deckel=("silber", "grau"))   # Achterteil
    b.cyl((-3.2, 0, 0), (-1.6, 0, 0), 2.15, "silber", n=10, glatt=False)                        # Ausrüstungsteil
    b.cyl((-1.6, 0, 0), (2.4, 0, 0), 1.56, "silber", n=32, keys_deckel=("grau", "grau"))       # Vorderteil
    b.cyl((2.4, 0, 0), (6.6, 0, 0), 1.55, "silber", n=32, deckel=(False, False))               # Lichtschutz
    b.cyl((2.3, 0, 0), (2.5, 0, 0), 1.6, "grau", n=32, deckel=(False, False))
    b.cyl((3.0, 0, 0), (6.6, 0, 0), 1.5, "schwarz", n=32, keys_deckel=("schwarz", "schwarz"),
          deckel=(True, False))                                                                 # innen dunkel
    tuer(b, 6.65, 1.6, 1.55, 105)
    for x in (-5.8, -4.6):                                                                      # Haltegriffe/Öffnungen
        b.box((x, 0, -2.13), (0.6, 1.2, 0.08), "grau")
    # Solarflügel SA3: lang parallel zur Achse
    for sg in (1, -1):
        b.rod((-1.4, sg * 1.5, 0.0), (-1.4, sg * 2.4, 0.0), 0.22, "grau")
        b.rod((-1.4, sg * 2.4, 0.0), (0.4, sg * 2.5, 0.0), 0.16, "grau")
        for half in (-1, 1):
            b.panel((0.4 + half * 1.8, sg * 3.75, 0), X, Y, 3.5, 2.6, cell=(0.7, 0.65), t=0.06, back="grau")
        b.rod((0.4 - 3.6, sg * 3.75, 0), (0.4 + 3.6, sg * 3.75, 0), 0.1, "grau")
    # Hochgewinnantennen auf Masten (±Z)
    for sg in (1, -1):
        b.rod((0.6, 0, sg * 1.5), (0.6, 0, sg * 4.6), 0.12, "grau")
        b.dish((0.6, 0, sg * 4.6), (0, 0, sg), 0.65, 0.3, "weiss", key_back="grau")
    b.rod((-6.6, 0, 1.2), (-7.0, 0, 1.2), 0.15, "grau")                                         # Niedriggewinnantenne
    b.rod((6.6, 0, -1.5), (6.9, 0, -1.5), 0.15, "grau")
    return b


def jwst():
    """JWST: fünflagiger Sonnenschild (unten, ~21 × 14 m), Spiegel blickt nach +X, Bus unter dem Schild"""
    b = Bau()
    # Sonnenschild: Ecken (X kurz, Y lang); Lagen nach oben kleiner, am Rand weiter auseinander
    rim = [(7.1, 4.0), (6.4, 7.4), (0.3, 10.6), (-6.4, 7.4), (-7.1, 4.0), (-7.1, -4.0), (-6.4, -7.4),
           (0.3, -10.6), (6.4, -7.4), (7.1, -4.0)]
    for k in range(5):
        f = 1.0 - 0.035 * k
        b.fan((0.0, 0.0, 0.05 + k * 0.09), [(x * f, y * f, 0.02 + k * 0.33) for x, y in rim], "violett", tile=2.0)
    for sg in (1, -1):
        b.strut((0.3, sg * 1.2, 0.0), (0.3, sg * 10.6, 1.0), 0.07, "grau")                     # Mittelausleger
        b.box((sg * 7.0, 0, -0.25), (0.6, 8.0, 0.4), "dunkel")                                  # Paletten vorn/hinten
    b.poly([(-7.3, -1.1, 0.0), (-7.3, 1.1, 0.0), (-8.9, 1.1, 0.55), (-8.9, -1.1, 0.55)], "violett")  # Trimmklappe
    # Bus (warme Seite), Solarpaneel nach -Z zur Sonne, Antenne
    b.box((-1.0, 0, -1.2), (3.0, 3.0, 1.6), "dunkel", keys={"+z": "silber"})
    b.box((-1.0, 0, -2.05), (2.0, 2.0, 0.1), "gold")
    b.panel((-5.6, 0, -1.9), X, Y, 5.6, 2.1, cell=(0.7, 0.7), t=0.05, nach=-Z, back="dunkel")
    b.rod((-2.5, 0, -1.9), (-2.8, 0, -1.9), 0.3, "grau")
    b.rod((0.3, 1.0, -2.0), (0.3, 1.0, -2.6), 0.08, "grau")
    b.dish((0.3, 1.0, -2.6), (0, 0, -1), 0.3, 0.12, "weiss", key_back="grau")
    # Turm von der Busoberseite bis zum ISIM
    xm, zc = -1.5, 5.0                                                                          # Spiegelfront, -mitte
    b.cyl((xm - 1.3, 0, -0.4), (xm - 1.3, 0, zc - 2.6), 0.35, "dunkel", n=12)
    b.box((xm - 1.3, 0, zc - 0.8), (1.6, 2.4, 3.0), "schwarz", keys={"-x": "silber"})          # ISIM
    b.box((xm - 0.8, 0, zc), (0.45, 3.0, 5.0), "schwarz")                                      # Rückwand
    # Hauptspiegel: 18 Sechsecke (Flachseite oben), konkav angeordnet, Spalte ±2 = Flügel
    R, roc = 1.32 / math.sqrt(3), 15.9
    for q in range(-2, 3):
        for r in range(-2, 3):
            if max(abs(q), abs(r), abs(q + r)) not in (1, 2):
                continue
            y, z = 1.5 * R * q, math.sqrt(3) * R * (r + q / 2)
            p = Vector((xm - (y * y + z * z) / (2 * roc), y, zc + z))
            n = (Vector((xm + roc, 0, zc)) - p).normalized()
            b.cyl(p - n * 0.14, p, R * 0.985, "schwarz", n=6, glatt=False, up=Z,
                  keys_deckel=("schwarz", "spiegel"))
    b.cyl((xm, 0, zc), (xm + 0.9, 0, zc), 0.32, "schwarz", n=12)                                # Nachfokus-Optik
    # Sekundärspiegel auf drei Streben (oben, unten links/rechts)
    sm = Vector((xm + 7.1, 0, zc))
    b.cyl(sm + V(0.15, 0, 0), sm, 0.37, "schwarz", n=16, keys_deckel=("schwarz", "spiegel"))
    for ang in (90, 210, 330):
        a = math.radians(ang)
        b.strut(sm + V(0.1, 0, 0), V(xm - 0.1, 3.1 * math.cos(a), zc + 3.1 * math.sin(a)), 0.05, "carbon")
    return b


def chandra():
    """Chandra: Achse X, Sonnenblende mit Klappe vorn (+X), ISIM hinten, zwei dreiteilige Flügel (±Y)"""
    b = Bau()
    b.cyl((4.2, 0, 0), (6.8, 0, 0), 1.2, "silber", n=24, deckel=(False, False))                # Sonnenblende
    b.cyl((4.6, 0, 0), (6.8, 0, 0), 1.15, "schwarz", n=24, deckel=(True, False))
    tuer(b, 6.85, 1.25, 1.2, 115)
    b.cyl((2.6, 0, 0), (4.2, 0, 0), 1.75, "gold", n=8, glatt=False, keys_deckel=("grau", "grau"))  # Raumfahrzeugteil
    b.cyl((-5.4, 0, 0), (2.6, 0, 0), 0.85, "silber", r1=0.95, n=24)                             # optische Bank
    for x in (-3.0, -0.5, 2.0):
        b.cyl((x - 0.08, 0, 0), (x + 0.08, 0, 0), 0.97, "grau", n=24, deckel=(False, False))
    b.box((-6.1, 0, 0), (1.4, 1.7, 1.7), "gold", keys={"+z": "radiator", "-z": "radiator"})    # ISIM
    b.box((-6.9, 0, 0.0), (0.2, 1.2, 1.2), "dunkel")
    for sg in (1, -1):
        b.rod((3.4, sg * 1.6, 0), (3.4, sg * 2.2, 0), 0.2, "grau")
        for i in range(3):
            b.panel((3.4, sg * (2.3 + 1.25 + i * 2.5), 0), Y, X, 2.45, 1.7, cell=(0.6, 0.57))
    b.dish((1.0, 0, -0.9), (0, 0, -1), 0.3, 0.1, "weiss", key_back="grau")
    b.rod((1.0, 0, -0.8), (1.0, 0, -0.9), 0.08, "grau")
    return b


def fermi():
    """Fermi: LAT oben (Zenit), Bus darunter, GBM-Detektoren, zwei Flügel (±Y)"""
    b = Bau()
    b.box((0, 0, 0.9), (1.8, 1.8, 0.72), "weiss", keys={"+z": "silber"}, tile=(0.45, 0.45, 0.45))   # LAT
    for sg in (1, -1):
        b.box((0, sg * 1.0, 0.75), (1.7, 0.08, 1.0), "radiator")                                   # LAT-Radiatoren
    b.box((0, 0, 0.0), (1.6, 1.6, 1.1), "gold")                                                     # Bus
    b.box((0, 0, -0.7), (1.2, 1.2, 0.3), "dunkel")
    for cx in (1, -1):                                                                              # GBM NaI
        for cy in (1, -1):
            for k in range(3):
                d = V(cx * 0.707, cy * 0.707, 0.3 * (k - 1)).normalized()
                p = V(cx * 0.82, cy * 0.82, 0.2 + 0.18 * k)
                b.cyl(p, p + d * 0.12, 0.065, "silber", n=10)
    for sg in (1, -1):                                                                              # GBM BGO
        b.cyl((0.65, sg * 0.82, -0.2), (0.65, sg * 0.82, 0.05), 0.065, "silber", n=10)
        b.rod((0, sg * 0.8, 0.0), (0, sg * 1.5, 0.0), 0.12, "grau")
        for i in range(2):
            b.panel((0, sg * (1.5 + 0.85 + i * 1.7), 0.0), Y, X, 1.65, 1.6, cell=(0.55, 0.53))
    b.rod((-0.8, 0.3, -0.5), (-1.6, 0.3, -1.1), 0.08, "grau")                                       # Ku-Antenne
    b.dish((-1.6, 0.3, -1.1), (-0.5, 0, -1), 0.35, 0.12, "weiss", key_back="grau")
    return b


def swift():
    """Swift: Achse X (Blickrichtung +X), BAT mit D-förmiger Maske, XRT- und UVOT-Tubus, zwei Flügel"""
    b = Bau()
    b.box((-2.0, 0, 0), (1.2, 1.9, 1.9), "gold")                                                    # Bus
    b.box((-1.32, 0, 0), (0.16, 2.4, 2.4), "grau")                                                  # optische Bank
    b.cyl((-1.25, 0.5, -0.65), (3.2, 0.5, -0.65), 0.3, "silber", n=16, keys_deckel=("grau", "schwarz"))  # XRT
    b.cyl((-1.25, -0.45, -0.65), (1.35, -0.45, -0.65), 0.25, "silber", n=16, keys_deckel=("grau", "schwarz"))  # UVOT
    # BAT: D-förmiges Prisma (gerade Seite unten), Maske oben drauf
    d = [(0.0, 1.35 * math.cos(math.pi * i / 10), -0.2 + 1.35 * math.sin(math.pi * i / 10)) for i in range(11)]
    b.prism([(1.4, y, z) for _, y, z in d], (1.3, 0, 0), "gold")
    b.prism([(2.7, y * 1.03, z + 0.01 * (z + 0.2)) for _, y, z in d], (0.1, 0, 0), "dunkel")
    b.box((0.4, 0, 0.3), (2.0, 1.4, 0.9), "silber")                                                 # BAT-Detektor/Träger
    for sg in (1, -1):
        b.rod((-1.8, sg * 0.95, 0), (-1.8, sg * 1.3, 0), 0.12, "grau")
        b.panel((-1.1, sg * (1.3 + 0.95), 0), X, Y, 2.6, 1.9, cell=(0.55, 0.47))
    b.box((-0.9, -1.0, 0.8), (0.4, 0.3, 0.3), "dunkel")                                             # Sternsensoren
    b.cyl((-2.6, 0.6, -0.95), (-2.6, 0.6, -1.25), 0.1, "weiss", n=8)
    return b


def nustar():
    """NuSTAR: Optikbank und Bus vorn (+X), 10 m ausfahrbarer Mast, Fokalbank hinten"""
    b = Bau()
    b.box((5.1, 0, 0), (0.2, 1.9, 1.2), "grau")                                                     # Optikbank
    for sg in (1, -1):
        b.cyl((5.2, sg * 0.45, 0), (5.75, sg * 0.45, 0), 0.22, "silber", n=16, keys_deckel=("grau", "schwarz"))
    b.box((4.35, 0, -0.1), (1.3, 1.3, 1.3), "gold")                                                 # Bus
    b.panel((4.35, -0.65 - 0.25 - 1.6, 0), Y, X, 3.2, 1.3, cell=(0.5, 0.43))              # ein Flügel
    b.rod((4.35, -0.65, 0), (4.35, -0.9, 0), 0.1, "grau")
    # ausfahrbarer Mast: 57 Felder, quadratisch 0,6 m
    b.truss((3.7, 0, 0), (-6.1, 0, 0), Y, 0.6, 0.6, 57, "grau", rod=0.025)
    b.box((-6.4, 0, 0), (0.6, 1.4, 0.8), "gold")                                                    # Fokalbank
    for sg in (1, -1):
        b.cyl((-6.1, sg * 0.45, 0), (-5.9, sg * 0.45, 0), 0.12, "dunkel", n=10)
    b.box((-6.75, 0, 0), (0.1, 1.2, 0.7), "radiator")
    return b


def xmm():
    """XMM-Newton: drei Spiegelmodule und Servicemodul vorn (+X), Tubus, Fokalebene hinten"""
    b = Bau()
    b.cyl((1.8, 0, 0), (3.2, 0, 0), 2.0, "gold", n=8, glatt=False, keys_deckel=("grau", "grau"), phase=math.pi / 8)
    b.box((2.5, 0, 2.1), (2.4, 3.6, 0.1), "radiator")                                              # Sonnenschutz
    for i, ang in enumerate((90, 210, 330)):                                                        # Spiegelmodule
        a = math.radians(ang)
        c = Vector((3.2, 1.0 * math.cos(a), 1.0 * math.sin(a)))
        b.cyl(c, c + V(0.6, 0, 0), 0.42, "silber", n=16, keys_deckel=("grau", "schwarz"))
        hinge = c + V(0.6, 0, 0.42) if i == 0 else c + V(0.6, 0.42 * math.cos(a), 0.42 * math.sin(a))
        b.box(hinge + V(0.4, 0, 0), (0.8, 0.85, 0.03), "silber")                                   # offene Deckel
    b.cyl((3.2, -1.2, -0.9), (3.6, -1.2, -0.9), 0.2, "grau", n=10)                                 # Optischer Monitor
    b.cyl((-5.2, 0, 0), (1.8, 0, 0), 1.1, "carbon", n=24, deckel=(False, False))                   # Tubus
    for x in (-5.0, -1.7, 1.6):
        b.cyl((x - 0.1, 0, 0), (x + 0.1, 0, 0), 1.13, "grau", n=24, deckel=(False, False))
    b.cyl((-6.8, 0, 0), (-5.2, 0, 0), 1.4, "gold", n=8, glatt=False, keys_deckel=("dunkel", "grau"))   # Fokalebene
    b.box((-6.0, 0, 1.5), (1.4, 1.8, 0.1), "radiator")
    b.box((-6.0, 0, -1.5), (1.4, 1.8, 0.1), "radiator")
    for sg in (1, -1):
        b.rod((2.5, sg * 2.0, 0), (2.5, sg * 2.5, 0), 0.15, "grau")
        for i in range(3):
            b.panel((2.5, sg * (2.55 + 0.92 + i * 1.84), 0), Y, X, 1.82, 1.9, cell=(0.6, 0.63))
    return b


# ---------------------------------------------------------------- Rakete mit Crew-Kapsel (zerlegbar)
# Gemeinsames Stapel-System: +X = Spitze/Flugrichtung, Ursprung = Kapselmitte. Jedes Teil bleibt in seiner
# Einbaulage (nicht zentriert), alle Teile an dieselbe Stelle gesetzt ergeben den Stapel.
# Neutrale Bauart nach Vorbild einer modernen Zweistufenrakete mit Crew-Kapsel, ohne Logos/Schriftzüge.
RR = 1.85                       # Radius der Stufen und des Trunks (Ø 3,7 m)
K_UNTEN = -2.0                  # Trunk-Oberkante (= Auflage des Hitzeschilds)
T_UNTEN = K_UNTEN - 3.7         # Trunk-Unterkante = Oberkante Zweitstufe
S2_UNTEN = T_UNTEN - 10.55      # Tankboden Zweitstufe = Oberkante Erststufe (Zwischenstufe)
S1_UNTEN = S2_UNTEN - 42.0      # Düsenaustritt Erststufe


def gitterflosse(b, x, phi):
    """Eingeklappte Gitterflosse: Rahmen mit Gitter, tangential am Zwischenstufen-Ring"""
    e = Vector((0, math.cos(phi), math.sin(phi)))
    t = Vector((0, -math.sin(phi), math.cos(phi)))
    c = Vector((x, 0, 0)) + e * (RR + 0.28)
    b.box(Vector((x - 0.9, 0, 0)) + e * (RR + 0.1), (0.4, 0.5, 0.3), "dunkel", ax=(X, t, e))  # Aktuator
    hl, hw = 0.75, 0.6
    ecken = [c + X * sx * hl + t * sy * hw for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    for i in range(4):
        b.rod(ecken[i], ecken[(i + 1) % 4], 0.09, "duese")
    for k in range(1, 6):                       # Gitterstäbe diagonal wie beim Original-Gitter
        f = k / 6
        b.rod(c + X * hl * (2 * f - 1) - t * hw, c + X * hl * (2 * f - 1) + t * hw, 0.03, "duese")
        b.rod(c - X * hl + t * hw * (2 * f - 1), c + X * hl + t * hw * (2 * f - 1), 0.03, "duese")


def rakete_stufe1():
    b = Bau()
    top = S2_UNTEN
    zw = top - 6.0                                                                  # Zwischenstufe 6 m
    b.cyl((S1_UNTEN + 1.35, 0, 0), (zw, 0, 0), RR, "lack", n=32, keys_deckel=("russ", "lack"))   # Tank
    b.cyl((zw, 0, 0), (top, 0, 0), RR, "russ", n=32, deckel=(False, False))                     # Zwischenstufe
    b.cyl((zw + 0.3, 0, 0), (top, 0, 0), RR - 0.05, "russ", n=32, deckel=(False, False))         # innen
    b.cyl((S1_UNTEN + 1.2, 0, 0), (S1_UNTEN + 1.35, 0, 0), RR, "russ", n=32)                    # Hitzeschutzboden
    # 9 Triebwerke: 8 im Kreis + 1 in der Mitte
    glocke = [(0, 0.2), (0.25, 0.3), (0.65, 0.4), (1.2, 0.46)]
    for k in range(9):
        if k < 8:
            a = 2 * math.pi * k / 8
            p = Vector((S1_UNTEN + 1.2, 1.25 * math.cos(a), 1.25 * math.sin(a)))
        else:
            p = Vector((S1_UNTEN + 1.2, 0, 0))
        b.lathe(p, -X, glocke, "duese", 16)
    for k in range(4):                                                               # Gitterflossen 0/90/180/270°
        gitterflosse(b, top - 0.9, math.pi / 2 * k)
    for k in range(4):                                                               # Landebeine 45/135/…°
        phi = math.pi / 4 + math.pi / 2 * k
        e = Vector((0, math.cos(phi), math.sin(phi)))
        t = Vector((0, -math.sin(phi), math.cos(phi)))
        b.box(Vector((S1_UNTEN + 1.3 + 4.9, 0, 0)) + e * (RR + 0.16), (9.6, 0.9, 0.3), "carbon", ax=(X, t, e))
        b.box(Vector((S1_UNTEN + 1.3 + 0.2, 0, 0)) + e * (RR + 0.25), (0.4, 1.1, 0.5), "duese", ax=(X, t, e))
        b.rod(Vector((S1_UNTEN + 10.2, 0, 0)) + e * (RR + 0.3), Vector((S1_UNTEN + 11.8, 0, 0)) + e * RR, 0.18, "grau")
    return b


def rakete_stufe2():
    b = Bau()
    b.cyl((S2_UNTEN, 0, 0), (T_UNTEN, 0, 0), RR, "lack", n=32, keys_deckel=("russ", "grau"))
    b.cyl((T_UNTEN - 0.25, 0, 0), (T_UNTEN, 0, 0), RR + 0.01, "grau", n=32, deckel=(False, False))   # Adapterring
    b.cyl((S2_UNTEN, 0, 0), (S2_UNTEN - 0.7, 0, 0), 0.55, "duese", r1=0.45, n=16)                   # Triebwerk
    b.lathe((S2_UNTEN - 0.7, 0, 0), -X, [(0, 0.45), (0.5, 0.85), (1.3, 1.3), (2.3, 1.6)], "duese", 28)  # Vakuumdüse
    return b


def kapsel_trunk():
    b = Bau()
    zellen = lambda i: "zellen" if i < 12 else "lack"                              # Zellen auf der Zenit-Hälfte
    b.lathe((T_UNTEN, 0, 0), X, [(0, RR), (K_UNTEN - T_UNTEN, RR)], "lack", 24, key_seg=zellen,
            deckel=(True, True), keys_deckel=("grau", "grau"))
    for sg in (1, -1):                                                               # zwei Finnen (±Y)
        y0 = sg * RR * 0.99
        y1 = sg * (RR + 0.75)
        b.prism([(T_UNTEN, y0, -0.05), (T_UNTEN + 1.6, y0, -0.05), (T_UNTEN + 0.7, y1, -0.05),
                 (T_UNTEN, y1, -0.05)], (0, 0, 0.1), "lack")
    return b


def kapsel():
    from mathutils import Matrix
    b = Bau()
    # Hitzeschild (schwarz, −X) und Kegelstumpf (weiß)
    b.lathe((-2.2, 0, 0), X, [(0, 0.0), (0.12, 1.0), (0.2, 1.65), (0.25, 2.0)], "russ", 32)
    b.lathe((-1.95, 0, 0), X, [(0, 2.0), (0.12, 2.0), (3.3, 1.05), (3.4, 0.95)], "lack", 32,
            deckel=(False, True), keys_deckel=("lack", "grau"))
    b.cyl((1.45, 0, 0), (1.75, 0, 0), 0.8, "grau", n=24, keys_deckel=("grau", "dunkel"))      # Docking-Ring
    # Fenster und SuperDraco-Abdeckungen auf der Kegelfläche
    neig = math.atan2(0.95, 3.2)
    for az, x, r in ((35, 0.2, 0.22), (145, 0.2, 0.22), (-35, 0.6, 0.18), (-145, 0.6, 0.18)):
        a = math.radians(az)
        e = Vector((0, math.cos(a), math.sin(a)))
        rx = 2.0 - (x + 1.83) * 0.95 / 3.2
        nrm = (e * math.cos(neig) + X * math.sin(neig)).normalized()
        p = Vector((x, 0, 0)) + e * rx
        b.cyl(p - nrm * 0.02, p + nrm * 0.03, r, "glas", n=12, keys_deckel=("glas", "glas"))
    for k in range(4):
        a = math.radians(45 + 90 * k)
        e = Vector((0, math.cos(a), math.sin(a)))
        t = Vector((0, -math.sin(a), math.cos(a)))
        nrm = (e * math.cos(neig) + X * math.sin(neig)).normalized()
        along = nrm.cross(t)
        b.box(Vector((-1.3, 0, 0)) + e * (2.0 - 0.55 * 0.95 / 3.2) + nrm * 0.03, (1.0, 0.6, 0.06), "dunkel",
              ax=(along, t, nrm))
    # Nasenkappe aufgeklappt: Scharnier an der Oberkante (+Z), nach vorn/oben geschwenkt
    rot = Matrix.Rotation(math.radians(-115), 3, "Y")
    hinge = Vector((1.45, 0, 1.05))
    base = hinge + rot @ Vector((0, 0, -1.05))
    b.lathe(base, rot @ X, [(0, 1.05), (0.3, 0.9), (0.55, 0.45), (0.62, 0.0)], "lack", 24, up=Y,
            deckel=(True, False), keys_deckel=("grau", "lack"))
    b.rod(hinge + Vector((-0.1, 0, -0.1)), base + (rot @ Vector((0, 0, 1))) * 0.9, 0.12, "grau")
    return b


def fallschirm():
    """Vier Hauptschirme über der Kapsel (+X), Leinen laufen bei x = 3 m zusammen"""
    b = Bau()
    conf = Vector((3.0, 0, 0))
    for k in range(4):                                                               # kurze Gurte zur Kapsel
        a = math.radians(45 + 90 * k)
        b.rod(conf, Vector((1.5, 0.8 * math.cos(a), 0.8 * math.sin(a))), 0.08, "leine")
    R, H, L, tilt, n, m = 16.0, 10.0, 38.0, math.radians(40), 24, 6
    for k in range(4):
        phi = math.radians(45 + 90 * k)
        d = Vector((math.cos(tilt), math.sin(tilt) * math.cos(phi), math.sin(tilt) * math.sin(phi)))
        rand = conf + d * L                                                          # Mitte des Schirmrands
        a, bb = basis(d)
        rings = []
        for j in range(m + 1):
            g = math.radians(80) * j / m                                             # bis zur Scheitelöffnung
            rr, hx = R * math.cos(g), H * math.sin(g)
            rings.append([b.bm.verts.new(rand + d * hx + (a * math.cos(2 * math.pi * i / n) +
                                                            bb * math.sin(2 * math.pi * i / n)) * rr)
                          for i in range(n)])
        for j in range(m):
            for i in range(n):
                i2 = (i + 1) % n
                key = "rot" if (i // 2) % 2 == 0 else "stoff"
                b._face([rings[j][i], rings[j][i2], rings[j + 1][i2], rings[j + 1][i]], key,
                        [(i / n, j / m), ((i + 1) / n, j / m), ((i + 1) / n, (j + 1) / m), (i / n, (j + 1) / m)],
                        glatt=True)
        for i in range(0, n, 2):                                                     # 12 Leinen je Schirm
            b.rod(conf, rings[0][i].co.copy(), 0.05, "leine")
    return b


def kapsel_gluehen():
    """Halbtransparentes Plasma vor dem Hitzeschild (Wiedereintritt), Ø ~6 m"""
    b = Bau()
    b.lathe((-3.5, 0, 0), X, [(0, 0.0), (0.3, 1.5), (0.75, 2.4), (1.4, 2.9), (2.3, 3.05), (3.0, 2.95)], "plasma", 32)
    b.lathe((-2.55, 0, 0), X, [(0, 0.0), (0.12, 1.1), (0.28, 1.8), (0.45, 2.15), (0.6, 2.25)], "plasma_kern", 32)
    return b


MODELLE = {"iss": iss, "tiangong": tiangong, "hubble": hubble, "jwst": jwst, "chandra": chandra,
           "fermi": fermi, "swift": swift, "nustar": nustar, "xmm": xmm,
           "rakete_stufe1": rakete_stufe1, "rakete_stufe2": rakete_stufe2, "kapsel_trunk": kapsel_trunk,
           "kapsel": kapsel, "fallschirm": fallschirm, "kapsel_gluehen": kapsel_gluehen}
STAPEL = {"rakete_stufe1", "rakete_stufe2", "kapsel_trunk", "kapsel", "fallschirm", "kapsel_gluehen"}  # nicht zentriert
# zusätzliche Vorschaubilder aus mehreren Teilen (Name -> Teile, Kamerarichtung)
VERBUND = {"rakete_stapel": (["rakete_stufe1", "rakete_stufe2", "kapsel_trunk", "kapsel"], (0.35, -1.0, 0.45)),
           "kapsel_fallschirm": (["kapsel", "fallschirm"], (0.3, -1.0, 0.35))}


# ---------------------------------------------------------------- Export, Kennzahlen, Vorschau

def kennzahlen(obj):
    me = obj.data
    co = np.array([v.co[:] for v in me.vertices])
    ext = co.max(0) - co.min(0)
    tris = sum(len(p.vertices) - 2 for p in me.polygons)
    k = {"length_m": round(float(ext[0]), 2), "span_m": round(float(ext[1]), 2), "tris": int(tris)}
    if obj.name in STAPEL:  # Lage im gemeinsamen Stapel-System
        k["x_min_m"], k["x_max_m"] = round(float(co[:, 0].min()), 2), round(float(co[:, 0].max()), 2)
    return k, ext


def vorschau(pfad, richtung=(1.0, -1.25, 0.95)):
    """Alle Meshes der Szene schräg von oben, Cycles auf der CPU (läuft ohne Grafikkarte)"""
    sc = bpy.context.scene
    co = np.concatenate([np.array([v.co[:] for v in o.data.vertices]) for o in sc.objects if o.type == "MESH"])
    ext, mitte = co.max(0) - co.min(0), Vector((co.max(0) + co.min(0)) / 2)
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = 24
    try:
        sc.cycles.use_denoising = True
    except Exception:
        pass
    sc.render.resolution_x, sc.render.resolution_y = 800, 600
    sc.render.image_settings.file_format = "PNG"
    w = bpy.data.worlds.new("Welt")
    w.use_nodes = True
    bg = w.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (0.16, 0.18, 0.22, 1)
    bg.inputs["Strength"].default_value = 1.0
    sc.world = w
    sun = bpy.data.objects.new("Sonne", bpy.data.lights.new("Sonne", "SUN"))
    sun.data.energy = 4.5
    sun.rotation_euler = (math.radians(40), math.radians(20), math.radians(-30))
    sc.collection.objects.link(sun)
    cam = bpy.data.objects.new("Kamera", bpy.data.cameras.new("Kamera"))
    cam.data.lens = 50
    cam.data.clip_end = 2000
    sc.collection.objects.link(cam)
    d = Vector(richtung).normalized()
    r = Vector(ext).length / 2
    cam.location = mitte + d * r * 2.9
    cam.rotation_euler = (-d).to_track_quat("-Z", "Y").to_euler()
    sc.camera = cam
    sc.render.filepath = pfad
    bpy.ops.render.render(write_still=True)


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    bilder = None
    if "--vorschau" in argv:
        i = argv.index("--vorschau")
        bilder = argv[i + 1]
        argv = argv[:i] + argv[i + 2:]
    richtung = (1.0, -1.25, 0.95)  # Kamerarichtung (vom Modell aus), z. B. --ansicht 1,0,0.2 für die Front
    if "--ansicht" in argv:
        i = argv.index("--ansicht")
        richtung = tuple(float(v) for v in argv[i + 1].split(","))
        argv = argv[:i] + argv[i + 2:]
    out, nur = argv[0], argv[1:]
    os.makedirs(out, exist_ok=True)
    jpfad = os.path.join(out, "models.json")
    info = {}
    if nur and os.path.exists(jpfad):
        with open(jpfad) as f:
            info = json.load(f)
    for name, bau in MODELLE.items():
        if nur and name not in nur:
            continue
        bpy.ops.wm.read_factory_settings(use_empty=True)
        _mats.clear()
        _tex.clear()
        obj = bau().fertig(name, zentrieren=name not in STAPEL)
        k, ext = kennzahlen(obj)
        info[name] = k
        pfad = os.path.join(out, name + ".glb")
        bpy.ops.export_scene.gltf(filepath=pfad, export_format="GLB", export_yup=True, export_apply=True,
                                  export_materials="EXPORT", export_image_format="AUTO")
        print(f"exportiert: {pfad}  {k}  {os.path.getsize(pfad) / 1e6:.2f} MB")
        if bilder:
            os.makedirs(bilder, exist_ok=True)
            vorschau(os.path.join(bilder, name + ".png"), richtung)
    for name, (teile, ri) in VERBUND.items():
        if bilder and (not nur or any(t in nur for t in teile)):
            bpy.ops.wm.read_factory_settings(use_empty=True)
            _mats.clear()
            _tex.clear()
            for t in teile:
                MODELLE[t]().fertig(t, zentrieren=False)
            vorschau(os.path.join(bilder, name + ".png"), ri)
    with open(jpfad, "w") as f:
        json.dump(info, f, indent=2)


main()
