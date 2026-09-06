'use client';

import {
  forwardRef,
  Suspense,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';

import { asset } from '@/lib/asset';
import { GLB_URL } from './Kare';
import {
  createConsoleMaterial,
  createScreenMaterial,
  isScreenMaterial,
  setScreenOn,
  key,
  PROP_FLIP,
  PROP_FLIP_TURN,
  PROP_ROOTS,
  type PropKind,
  type TwoToneMaterial,
} from '@/lib/twoTone';

const SQUIRCLE = 'M 67.676 0 c 21.1154 0 31.6731 0 39.7381 4.1093 a 37.7025 37.7025 0 0 1 16.4766 16.4766 c 4.1093 8.065 4.1093 18.6227 4.1093 39.7381 L 128 67.676 c 0 21.1154 0 31.6731 -4.1093 39.7381 a 37.7025 37.7025 0 0 1 -16.4766 16.4766 c -8.065 4.1093 -18.6227 4.1093 -39.7381 4.1093 L 60.324 128 c -21.1154 0 -31.6731 0 -39.7381 -4.1093 a 37.7025 37.7025 0 0 1 -16.4766 -16.4766 c -4.1093 -8.065 -4.1093 -18.6227 -4.1093 -39.7381 L 0 60.324 c 0 -21.1154 0 -31.6731 4.1093 -39.7381 a 37.7025 37.7025 0 0 1 16.4766 -16.4766 c 8.065 -4.1093 18.6227 -4.1093 39.7381 -4.1093 Z';
const SQUIRCLE_UNIT = 'M 0.5287 0 c 0.165 0 0.2474 0 0.3105 0.0321 a 0.2946 0.2946 0 0 1 0.1287 0.1287 c 0.0321 0.063 0.0321 0.1455 0.0321 0.3105 L 1 0.5287 c 0 0.165 0 0.2474 -0.0321 0.3105 a 0.2946 0.2946 0 0 1 -0.1287 0.1287 c -0.063 0.0321 -0.1455 0.0321 -0.3105 0.0321 L 0.4713 1 c -0.165 0 -0.2474 0 -0.3105 -0.0321 a 0.2946 0.2946 0 0 1 -0.1287 -0.1287 c -0.0321 -0.063 -0.0321 -0.1455 -0.0321 -0.3105 L 0 0.4713 c 0 -0.165 0 -0.2474 0.0321 -0.3105 a 0.2946 0.2946 0 0 1 0.1287 -0.1287 c 0.063 -0.0321 0.1455 -0.0321 0.3105 -0.0321 Z';
const CLIP_ID = 'inventory-squircle';
const MARK_CLIP_ID = 'inventory-mark';

const ITEM_FOV = 12;
const ITEM_FILL = 0.676;
const ITEM_ELEVATION = 30;
const ITEM_YAW = -22;

const BOB = 0.05;
const BOB_RATE = 0.9;
const SWAY = 0.06;
const SWAY_RATE = 0.55;
const TILT = 0.035;
const TILT_RATE = 0.71;

const SHADOW_ALPHA = 0.24;
const SHADOW_SPREAD = 1.35;
const SHADOW_GAP = 0.05;
const SHADOW_SHRINK = 0.14;
const SHADOW_FADE = 0.32;

function usePropItem(kind: PropKind) {
  const { scene } = useGLTF(GLB_URL);

  const item = useMemo(() => {
    const wanted = PROP_ROOTS[kind];
    const found: THREE.Object3D[] = [];
    scene.traverse((obj) => {
      if (key(obj.name) === wanted) found.push(obj);
    });
    const source = found[0];
    if (!source) return null;

    const relative = new THREE.Matrix4();
    const step = new THREE.Matrix4();
    const toRoot = (node: THREE.Object3D) => {
      relative.identity();
      for (let at: THREE.Object3D | null = node; at && at !== source; at = at.parent) {
        step.compose(at.position, at.quaternion, at.scale);
        relative.premultiply(step);
      }
      return relative;
    };

    const inner = new THREE.Group();
    const materials: TwoToneMaterial[] = [];
    const owned: THREE.Material[] = [];
    const screens: THREE.ShaderMaterial[] = [];

    const built = new Map<THREE.Material, THREE.Material>();

    source.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;

      const base = (mesh.userData.baseMaterial ?? mesh.material) as
        | THREE.Material
        | THREE.Material[];
      const slots = Array.isArray(base) ? base : [base];

      const swapped = slots.map((slot) => {
        let made = built.get(slot);
        if (!made) {
          if (isScreenMaterial(slot)) {
            const screen = createScreenMaterial(slot, mesh.geometry);
            screens.push(screen);
            made = screen;
          } else {
            const tone = createConsoleMaterial(slot);
            materials.push(tone);
            made = tone;
          }
          built.set(slot, made);
          owned.push(made);
        }
        return made;
      });

      const copy = new THREE.Mesh(mesh.geometry, swapped.length > 1 ? swapped : swapped[0]);
      toRoot(mesh).decompose(copy.position, copy.quaternion, copy.scale);
      inner.add(copy);
    });

    if (PROP_FLIP.has(kind)) inner.rotateY(PROP_FLIP_TURN);

    const box = new THREE.Box3().setFromObject(inner);
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    inner.position.copy(centre).multiplyScalar(-1);

    const object = new THREE.Group();
    const fit = 1 / Math.max(size.x, size.y, size.z, 1e-6);
    object.scale.setScalar(fit);
    object.add(inner);
    const extent = size.clone().multiplyScalar(fit);

    return { object, materials, owned, screens, extent };
  }, [scene, kind]);

  useEffect(
    () => () => {
      for (const material of item?.owned ?? []) material.dispose();
    },
    [item],
  );

  return item;
}

