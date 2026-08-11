import bpy, json, os, numpy as np

BLEND = os.environ.get("BLEND", os.path.expanduser("~/Desktop/milkyforweb2.blend"))
OUT   = os.environ.get("OUT", "public/vat")
# optional resample: number of stored rows (default = one per frame)
ROWS  = int(os.environ.get("ROWS", "0"))
RAMP_FRAC = 0.22          # fraction of the loop used to close the seam
os.makedirs(OUT, exist_ok=True)

bpy.ops.wm.open_mainfile(filepath=BLEND)
sc = bpy.context.scene
F0, F1 = sc.frame_start, sc.frame_end
FPS = sc.render.fps / sc.render.fps_base
NF = F1 - F0 + 1
TARGETS = ["shirts", "pants"]

def lin2srgb(c):
    c = max(0.0, min(1.0, float(c)))
    return 12.92 * c if c <= 0.0031308 else 1.055 * (c ** (1 / 2.4)) - 0.055

def material_look(obj):
    if not obj.data.materials or obj.data.materials[0] is None:
        return {"name": None, "color": "#9a9a9a", "roughness": 1.0}
    m = obj.data.materials[0]
    col, rough = (0.8, 0.8, 0.8), 1.0
    if m.use_nodes:
        for nd in m.node_tree.nodes:
            if nd.type == 'BSDF_PRINCIPLED':
                col = tuple(nd.inputs['Base Color'].default_value)[:3]
                rough = float(nd.inputs['Roughness'].default_value)
                break
    hexcol = "#" + "".join(f"{round(lin2srgb(c) * 255):02x}" for c in col)
    return {"name": m.name, "color": hexcol, "roughness": round(rough, 3)}

def yup(a):
    return np.stack([a[..., 0], a[..., 2], -a[..., 1]], axis=-1)

# ---------- geometry from the evaluated mesh at F0 ----------
sc.frame_set(F0)
dg = bpy.context.evaluated_depsgraph_get()
geo = {}
for name in TARGETS:
    o = bpy.data.objects[name]
    oe = o.evaluated_get(dg)
    me = oe.to_mesh()
    me.calc_loop_triangles()
    uvl = me.uv_layers.active
    key2idx, src_of_render, uvs, indices = {}, [], [], []
    for tri in me.loop_triangles:
        for li, vi in zip(tri.loops, tri.vertices):
            uv = tuple(round(c, 6) for c in uvl.data[li].uv) if uvl else (0.0, 0.0)
            k = (vi, uv)
            j = key2idx.get(k)
            if j is None:
                j = len(src_of_render); key2idx[k] = j
                src_of_render.append(vi); uvs.append(uv)
            indices.append(j)
    geo[name] = {
        "nsrc": len(me.vertices),
        "src": np.array(src_of_render, dtype=np.int32),
        "uv": np.array(uvs, dtype=np.float32),
        "idx": np.array(indices, dtype=np.uint32),
        "tris": np.array([list(t.vertices) for t in me.loop_triangles], dtype=np.int32),
        "look": material_look(o),
    }
    oe.to_mesh_clear()

# ---------- sample world-space positions, stepping the timeline in order ----------
pos = {n: np.zeros((NF, geo[n]["nsrc"], 3), dtype=np.float64) for n in TARGETS}
for fi, f in enumerate(range(F0, F1 + 1)):
    sc.frame_set(f)
    dg = bpy.context.evaluated_depsgraph_get()
    for n in TARGETS:
        oe = bpy.data.objects[n].evaluated_get(dg)
        me = oe.to_mesh()
        if len(me.vertices) != geo[n]["nsrc"]:
            raise SystemExit(
                f"{n}: evaluated vertex count changed at frame {f} "
                f"({len(me.vertices)} vs {geo[n]['nsrc']}) — a VAT needs stable topology"
            )
        co = np.empty(len(me.vertices) * 3, dtype=np.float64)
        me.vertices.foreach_get("co", co)
        mw = np.array(oe.matrix_world)
        pos[n][fi] = co.reshape(-1, 3) @ mw[:3, :3].T + mw[:3, 3]
        oe.to_mesh_clear()

