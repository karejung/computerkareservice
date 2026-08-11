'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, Stage } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import * as THREE from 'three';

import { asset } from '@/lib/asset';
import { Kare, type KareHandle, type KareMode } from './Kare';
import { PuffBurst, type PuffBurstHandle } from './PuffBurst';
import { StarSpiral, type StarSpiralHandle } from './StarSpiral';

const CURSOR_DEFAULT = { src: asset('/cursors/cursor.png'), x: 3, y: 1 };
const CURSOR_POINTER = { src: asset('/cursors/pointer.png'), x: 8, y: 0 };
const POINTER_TARGET =
  'a, button, [role="button"], input, select, textarea, label, summary, .action-btn';

/**
 * CSS `cursor: url(...)` keeps getting stomped (or rejected) on the canvas.
 * Draw the cursor ourselves so OrbitControls can't touch it.
 */
function CustomCursor() {
  const img = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const next =
        under && under.closest(POINTER_TARGET) ? CURSOR_POINTER : CURSOR_DEFAULT;
      if (img.current) {
        if (img.current.getAttribute('src') !== next.src) {
          img.current.src = next.src;
        }
        img.current.style.opacity = '1';
        img.current.style.transform = `translate3d(${e.clientX - next.x}px, ${e.clientY - next.y}px, 0)`;
      }
    };
    const leave = () => {
      if (img.current) img.current.style.opacity = '0';
    };
    const enter = () => {
      if (img.current) img.current.style.opacity = '1';
    };
    window.addEventListener('pointermove', move);
    document.documentElement.addEventListener('mouseleave', leave);
    document.documentElement.addEventListener('mouseenter', enter);
    return () => {
      window.removeEventListener('pointermove', move);
      document.documentElement.removeEventListener('mouseleave', leave);
      document.documentElement.removeEventListener('mouseenter', enter);
    };
  }, []);

  return (
    <img
      ref={img}
      className="custom-cursor"
      src={CURSOR_DEFAULT.src}
      alt=""
      draggable={false}
      aria-hidden
      style={{ opacity: 0 }}
    />
  );
}

type Preset = 'rembrandt' | 'portrait' | 'upfront' | 'soft';
type EnvPreset =
  | 'city' | 'studio' | 'apartment' | 'dawn' | 'sunset'
  | 'night' | 'warehouse' | 'forest' | 'park' | 'lobby';

type Look = {
  contactShadow: boolean;
  intensity: number;
  preset: Preset;
  environment: EnvPreset;
  /** The two checker squares on the floor disc. */
  background: string;
  background2: string;
  /** Edge length of one square, in world units. */
  checkerSize: number;
  /** Emissive on the hair, pants and shoes. */
  emissive: string;
  /** Shadow tone on the white parts; the lit side is always #ffffff. */
  shadeColor: string;
  /** Where the terminator falls, as a normal-facing threshold (-1..1). */
  shadeSplit: number;
  /** Direction the fake shadow is cast from, in degrees. */
  shadeAngle: number;
  shadeHeight: number;
  /** Head tracking limits at the edge of the window, in radians. */
  headYaw: number;
  headPitch: number;
};

type CameraShot = {
  /** Look-at point. */
  target: THREE.Vector3;
  /** Unit vector from target to camera. */
  dir: THREE.Vector3;
  distance: number;
  minDistance: number;
  maxDistance: number;
};

/** Default view: from the character's right, mild elevation. */
const BODY_DIR = new THREE.Vector3(-0.45, 0.12, 1).normalize();

/** Must match <OrbitControls> — face zoom tips to the upper (frontal) limit. */
const MIN_POLAR = 0.2;
const MAX_POLAR = Math.PI / 2 - 0.02;

const GREY = '#e0e0e0';
const WHITE = '#ffffff';
const BLACK = '#377cf6';

/** Edge length of one checker square, in world units. */
const CHECKER_SIZE = 0.5;
/** Squares baked into the texture before it tiles. */
const CHECKER_CELLS = 16;
/** World-space diameter of the pin-lit checker disc under the character. */
const FLOOR_SIZE = 2.8;

