'use client';

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

const COUNT = 20;
/** Seconds from pop to gone. */
const LIFE = 0.6;
/** How far the outermost puffs travel from the origin, in world units. */
const SPREAD = 0.58;
/** Puffs rise a little as they dissipate. */
const DRIFT = 0.2;
/**
 * Alpha is snapped to this many levels.
 *
 * Hand-drawn animation has no crossfade — cels are painted at whole opacities
 * and swapped, so smoke leaves in visible steps. A linear ramp is the single
 * thing that makes an effect read as engine output rather than as drawing.
 */
const ALPHA_STEPS = 5;

const OUTLINE = '#1c1c22';
const FILL = '#ffffff';
const SHADE = '#cdd6e4';

type Puff = {
  dx: number;
  dy: number;
  dz: number;
  reach: number;
  size: number;
  grow: number;
  spin: number;
  delay: number;
};

/**
 * One cartoon smoke puff: lumpy silhouette, hard black rim, two flat tones.
 *
 * The rim comes from drawing the same cluster of circles twice — once at full
 * size in the outline colour, once inset in the fill — rather than stroking a
 * path, because the blob is a union of overlapping circles and stroking those
 * individually would draw every internal seam.
 *
 * Only a hair of blur, purely to take the stair-stepping off the edge. Any
 * more and the flat cel look goes with it.
 */
