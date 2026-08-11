'use client';

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';

import { createFaceRig, type FaceRig } from '@/lib/faceTexture';

const GLB_URL = '/models/kare7.glb';

/**
 * The two clips that loop, and the one-shots that move between them.
 *
 * The two directions are not symmetrical: `spin` carries her into ds, but
 * coming back out she is startled by whatever she was holding vanishing, so
 * that leg plays `poof` instead.
 */
const CLIPS = { idle: 'idle', ds: 'ds', spin: 'spin', poof: 'poof', vsign: 'Vsign' } as const;
type ClipKey = keyof typeof CLIPS;
/** The clips that hold until something else asks for a change. */
export type KareMode = 'idle' | 'ds';

/** Crossfade length when the two poses are far apart — into ds, into Vsign. */
const FADE = 0.25;
/**
 * …and a short one for the idle↔spin joins. The spin's first and last frames
 * were authored to match idle's first pose, so there is nothing to blend; a
 * long fade would only eat into a clip that only runs 0.87s.
 */
const FADE_TIGHT = 0.1;
/**
 * How far into `poof` the thing actually disappears — frame 4 of 36 at 30fps.
 * The graphic has to land on that frame, not on the keypress.
 */
const POOF_CUE = 0.1;

/**
 * Node names change between exports — `HAIR` came back as `hair`, GLTFLoader
 * strips the dot out of `FACE.003` — so every lookup goes through this rather
 * than matching the string as authored.
 */
const key = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Node carrying the face. Its `white` slot is what the live canvas paints. */
const FACE_NODE = key('FACE');

/** Material the tintable parts share — with the chair, which is why the set below exists. */
const TINT_MATERIAL = key('black.001');

/** Cheek marks, which sit under the hair geometrically but should read over it. */
const BLUSH_MATERIAL = key('blush');
const BLUSH_RENDER_ORDER = 10;

/**
 * Nodes the model colour applies to: hair, the brows over the face, pants and
 * both shoes.
 *
 * Matched per node *and* per material slot. `FACE` carries two slots — the
 * brows on `black.001` and the face itself on `white` — so tinting the whole
 * node would take the face with it, and tinting the material outright would
 * take the chair.
 */
const TINTED_NODES = new Set(['hair', 'FACE', 'pants', 'SHOEL', 'SHOER'].map(key));

/** Head tracking, split so the turn reads as a lean rather than a swivel. */
const HEAD_TRACK = [
  { node: key('mixamorig:Neck'), weight: 0.35 },
  { node: key('mixamorig:Head'), weight: 0.65 },
];
/** Seconds for the head to close most of the gap to the pointer. */
const HEAD_RESPONSE = 0.12;

/** Material the body, face shell, top and keyboard share. */
const LIT_MATERIAL = key('white');

/** Empty the console hangs off, bone-parented to the left hand in the GLB. */
const DS_ROOT = key('Nintendo DS');
/** Seconds for the console to pop into existence. */
const DS_POP = 0.18;
/**
 * The console body was authored with a Toon BSDF, which glTF has no equivalent
 * for, so the exporter drops its colour and it arrives white. It was #377cf6 —
 * the same accent the character is tinted with — so it rides `emissive` rather
 * than being written down a second time and drifting.
 */
const DS_BODY_MATERIAL = key('blue');
/** Edge strips, likewise lost: an Emission green the exporter kept only partly. */
const DS_NEON_MATERIALS = new Set(['neon.001', 'neon droite.001'].map(key));
const DS_NEON_COLOR = '#3fff00';

type TwoToneUniforms = {
  uShade: { value: THREE.Color };
  uSplit: { value: number };
  uShadeDir: { value: THREE.Vector3 };
};

type TwoToneMaterial = THREE.MeshLambertMaterial & {
  userData: { uniforms: TwoToneUniforms };
};

/**
 * Two-tone shading painted straight from the surface normal, with the scene's
 * lights left out of it entirely.
 *
 * Deriving the shadow from the rig is what made this unpredictable before: the
 * output scaled with however bright the lights happened to be, so the lit side
 * only hit #ffffff by coincidence and every preset moved the result. Here the
 * shadow is a drawing decision — a fixed direction, one threshold, two exact
 * colours — so `light intensity`, `preset` and `environment` cannot disturb it.
 *
 * Lambert is the base only because it hands over a skinned, double-sided-aware
 * `normal` in the fragment shader; none of its lighting survives.
 */