/** Matches Kare's name normalisation for looking up the face mesh. */
const nodeKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');
const FACE_NODE = nodeKey('FACE');
const HEAD_NODE = nodeKey('mixamorig:Head');

const DEFAULT_LOOK: Look = {
  contactShadow: false,
  intensity: 1.0,
  preset: 'rembrandt',
  environment: 'city',
  background: GREY,
  background2: WHITE,
  checkerSize: CHECKER_SIZE,
  emissive: BLACK,
  shadeColor: '#eeeeee',
  shadeSplit: 0.05,
  shadeAngle: 55,
  shadeHeight: 32,
  headYaw: 0.4,
  headPitch: 0.18,
};

/**
 * World-space bounds of the model *as currently posed*.
 *
 * Box3.setFromObject reads each geometry's rest bounding box, which for this
 * rig is a standing Mixamo T-pose — but the clip seats the character, so those
 * bounds are both too tall and in the wrong place. Skinning a sample of the
 * vertices by hand gives bounds that match what is actually on screen, which is
 * what the camera fit depends on.
 */
function posedBounds(root: THREE.Object3D): THREE.Box3 {
  const box = new THREE.Box3();
  const v = new THREE.Vector3();

  root.updateMatrixWorld(true);
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || !mesh.visible) return;

    const position = mesh.geometry?.getAttribute('position');
    if (!position) return;

    const skinned = mesh as THREE.SkinnedMesh;
    // A few thousand samples is plenty to bound a character.
    const step = Math.max(1, Math.floor(position.count / 1500));
    for (let i = 0; i < position.count; i += step) {
      v.fromBufferAttribute(position, i);
      if (skinned.isSkinnedMesh) skinned.applyBoneTransform(i, v);
      box.expandByPoint(v.applyMatrix4(mesh.matrixWorld));
    }
  });

  return box;
}

/**
 * Drops the model onto y=0 and frames it, once, after the first pose has been
 * applied. Stage's own centering and `adjustCamera` are both off: it centers
 * the model *through* the origin and drives the camera through <Bounds>, which
 * fights OrbitControls for the same target.
 *
 * Also parks the checker disc under the character's footprint.
 */
function GroundAndFit({
  group,
  floor,
  home,
}: {
  group: React.RefObject<THREE.Group | null>;
  floor: React.RefObject<THREE.Mesh | null>;
  home: React.MutableRefObject<CameraShot | null>;
}) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;
  const frame = useRef(0);
  const done = useRef(false);

  useFrame(() => {
    if (done.current || !group.current || !controls) return;
    // Let the mixer pose the skeleton before measuring it.
    if (frame.current++ < 3) return;

    let box = posedBounds(group.current);
    if (box.isEmpty()) return;

    const extent = box.getSize(new THREE.Vector3());
    if (extent.y < 1e-4) return;

    done.current = true;

    // Feet on the floor.
    group.current.position.y -= box.min.y;
    group.current.updateMatrixWorld(true);

    box = posedBounds(group.current);
    const center = box.getCenter(new THREE.Vector3());

    if (floor.current) {
      floor.current.position.set(center.x, -0.004, center.z);
    }

    // Perspective framing is distance: back off far enough that the taller of
    // the two fits, whichever that is at the current aspect.
    const halfFov = (camera.fov * Math.PI) / 180 / 2;
    const fitHeight = extent.y / 2 / Math.tan(halfFov);
    const fitWidth = extent.x / 2 / Math.tan(halfFov) / camera.aspect;
    const distance = Math.max(fitHeight, fitWidth) * 1.35;

    // From the character's right (negative X) so the right cheek faces the lens.
    const dir = BODY_DIR;
    camera.position.copy(center).addScaledVector(dir, distance);
    camera.near = distance / 200;
    camera.far = distance * 200;
    camera.updateProjectionMatrix();

    controls.target.copy(center);
    controls.minDistance = distance * 0.15;
    controls.maxDistance = distance * 5;
    controls.update();

    // Remember the full-body framing so the face button can return here.
    home.current = {
      target: center.clone(),
      dir: dir.clone(),
      distance,
      minDistance: controls.minDistance,
      maxDistance: controls.maxDistance,
    };
  });

  return null;
}

