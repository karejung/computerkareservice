'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import * as THREE from 'three';

import { asset } from '@/lib/asset';
import { Kare, type KareHandle, type KareMode } from './Kare';
import { Inventory, type InventoryHandle } from './Inventory';
import { Stickers } from './Stickers';
import { ZoomButton } from './ZoomButton';
import { SquircleCard } from './SquircleCard';
import { Bloom } from './Bloom';
import { PuffBurst, type PuffBurstHandle } from './PuffBurst';
import { StarSpiral, type StarSpiralHandle } from './StarSpiral';

const CURSOR_DEFAULT = { src: asset('/cursors/cursor.png'), x: 3, y: 1 };
const CURSOR_POINTER = { src: asset('/cursors/pointer.png'), x: 8, y: 0 };
const POINTER_TARGET =
  'a, button, [role="button"], input, select, textarea, label, summary, .pick, .zoom, .sticker';

/*
 * Portalled to <body> rather than left in .scene-root, because .split__stage
 * carries `container-type: size` — which implies `contain: layout`, and that
 * makes the stage the containing block for `position: fixed` descendants. In
 * there the cursor was measured from the stage's corner instead of the
 * viewport's, so it sat a gutter off from the real pointer, and the stage's
 * `overflow: hidden` and clip-path cut it off the moment it left the canvas.
 */
function CustomCursor() {
  const img = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      // Touch and pen drags raise pointermove too. This is a stand-in for a
      // mouse pointer, so without a real one it is just a sticker left behind
      // wherever the last tap landed.
      if (e.pointerType !== 'mouse') return;
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

  // Scene is imported with `ssr: false`, so document is always there by now.
  return createPortal(
    <img
      ref={img}
      className="custom-cursor"
      src={CURSOR_DEFAULT.src}
      alt=""
      draggable={false}
      aria-hidden
      style={{ opacity: 0 }}
    />,
    document.body,
  );
}

type Look = {
  background: string;
  background2: string;
  checkerSize: number;
  emissive: string;
  shadeColor: string;
  shadeSplit: number;
  shadeAngle: number;
  shadeHeight: number;
  shadeRound: number;
  shadeSweep: number;
  headYaw: number;
  headPitch: number;

  bloom: boolean;
  bloomStrength: number;
  bloomRadius: number;
  bloomThreshold: number;
};

type CameraShot = {
  target: THREE.Vector3;
  dir: THREE.Vector3;
  distance: number;
  minDistance: number;
  maxDistance: number;
};

const BODY_DIR = new THREE.Vector3(-0.45, 0.12, 1).normalize();

const FACE_FILL = 2.6;
const FACE_DROP = 0.3;

const MIN_POLAR = 0.2;
const MAX_POLAR = Math.PI / 2 - 0.02;

/*
 * The character tier is one flat colour now, not a ramp — this and the CSS
 * background on .scene-root__view are the same value, so the hand-off at first
 * frame is invisible.
 */
const CANVAS_BG = 0xd5d7db;

const GREY = '#e0e0e0';
const WHITE = '#ffffff';
const BLACK = '#377cf6';

/** Seconds the zoom and V buttons hold her looking at the camera. */
const FRONT_HOLD = 1.2;

const CHECKER_SIZE = 0.5;
const CHECKER_CELLS = 16;
const FLOOR_SIZE = 2.8;

const nodeKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');
const FACE_NODE = nodeKey('FACE');
const HEAD_NODE = nodeKey('mixamorig:Head');

const LOOK: Look = {
  background: GREY,
  background2: WHITE,
  checkerSize: CHECKER_SIZE,
  emissive: BLACK,
  shadeColor: '#dedede',
  shadeSplit: 0.05,
  shadeAngle: 44,
  shadeHeight: 30,
  /*
   * How much of the terminator is drawn rather than lit, on the t-shirt and the
   * shoes — the nodes listed in Kare's SWEPT_NODES, and nowhere else. Round
   * takes the polygon grain out of the edge, sweep runs it straight across the
   * garment; between them it is one long clean line instead of a boundary
   * picking its way over facets. Both off is the old surface-normal shading,
   * both at 1 is a flat diagonal cut with no form left in it at all.
   */
  shadeRound: 0.55,
  shadeSweep: 0.45,
  headYaw: 0.4,
  headPitch: 0.1,

  bloom: true,
  bloomStrength: 0.03,
  bloomRadius: 0.1,
  bloomThreshold: 0.9,
};

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

    const step = Math.max(1, Math.floor(position.count / 1500));
    for (let i = 0; i < position.count; i += step) {
      v.fromBufferAttribute(position, i);
      if (skinned.isSkinnedMesh) skinned.applyBoneTransform(i, v);
      box.expandByPoint(v.applyMatrix4(mesh.matrixWorld));
    }
  });

  return box;
}