/**
 * Rebuild an authored-unlit glTF material as a genuinely unlit one.
 *
 * These carry their colour on `emissiveFactor` over a black base, which reads
 * as flat right up until the edges: MeshStandardMaterial pins `specularF90` to
 * 1.0, so Fresnel still climbs to full reflectance at grazing angles no matter
 * how black the base colour is, and the environment lights that rim. Dropping
 * to MeshBasicMaterial removes the lighting term altogether rather than trying
 * to cancel it — flat is then the only thing it can be.
 */
function createFlatMaterial(source: THREE.Material): THREE.MeshBasicMaterial {
  const src = source as THREE.MeshStandardMaterial;
  // The character is authored unlit, so its colour is on emissive. The console
  // is not — its parts came through glTF as ordinary PBR, with the colour on
  // baseColor and emissive left black. Reading only emissive rendered those
  // black, so fall back when there is nothing on that channel.
  const lit = src.emissive?.clone().multiplyScalar(src.emissiveIntensity ?? 1);
  const useBase = !lit || (lit.r + lit.g + lit.b) < 0.001;
  return new THREE.MeshBasicMaterial({
    name: src.name,
    color: useBase ? (src.color?.clone() ?? new THREE.Color(0xffffff)) : lit,
    // The colour lived on the emissive channel, so its texture does too.
    map: src.emissiveMap ?? src.map ?? null,
    transparent: src.transparent,
    opacity: src.opacity,
    alphaTest: src.alphaTest,
    side: src.side,
    depthWrite: src.depthWrite,
  });
}

function createTwoToneMaterial(
  side: THREE.Side,
  map?: THREE.Texture,
  color: THREE.ColorRepresentation = 0xffffff,
  cutout = false,
): TwoToneMaterial {
  const material = new THREE.MeshLambertMaterial({
    name: cutout ? 'face-live' : 'two-tone',
    color,
    side,
    map,
    // Cut out rather than blend: a blended shell turns off depth writes, and
    // then the back of the head and the neck show through the face. Only the
    // face needs it — the console's screens are opaque, and an alphaTest there
    // would punch holes anywhere the artwork happens to be dark.
    alphaTest: cutout ? 0.5 : 0,
  }) as TwoToneMaterial;

  // Built up front and handed to the shader by reference, so writing to them
  // takes effect whether or not the program has compiled yet.
  const uniforms: TwoToneUniforms = {
    uShade: { value: new THREE.Color(0xc8c8c8) },
    uSplit: { value: 0.15 },
    uShadeDir: { value: new THREE.Vector3(0.5, 0.6, 0.6).normalize() },
  };
  material.userData.uniforms = uniforms;

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform vec3 uShade;
        uniform float uSplit;
        uniform vec3 uShadeDir;`,
      )
      .replace(
        '#include <opaque_fragment>',
        `{
          // uShadeDir is authored in world space, the normal is in view space.
          vec3 shadeDir = normalize( mat3( viewMatrix ) * uShadeDir );
          float facing = dot( normalize( normal ), shadeDir );
          vec3 tone = mix( uShade, vec3( 1.0 ), step( uSplit, facing ) );
          // Modulating diffuseColor rather than replacing the light keeps any
          // map intact — the face is drawn on one of these, and it has to
          // survive the shading rather than be painted over by it.
          outgoingLight = diffuseColor.rgb * tone;
        }
        #include <opaque_fragment>`,
      );
  };
  // Distinct key so three does not hand this the program of an unpatched
  // Lambert material.
  material.customProgramCacheKey = () => 'two-tone-v2';

  return material;
}

const _euler = new THREE.Euler();
const _delta = new THREE.Quaternion();
const _parent = new THREE.Quaternion();
const _parentInverse = new THREE.Quaternion();
const _shadeDir = new THREE.Vector3();
const _handL = new THREE.Vector3();
const _handR = new THREE.Vector3();
const _between = new THREE.Vector3();