/** Ease camera.position / controls.target toward a face crop or back home. */
function CameraFocus({
  group,
  home,
  face,
}: {
  group: React.RefObject<THREE.Group | null>;
  home: React.RefObject<CameraShot | null>;
  face: boolean;
}) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;
  const goalPos = useRef(new THREE.Vector3());
  const goalTarget = useRef(new THREE.Vector3());
  const moving = useRef(false);

  useEffect(() => {
    if (!controls || !group.current || !home.current) return;

    if (!face) {
      goalTarget.current.copy(home.current.target);
      goalPos.current
        .copy(home.current.target)
        .addScaledVector(home.current.dir, home.current.distance);
      controls.minDistance = home.current.minDistance;
      controls.maxDistance = home.current.maxDistance;
    } else {
      const found: THREE.Object3D[] = [];
      group.current.traverse((obj) => {
        const k = nodeKey(obj.name);
        if (k === FACE_NODE) found[0] = obj;
        else if (!found[0] && k === HEAD_NODE) found[0] = obj;
      });
      const focus = found[0];
      if (!focus) return;

      const box = posedBounds(focus);
      if (box.isEmpty()) focus.getWorldPosition(goalTarget.current);
      else box.getCenter(goalTarget.current);

      const extent = box.isEmpty()
        ? new THREE.Vector3(0.25, 0.25, 0.25)
        : box.getSize(new THREE.Vector3());
      const halfFov = (camera.fov * Math.PI) / 180 / 2;
      const fit = Math.max(extent.x, extent.y, 0.12) / 2 / Math.tan(halfFov);
      const distance = fit * 2.1;

      // Same viewing angle — just pull in so the face sits in the middle.
      const dir = camera.position.clone().sub(controls.target).normalize();
      goalPos.current.copy(goalTarget.current).addScaledVector(dir, distance);

      controls.minDistance = Math.min(home.current.minDistance, distance * 0.5);
      controls.maxDistance = home.current.maxDistance;
    }

    controls.enabled = false;
    moving.current = true;
  }, [face, camera, controls, group, home]);

  useFrame((_, dt) => {
    if (!moving.current || !controls) return;

    const k = 1 - Math.exp(-dt * 5);
    camera.position.lerp(goalPos.current, k);
    controls.target.lerp(goalTarget.current, k);

    if (camera.position.distanceToSquared(goalPos.current) < 1e-6) {
      camera.position.copy(goalPos.current);
      controls.target.copy(goalTarget.current);
      controls.update();
      controls.enabled = true;
      moving.current = false;
    }
  });

  return null;
}

/**
 * Procedural checker texture — generated at 16×16 cells and then tiled, which
 * keeps mipmapping useful (a literal 2×2 texture aliases badly into the distance).
 */
function useCheckerTexture(a: string, b: string): THREE.Texture {
  const gl = useThree((s) => s.gl);
  return useMemo(() => {
    const PIXELS = 1024;
    const cell = PIXELS / CHECKER_CELLS;

    const canvas = document.createElement('canvas');
    canvas.width = PIXELS;
    canvas.height = PIXELS;
    const ctx = canvas.getContext('2d')!;
    for (let y = 0; y < CHECKER_CELLS; y += 1) {
      for (let x = 0; x < CHECKER_CELLS; x += 1) {
        ctx.fillStyle = (x + y) % 2 === 0 ? b : a;
        ctx.fillRect(x * cell, y * cell, cell, cell);
      }
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = gl.capabilities.getMaxAnisotropy();
    return texture;
  }, [gl, a, b]);
}

/**
 * Checker disc under the character with a soft radial falloff — pin-lit pool
 * against the solid page background showing through the transparent canvas.
 */
function Floor({
  a,
  b,
  cell,
  meshRef,
}: {
  a: string;
  b: string;
  cell: number;
  meshRef: React.RefObject<THREE.Mesh | null>;
}) {
  const texture = useCheckerTexture(a, b);

  const material = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: texture },
        uRepeat: { value: new THREE.Vector2(1, 1) },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        uniform vec2 uRepeat;
        varying vec2 vUv;
        void main() {
          vec4 color = texture2D(uMap, vUv * uRepeat);
          float d = length(vUv - vec2(0.5)) * 2.0;
          float alpha = 1.0 - smoothstep(0.25, 1.0, d);
          float lift = 1.0 - smoothstep(0.0, 0.85, d) * 0.12;
          gl_FragColor = vec4(color.rgb * lift, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });
  }, [texture]);

  useEffect(() => {
    const tiles = FLOOR_SIZE / (CHECKER_CELLS * Math.max(cell, 0.01));
    material.uniforms.uRepeat.value.set(tiles, tiles);
  }, [material, cell]);

  return (
    // A hair below y=0 so it never z-fights Stage's contact shadow plane.
    <mesh
      ref={meshRef}
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, -0.004, 0]}
      material={material}
    >
      <planeGeometry args={[FLOOR_SIZE, FLOOR_SIZE]} />
    </mesh>
  );
}

