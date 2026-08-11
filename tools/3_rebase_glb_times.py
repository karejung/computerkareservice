"""Shift every glTF animation sampler so the clip starts at t=0.

Blender's exporter writes absolute scene times, so a clip exported from frames
170..375 arrives with keys at 5.667s..12.5s. three.js would then hold the first
pose for 5.7 seconds before anything moved. This rewrites the input accessors
in place and fixes up their min/max.

    python3 tools/3_rebase_glb_times.py public/models/scene.glb 170 30
"""
import json
import struct
import sys

import numpy as np

path = sys.argv[1] if len(sys.argv) > 1 else "public/models/scene.glb"
frame_start = float(sys.argv[2]) if len(sys.argv) > 2 else 170.0
fps = float(sys.argv[3]) if len(sys.argv) > 3 else 30.0
shift = frame_start / fps

data = bytearray(open(path, "rb").read())
assert data[:4] == b"glTF", "not a binary glTF"

offset, js, bin_offset = 12, None, None
while offset < len(data):
    length, kind = struct.unpack_from("<II", data, offset)
    offset += 8
    if kind == 0x4E4F534A:
        js = json.loads(bytes(data[offset:offset + length]))
    elif kind == 0x004E4942:
        bin_offset = offset
    offset += length

inputs = {s["input"] for a in js.get("animations", []) for s in a["samplers"]}
for index in sorted(inputs):
    a = js["accessors"][index]
    assert a["componentType"] == 5126 and a["type"] == "SCALAR"
    view = js["bufferViews"][a["bufferView"]]
    start = bin_offset + view.get("byteOffset", 0) + a.get("byteOffset", 0)
    n = a["count"]
    times = np.frombuffer(bytes(data[start:start + n * 4]), dtype="<f4").copy()
    times -= shift
    times[times < 0] = 0.0
    data[start:start + n * 4] = times.astype("<f4").tobytes()
    a["min"], a["max"] = [float(times.min())], [float(times.max())]

blob = json.dumps(js, separators=(",", ":")).encode()
blob += b" " * ((4 - len(blob) % 4) % 4)
chunk = bytes(data[bin_offset:])
chunk += b"\0" * ((4 - len(chunk) % 4) % 4)

out = bytearray(b"glTF" + struct.pack("<II", 2, 0))
out += struct.pack("<II", len(blob), 0x4E4F534A) + blob
out += struct.pack("<II", len(chunk), 0x004E4942) + chunk
struct.pack_into("<I", out, 8, len(out))
open(path, "wb").write(bytes(out))

print(f"rebased {path} by -{shift:.4f}s")
for a in js.get("animations", []):
    lo = min(js["accessors"][s["input"]]["min"][0] for s in a["samplers"])
    hi = max(js["accessors"][s["input"]]["max"][0] for s in a["samplers"])
    print(f"  {a.get('name')}: [{lo:.4f}, {hi:.4f}]")