function GroundAndFit({
  group,
  floor,
  home,
  front,
  onFit,
}: {
  group: React.RefObject<THREE.Group | null>;
  floor: React.RefObject<THREE.Mesh | null>;
  home: React.MutableRefObject<CameraShot | null>;
  /** Same nonce CameraFocus takes; clears the remembered orbit with it. */
  front: number;
  /** First time the model is framed — the loader waits on this. */
  onFit?: () => void;
}) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;
  const size = useThree((s) => s.size);
  const frame = useRef(0);
  const done = useRef(false);
  const tallest = useRef(0);
  const settled = useRef(0);
  const orbited = useRef(false);
  const facing = useRef(BODY_DIR.clone());
  const announced = useRef(false);
  const onFitRef = useRef(onFit);
  onFitRef.current = onFit;

  const announce = () => {
    if (announced.current) return;
    announced.current = true;
    onFitRef.current?.();
  };

  useEffect(() => {
    if (!controls) return;
    const yield_ = () => {
      done.current = true;
      orbited.current = true;
      announce();
    };
    controls.addEventListener('start', yield_);
    return () => controls.removeEventListener('start', yield_);
  }, [controls]);

  /*
   * The fit is distance-from-aspect, so it goes stale the moment the viewport
   * changes shape — which is why resizing the window used to crop the model and
   * never recover: the fit ran once and set `done`.
   *
   * Re-running it keeps the framing, but it must not also undo an orbit. Once
   * the user has dragged, the direction they left the camera on is remembered
   * and the refit re-uses it; only the distance is recomputed.
   */
  useEffect(() => {
    orbited.current = false;
    facing.current.copy(BODY_DIR);
  }, [front]);

  useEffect(() => {
    if (controls && orbited.current) {
      facing.current.copy(camera.position).sub(controls.target).normalize();
    }
    done.current = false;
    frame.current = 3;
    settled.current = 21;
  }, [size.width, size.height, camera, controls]);

  useFrame(() => {
    if (done.current || !group.current || !controls) return;

    if (frame.current++ < 3) return;

    let box = posedBounds(group.current);
    if (box.isEmpty()) return;

    const extent = box.getSize(new THREE.Vector3());
    if (extent.y < 1e-4) return;

    // Keep fitting until the measurement stops growing. The first frames that
    // have a mesh in them can still be measuring a skeleton the mixer has not
    // posed yet, and a fit taken then locks the camera in far too close.
    const wasDone = done.current;
    if (extent.y > tallest.current * 1.01) {
      tallest.current = extent.y;
      settled.current = 0;
    } else if (++settled.current > 20 || frame.current > 150) {
      done.current = true;
    }

    if (Math.abs(box.min.y) > 1e-4) {
      group.current.position.y -= box.min.y;
      group.current.updateMatrixWorld(true);
    }

    box = posedBounds(group.current);
    const center = box.getCenter(new THREE.Vector3());

    if (floor.current) {
      floor.current.position.set(center.x, -0.004, center.z);
    }

    const halfFov = (camera.fov * Math.PI) / 180 / 2;
    const fitHeight = extent.y / 2 / Math.tan(halfFov);
    const fitWidth = extent.x / 2 / Math.tan(halfFov) / camera.aspect;
    const distance = Math.max(fitHeight, fitWidth) * 1.35;

    const dir = orbited.current ? facing.current : BODY_DIR;
    camera.position.copy(center).addScaledVector(dir, distance);
    camera.near = distance / 200;
    camera.far = distance * 200;
    camera.updateProjectionMatrix();

    controls.target.copy(center);
    controls.minDistance = distance * 0.15;
    controls.maxDistance = distance * 5;
    controls.update();

    home.current = {
      target: center.clone(),
      dir: dir.clone(),
      distance,
      minDistance: controls.minDistance,
      maxDistance: controls.maxDistance,
    };

    if (!wasDone && done.current) announce();
  });

  return null;
}

