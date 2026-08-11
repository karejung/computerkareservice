# KARE

`milkyforweb2.blend` running in the browser. Next.js (App Router) + three.js.

The scene splits into two very different playback mechanisms:

| collection  | what it is                              | how it plays back on the web        |
| ----------- | --------------------------------------- | ----------------------------------- |
| `body`      | skinned meshes + 148-bone armature      | glTF skeletal animation             |
| `furniture` | plain meshes, chair has object anim     | glTF node animation                 |
| `cloth`     | `shirts` and `pants`, both cloth sims   | vertex animation texture on the GPU |

Everything loops over Blender frames **170–375** at 30 fps (6.833 s), toon
shaded, on a checkerboard ground plane. There is no page copy — the route is a
single full-viewport canvas.

## Getting started

```bash
npm install
npm run dev
```

Then open http://localhost:3000. Append `?debug=1` for a play/pause, speed and
scrub panel, and a `window.__kare` handle for the shared clock.

## How the cloth works

A cloth simulation cannot be exported as skinning or morph targets at this
length, so it is baked into a texture instead.

`tools/2_bake_vat.py` steps the Blender timeline frame by frame and writes every
garment vertex into a texture: **one texel per (vertex, frame)** — vertex index
across, time down. At runtime a patched `MeshStandardMaterial` reads the two
rows bracketing the current time in its vertex shader and blends between them.
There is no solver on the web side; the cloth costs two texture fetches per
vertex.

Details worth knowing if you change the bake:

- **Positions are stored as offsets from the frame-170 pose**, as `RGBA16F`.
  Offsets stay small, so half precision is accurate to well under a millimetre
  here — far cheaper than storing absolute positions at float32.
- **Positions are in world space.** Garments are parented to the animated
  `chair` in Blender, but baking world space means the web side can drop them at
  the scene root with an identity transform and never mirror that hierarchy.
- **Normals are baked too**, as `RGBA8`. Recomputing them per frame on the GPU
  would need neighbour information the shader does not have.
- **The loop is closed by hand.** Cloth does not return to its start pose on its
  own — the shirt ends frame 375 about 0.256 units from frame 170, the trousers
  0.485. The bake ramps a per-vertex correction over the last ~22% of the loop
  with a smoothstep so the final row lands exactly on the first. Measured seam
  after the fix: a mean pixel difference of 0.052 between the first and last
  rendered frame, and most of what remains is the hair springs rather than the
  cloth — they carry state across the loop and do not reset.
- **Texture filtering must be `NearestFilter`.** Neighbouring texels along X are
  *different vertices*; letting the hardware interpolate would smear unrelated
  vertices together. The frame blend is done explicitly in the shader instead.

## Source model

Baked from `~/Desktop/milkyforweb2.blend`, frames 170–375 @ 30fps.

Both garments carry a real cloth sim. Subdivision and Solidify are now applied
in Blender rather than left on the stack, so the sim runs on the dense mesh
directly: the shirt is 8098 vertices and the trousers 4066, with only `Cloth`
and `Collision` left as modifiers. Both point caches are baked, so the bake
reads them instead of re-simulating — which is what makes the result
reproducible and identical to the viewport.

The bake resamples to **103 rows** (`ROWS=103`) rather than one row per frame;
the shader interpolates between rows either way. Payload is **11.7 MB gzipped**,
and the shirt is most of it — its mesh is twice as dense as the trousers'.

Going below 103 rows is the obvious lever, but it is not free, and the two
garments behave very differently (max positional error, in world units, on a
character ~12 units tall):

| rows | shirt err | trousers err | total gzip |
| ---- | --------- | ------------ | ---------- |
| 103  | —         | —            | 10.0 MB    |
| 82   | 0.012     | 0.065        | 7.9 MB     |
| 69   | 0.019     | 0.117        | 6.7 MB     |
| 52   | 0.028     | 0.114        | 5.0 MB     |

The trousers degrade about six times faster than the shirt, because their world
offsets are larger — they carry the chair's swing as well as the cloth. If the
payload needs to come down, dropping the shirt cage's density in Blender is a
better lever than cutting rows: it is the thing that quadrupled the file.

Garment colour now travels in `cloth.json` (converted from the Principled base
colour to sRGB at bake time) instead of a name-keyed table on the web side —
renaming a material in Blender used to silently drop the garment to fallback
grey, which is exactly what `black` → `pants.004` would have done.

### Trap: a selection-locked armature silently kills the skin

The export selects the `body` and `furniture` collections and exports the
selection. If any object in them is **locked in the outliner** (the cursor
icon, `hide_select`), `select_set()` refuses it *silently* — and locking the
rig so you can't grab it by accident in the viewport is a completely normal
thing to do.

When that happens to the armature, the GLB comes out with no skins, no bones
and no pose animation. Every mesh still exports, just frozen in its rest pose,
and nothing in Blender's log says anything is wrong. `tools/1_export_glb.py`
now clears `hide_select` before selecting and aborts if any object still fails
to select, so this can only ever be a loud failure.

### Re-baking

The tools need Blender 5.x. Either run them with the `blender` binary, or
`pip install bpy==5.0.1` and run them with plain Python.

```bash
# 1. body + furniture -> public/models/scene.glb
BLEND=~/Desktop/milkyforweb2.blend blender --background --python tools/1_export_glb.py

# 2. shift the animation to start at t=0 (Blender writes absolute scene times)
python3 tools/3_rebase_glb_times.py public/models/scene.glb 170 30

# 3. cloth -> public/vat/*.bin + cloth.json
ROWS=103 BLEND=~/Desktop/milkyforweb2.blend blender --background --python tools/2_bake_vat.py
```