type LookProps = {
  shadeColor?: string;
  shadeSplit?: number;
  shadeAngle?: number;
  shadeHeight?: number;
};

function Fit({ object }: { object: THREE.Object3D }) {
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const size = useThree((state) => state.size);
  const shot = useRef<{ corners: THREE.Vector3[]; target: THREE.Vector3 } | null>(null);
  const distance = useRef(1);

  useLayoutEffect(() => {
    if (!size.width || !size.height) return;
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return;
    const target = box.getCenter(new THREE.Vector3());
    const radius = box.getBoundingSphere(new THREE.Sphere()).radius;
    if (!(radius > 0)) return;

    distance.current = radius * 8;
    shot.current = {
      corners: Array.from({ length: 8 }, (_, i) =>
        new THREE.Vector3(
          i & 1 ? box.max.x : box.min.x,
          i & 2 ? box.max.y : box.min.y,
          i & 4 ? box.max.z : box.min.z,
        ),
      ),
      target,
    };
  }, [object, size.width, size.height]);

  useFrame(() => {
    const placed = shot.current;
    if (!placed) return;

    if (camera.fov !== ITEM_FOV) {
      camera.fov = ITEM_FOV;
      camera.updateProjectionMatrix();
    }

    const elevation = ITEM_ELEVATION * THREE.MathUtils.DEG2RAD;
    camera.position.set(
      placed.target.x,
      placed.target.y + Math.sin(elevation) * distance.current,
      placed.target.z + Math.cos(elevation) * distance.current,
    );
    camera.lookAt(placed.target);
    camera.updateMatrixWorld();

    let extent = 0;
    let behind = false;
    for (const corner of placed.corners) {
      _corner.copy(corner).applyMatrix4(camera.matrixWorldInverse);

      if (_corner.z > -camera.near) {
        behind = true;
        break;
      }
      _corner.applyMatrix4(camera.projectionMatrix);
      extent = Math.max(extent, Math.abs(_corner.x), Math.abs(_corner.y));
    }

    if (behind) {
      distance.current *= 2;
      return;
    }
    if (extent > 1e-4 && Math.abs(extent - ITEM_FILL) > 0.005) {
      const step = extent / ITEM_FILL;
      distance.current *= 1 + (step - 1) * 0.7;
    }
  });

  return null;
}

function makeShadowTexture(): THREE.CanvasTexture {
  const S = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);

  gradient.addColorStop(0, 'rgba(0,0,0,1)');
  gradient.addColorStop(0.45, 'rgba(0,0,0,0.62)');
  gradient.addColorStop(0.75, 'rgba(0,0,0,0.17)');
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, S, S);
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

function Shadow({ extent }: { extent: THREE.Vector3 }) {
  const mesh = useRef<THREE.Mesh>(null);
  const texture = useMemo(makeShadowTexture, []);
  const material = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        depthWrite: false,
        opacity: SHADOW_ALPHA,
      }),
    [texture],
  );

  useEffect(
    () => () => {
      material.dispose();
      texture.dispose();
    },
    [material, texture],
  );

  useFrame((state) => {
    const lift = (Math.sin(state.clock.elapsedTime * BOB_RATE) + 1) / 2;
    const spread = 1 + SHADOW_SHRINK * lift;
    mesh.current?.scale.set(
      extent.x * SHADOW_SPREAD * spread,
      extent.z * SHADOW_SPREAD * spread,
      1,
    );
    material.opacity = SHADOW_ALPHA * (1 - SHADOW_FADE * lift);
  });

  return (
    <mesh
      ref={mesh}
      scale={[extent.x * SHADOW_SPREAD, extent.z * SHADOW_SPREAD, 1]}
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, -extent.y / 2 - BOB - SHADOW_GAP, 0]}
      material={material}
      renderOrder={-1}
    >
      <planeGeometry args={[1, 1]} />
    </mesh>
  );
}