/*
 * three compiles a program the first time a mesh is actually drawn, and the
 * props sit at `visible = false` until they are picked — so the compile lands
 * on the frame the prop appears, which is exactly the frame that could least
 * afford it. Each prop's screen is its own raw ShaderMaterial with the star
 * field inlined, so there is real work to do there.
 *
 * Everything hidden is shown for the length of one traversal and put straight
 * back. `compileAsync` gathers its materials synchronously before it returns
 * the promise, so the restore does not have to wait for the compile to finish
 * — which matters, because waiting would leave all three props on screen at
 * once for however long the driver took.
 */
function Precompile() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const done = useRef(false);

  useEffect(() => {
    if (done.current) return;
    done.current = true;

    const hidden: THREE.Object3D[] = [];
    scene.traverse((object) => {
      if (!object.visible) {
        hidden.push(object);
        object.visible = true;
      }
    });

    try {
      gl.compileAsync(scene, camera);
    } finally {
      for (const object of hidden) object.visible = false;
    }
  }, [gl, scene, camera]);

  return null;
}

function CameraFocus({
  group,
  home,
  face,
  front,
}: {
  group: React.RefObject<THREE.Group | null>;
  home: React.RefObject<CameraShot | null>;
  face: boolean;
  /*
   * Bumped by whichever button was pressed. Both of them put her back
   * front-on — an orbit is a thing you did to look around, not a viewpoint the
   * app should keep honouring once you ask it to do something.
   */
  front: number;
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
      const distance = fit * FACE_FILL;

      goalTarget.current.y -= extent.y * FACE_DROP;

      goalPos.current.copy(goalTarget.current).addScaledVector(home.current.dir, distance);

      controls.minDistance = Math.min(home.current.minDistance, distance * 0.5);
      controls.maxDistance = home.current.maxDistance;
    }

    const damped = controls.enableDamping;
    controls.enableDamping = false;
    controls.update();
    controls.enableDamping = damped;

    controls.enabled = false;
    moving.current = true;
  }, [face, front, camera, controls, group, home]);

  useFrame((_, dt) => {
    if (!moving.current || !controls) return;

    const k = 1 - Math.exp(-dt * 5);
    camera.position.lerp(goalPos.current, k);
    controls.target.lerp(goalTarget.current, k);
    /*
     * Nothing else turns the camera while this runs. drei calls
     * controls.update() only while the controls are enabled, and they are off
     * for the whole flight, so the camera held whatever orientation the orbit
     * had left it in and swung onto the new one in a single frame on arrival —
     * the further round you had dragged, the further off the move looked. This
     * is the lookAt update() itself ends on, so handing back to the controls
     * lands on the rotation they were already going to keep.
     */
    camera.lookAt(controls.target);

    if (
      camera.position.distanceToSquared(goalPos.current) < 1e-6 &&
      controls.target.distanceToSquared(goalTarget.current) < 1e-6
    ) {
      camera.position.copy(goalPos.current);
      controls.target.copy(goalTarget.current);
      controls.update();
      controls.enabled = true;
      moving.current = false;
    }
  });

  return null;
}

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

function Floor({
  a,
  b,
  cell,
  meshRef,
  visible = true,
}: {
  a: string;
  b: string;
  cell: number;
  meshRef: React.RefObject<THREE.Mesh | null>;
  visible?: boolean;
}) {
  const texture = useCheckerTexture(a, b);

  const material = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: texture },
        uRepeat: { value: new THREE.Vector2(1, 1) },
      },
      vertexShader:`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader:`
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

    <mesh
      ref={meshRef}
      visible={visible}
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, -0.004, 0]}
      material={material}
    >
      <planeGeometry args={[FLOOR_SIZE, FLOOR_SIZE]} />
    </mesh>
  );
}

