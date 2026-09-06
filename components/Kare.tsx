'use client';

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';

import { asset } from '@/lib/asset';
import { createFaceRig, type FaceRig } from '@/lib/faceTexture';
import {
  createConsoleMaterial,
  createScreenMaterial,
  tickScreens,
  createTwoToneMaterial,
  isScreenMaterial,
  key,
  PROP_ROOTS,
  type PropKind,
  type TwoToneMaterial,
} from '@/lib/twoTone';

export const GLB_URL = asset('/models/kare9.glb');

const CLIPS = {
  idle: 'idle',
  ds: 'ds',
  pc: 'PC',
  phone: 'phone',
  spin: 'spin',
  poof: 'poof',
  vsign: 'Vsign',
} as const;
type ClipKey = keyof typeof CLIPS;
export type KareMode = 'idle' | PropKind;
const PROP_MODES = ['ds', 'pc', 'phone'] as const satisfies readonly PropKind[];

const FADE = 0.25;
const FADE_TIGHT = 0.1;

const VSIGN_CUE = FADE + 0.1;

const V_TIPS = ['HandIndex4', 'HandMiddle4'];

const WINK_HOLD = 0.5;

const GAZE_HOLD = 0.4;

const FACE_NODE = key('FACE');

const TINT_MATERIAL = key('black.001');

const BLUSH_MATERIAL = key('blush');
const BLUSH_RENDER_ORDER = 10;

const TINTED_NODES = new Set(['hair', 'FACE', 'pants', 'SHOEL', 'SHOER'].map(key));

const HEAD_TRACK = [
  { node: key('mixamorig:Neck'), weight: 0.35 },
  { node: key('mixamorig:Head'), weight: 0.65 },
];
const HEAD_RESPONSE = 0.12;
const PITCH_UP_GAIN = 2.0;

const LIT_MATERIAL = key('white');
const FACE_MATERIAL = key('face.002');
const LIT_MATERIALS = new Set([LIT_MATERIAL, FACE_MATERIAL]);

const DS_POP = 0.26;
const PUFF_COVER = 1.5;
const REVEAL_DELAY = FADE;

function createFlatMaterial(source: THREE.Material): THREE.MeshBasicMaterial {
  const src = source as THREE.MeshStandardMaterial;

  const lit = src.emissive?.clone().multiplyScalar(src.emissiveIntensity ?? 1);
  const useBase = !lit || (lit.r + lit.g + lit.b) < 0.001;
  const map = src.transparent ? (src.map ?? src.emissiveMap) : (src.emissiveMap ?? src.map);
  return new THREE.MeshBasicMaterial({
    name: src.name,
    color: useBase ? (src.color?.clone() ?? new THREE.Color(0xffffff)) : lit,
    map: map ?? null,
    transparent: src.transparent,
    opacity: src.opacity,
    alphaTest: src.alphaTest,
    side: src.side,
    depthWrite: src.depthWrite,
  });
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
  playVsign: () => void;
  setMode: (mode: KareMode) => boolean;
  toggleDs: () => boolean;
};

export type KareProps = {
  emissive?: string;
  shadeColor?: string;
  shadeSplit?: number;
  shadeAngle?: number;
  shadeHeight?: number;
  headYaw?: number;
  headPitch?: number;
  onModeChange?: (mode: KareMode) => void;
  onSpin?: (seconds: number) => void;
  onPuff?: (at: THREE.Vector3, radius?: number, stars?: boolean) => void;
  onSparkle?: (at: THREE.Vector3) => void;
};