def vnormals(P, tris, nsrc):
    a, b, c = P[tris[:, 0]], P[tris[:, 1]], P[tris[:, 2]]
    fn = np.cross(b - a, c - a)
    N = np.zeros((nsrc, 3))
    for k in range(3):
        np.add.at(N, tris[:, k], fn)
    ln = np.linalg.norm(N, axis=1, keepdims=True); ln[ln == 0] = 1.0
    return N / ln

manifest = {"frameStart": F0, "frameEnd": F1, "sourceFrames": NF, "fps": FPS,
            "duration": (F1 - F0) / FPS, "garments": {}}

for n in TARGETS:
    g = geo[n]
    P = pos[n]
    raw_gap = float(np.abs(P[-1] - P[0]).max())

    # close the loop: ramp a per-vertex correction so the last row lands on the first
    ramp = max(2, int(NF * RAMP_FRAC))
    D = P[0] - P[-1]
    w = np.zeros(NF)
    k = np.linspace(0.0, 1.0, ramp + 1)
    w[NF - ramp - 1:] = k * k * (3 - 2 * k)
    P = P + w[:, None, None] * D[None, :, :]

    # optional resample to fewer rows; row (rows-1) still equals row 0
    if ROWS and ROWS != NF:
        src_t = np.linspace(0.0, 1.0, NF)
        dst_t = np.linspace(0.0, 1.0, ROWS)
        P = np.stack([np.array([np.interp(dst_t, src_t, P[:, v, c])
                                for c in range(3)]).T for v in range(P.shape[1])], axis=1)
    rows = P.shape[0]

    Pg = yup(P)
    base = Pg[0]
    offs = Pg - base[None, :, :]
    Ng = yup(np.stack([vnormals(P[f], g["tris"], g["nsrc"]) for f in range(rows)], axis=0))

    V = g["nsrc"]
    o4 = np.zeros((rows, V, 4), dtype=np.float32); o4[..., :3] = offs
    o4.astype(np.float16).tofile(os.path.join(OUT, f"{n}.pos.bin"))
    n4 = np.zeros((rows, V, 4), dtype=np.float32)
    n4[..., :3] = Ng * 0.5 + 0.5; n4[..., 3] = 1.0
    np.clip(n4 * 255.0 + 0.5, 0, 255).astype(np.uint8).tofile(os.path.join(OUT, f"{n}.nrm.bin"))

    src = g["src"]
    parts = [base[src].astype(np.float32).tobytes(), g["uv"].tobytes(),
             np.arange(len(src), dtype=np.float32).tobytes() * 0, g["idx"].astype(np.uint16).tobytes()]
    parts[2] = src.astype(np.float32).tobytes()
    open(os.path.join(OUT, f"{n}.geom.bin"), "wb").write(b"".join(parts))
    off = 0; layout = {}
    for key, arr in zip(["position", "uv", "vatId", "index"], parts):
        layout[key] = {"byteOffset": off, "byteLength": len(arr)}; off += len(arr)

    manifest["garments"][n] = {
        "vertexCount": int(len(src)), "sourceVertexCount": int(V),
        "indexCount": int(len(g["idx"])), "triangleCount": int(len(g["tris"])),
        "material": g["look"]["name"], "color": g["look"]["color"],
        "roughness": g["look"]["roughness"],
        "vat": {"width": int(V), "height": int(rows),
                "positionFile": f"{n}.pos.bin", "positionType": "float16",
                "normalFile": f"{n}.nrm.bin", "normalType": "uint8",
                "encoding": "offset-from-base"},
        "geometryFile": f"{n}.geom.bin", "layout": layout,
        "bbox": {"min": [float(x) for x in Pg.reshape(-1, 3).min(0)],
                 "max": [float(x) for x in Pg.reshape(-1, 3).max(0)]},
        "maxOffset": float(np.abs(offs).max()),
        "loopGapBefore": raw_gap,
        "loopGapAfter": float(np.abs(Pg[-1] - Pg[0]).max()),
    }
    manifest["frames"] = rows

open(os.path.join(OUT, "cloth.json"), "w").write(json.dumps(manifest, indent=1))
print(json.dumps(manifest, indent=1))