Step 2 is not optional. Blender exports frame 170 as t=5.667 s, which would make
three.js hold the opening pose for almost six seconds before anything moved.

The bake aborts if a garment's evaluated vertex count changes between frames — a
VAT cannot represent changing topology, and the failure would otherwise show up
as scrambled geometry rather than as an error.

## Toon shading

`lib/toonMaterial.ts` is lifted unchanged from the `202602` project:
`MeshToonMaterial` with a three-step gradient ramp, plus two specular bands and
a rim term injected through `onBeforeCompile`.

Two things were needed to make it fit here:

- **The VAT patch had to chain, not overwrite.** The garment materials arrive
  with the toon fragment-shader patch already installed on `onBeforeCompile`, so
  `attachVat` captures the existing callback and calls it before adding the
  vertex displacement. Same for `customProgramCacheKey`.
- **Pure black had to be rescued.** `createToonMaterialFromExisting` drops base
  colours under ~1% luminance and falls back to white — a sensible guard against
  unlit exports, but this scene's hair really is pure black and turned white.
  `Character.tsx` records the colour before conversion and restores it.

Three lighting rules fall out of `MeshToonMaterial`, and all are easy to get
wrong:

- **It ignores environment maps.** All shaping comes from direct light; the
  original `RoomEnvironment` IBL was removed because it cost startup time and
  did nothing.
- **Do not add ambient light.** Ambient lands in `indirectDiffuse`, which never
  passes through the gradient ramp, so it washes the cel bands into a flat mid
  grey. There is no ambient in the scene at all — the ramp's dark band already
  sits at ~59%, so nothing needs filling.
- **The key light wants to be over-bright, and tone mapping has to be on.** A
  reasonable-looking intensity of 1.0 with tone mapping off lands the ramp's
  dark band at 0.59, and the whole scene reads murky. Pushing the light past 1.0
  drives the bands above white so ACES compresses them together, which is what
  makes skin and fabric read as flat bright shapes rather than visibly stepped
  grey. The floor opts out with `toneMapped={false}` so the checkerboard still
  renders as authored and its fogged edge matches the pure white background.

### Calibration

The tones were measured against the reference project rather than eyeballed:
its render was captured, sampled per region, and this scene tuned to match.

| region | reference | here  |
| ------ | --------- | ----- |
| floor  | 239.5     | 244.3 |
| skin   | 190.1     | 189.4 |
| hair   | 63.9      | 53.9  |
| black  | 55.6      | 52.0  |

That is what set the key light to **2.2** and the two values in
`lib/palette.ts`. Hair is left deliberately under its target so it still reads
as black rather than dark grey.

Two things make this kind of tuning much less painful, and both are worth
keeping: `?light=2.6` overrides the key intensity without a rebuild, and
`?debug=1` exposes `window.__kare` so the loop can be pinned to one frame.
Without pinning, every capture lands on a different pose and any fixed sample
region measures something different each time.

### Hair highlights

The toon specular is multiplicative — it scales `outgoingLight`. That is right
for skin and fabric, but it cannot put a highlight on black hair, because
anything times zero is still zero. Two things fix it:

- `lib/palette.ts` remaps every pure-black material to a dark grey. Nothing in
  the scene reads differently against a white background, but the multiplicative
  terms now have something to lift.
- `lib/hairHighlight.ts` adds an **additive** Blinn-Phong band on top, so the
  highlight carries its own luminance. It only applies to the hair mesh, and
  only on the lit side — a highlight on the shadowed half of the head reads as a
  bug immediately.

The band wants to be tight. A first pass at `power: 16` with a broad sheen
turned the whole head silver: most of the hair's top faces sit near the halfway
vector, so a loose exponent catches nearly all of them at once. `power: 45` with
the sheen almost switched off keeps the hair black with a highlight on it. The
softness is deliberately generous (`0.28`) because the hair mesh has split
normals along its strands, and a hard threshold makes the highlight break into
visible polygons.

## The floor

A white/grey checkerboard drawn to a canvas at load, tiled with mipmaps and
anisotropy so it resolves into the distance instead of shimmering. It is
deliberately **unlit** (`meshBasicMaterial`): under the key light both checker
tones clip toward the same white and the pattern disappears. Shadows land on a
separate transparent `shadowMaterial` plane 4 mm above it.

The garments **cast** shadows but do not **receive** them. They are open,
zero-thickness surfaces, so they sample their own shadow map at essentially the
depth they were rendered from, and the shirt breaks out in acne no matter how
the bias is tuned.

## Layout

```
app/                 route, layout, global styles
components/
  Scene.tsx          canvas, lighting, floor, camera
  Character.tsx      the GLB, its animation mixer, toon conversion
  Cloth.tsx          VAT meshes
  DebugPanel.tsx     ?debug=1 controls
lib/
  vat.ts             loads cloth.json + the binary payloads
  vatMaterial.ts     the VAT shader patch
  toonMaterial.ts    the toon material (from the 202602 project)
  playback.ts        the single clock everything reads
public/
  models/scene.glb   1.9 MB
  vat/               2.3 MB
tools/               the Blender side
```

## Notes

- **One clock, read by everything.** `lib/playback.ts` holds a plain mutable
  object rather than React state — it is written every frame and must never
  cause a re-render. Both the mixer and the cloth shader derive their time from
  it, which is what stops the body and the garment drifting apart over a long
  session.
- **Tone mapping is off.** The toon ramp wants flat output; ACES would roll the
  highlights off and stop white from matching the white background and fog.
- Textures were downscaled to 1024 px during export; raise `MAX` in
  `tools/1_export_glb.py` if you want more detail at the cost of payload.