export type KareHandle = {
  /** Play the Vsign once, then ease back into whichever loop was running. */
  playVsign: () => void;
  /** Spin into the ds loop, or spin back out of it. */
  toggleDs: () => void;
};

export type KareProps = {
  /** Emissive colour for the hair, pants and shoes. */
  emissive?: string;
  /** Colour of the shadow tone on the white parts; the lit side is #ffffff. */
  shadeColor?: string;
  /** Where the terminator falls, as a normal-facing threshold (-1..1). */
  shadeSplit?: number;
  /** Direction the fake shadow is cast from: compass angle, in degrees. */
  shadeAngle?: number;
  /** …and how high above the horizon, in degrees. */
  shadeHeight?: number;
  /** Maximum left/right head turn at the edge of the window, in radians. */
  headYaw?: number;
  /** Maximum up/down head tilt, in radians. */
  headPitch?: number;
  /** Fires when the resting loop changes, so the caller can light its button. */
  onModeChange?: (mode: KareMode) => void;
  /**
   * Fires on the frame the held object vanishes, at the point between her
   * hands. The vector is reused between calls — copy it, don't keep it.
   */
  onPoof?: (at: THREE.Vector3) => void;
  /** Fires as a spin starts, with the clip's length, for effects to ride along. */
  onSpin?: (seconds: number) => void;
};

/**
 * kare7.glb.
 *
 * Two resting loops, `idle` and `ds`, with two one-shots that move between
 * them:
 *
 *   playVsign()  – Vsign, then back to whichever loop was running
 *   toggleDs()   – spin, then into the loop the character was not in
 *
 * A one-shot in flight is ignored rather than queued, so a double-tap cannot
 * strand the mixer between clips.
 *
 * The face comes from a live canvas (face.svg redrawn every frame: the eyes
 * follow the pointer and blink on their own) rather than a baked image, and it
 * rides on the same two-tone material as the body, so the drawing picks up the
 * shading instead of sitting flat on top of it.
 *
 * Node and material names move around between exports — `HAIR` came back as
 * `hair`, the face went from two `FACE.00x` shells to one `FACE` with two
 * material slots — so nothing here matches a name as authored. Everything goes
 * through `key()`, and the face is handled per slot rather than per node.
 */