export default function Scene({
  onReady,
}: {
  onReady?: () => void;
}) {
  const [faceZoom, setFaceZoom] = useState(false);
  const [live, setLive] = useState(false);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const model = useRef<THREE.Group>(null);
  const floor = useRef<THREE.Mesh>(null);
  const kare = useRef<KareHandle>(null);
  const home = useRef<CameraShot | null>(null);

  const [mode, setMode] = useState<KareMode>('idle');
  const puff = useRef<PuffBurstHandle>(null);
  const stars = useRef<StarSpiralHandle>(null);
  const [wanted, setWanted] = useState<KareMode>('idle');
  const inventory = useRef<InventoryHandle>(null);
  const [busy, setBusy] = useState(false);
  /*
   * Both buttons go through goEmpty, so bumping this there is the same as
   * saying "the zoom and the V sign put her back front-on".
   */
  const [front, setFront] = useState(0);

  const pendingAction = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (mode !== wanted) {
      kare.current?.setMode(wanted);
      return;
    }
    setBusy(false);
    const act = pendingAction.current;
    if (act) {
      pendingAction.current = null;
      act();
    }
  }, [mode, wanted]);

  const goEmpty = (then: () => void) => {
    if (busy) return;
    setFront((n) => n + 1);
    // Long enough to cover the camera move; after it she picks the pointer up
    // again on its next move.
    kare.current?.faceFront(FRONT_HOLD);
    inventory.current?.toEmpty();
    if (mode === 'idle') {
      then();
      return;
    }
    setBusy(true);
    pendingAction.current = then;

    setWanted('idle');
  };

  const onArrow = (by: number) => {
    if (busy) return;
    setBusy(true);
    inventory.current?.step(by);
  };

  return (
    <div className="scene-root">
      <SquircleCard id="view-squircle" className="scene-root__view">
        <Canvas

          flat
          dpr={[1, 2]}
          gl={{ antialias: true, alpha: false }}
          camera={{ position: [-2, 1.4, 3], fov: 35, near: 0.01, far: 500 }}
          onCreated={({ gl }) => gl.setClearColor(CANVAS_BG, 1)}
        >
            <Suspense fallback={null}>
            <ambientLight intensity={1} />
            <group ref={model}>
              <Kare
                ref={kare}
                emissive={LOOK.emissive}
                shadeColor={LOOK.shadeColor}
                shadeSplit={LOOK.shadeSplit}
                shadeAngle={LOOK.shadeAngle}
                shadeHeight={LOOK.shadeHeight}
                shadeRound={LOOK.shadeRound}
                shadeSweep={LOOK.shadeSweep}
                headYaw={LOOK.headYaw}
                headPitch={LOOK.headPitch}
                onModeChange={setMode}
                onSpin={(seconds) => stars.current?.burst(seconds)}
                onPuff={(at, radius, kind) => puff.current?.burst(at, radius, kind)}
                onSparkle={(at) => puff.current?.sparkle(at)}
              />
              <StarSpiral ref={stars} />
            </group>
            <Precompile />
          </Suspense>

          <PuffBurst ref={puff} />

          <Floor
            a={LOOK.background}
            b={LOOK.background2}
            cell={LOOK.checkerSize}
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
          <GroundAndFit
            group={model}
            floor={floor}
            home={home}
            front={front}
            onFit={() => {
              setLive(true);
              onReadyRef.current?.();
            }}
          />
          <CameraFocus group={model} home={home} face={faceZoom} front={front} />

          <Bloom
            enabled={LOOK.bloom}
            strength={LOOK.bloomStrength}
            radius={LOOK.bloomRadius}
            threshold={LOOK.bloomThreshold}
          />
        </Canvas>

        <CustomCursor />
      </SquircleCard>

      {/*
        * Order matters here, and so does being outside the card. The three
        * layers stack canvas < stickers < controls, and z-index can only order
        * them against each other inside one stacking context — .split__stage
        * establishes its own, so a sticker layer up at page level could never
        * be slipped under controls that lived in the card.
        */}
      {live && (
        <Stickers
          swept={faceZoom}
          holding={mode}
          onVsign={() => goEmpty(() => kare.current?.playVsign())}
        />
      )}

      {live && (
        <ZoomButton active={faceZoom} onToggle={() => goEmpty(() => setFaceZoom((v) => !v))} />
      )}

      {live && (
        <Inventory
          ref={inventory}
          busy={busy}
          dimmed={faceZoom}
          onArrow={onArrow}
          onSettled={() => {
            if (mode === wanted) setBusy(false);
          }}
          onSelect={(kind) => setWanted(kind === 'unknown' ? 'idle' : kind)}
        />
      )}
    </div>
  );
}