function makePuffTexture(): THREE.CanvasTexture {
  const S = 320;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext('2d')!;
  const c = S / 2;

  let seed = 99;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  // One lump profile, reused by every layer so they nest concentrically.
  const lumps = [{ a: 0, d: 0, r: 0.34 }].concat(
    Array.from({ length: 9 }, (_, i) => ({
      a: (i / 9) * Math.PI * 2 + rnd() * 0.4,
      d: 0.2 + rnd() * 0.16,
      r: 0.2 + rnd() * 0.16,
    })),
  );

  const blob = (scale: number, ox = 0, oy = 0) => {
    for (const l of lumps) {
      ctx.beginPath();
      ctx.arc(
        c + Math.cos(l.a) * l.d * c * scale + ox * c,
        c + Math.sin(l.a) * l.d * c * scale + oy * c,
        l.r * c * scale,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
  };

  ctx.filter = 'blur(1.1px)';

  ctx.fillStyle = OUTLINE;
  blob(1.0);
  // Shade covers the whole inside; the fill is then nudged up-left so the
  // shade survives only along the bottom-right, which is where a single
  // painted highlight direction puts it.
  ctx.fillStyle = SHADE;
  blob(0.87);
  ctx.fillStyle = FILL;
  blob(0.8, -0.035, -0.045);

  ctx.filter = 'none';

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

const VERT = /* glsl */ `
  attribute float aAlpha;
  attribute float aSize;
  attribute float aRot;
  uniform float uPixelRatio;
  varying float vAlpha;
  varying float vRot;
  void main() {
    vAlpha = aAlpha;
    vRot = aRot;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    // gl_PointSize is in framebuffer pixels, hence the device ratio.
    gl_PointSize = aSize * uPixelRatio * (300.0 / max(0.001, -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec3 uTint;
  varying float vAlpha;
  varying float vRot;
  void main() {
    if (vAlpha <= 0.002) discard;
    // Spin the lookup rather than the quad: points cannot be rotated, but the
    // sample can, and without it every puff is visibly the same stamp.
    vec2 p = gl_PointCoord - 0.5;
    float s = sin(vRot), c = cos(vRot);
    vec2 uv = vec2(p.x * c - p.y * s, p.x * s + p.y * c) + 0.5;
    vec4 tex = texture2D(uMap, uv);
    // The rim and both tones are painted into the texture, so pass its colour
    // straight through — nothing here shades it a second time.
    gl_FragColor = vec4(tex.rgb * uTint, tex.a * vAlpha);
  }
`;

/** Fast out of the gate, then coasting — a puff loses its push immediately. */
const easeOut = (u: number) => 1 - Math.pow(1 - u, 3);

/** Hold, then leave in whole steps rather than dissolving. */
function celAlpha(u: number) {
  if (u < 0.06) return 1;
  const raw = u < 0.5 ? 1 : 1 - (u - 0.5) / 0.5;
  return Math.ceil(Math.max(0, raw) * ALPHA_STEPS) / ALPHA_STEPS;
}

export type PuffBurstHandle = {
  /** Pop a cloud at a world-space point. */
  burst: (at: THREE.Vector3) => void;
};

export type PuffBurstProps = {
  /** Multiplies the painted colours; leave white to use them as drawn. */
  tint?: string;
};

/**
 * A cartoon smoke burst: a ring of outlined puffs thrown outward, growing as
 * they go and stepping out of existence rather than fading.
 *
 * Points with a rotated texture lookup, so all twenty are one draw call and
 * still none of them looks like the same stamp twice. Depth testing stays on —
 * this is smoke sitting *in* the scene, so puffs behind a hand read as behind
 * it.
 */
export const PuffBurst = forwardRef<PuffBurstHandle, PuffBurstProps>(function PuffBurst(
  { tint = '#ffffff' },
  ref,
) {
  const clock = useRef({ time: 0, live: false });
  const origin = useRef(new THREE.Vector3());
  const texture = useMemo(makePuffTexture, []);

  const puffs = useMemo<Puff[]>(() => {
    let seed = 4242;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    return Array.from({ length: COUNT }, () => {
      // Even-ish spherical spread, squashed so the cloud is wider than tall.
      const theta = rnd() * Math.PI * 2;
      const z = rnd() * 2 - 1;
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      return {
        dx: Math.cos(theta) * r,
        dy: z * 0.7,
        dz: Math.sin(theta) * r,
        reach: SPREAD * (0.45 + rnd() * 0.55),
        size: 0.42 + rnd() * 0.42,
        grow: 1.5 + rnd() * 1.3,
        spin: rnd() * Math.PI * 2,
        delay: rnd() * 0.14,
      };
    });
  }, []);

  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(COUNT * 3), 3));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(COUNT), 1));
    g.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(COUNT), 1));
    g.setAttribute(
      'aRot',
      new THREE.BufferAttribute(Float32Array.from(puffs.map((p) => p.spin)), 1),
    );
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4);
    return g;
  }, [puffs]);

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          uMap: { value: texture },
          uTint: { value: new THREE.Color(tint) },
          uPixelRatio: { value: 1 },
        },
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
      }),
    [texture, tint],
  );

  useEffect(() => {
    material.uniforms.uTint.value.set(tint);
  }, [material, tint]);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
      texture.dispose();
    },
    [geometry, material, texture],
  );

  useImperativeHandle(ref, () => ({
    burst(at: THREE.Vector3) {
      origin.current.copy(at);
      clock.current.time = 0;
      clock.current.live = true;
    },
  }));

  useFrame((state, dt) => {
    material.uniforms.uPixelRatio.value = state.gl.getPixelRatio();

    const c = clock.current;
    if (!c.live) return;
    c.time += dt;

    const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
    const alpha = geometry.getAttribute('aAlpha') as THREE.BufferAttribute;
    const size = geometry.getAttribute('aSize') as THREE.BufferAttribute;
    const o = origin.current;
    const t = c.time / LIFE;

    for (let i = 0; i < COUNT; i++) {
      const p = puffs[i];
      const u = (t - p.delay) / (1 - p.delay);
      if (u <= 0 || u >= 1) {
        alpha.setX(i, 0);
        continue;
      }
      const out = easeOut(u) * p.reach;
      pos.setXYZ(i, o.x + p.dx * out, o.y + p.dy * out + DRIFT * u * u, o.z + p.dz * out);
      // Swells as it expands: smoke disperses, it does not retract.
      size.setX(i, p.size * (0.55 + p.grow * easeOut(u)));
      alpha.setX(i, celAlpha(u));
    }

    pos.needsUpdate = true;
    alpha.needsUpdate = true;
    size.needsUpdate = true;

    if (c.time >= LIFE) {
      c.live = false;
      for (let i = 0; i < COUNT; i++) alpha.setX(i, 0);
      alpha.needsUpdate = true;
    }
  });

  return <points geometry={geometry} material={material} frustumCulled={false} />;
});
