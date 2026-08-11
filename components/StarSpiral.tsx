'use client';

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

const COUNT = 160;

/**
 * How much longer than the clip the stars keep going, as a multiple of it.
 * The spin is 0.87s; ending the sparkle on the same frame the character stops
 * reads as a cut, so the tail carries on a little past it.
 */
const TAIL = 1.7;

/** Radius of the column the stars travel up, in world units. */
const R_MIN = 0.34;
const R_MAX = 0.78;
/** Bottom and top of that column — roughly ankle to a little over the head. */
const Y_MIN = -0.02;
const Y_MAX = 2.15;

type Particle = {
  /** Where on the circle it starts, and which way it goes round. */
  angle: number;
  dir: number;
  /** Turns completed over its life. */
  turns: number;
  radius: number;
  from: number;
  to: number;
  /** Fraction of the burst to wait before setting off. */
  delay: number;
  /** …and how much of what's left it takes, so they don't land together. */
  span: number;
  size: number;
  spin: number;
};

/**
 * Petal depth in the polar inequality below. 0 gives a plain circle, 0.4 is as
 * far as the reference pushes it; 0.34 keeps four clear lobes without the waist
 * pinching down to a cross.
 */
const PETAL_Q = 0.34;
/** Base radius the lobes modulate around. */
const PETAL_R0 = 0.5;

/**
 * The sparkle, filled from `r < R0 + q·cos(4θ)`.
 *
 * A four-lobed rounded star, straight off the polar form rather than assembled
 * from quadratic spikes — the curve is continuous all the way round, so the
 * lobes meet in soft waists instead of the hard notches a hand-built path
 * leaves at the joins.
 *
 * Only the alpha survives: the shader multiplies this by a flat colour, so this
 * is a silhouette, not artwork.
 */
