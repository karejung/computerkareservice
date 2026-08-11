import bpy, json, os

BLEND = os.environ.get("BLEND", os.path.expanduser("~/Desktop/milkyforweb2.blend"))
OUT   = os.environ.get("OUT", "public/models")
os.makedirs(OUT, exist_ok=True)
bpy.ops.wm.open_mainfile(filepath=BLEND)
sc = bpy.context.scene

F0, F1 = sc.frame_start, sc.frame_end
sc.frame_step = 1
report = {"frame_start": F0, "frame_end": F1, "fps": sc.render.fps / sc.render.fps_base}

# keep the web payload sane
MAX = 1024
scaled = []
for img in bpy.data.images:
    if img.source != 'FILE' or img.size[0] == 0:
        continue
    w, h = img.size
    if max(w, h) > MAX:
        s = MAX / max(w, h)
        try:
            img.scale(max(1, int(w * s)), max(1, int(h * s)))
            scaled.append(img.name)
        except Exception as e:
            scaled.append(f"{img.name} FAILED {e}")
report["scaled_images"] = len(scaled)

for o in bpy.data.objects:
    o.select_set(False)

wanted = []
for cn in ["body", "furniture"]:
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
        o.hide_set(False); o.hide_viewport = False; o.hide_render = False
        o.select_set(True)
        wanted.append(o)
bpy.context.view_layer.objects.active = wanted[0]

report["exported_objects"] = sorted(o.name for o in wanted)

# Fail loudly rather than shipping a silently skinless GLB.
missed = [o.name for o in wanted if not o.select_get()]
if missed:
    raise SystemExit(f"these objects could not be selected and would be dropped: {missed}")
armatures = [o.name for o in wanted if o.type == 'ARMATURE']
report["armatures"] = armatures

path = os.path.join(OUT, "scene.glb")
bpy.ops.export_scene.gltf(
    filepath=path,
    export_format='GLB',
    use_selection=True,
    # applies Solidify/Subdivision etc.; the exporter skips Armature modifiers
    # so skinning still comes across as a skin rather than being frozen in
    export_apply=True,
    export_yup=True,
    export_animations=True,
    export_animation_mode='SCENE',
    export_frame_range=True,
    export_bake_animation=True,
    export_skins=True,
    export_morph=False,
    export_cameras=False,
    export_lights=False,
    export_image_format='JPEG',
    export_jpeg_quality=82,
    export_normals=True,
    export_tangents=False,
    export_extras=False,
    export_optimize_animation_size=True,
)
report["glb_bytes"] = os.path.getsize(path)
open("/tmp/export_v2.json", "w").write(json.dumps(report, indent=1, default=str))