export const Kare = forwardRef<KareHandle, KareProps>(function Kare(
  {
    emissive,
    shadeColor = '#dedede',
    shadeSplit = 0.05,
    shadeAngle = 44,
    shadeHeight = 30,
    headYaw = 0,
    headPitch = 0,
    onModeChange,
    onSpin,
    onPuff,
    onSparkle,
  },
  ref,
) {
  const { scene, animations } = useGLTF(GLB_URL);
  const gl = useThree((s) => s.gl);
  const mixer = useMemo(() => new THREE.AnimationMixer(scene), [scene]);
  const actions = useRef<Partial<Record<ClipKey, THREE.AnimationAction>>>({});
  const mode = useRef<KareMode>('idle');
  const pending = useRef<KareMode | null>(null);

  const notify = useRef(onModeChange);
  notify.current = onModeChange;
  const onSpinRef = useRef(onSpin);
  onSpinRef.current = onSpin;
  const onPuffRef = useRef(onPuff);
  onPuffRef.current = onPuff;
  const onSparkleRef = useRef(onSparkle);
  onSparkleRef.current = onSparkle;
  const vsignCue = useRef(false);
  const winkUntil = useRef(0);
  const gazeUntil = useRef(0);
  const hands = useRef<THREE.Object3D[]>([]);
  const vHands = useRef<{ hand: THREE.Object3D; tips: THREE.Object3D[] }[]>([]);
  const rig = useRef<FaceRig | null>(null);
  const tint = useRef<THREE.MeshBasicMaterial | null>(null);
  const propRoots = useRef<Partial<Record<PropKind, THREE.Object3D>>>({});
  const propScale = useRef<Partial<Record<PropKind, number>>>({});
  const propRadius = useRef<Partial<Record<PropKind, number>>>({});
  const popping = useRef<PropKind | null>(null);
  const reveal = useRef<{ kind: PropKind; at: number } | null>(null);
  const dsPop = useRef(-1);
  const twoTone = useRef<TwoToneMaterial[]>([]);
  const headBones = useRef<
    { bone: THREE.Object3D; weight: number; posed: THREE.Quaternion }[]
  >([]);
  const look = useRef({ x: 0, y: 0, tx: 0, ty: 0 });

  const fadeTo = (from: ClipKey, to: ClipKey, seconds: number) => {
    const a = actions.current;
    const next = a[to];
    if (!next) return;
    a[from]?.fadeOut(seconds);
    next.reset().setEffectiveWeight(1).fadeIn(seconds).play();
  };

  const puffAt = (kind: PropKind | null, stars: boolean) => {
    if (hands.current.length !== 2) return;
    hands.current[0].getWorldPosition(_handL);
    hands.current[1].getWorldPosition(_handR);
    const radius = kind ? propRadius.current[kind] : undefined;
    onPuffRef.current?.(
      _between.addVectors(_handL, _handR).multiplyScalar(0.5),
      radius === undefined ? undefined : radius * PUFF_COVER,
      stars,
    );
  };

  const showProp = (kind: KareMode | null) => {
    for (const m of PROP_MODES) {
      const root = propRoots.current[m];
      if (root) root.visible = m === kind;
    }
  };

  const oneShot = (clip: 'spin' | 'poof' | 'vsign', after: KareMode, seconds: number) => {
    if (pending.current) return false;
    const action = actions.current[clip];
    if (!action) return false;
    pending.current = after;
    fadeTo(mode.current, clip, seconds);
    return action.getClip().duration;
  };

  const wink = (seconds: number) => {
    rig.current?.setWink(true);
    winkUntil.current = performance.now() + (seconds + WINK_HOLD) * 1000;
  };

  const setMode = (next: KareMode): boolean => {
    if (next === mode.current) return false;
    const toIdle = next === 'idle';
    const seconds = toIdle
      ? oneShot('poof', 'idle', FADE_TIGHT)
      : oneShot('spin', next, FADE_TIGHT);

    if (!seconds) return false;

    const leaving = mode.current === 'idle' ? null : (mode.current as PropKind);
    showProp(null);
    popping.current = null;
    dsPop.current = -1;

    reveal.current = null;

    if (toIdle) {
      puffAt(leaving, true);
    } else {
      onSpinRef.current?.(seconds);
    }
    wink(seconds);
    return true;
  };

  useImperativeHandle(ref, () => ({
    playVsign() {
      const seconds = oneShot('vsign', mode.current, FADE);
      if (!seconds) return;
      vsignCue.current = true;

      rig.current?.resetLook();
      gazeUntil.current = performance.now() + (seconds + GAZE_HOLD) * 1000;
    },
    setMode,
    toggleDs() {
      return setMode(mode.current === 'ds' ? 'idle' : 'ds');
    },
  }));

  useEffect(() => {
    const face = createFaceRig();
    rig.current = face;

    const byName = new Map<string, THREE.Object3D>();
    scene.traverse((obj) => {
      byName.set(key(obj.name), obj);
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (!mesh.userData.baseMaterial) mesh.userData.baseMaterial = mesh.material;
    });

    const baseOf = (mesh: THREE.Mesh): THREE.Material[] => {
      const base = (mesh.userData.baseMaterial ?? mesh.material) as
        | THREE.Material
        | THREE.Material[];
      return Array.isArray(base) ? base : [base];
    };

    const faceNode = byName.get(FACE_NODE);
    const consoleMeshes = new Set<THREE.Object3D>();
    for (const kind of PROP_MODES) {
      byName.get(PROP_ROOTS[kind])?.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) consoleMeshes.add(o);
      });
    }
    let litShared: TwoToneMaterial | null = null;
    let faceMaterial: TwoToneMaterial | null = null;
    let tinted: THREE.MeshBasicMaterial | null = null;
    const twoToneMaterials: TwoToneMaterial[] = [];

    const flats = new Map<THREE.Material, THREE.MeshBasicMaterial>();
    const consoleMats = new Map<THREE.Material, THREE.Material>();

    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;

      const isFace = mesh === faceNode;
      const tintable = TINTED_NODES.has(key(mesh.name));
      const slots = baseOf(mesh);

      const swapped = slots.map((slot) => {
        const name = key(slot.name);

        if (LIT_MATERIALS.has(name)) {
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

        if (name === TINT_MATERIAL && tintable) {
          if (!tinted) {
            tinted = createFlatMaterial(slot);
            tinted.name = 'tinted';
          }
          return tinted;
        }

        if (consoleMeshes.has(mesh)) {
          let shaded = consoleMats.get(slot);
          if (!shaded) {
            if (isScreenMaterial(slot)) {
              shaded = createScreenMaterial(slot, mesh.geometry, true);
            } else {
              const tone = createConsoleMaterial(slot);
              twoToneMaterials.push(tone);
              shaded = tone;
            }
            consoleMats.set(slot, shaded);
          }
          return shaded;
        }

        let flat = flats.get(slot);
        if (!flat) {
          flat = createFlatMaterial(slot);
          if (name === BLUSH_MATERIAL) {
            flat.depthTest = false;
            flat.depthWrite = false;
            flat.transparent = true;
            flat.side = THREE.FrontSide;

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

    propRoots.current = {};
    propScale.current = {};
    for (const kind of PROP_MODES) {
      const root = byName.get(PROP_ROOTS[kind]);
      if (!root) continue;
      propRoots.current[kind] = root;
      propScale.current[kind] = root.scale.x;

      root.visible = true;
      root.updateWorldMatrix(true, true);
      const box = new THREE.Box3().setFromObject(root);
      propRadius.current[kind] = box.isEmpty()
        ? undefined
        : box.getBoundingSphere(new THREE.Sphere()).radius;
      root.visible = false;
    }

    hands.current = [key('mixamorig:LeftHand'), key('mixamorig:RightHand')]
      .map((n) => byName.get(n))
      .filter((b): b is THREE.Object3D => Boolean(b));

    vHands.current = (['Left', 'Right'] as const).flatMap((side) => {
      const hand = byName.get(key(`mixamorig:${side}Hand`));
      if (!hand) return [];
      const tips = V_TIPS.map((tip) => byName.get(key(`mixamorig:${side}${tip}`))).filter(
        (b): b is THREE.Object3D => Boolean(b),
      );
      return [{ hand, tips }];
    });

    headBones.current = HEAD_TRACK.flatMap(({ node, weight }) => {
      const bone = byName.get(node);
      return bone ? [{ bone, weight, posed: bone.quaternion.clone() }] : [];
    });

    const clamp = (v: number) => Math.max(-1, Math.min(1, v));
    const leave = () => {
      look.current.tx = 0;
      look.current.ty = 0;
      if (!gazeUntil.current) rig.current?.resetLook();
    };
    const move = (e: PointerEvent) => {
      const frame = gl.domElement.getBoundingClientRect();
      if (
        e.clientX < frame.left ||
        e.clientX > frame.right ||
        e.clientY < frame.top ||
        e.clientY > frame.bottom
      ) {
        leave();
        return;
      }
      const nx = clamp(((e.clientX - frame.left) / frame.width) * 2 - 1);
      const ny = clamp(((e.clientY - frame.top) / frame.height) * 2 - 1);

      look.current.tx = nx;
      look.current.ty = ny;
      if (!gazeUntil.current) rig.current?.setLookTarget(nx, ny);
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

      if (!after || (e.action !== a.vsign && e.action !== a.spin && e.action !== a.poof)) {
        return;
      }
      vsignCue.current = false;
      const from: ClipKey =
        e.action === a.spin ? 'spin' : e.action === a.poof ? 'poof' : 'vsign';

      fadeTo(from, after, from === 'vsign' ? FADE : from === 'spin' ? FADE : FADE_TIGHT);
      pending.current = null;
      if (after !== 'idle' && propRoots.current[after]) {
        reveal.current = { kind: after, at: performance.now() + REVEAL_DELAY * 1000 };
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
      vHands.current = [];
      winkUntil.current = 0;
      gazeUntil.current = 0;
      propRoots.current = {};
      propScale.current = {};
      propRadius.current = {};
      popping.current = null;
      reveal.current = null;
      dsPop.current = -1;
      vsignCue.current = false;
      actions.current = {};
      mode.current = 'idle';
      pending.current = null;
      mixer.stopAllAction();
      mixer.uncacheRoot(scene);
    };
  }, [scene, animations, mixer, gl]);

  useEffect(() => {
    if (!emissive) return;

    tint.current?.color.set(emissive);

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

    for (const { bone, posed } of tracked) bone.quaternion.copy(posed);

    mixer.update(dt);

    for (const track of tracked) track.posed.copy(track.bone.quaternion);

    if (vsignCue.current) {
      const vsign = actions.current.vsign;
      if (!vsign) {
        vsignCue.current = false;
      } else if (vsign.time >= VSIGN_CUE && vHands.current.length) {
        vsignCue.current = false;
        let raised = vHands.current[0];
        let highest = -Infinity;
        for (const candidate of vHands.current) {
          candidate.hand.getWorldPosition(_handL);
          if (_handL.y > highest) {
            highest = _handL.y;
            raised = candidate;
          }
        }
        const points = raised.tips.length ? raised.tips : [raised.hand];
        _between.set(0, 0, 0);
        for (const point of points) _between.add(point.getWorldPosition(_handR));
        onSparkleRef.current?.(_between.multiplyScalar(1 / points.length));
      }
    }

    if (headYaw !== 0 || headPitch !== 0) {
      const l = look.current;
      const alpha = 1 - Math.exp(-dt / HEAD_RESPONSE);
      l.x += (l.tx - l.x) * alpha;
      l.y += (l.ty - l.y) * alpha;

      const pitch = l.y * headPitch * (l.y < 0 ? PITCH_UP_GAIN : 1);
      for (const { bone, weight } of tracked) {
        _euler.set(pitch * weight, l.x * headYaw * weight, 0, 'YXZ');
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

    const pop = popping.current;
    const popRoot = pop ? propRoots.current[pop] : null;
    if (dsPop.current >= 0 && pop && popRoot) {
      dsPop.current += dt;
      const u = Math.min(1, dsPop.current / DS_POP);
      const c1 = 2.2;
      const back = 1 + (c1 + 1) * Math.pow(u - 1, 3) + c1 * Math.pow(u - 1, 2);
      popRoot.scale.setScalar((propScale.current[pop] ?? 1) * back);
      if (u >= 1) {
        dsPop.current = -1;
        popping.current = null;
      }
    }

    if (winkUntil.current && performance.now() >= winkUntil.current) {
      winkUntil.current = 0;
      rig.current?.setWink(false);
    }

    const due = reveal.current;
    if (due && performance.now() >= due.at) {
      reveal.current = null;
      showProp(due.kind);
      popping.current = due.kind;
      dsPop.current = 0;
      puffAt(due.kind, false);
    }

    tickScreens(dt);

    if (gazeUntil.current && performance.now() >= gazeUntil.current) {
      gazeUntil.current = 0;
      rig.current?.setLookTarget(look.current.tx, look.current.ty);
    }

    rig.current?.update();
  });

  return <primitive object={scene} />;
});

useGLTF.preload(GLB_URL);