function makeStarTexture(): THREE.CanvasTexture {
  const S = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext('2d')!;
  const c = S / 2;
  // Scale so the lobe tips just reach the edge, leaving a pixel for the blur.
  const scale = (c - 2) / (PETAL_R0 + PETAL_Q);

  const STEPS = 256;
  ctx.beginPath();
  for (let i = 0; i <= STEPS; i++) {
    const t = (i / STEPS) * Math.PI * 2;
    const r = (PETAL_R0 + PETAL_Q * Math.cos(4 * t)) * scale;
    const x = c + Math.cos(t) * r;
    const y = c + Math.sin(t) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  // Just enough blur to take the stair-stepping off; the shape stays crisp.
  ctx.filter = 'blur(0.8px)';
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.filter = 'none';

  const texture = new THREE.CanvasTexture(canvas);
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
    // Perspective falloff so a star keeps its world size as the camera moves,
    // times the device ratio — gl_PointSize is in framebuffer pixels, so on a
    // retina display an unscaled value comes out half the size it looks here.
    gl_PointSize = aSize * uPixelRatio * (300.0 / max(0.001, -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec3 uColor;
  varying float vAlpha;
  varying float vRot;
  void main() {
    if (vAlpha <= 0.002) discard;
    // Spin the lookup: points cannot be rotated, but the sample can, and a
    // four-fold shape at one fixed angle reads as the same stamp 160 times.
    vec2 p = gl_PointCoord - 0.5;
    float s = sin(vRot), c = cos(vRot);
    vec4 tex = texture2D(uMap, vec2(p.x * c - p.y * s, p.x * s + p.y * c) + 0.5);
    // Straight alpha, not additive: the page clears to #ccc and the floor is
    // lighter still, and adding light to an almost-white background is a
    // change of a few percent — which is why the first pass read as nothing.
    gl_FragColor = vec4(uColor, tex.a * vAlpha);
  }
`;

/** Ease so stars leave quickly and drift as they rise. */
const easeOut = (u: number) => 1 - Math.pow(1 - u, 2.2);

export type StarSpiralHandle = {
  /** Run one burst timed to a clip `seconds` long. */
  burst: (seconds: number) => void;
};

export type StarSpiralProps = {
  /** Star colour. Drawn solid, so it needs to contrast with the page. */
  color?: string;
};

/**
 * Stars spiralling up around the character, fired once per spin.
 *
 * Points rather than instanced meshes: they are camera-facing by definition,
 * which is what a sparkle wants, and 160 of them cost one draw call.
 *
 * The whole thing is inert between bursts — the geometry stays mounted with
 * every alpha at zero, so a burst never has to rebuild buffers mid-frame.
 */
export const StarSpiral = forwardRef<StarSpiralHandle, StarSpiralProps>(function StarSpiral(
  { color = '#ffffff' },
  ref,
) {
  const clock = useRef({ time: 0, life: 0 });
  const texture = useMemo(makeStarTexture, []);

  const particles = useMemo<Particle[]>(() => {
    // Deterministic so a reload looks the same; Math.random would make every
    // burst a different shape between sessions for no gain.
    let seed = 20260810;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    return Array.from({ length: COUNT }, () => {
      const delay = rnd() * 0.55;
      return {
        angle: rnd() * Math.PI * 2,
        dir: rnd() < 0.75 ? 1 : -1, // mostly with the spin, a few against
        turns: 0.7 + rnd() * 1.1,
        radius: R_MIN + rnd() * (R_MAX - R_MIN),
        from: Y_MIN + rnd() * 0.35,
        to: Y_MAX - rnd() * 0.7,
        delay,
        span: 0.45 + rnd() * (1 - delay) * 0.55,
        size: 0.16 + rnd() * 0.34,
        spin: rnd() * Math.PI * 2,
      };
    });
  }, []);

  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(COUNT * 3), 3));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(COUNT), 1));
    g.setAttribute(
      'aSize',
      new THREE.BufferAttribute(Float32Array.from(particles.map((p) => p.size)), 1),
    );
    g.setAttribute(
      'aRot',
      new THREE.BufferAttribute(Float32Array.from(particles.map((p) => p.spin)), 1),
    );
    // Fixed bounds: the positions churn every frame and three would otherwise
    // want to recompute a sphere for them, and an all-zero buffer between
    // bursts would frustum-cull the whole thing on the frame it starts.
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 3);
    return g;
  }, [particles]);

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          uMap: { value: texture },
          uColor: { value: new THREE.Color(color) },
          uPixelRatio: { value: 1 },
        },
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
      }),
    [texture, color],
  );

  useEffect(() => {
    material.uniforms.uColor.value.set(color);
  }, [material, color]);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
      texture.dispose();
    },
    [geometry, material, texture],
  );

  useImperativeHandle(ref, () => ({
    burst(seconds: number) {
      clock.current.time = 0;
      clock.current.life = Math.max(0.2, seconds) * TAIL;
    },
  }));

  useFrame((state, dt) => {
    material.uniforms.uPixelRatio.value = state.gl.getPixelRatio();

    const c = clock.current;
    if (c.life <= 0) return;

    c.time += dt;
    const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
    const alpha = geometry.getAttribute('aAlpha') as THREE.BufferAttribute;
    const t = c.time / c.life;

    for (let i = 0; i < COUNT; i++) {
      const p = particles[i];
      // Each star runs its own clip inside the burst.
      const u = (t - p.delay) / p.span;
      if (u <= 0 || u >= 1) {
        alpha.setX(i, 0);
        continue;
      }
      const rise = easeOut(u);
      const a = p.angle + p.dir * p.turns * Math.PI * 2 * rise;
      // Bulge outward on the way up, then draw back in as it fades.
      const r = p.radius * (0.65 + 0.45 * Math.sin(Math.PI * u));
      pos.setXYZ(i, Math.cos(a) * r, p.from + (p.to - p.from) * rise, Math.sin(a) * r);
      // Quick in, slow out.
      alpha.setX(i, u < 0.15 ? u / 0.15 : 1 - (u - 0.15) / 0.85);
    }

    pos.needsUpdate = true;
    alpha.needsUpdate = true;

    if (c.time >= c.life) {
      c.life = 0;
      for (let i = 0; i < COUNT; i++) alpha.setX(i, 0);
      alpha.needsUpdate = true;
    }
  });

  return <points geometry={geometry} material={material} frustumCulled={false} />;
});
