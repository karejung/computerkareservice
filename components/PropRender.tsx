'use client';

import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';

import { GLB_URL } from './Kare';
import {
  createConsoleMaterial,
  createScreenMaterial,
  isScreenMaterial,
  key,
  PROP_FLIP,
  PROP_FLIP_TURN,
  PROP_ROOTS,
  type PropKind,
  type TwoToneMaterial,
} from '@/lib/twoTone';

/**
 * Rendering a prop from the GLB: pull it out of the scene, re-shade it, frame
 * it, float it, ground it with a shadow.
 *
 * The inventory used to do this live, one WebGL canvas per slot. It now shows
 * flat thumbnails instead, and this is what bakes them — app/thumbs drives it
 * through a real GL context because the shading in lib/twoTone.ts only exists
 * once those shaders compile. Keep it and the thumbnails in step: change the
 * look here and the PNGs in public/image/thumbs are stale until regenerated.
 */

export const ITEM_FOV = 12;
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

export function usePropItem(kind: PropKind) {
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

export function Fit({ object }: { object: THREE.Object3D }) {
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

export function Shadow({ extent }: { extent: THREE.Vector3 }) {
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

export function FloatingItem({ object }: { object: THREE.Object3D }) {
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