export const Kare = forwardRef<KareHandle, KareProps>(function Kare(
  {
    emissive,
    shadeColor = '#ededed',
    shadeSplit = 0.05,
    shadeAngle = 55,
    shadeHeight = 47,
    headYaw = 0,
    headPitch = 0,
    onModeChange,
    onPoof,
    onSpin,
  },
  ref,
) {
  const { scene, animations } = useGLTF(GLB_URL);
  const mixer = useMemo(() => new THREE.AnimationMixer(scene), [scene]);
  const actions = useRef<Partial<Record<ClipKey, THREE.AnimationAction>>>({});
  /** The loop that is running, or that a one-shot will hand back to. */
  const mode = useRef<KareMode>('idle');
  /** Set while a one-shot is in flight; holds the loop to settle into after. */
  const pending = useRef<KareMode | null>(null);
  // Kept in a ref so the mixer callback never closes over a stale prop.
  const notify = useRef(onModeChange);
  notify.current = onModeChange;
  const onPoofRef = useRef(onPoof);
  onPoofRef.current = onPoof;
  const onSpinRef = useRef(onSpin);
  onSpinRef.current = onSpin;
  /** Set while a poof is running and its graphic has not been fired yet. */
  const poofCue = useRef(false);
  const hands = useRef<THREE.Object3D[]>([]);
  const rig = useRef<FaceRig | null>(null);
  const tint = useRef<THREE.MeshBasicMaterial | null>(null);
  const dsBody = useRef<TwoToneMaterial | null>(null);
  const dsRoot = useRef<THREE.Object3D | null>(null);
  const dsScale = useRef(1);
  const dsPop = useRef(-1);
  const twoTone = useRef<TwoToneMaterial[]>([]);
  const headBones = useRef<
    { bone: THREE.Object3D; weight: number; posed: THREE.Quaternion }[]
  >([]);
  const look = useRef({ x: 0, y: 0, tx: 0, ty: 0 });

  /**
   * Hand the character over to `to`, fading `from` out across the same window.
   *
   * fadeIn/fadeOut only schedule a weight ramp, so the outgoing action has to
   * keep playing through it — stopping it here would snap rather than blend.
   */
  const fadeTo = (from: ClipKey, to: ClipKey, seconds: number) => {
    const a = actions.current;
    const next = a[to];
    if (!next) return;
    a[from]?.fadeOut(seconds);
    next.reset().setEffectiveWeight(1).fadeIn(seconds).play();
  };

  /** Start a one-shot that lands in `after` once it finishes. */
  const oneShot = (clip: 'spin' | 'poof' | 'vsign', after: KareMode, seconds: number) => {
    if (pending.current) return false; // already mid-transition
    const action = actions.current[clip];
    if (!action) return false;
    pending.current = after;
    fadeTo(mode.current, clip, seconds);
    return action.getClip().duration;
  };

  useImperativeHandle(ref, () => ({
    playVsign() {
      oneShot('vsign', mode.current, FADE);
    },
    toggleDs() {
      if (mode.current === 'idle') {
        // Into ds: the spin's first frame matches idle pose-for-pose, but its
        // last is ~70 deg from the ds hold at the shoulders, so that end blends.
        const seconds = oneShot('spin', 'ds', FADE_TIGHT);
        // Falsy when the press was swallowed mid-transition, so the sparkle
        // only fires on a spin that actually started.
        if (seconds) onSpinRef.current?.(seconds);
      } else {
        // Back out: poof was authored from the ds pose to idle's, so both ends
        // already line up and neither needs a real blend.
        if (oneShot('poof', 'idle', FADE_TIGHT)) poofCue.current = true;
      }
    },
  }));

  useEffect(() => {
    const face = createFaceRig();
    rig.current = face;

    /*
     * One pass to index the scene and stash what the GLB actually shipped.
     *
     * Everything below rebuilds materials from `base`, never from whatever is
     * mounted. useGLTF hands back one cached scene and React runs this effect
     * twice in development, so a swap that read the live material would find
     * the previous run's replacement the second time round — and the lookups
     * here go by material name, which that replacement no longer carries.
     */
    const byName = new Map<string, THREE.Object3D>();
    scene.traverse((obj) => {
      byName.set(key(obj.name), obj);
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (!mesh.userData.baseMaterial) mesh.userData.baseMaterial = mesh.material;
      // Casting still feeds the contact shadow on the floor. Receiving is off:
      // the shading here is drawn from the normal, not lit, so a shadow landing
      // on the model would only fight the two-tone it is supposed to have.
      mesh.castShadow = true;
      mesh.receiveShadow = false;
    });

    const baseOf = (mesh: THREE.Mesh): THREE.Material[] => {
      const base = (mesh.userData.baseMaterial ?? mesh.material) as
        | THREE.Material
        | THREE.Material[];
      return Array.isArray(base) ? base : [base];
    };

    /*
     * One slot-by-slot pass over every mesh.
     *
     * `FACE` carries two materials on one mesh — brows on `black.001`, the face
     * itself on `white` — so this cannot work at the node level: the node needs
     * one slot tinted and the other painted with the canvas.
     *
     * `white` was authored unlit (white emissive, black base colour), so its
     * colour has to move onto `color` where the two-tone shader can reach it.
     */
    const faceNode = byName.get(FACE_NODE);
    /*
     * Every mesh hanging off the console, so its slots can be routed to the
     * same two-tone shading the body uses. Matching by material name would not
     * do: the console's parts carry names of their own, and one of them is a
     * texture the character never touches.
     */
    const consoleMeshes = new Set<THREE.Object3D>();
    byName.get(DS_ROOT)?.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) consoleMeshes.add(o);
    });
    let litShared: TwoToneMaterial | null = null;
    let faceMaterial: TwoToneMaterial | null = null;
    let tinted: THREE.MeshBasicMaterial | null = null;
    const twoToneMaterials: TwoToneMaterial[] = [];
    // Keyed on the source so meshes sharing a material keep sharing one.
    const flats = new Map<THREE.Material, THREE.MeshBasicMaterial>();
    const consoleMats = new Map<THREE.Material, TwoToneMaterial>();

    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;

      const isFace = mesh === faceNode;
      const tintable = TINTED_NODES.has(key(mesh.name));
      const slots = baseOf(mesh);

      const swapped = slots.map((slot) => {
        const name = key(slot.name);

        if (name === LIT_MATERIAL) {
          if (isFace) {
            if (!faceMaterial) {
              faceMaterial = createTwoToneMaterial(slot.side, face.texture, 0xffffff, true);
              twoToneMaterials.push(faceMaterial);
            }
            return faceMaterial;
          }
          if (!litShared) {
            litShared = createTwoToneMaterial(slot.side);
            twoToneMaterials.push(litShared);
          }
          return litShared;
        }

        // One material shared by every tinted slot, so a single write
        // recolours the lot while the chair keeps its own.
        if (name === TINT_MATERIAL && tintable) {
          if (!tinted) {
            tinted = createFlatMaterial(slot);
            tinted.name = 'tinted';
          }
          return tinted;
        }

        /*
         * The console: same two-tone treatment as the skin, keeping whatever
         * colour or screen artwork the slot arrived with. Left flat it read as
         * a sticker on an otherwise shaded character.
         */
        if (consoleMeshes.has(mesh)) {
          let shaded = consoleMats.get(slot);
          if (!shaded) {
            const src = slot as THREE.MeshStandardMaterial;
            const lit = src.emissive?.clone().multiplyScalar(src.emissiveIntensity ?? 1);
            const colour =
              !lit || lit.r + lit.g + lit.b < 0.001
                ? (src.color?.clone() ?? new THREE.Color(0xffffff))
                : lit;
            if (DS_NEON_MATERIALS.has(name)) colour.set(DS_NEON_COLOR);
            shaded = createTwoToneMaterial(
              src.side,
              src.emissiveMap ?? src.map ?? undefined,
              colour,
            );
            shaded.name = `ds-${slot.name}`;
            twoToneMaterials.push(shaded);
            consoleMats.set(slot, shaded);
            if (name === DS_BODY_MATERIAL) dsBody.current = shaded;
          }
          return shaded;
        }

        // Everything else authored unlit — the chair, the blush — goes flat
        // too, or it keeps the rim the environment gives it.
        let flat = flats.get(slot);
        if (!flat) {
          flat = createFlatMaterial(slot);
          if (name === BLUSH_MATERIAL) {
            /*
             * The cheek marks sit on the head, behind the hair that falls over
             * it, so depth testing hides them exactly where they read best.
             * Drawing them last with the test off puts them back on top.
             *
             * That alone would also show them through the back of the head, so
             * back-face culling stands in for the depth test: the marks face
             * out of the cheeks, and once the head turns away they face away
             * too and are dropped.
             */
            flat.depthTest = false;
            flat.depthWrite = false;
            flat.transparent = true;
            flat.side = THREE.FrontSide;

            /*
             * Full strength, ignoring the 0.5 emissive factor it was authored
             * with. That factor was only half the picture before: the material
             * is the one thing here with a non-metallic base colour, so it also
             * picked up a lit diffuse pass on top. Unlit, keeping the 0.5 just
             * halves the texture and the pink goes muddy — the texture already
             * carries the colour it should be.
             */
            flat.color.setRGB(1, 1, 1);
          }
          flats.set(slot, flat);
        }
        if (name === BLUSH_MATERIAL) mesh.renderOrder = BLUSH_RENDER_ORDER;
        return flat;
      });

      mesh.material = slots.length > 1 ? swapped : swapped[0];
    });

    twoTone.current = twoToneMaterials;
    tint.current = tinted;

    /*
     * The console starts hidden, and has to be hidden before the camera fit
     * runs: that pass skips invisible meshes, so leaving it on would let a prop
     * the character is not even holding yet pull the framing around.
     */
    const console3d = byName.get(DS_ROOT) ?? null;
    dsRoot.current = console3d;
    if (console3d) {
      console3d.visible = false;
      dsScale.current = console3d.scale.x;
    }

    hands.current = [key('mixamorig:LeftHand'), key('mixamorig:RightHand')]
      .map((n) => byName.get(n))
      .filter((b): b is THREE.Object3D => Boolean(b));

    headBones.current = HEAD_TRACK.flatMap(({ node, weight }) => {
      const bone = byName.get(node);
      return bone ? [{ bone, weight, posed: bone.quaternion.clone() }] : [];
    });

    const move = (e: PointerEvent) => {
      const nx = (e.clientX / window.innerWidth) * 2 - 1;
      const ny = (e.clientY / window.innerHeight) * 2 - 1;
      rig.current?.setLookTarget(nx, ny);
      look.current.tx = Math.max(-1, Math.min(1, nx));
      look.current.ty = Math.max(-1, Math.min(1, ny));
    };
    const leave = () => {
      rig.current?.resetLook();
      look.current.tx = 0;
      look.current.ty = 0;
    };
    window.addEventListener('pointermove', move);
    document.addEventListener('mouseleave', leave);
    window.addEventListener('blur', leave);

    const byClip = new Map(animations.map((clip) => [clip.name, clip]));
    const built: Partial<Record<ClipKey, THREE.AnimationAction>> = {};
    const missing: string[] = [];

    for (const [slot, name] of Object.entries(CLIPS) as [ClipKey, string][]) {
      const clip = byClip.get(name);
      if (!clip) {
        missing.push(name);
        continue;
      }
      const action = mixer.clipAction(clip);
      if (slot === 'idle' || slot === 'ds') {
        action.setLoop(THREE.LoopRepeat, Infinity);
      } else {
        action.setLoop(THREE.LoopOnce, 1);
        // Hold the last frame; the crossfade out of it starts on the same tick
        // the 'finished' event lands, and a clip that had rewound would pop.
        action.clampWhenFinished = true;
      }
      built[slot] = action;
    }
    if (missing.length) {
      console.warn(
        `[kare] missing clips ${missing.join(', ')} — got:`,
        animations.map((c) => c.name),
      );
    }
    actions.current = built;
    mode.current = 'idle';
    pending.current = null;
    built.idle?.play();

    const onFinished = (e: { action: THREE.AnimationAction }) => {
      const a = actions.current;
      const after = pending.current;
      // Loops never fire this, so anything here is one of the two one-shots.
      if (!after || (e.action !== a.vsign && e.action !== a.spin && e.action !== a.poof)) {
        return;
      }
      poofCue.current = false;
      const from: ClipKey =
        e.action === a.spin ? 'spin' : e.action === a.poof ? 'poof' : 'vsign';
      // spin ends on the ds hold and poof ends on the idle pose, so both hand
      // over tight. The Vsign stops mid-gesture and needs the longer blend.
      fadeTo(from, after, from === 'vsign' ? FADE : from === 'spin' ? FADE : FADE_TIGHT);
      pending.current = null;
      if (after === 'ds' && dsRoot.current) {
        dsRoot.current.visible = true;
        dsPop.current = 0;
      }
      if (mode.current !== after) {
        mode.current = after;
        notify.current?.(after);
      }
    };
    mixer.addEventListener('finished', onFinished);

    return () => {
      window.removeEventListener('pointermove', move);
      document.removeEventListener('mouseleave', leave);
      window.removeEventListener('blur', leave);
      mixer.removeEventListener('finished', onFinished);
      face.dispose();
      rig.current = null;
      tinted?.dispose();
      tint.current = null;
      for (const flat of flats.values()) flat.dispose();
      for (const mat of twoToneMaterials) mat.dispose();
      twoTone.current = [];
      headBones.current = [];
      hands.current = [];
      dsRoot.current = null;
      dsBody.current = null;
      dsPop.current = -1;
      poofCue.current = false;
      actions.current = {};
      mode.current = 'idle';
      pending.current = null;
      mixer.stopAllAction();
      mixer.uncacheRoot(scene);
    };
  }, [scene, animations, mixer]);

  // Runs after the effect above, which is where `tint` is filled in.
  // Color.set() takes the hex from sRGB into the linear working space, which is
  // where glTF's emissiveFactor already lives.
  useEffect(() => {
    if (!emissive) return;
    // Unlit now, so the colour lives on `color` rather than `emissive`.
    tint.current?.color.set(emissive);
    // The console body was that same accent before glTF lost it.
    dsBody.current?.color.set(emissive);
    // The eyes, lids and brows are drawn in the same ink as the hair, so they
    // move with it rather than staying black once the model is recoloured.
    rig.current?.setInk(emissive);
  }, [scene, emissive]);

  useEffect(() => {
    const azimuth = shadeAngle * THREE.MathUtils.DEG2RAD;
    const elevation = shadeHeight * THREE.MathUtils.DEG2RAD;
    _shadeDir.set(
      Math.sin(azimuth) * Math.cos(elevation),
      Math.sin(elevation),
      Math.cos(azimuth) * Math.cos(elevation),
    );

    for (const { userData } of twoTone.current) {
      userData.uniforms.uShade.value.set(shadeColor);
      userData.uniforms.uSplit.value = shadeSplit;
      userData.uniforms.uShadeDir.value.copy(_shadeDir);
    }
  }, [scene, shadeColor, shadeSplit, shadeAngle, shadeHeight]);

  useFrame((_, dt) => {
    const tracked = headBones.current;

    /*
     * Put last frame's pose back before the mixer runs.
     *
     * three's PropertyMixer compares its own buffers to decide whether a track
     * changed, and skips writing to the bone when it has not — it never looks
     * at the bone itself. So on any frame where the clip holds still, the bone
     * keeps the turn written into it last frame, and the next turn multiplies
     * on top of that. That is the spin: the offset compounds instead of being
     * reset. Restoring first means the delta always lands on a clean pose.
     */
    for (const { bone, posed } of tracked) bone.quaternion.copy(posed);

    mixer.update(dt);

    for (const track of tracked) track.posed.copy(track.bone.quaternion);

    /*
     * Fire the burst on the frame the object goes, reading the hands straight
     * from the pose the mixer just wrote. Doing it off the keypress instead
     * would put the graphic ~3 frames early, before she has reacted at all.
     */
    if (poofCue.current) {
      const poof = actions.current.poof;
      if (!poof) {
        poofCue.current = false;
      } else if (poof.time >= POOF_CUE && hands.current.length === 2) {
        poofCue.current = false;
        hands.current[0].getWorldPosition(_handL);
        hands.current[1].getWorldPosition(_handR);
        onPoofRef.current?.(_between.addVectors(_handL, _handR).multiplyScalar(0.5));
        // Gone on the same frame the smoke appears, which is what sells it.
        if (dsRoot.current) dsRoot.current.visible = false;
      }
    }

    /*
     * Head tracking, layered on top of the clip.
     *
     * The turn goes around world axes rather than the bone's own, since
     * Mixamo's local axes do not line up with yaw and pitch:
     *   local' = parent⁻¹ · delta · parent · local
     * Neck is processed first, so by the time Head reads its parent's world
     * rotation the lean is already part of it.
     */
    if (headYaw !== 0 || headPitch !== 0) {
      // Frame-rate independent easing, so the follow feels the same at 30fps.
      const l = look.current;
      const alpha = 1 - Math.exp(-dt / HEAD_RESPONSE);
      l.x += (l.tx - l.x) * alpha;
      l.y += (l.ty - l.y) * alpha;

      for (const { bone, weight } of tracked) {
        _euler.set(l.y * headPitch * weight, l.x * headYaw * weight, 0, 'YXZ');
        _delta.setFromEuler(_euler);
        if (bone.parent) {
          bone.parent.getWorldQuaternion(_parent);
          _parentInverse.copy(_parent).invert();
          bone.quaternion
            .premultiply(_parent)
            .premultiply(_delta)
            .premultiply(_parentInverse);
        } else {
          bone.quaternion.premultiply(_delta);
        }
      }
    }

    /*
     * Pop-in, overshooting slightly before settling. Scaling the empty is
     * enough — the thirteen meshes hang off it, so one write moves the lot,
     * and the bone parent keeps it in her hand throughout.
     */
    if (dsPop.current >= 0 && dsRoot.current) {
      dsPop.current += dt;
      const u = Math.min(1, dsPop.current / DS_POP);
      const c1 = 2.2;
      const back = 1 + (c1 + 1) * Math.pow(u - 1, 3) + c1 * Math.pow(u - 1, 2);
      dsRoot.current.scale.setScalar(dsScale.current * back);
      if (u >= 1) dsPop.current = -1;
    }

    rig.current?.update();
  });

  return <primitive object={scene} />;
});

useGLTF.preload(GLB_URL);