/** lil-gui panel. Lives outside the Canvas (it is DOM), imported dynamically. */
function LookPanel({ initial, onChange }: { initial: Look; onChange: (next: Look) => void }) {
  useEffect(() => {
    let gui: { destroy: () => void } | null = null;
    let disposed = false;

    // lil-gui mutates this object in place; mirror each edit into React state
    // so <Stage> re-renders with the new look.
    const state = { ...initial };

    import('lil-gui').then(({ default: GUI }) => {
      if (disposed) return;
      const g = new GUI({ title: 'kare' });
      gui = g;
      // Hidden for now — look defaults still apply; reopen with g.show().
      g.hide();

      const push = () => onChange({ ...state });

      g.addColor(state, 'background').name('checker 1').onChange(push);
      g.addColor(state, 'background2').name('checker 2').onChange(push);
      g.add(state, 'checkerSize', 0.05, 4, 0.05).name('checker size').onChange(push);
      g.addColor(state, 'emissive').name('model color').onChange(push);
      /*
       * A drawn shadow, not a lit one — the scene lights have no say in it, so
       * the lit side stays exactly #ffffff whatever the rig is doing.
       */
      g.addColor(state, 'shadeColor').name('shade color').onChange(push);
      // How much of the surface the shadow covers: higher eats further in.
      g.add(state, 'shadeSplit', -1, 1, 0.01).name('shade amount').onChange(push);
      g.add(state, 'shadeAngle', 0, 360, 1).name('shade angle').onChange(push);
      g.add(state, 'shadeHeight', -60, 89, 1).name('shade height').onChange(push);

      // Signed, so a negative value flips the direction the head follows.
      g.add(state, 'headYaw', -0.8, 0.8, 0.01).name('head turn').onChange(push);
      g.add(state, 'headPitch', -0.6, 0.6, 0.01).name('head tilt').onChange(push);

      g.add(state, 'contactShadow').name('contactShadow').onChange(push);
      g.add(state, 'intensity', 0, 3, 0.05).name('light intensity').onChange(push);
      g.add(state, 'preset', ['rembrandt', 'portrait', 'upfront', 'soft'])
        .name('preset')
        .onChange(push);
      g.add(state, 'environment', [
        'city', 'studio', 'apartment', 'dawn', 'sunset',
        'night', 'warehouse', 'forest', 'park', 'lobby',
      ])
        .name('environment')
        .onChange(push);
    });

    return () => {
      disposed = true;
      gui?.destroy();
    };
    // Mount once — the panel owns its copy of the state from then on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}

export default function Scene() {
  const [look, setLook] = useState<Look>(DEFAULT_LOOK);
  const [faceZoom, setFaceZoom] = useState(false);
  const model = useRef<THREE.Group>(null);
  const floor = useRef<THREE.Mesh>(null);
  const kare = useRef<KareHandle>(null);
  const home = useRef<CameraShot | null>(null);
  // Which loop the character is resting in, so the ds button can show its state.
  const [mode, setMode] = useState<KareMode>('idle');
  const puff = useRef<PuffBurstHandle>(null);
  const stars = useRef<StarSpiralHandle>(null);

  return (
    <div className="scene-root">
      <Canvas
        shadows
        // `flat` switches tone mapping off. r3f defaults to ACES, which is for
        // photographic input — it desaturates and darkens the flat emissive
        // colours this model is authored in, so the hair rendered as something
        // other than the #377CF6 it was given, and the ink (composited after
        // tone mapping, so untouched by it) could never line up with it.
        flat
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: false }}
        camera={{ position: [-2, 1.4, 3], fov: 35, near: 0.01, far: 500 }}
        /*
         * Clear to the page grey (#ccc). The brand logo sits above the canvas
         * with mix-blend-mode: difference — an alpha-0 clear would read as
         * black and break the invert, so the empty frame has to be opaque.
         */
        onCreated={({ gl }) => gl.setClearColor(0xcccccc, 1)}
      >
        <Suspense fallback={null}>
          {/*
            Stage supplies the three-point rig plus IBL. Keyed on the look so
            switching preset/environment rebuilds it cleanly.
          */}
          <Stage
            key={`${look.preset}-${look.environment}-${look.contactShadow}`}
            intensity={look.intensity}
            preset={look.preset}
            environment={look.environment}
            shadows={look.contactShadow ? { type: 'contact', opacity: 0.6, blur: 2.5 } : false}
            adjustCamera={false}
            center={{ disable: true }}
          >
            <group ref={model}>
              <Kare
                ref={kare}
                emissive={look.emissive}
                shadeColor={look.shadeColor}
                shadeSplit={look.shadeSplit}
                shadeAngle={look.shadeAngle}
                shadeHeight={look.shadeHeight}
                headYaw={look.headYaw}
                headPitch={look.headPitch}
                onModeChange={setMode}
                onPoof={(at) => puff.current?.burst(at)}
                onSpin={(seconds) => stars.current?.burst(seconds)}
              />
              {/*
                Inside the model group so it rides the drop to y=0 that
                GroundAndFit applies. Points are not meshes, so the fit's
                bounds pass ignores them and the framing is unaffected.
              */}
              <StarSpiral ref={stars} color={look.emissive} />
            </group>
          </Stage>
        </Suspense>

        {/*
          Outside the model group and given a world-space point by Kare, so no
          part of the fit or the ground drop has to be undone to place it.
        */}
        <PuffBurst ref={puff} />

        <Floor
          a={look.background}
          b={look.background2}
          cell={look.checkerSize}
          meshRef={floor}
        />

        <OrbitControls
          makeDefault
          enableDamping
          dampingFactor={0.06}
          enablePan={false}
          minPolarAngle={MIN_POLAR}
          maxPolarAngle={MAX_POLAR}
        />
        <GroundAndFit group={model} floor={floor} home={home} />
        <CameraFocus group={model} home={home} face={faceZoom} />
      </Canvas>

      <CustomCursor />

      <div className="action-bar">
        <button type="button" className="action-btn" aria-label="Home">
          <img src={asset('/image/home.png')} alt="" draggable={false} />
        </button>
        <button
          type="button"
          className="action-btn"
          aria-label="V sign"
          onClick={() => kare.current?.playVsign()}
        >
          <img src={asset('/image/vbutton.png')} alt="" draggable={false} />
        </button>
        {/*
          Placeholder until the real artwork lands: spins into the ds loop and
          spins back out again. Text rather than an <img> so it is obvious this
          one is not finished.
        */}
        <button
          type="button"
          className="action-btn action-btn--placeholder"
          aria-label={mode === 'ds' ? 'Stop playing' : 'Play ds'}
          aria-pressed={mode === 'ds'}
          onClick={() => kare.current?.toggleDs()}
        >
          DS
        </button>
        <button
          type="button"
          className="action-btn"
          aria-label={faceZoom ? 'Full body' : 'Face zoom'}
          aria-pressed={faceZoom}
          onClick={() => setFaceZoom((v) => !v)}
        >
          <img src={asset('/image/cambutton.png')} alt="" draggable={false} />
        </button>
      </div>

      <LookPanel initial={DEFAULT_LOOK} onChange={setLook} />
    </div>
  );
}