function FloatingItem({ object }: { object: THREE.Object3D }) {
  const pivot = useRef<THREE.Group>(null);
  const rest = ITEM_YAW * THREE.MathUtils.DEG2RAD;
  useFrame((state) => {
    const group = pivot.current;
    if (!group) return;
    const t = state.clock.elapsedTime;
    group.position.y = Math.sin(t * BOB_RATE) * BOB;
    group.rotation.y = rest + Math.sin(t * SWAY_RATE) * SWAY;
    group.rotation.z = Math.sin(t * TILT_RATE) * TILT;
  });
  return (
    <group ref={pivot}>
      <primitive object={object} />
    </group>
  );
}

const _corner = new THREE.Vector3();
const _shadeDir = new THREE.Vector3();

function ItemCanvas({
  kind,
  live,
  shadeColor = '#dedede',
  shadeSplit = 0.05,
  shadeAngle = 44,
  shadeHeight = 30,
}: LookProps & { kind: PropKind; live: boolean }) {
  const item = usePropItem(kind);

  useEffect(() => {
    for (const screen of item?.screens ?? []) setScreenOn(screen, live);
  }, [item, live]);

  useEffect(() => {
    if (!item) return;
    const azimuth = shadeAngle * THREE.MathUtils.DEG2RAD;
    const elevation = shadeHeight * THREE.MathUtils.DEG2RAD;
    _shadeDir.set(
      Math.sin(azimuth) * Math.cos(elevation),
      Math.sin(elevation),
      Math.cos(azimuth) * Math.cos(elevation),
    );
    for (const { userData } of item.materials) {
      userData.uniforms.uShade.value.set(shadeColor);
      userData.uniforms.uSplit.value = shadeSplit;
      userData.uniforms.uShadeDir.value.copy(_shadeDir);
    }
  }, [item, shadeColor, shadeSplit, shadeAngle, shadeHeight]);

  if (!item) return null;

  return (
    <Canvas
      className="inventory__canvas"
      resize={{ offsetSize: true }}

      flat
      dpr={[1, 2]}
      gl={{ antialias: true, alpha: true }}

      camera={{ position: [0, 4, 7], fov: ITEM_FOV, near: 0.1, far: 60 }}
    >
      <ambientLight intensity={1} />
      <Shadow extent={item.extent} />
      <FloatingItem object={item.object} />
      <Fit object={item.object} />
    </Canvas>
  );
}

const MARK_BOWL =
  'M48.67 90.7L17.76 90.72L17.85 74.2C17.95 56.55 32.25 42.9 49.78 42.6L55.44 42.35C59.14 42.19 61.69 39.18 61.72 35.9C61.76 32.29 59.12 29.5 55.2 29.03L0 29.01V0L57.22 0.02C76.69 0.21 91.64 12.13 93.4 31.56C95.34 52.99 78.61 70.31 57.2 69.55C52.12 69.37 48.57 73.35 48.6 78.09L48.67 90.7Z';
const MARK_DOT =
  'M33.1497 137.05C43.7867 137.05 52.4096 128.427 52.4096 117.79C52.4096 107.153 43.7867 98.5303 33.1497 98.5303C22.5126 98.5303 13.8896 107.153 13.8896 117.79C13.8896 128.427 22.5126 137.05 33.1497 137.05Z';

function UnknownMark() {
  return (
    <svg
      className="inventory__mark"
      viewBox="-18 -18 130 174"
      width="130"
      height="174"
      aria-hidden="true"
    >
      <defs>
        <clipPath id={MARK_CLIP_ID}>
          <path d={MARK_BOWL} />
          <path d={MARK_DOT} />
        </clipPath>
      </defs>

      <g className="inventory__mark-edge">
        <path d={MARK_BOWL} />
        <path d={MARK_DOT} />
      </g>

      <g className="inventory__mark-body">
        <path d={MARK_BOWL} />
        <path d={MARK_DOT} />
      </g>

      <g className="inventory__mark-inner" clipPath={`url(#${MARK_CLIP_ID})`}>
        <path d={MARK_BOWL} />
        <path d={MARK_DOT} />
      </g>
    </svg>
  );
}

