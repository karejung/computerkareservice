"""Export the character and its three props to public/models/kare9.glb.

  blender --background --python tools/1_export_glb.py

Run headless, off the saved .blend. Never point this at a live session: it
rewrites image datablocks to downscale them, and doing that over the MCP socket
once took Blender down with hours of unsaved work in it.

Four things this has to get right, three of which fail silently:

  * `export_animation_mode='ACTIONS'` — the web app plays clips by name
    (idle / ds / PC / phone / spin / poof / Vsign). 'SCENE' collapses the lot
    into one unnamed clip and the mixer then has nothing to look up. Every
    action in the file becomes a clip, including ones no object is using, so
    the working copies a rig session leaves behind ship unless they are named
    out of it — see BACKUP_SUFFIX.
  * `export_image_format='AUTO'` — forcing JPEG strips alpha. The blush is a
    four-vertex quad that is nothing but its alpha, and the web material reads
    emissiveMap, which came back opaque: magenta rectangles on her cheeks.
  * collections excluded from the view layer have no selectable objects, and a
    selection-based export drops them without a word.
  * the console the web app finds is the node literally named `Nintendo DS`.
    The low-poly rebuild lives under `ds_low`, so it takes that name for the
    trip and the high-poly original steps aside.
"""
import bpy, json, os

BLEND = os.environ.get(
    "BLEND",
    os.path.expanduser(
        "~/Library/Mobile Documents/com~apple~CloudDocs/milkydepo3.blend"
    ),
)
OUT = os.environ.get("OUT", "public/models")
NAME = os.environ.get("NAME", "kare9.glb")

# body: character + armature. The rest are one prop each, bone-parented to the
# left hand, and shown by whichever clip is running.
COLLECTIONS = ["body", "nintendo_low", "laptop", "phone"]
LOWPOLY_COLLECTION = "nintendo_low"
HIGHPOLY_ROOT = "Nintendo DS"
LOWPOLY_ROOT = "ds_low"

# Before-and-after copies kept in the .blend so a reworked clip can be reverted.
# They are a rigging convenience and no object plays them, but 'ACTIONS' exports
# every action regardless — two spare copies of the spin were 62 KB of JSON and
# two clips the mixer would never look up. Dropped from this Blender's memory
# only; the .blend on disk keeps them.
BACKUP_SUFFIX = "_ORIG"

os.makedirs(OUT, exist_ok=True)
bpy.ops.wm.open_mainfile(filepath=BLEND)
sc = bpy.context.scene
report = {"blend": BLEND, "fps": sc.render.fps / sc.render.fps_base}


def layer_collections():
    out = {}

    def walk(lc):
        out[lc.name] = lc
        for ch in lc.children:
            walk(ch)

    walk(bpy.context.view_layer.layer_collection)
    return out


lcs = layer_collections()
for name in COLLECTIONS + ["backup"]:
    if name in lcs:
        lcs[name].exclude = False
bpy.context.view_layer.update()

# Keep the web payload sane: the console's plastic carries 4K imperfection maps
# that were 2.5 MB of the GLB between them.
MAX = 1024
scaled = []
for img in bpy.data.images:
    if img.source != "FILE" or img.size[0] == 0:
        continue
    w, h = img.size
    if max(w, h) > MAX:
        s = MAX / max(w, h)
        try:
            img.scale(max(1, int(w * s)), max(1, int(h * s)))
            scaled.append(img.name)
        except Exception as e:  # noqa: BLE001 - report it, do not stop the export
            scaled.append(f"{img.name} FAILED {e}")
report["scaled_images"] = scaled

low = bpy.data.objects.get(LOWPOLY_ROOT)
if low is not None:
    high = bpy.data.objects.get(HIGHPOLY_ROOT)
    if high is not None and high is not low:
        high.name = HIGHPOLY_ROOT + ".highpoly"
    low.name = HIGHPOLY_ROOT
else:
    # already renamed by a previous run - fine, as long as the node the web app
    # looks for is the rebuild and not the 22k-vert original
    named = bpy.data.objects.get(HIGHPOLY_ROOT)
    lowcoll = bpy.data.collections.get(LOWPOLY_COLLECTION)
    if named is None or lowcoll is None or named.name not in lowcoll.objects:
        raise SystemExit(
            f"{LOWPOLY_ROOT!r} missing and {HIGHPOLY_ROOT!r} is not the low-poly root"
        )
report["console_root"] = HIGHPOLY_ROOT

dropped = []
for action in list(bpy.data.actions):
    if action.name.endswith(BACKUP_SUFFIX):
        dropped.append(action.name)
        action.use_fake_user = False
        bpy.data.actions.remove(action)
report["dropped_actions"] = dropped

for o in bpy.data.objects:
    o.select_set(False)

wanted = []
for cn in COLLECTIONS:
    c = bpy.data.collections.get(cn)
    if not c:
        raise SystemExit(f"collection {cn} missing")
    for o in c.objects:
        # hide_select is the outliner's cursor icon. Riggers routinely lock the
        # armature so they can't grab it by accident in the viewport — but a
        # locked object silently refuses select_set(), and a selection-based
        # export then drops it. Losing the armature costs the whole skin: the
        # meshes come out static and the pose animation disappears, with no
        # error anywhere in the log.
        o.hide_select = False
        o.hide_set(False)
        o.hide_viewport = False
        o.hide_render = False
        o.select_set(True)
        wanted.append(o)
bpy.context.view_layer.objects.active = wanted[0]

report["exported_objects"] = sorted(o.name for o in wanted)
report["armatures"] = [o.name for o in wanted if o.type == "ARMATURE"]

# Fail loudly rather than shipping a silently skinless GLB.
missed = [o.name for o in wanted if not o.select_get()]
if missed:
    raise SystemExit(f"these objects could not be selected and would be dropped: {missed}")

path = os.path.join(OUT, NAME)
bpy.ops.export_scene.gltf(
    filepath=path,
    export_format="GLB",
    use_selection=True,
    # applies Solidify/Subdivision etc.; the exporter skips Armature modifiers
    # so skinning still comes across as a skin rather than being frozen in
    export_apply=True,
    export_yup=True,
    export_animations=True,
    export_animation_mode="ACTIONS",
    export_frame_range=False,
    export_bake_animation=True,
    export_skins=True,
    export_morph=False,
    export_cameras=False,
    export_lights=False,
    export_image_format="AUTO",
    export_jpeg_quality=82,
    export_normals=True,
    export_tangents=False,
    export_extras=False,
    export_optimize_animation_size=True,
)
report["glb_bytes"] = os.path.getsize(path)
report["actions"] = [a.name for a in bpy.data.actions]
print("EXPORT_REPORT " + json.dumps(report, default=str))
