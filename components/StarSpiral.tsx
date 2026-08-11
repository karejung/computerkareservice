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
 * The sparkle is the polar inequality `r < R0 + q·cos(4θ)`, unioned with a
 * plain disc.
 *
 * q is what animates. At 0 the inequality is just a circle of R0; pushed to
 * QMAX the four lobes reach R0+q while the 45° waists pinch in to R0−q, so the
 * shape blooms outward and narrows into a star at the same time. The disc sits
 * underneath and stops those waists closing to nothing — that is the "circle
 * plus flower" read, and it is why one equation was never going to be enough.
 *
 * Evaluated in the fragment shader rather than baked: a texture would fix q,
 * and q changing is the whole effect.
 */
const R0 = 0.5;
const QMAX = 0.4;
/** Radius of the disc under the petals, as a fraction of R0. */
const CORE = 0.62;

const VERT = /* glsl */ `
  attribute float aAlpha;
  attribute float aSize;
  attribute float aRot;
  attribute float aQ;
  uniform float uPixelRatio;
  varying float vAlpha;
  varying float vRot;
  varying float vQ;
  void main() {
    vAlpha = aAlpha;
    vRot = aRot;
    vQ = aQ;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    // Perspective falloff so a star keeps its world size as the camera moves,
    // times the device ratio — gl_PointSize is in framebuffer pixels, so on a
    // retina display an unscaled value comes out half the size it looks here.
    gl_PointSize = aSize * uPixelRatio * (300.0 / max(0.001, -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  uniform vec3 uColor;
  varying float vAlpha;
  varying float vRot;
  varying float vQ;

  const float R0 = 0.5;
  const float QMAX = 0.4;
  const float CORE = 0.62;

  void main() {
    if (vAlpha <= 0.002) discard;

    vec2 p = gl_PointCoord - 0.5;
    // Turn the sample, not the quad: points cannot rotate, and a four-fold
    // shape at one fixed angle reads as the same stamp every time.
    float s = sin(vRot), c = cos(vRot);
    p = vec2(p.x * c - p.y * s, p.x * s + p.y * c);

    // Put the quad edge at the widest the shape can ever be, so a blooming
    // lobe grows into space that is already there instead of being clipped.
    float r = length(p) * 2.0 * (R0 + QMAX);
    float theta = atan(p.y, p.x);

    float petals = R0 + vQ * cos(4.0 * theta);
    float edge = max(petals, R0 * CORE);

    // fwidth keeps the rim one pixel wide however close the camera gets.
    float w = fwidth(r) * 1.2;
    float mask = 1.0 - smoothstep(edge - w, edge + w, r);
    if (mask <= 0.002) discard;

    // Straight alpha, not additive: the page clears to #ccc and the floor is
    // lighter still, and adding light to an almost-white background is a
    // change of a few percent — which is why the first pass read as nothing.
    gl_FragColor = vec4(uColor, mask * vAlpha);
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
    g.setAttribute('aQ', new THREE.BufferAttribute(new Float32Array(COUNT), 1));
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
          uColor: { value: new THREE.Color(color) },
          uPixelRatio: { value: 1 },
        },
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
      }),
    [color],
  );

  useEffect(() => {
    material.uniforms.uColor.value.set(color);
  }, [material, color]);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
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
    const petal = geometry.getAttribute('aQ') as THREE.BufferAttribute;
    const t = c.time / c.life;

    for (let i = 0; i < COUNT; i++) {
      const p = particles[i];
      // Each star runs its own clip inside the burst.
      const u = (t - p.delay) / p.span;
      if (u <= 0 || u >= 1) {
        alpha.setX(i, 0);
        continue;
      }
      // Opens out of a circle, peaks as a star around mid-flight, closes again.
      petal.setX(i, QMAX * Math.sin(Math.PI * u) ** 0.7);
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
    petal.needsUpdate = true;

    if (c.time >= c.life) {
      c.life = 0;
      for (let i = 0; i < COUNT; i++) alpha.setX(i, 0);
      alpha.needsUpdate = true;
    }
  });

  return <points geometry={geometry} material={material} frustumCulled={false} />;
});