type SlotKind = PropKind | 'unknown';
type Slot = { id: string; kind: SlotKind };

const SLOTS: Slot[] = [
  { id: 'unknown', kind: 'unknown' },
  { id: 'nintendo', kind: 'ds' },
  { id: 'laptop', kind: 'pc' },
  { id: 'phone', kind: 'phone' },
];

const FIRST_SLOT = 0;
const EMPTY_SLOT = SLOTS.findIndex((s) => s.kind === 'unknown');

const HALF = Math.floor(SLOTS.length / 2);
const offsetOf = (slot: number, centre: number) =>
  ((slot - centre + HALF + SLOTS.length) % SLOTS.length) - HALF;

export type InventoryProps = LookProps & {
  held: boolean;
  onSelect: (kind: SlotKind) => void;
  onArrow: (by: number) => void;
  onSettled?: () => void;
  busy?: boolean;
};

export type InventoryHandle = {
  step: (by: number) => void;
  toEmpty: () => void;
};

export const Inventory = forwardRef<InventoryHandle, InventoryProps>(function Inventory(
  { held, onSelect, onArrow, onSettled, busy = false, ...look },
  ref,
) {
  const [index, setIndex] = useState(FIRST_SLOT);
  const [slide, setSlide] = useState(0);

  const current = SLOTS[index];

  const step = (by: number) => {
    if (slide !== 0) return;
    setIndex((i) => (i + by + SLOTS.length) % SLOTS.length);
    setSlide(by);
  };

  const toEmpty = () => {
    const by = offsetOf(EMPTY_SLOT, index);
    if (by !== 0) step(by);
  };

  useImperativeHandle(ref, () => ({ step, toEmpty }));

  const settled = useRef(onSettled);
  useEffect(() => {
    settled.current = onSettled;
  });

  useEffect(() => {
    if (slide === 0) return;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        setSlide(0);
        settled.current?.();
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [slide]);

  const select = useRef(onSelect);
  useEffect(() => {
    select.current = onSelect;
  });
  useEffect(() => {
    select.current(current.kind);
  }, [current.kind]);

  return (
    <aside className="inventory" aria-label="Inventory">
      <svg className="inventory__defs" aria-hidden="true">
        <defs>
          <clipPath id={CLIP_ID} clipPathUnits="objectBoundingBox">
            <path d={SQUIRCLE_UNIT} />
          </clipPath>
        </defs>
      </svg>

      <div className="inventory__rail">
        <button
          type="button"
          className="inventory__arrow is-prev"
          aria-label="Previous item"
          disabled={busy}
          onClick={() => onArrow(-1)}
        >
          <img
            className="inventory__arrow-orb"
            src={asset('/image/basebutton.png')}
            alt=""
            draggable={false}
          />
          <span className="inventory__arrow-glyph">&#8249;</span>
        </button>

        <div className="inventory__viewport">
          <div className="inventory__slot" aria-hidden="true">
            <div className="inventory__ground">
              <img
                className="inventory__ground-art"
                src={asset('/image/checkerboard.png')}
                alt=""
                draggable={false}
              />
            </div>
            <svg
              className="inventory__frame"
              viewBox="0 0 128 128"
              preserveAspectRatio="none"
            >
              <path d={SQUIRCLE} />
              <path className="inventory__inner" d={SQUIRCLE} />
            </svg>
          </div>

          <div
            className={`inventory__track${slide === 0 ? '' : ' is-jumped'}`}
            style={{ '--slide': slide } as React.CSSProperties}
          >
            {SLOTS.map((slot, i) => {
              const offset = offsetOf(i, index);
              const centred = offset === 0;
              return (
                <div
                  key={slot.id}
                  className="inventory__cell"
                  style={{ '--d': offset } as React.CSSProperties}
                >
                  <div className={`inventory__lift${centred ? ' is-center' : ''}`}>
                    {slot.kind !== 'unknown' ? (
                      <div className="inventory__item">
                        <Suspense fallback={null}>
                          <ItemCanvas
                            kind={slot.kind}
                            live={held && centred}
                            {...look}
                          />
                        </Suspense>
                      </div>
                    ) : (
                      <div className="inventory__item inventory__unknown" aria-hidden>
                        <UnknownMark />
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <button
          type="button"
          className="inventory__arrow is-next"
          aria-label="Next item"
          disabled={busy}
          onClick={() => onArrow(1)}
        >
          <img
            className="inventory__arrow-orb"
            src={asset('/image/basebutton.png')}
            alt=""
            draggable={false}
          />
          <span className="inventory__arrow-glyph">&#8250;</span>
        </button>
      </div>

    </aside>
  );
});
