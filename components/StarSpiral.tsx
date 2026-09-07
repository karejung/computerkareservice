'use client';

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

import { STAR_GLSL } from '@/lib/star';

const COUNT = 60;

const TAIL = 2.6;

const TURNS = 2;

const SWEEP = 0.62;
const PALETTE = ['#377cf6', '#ffffff', '#ea35d7', '#b3fc4f'];

const RISE_MIN = 0.12;
const RISE_MAX = 0.3;

const SCATTER_Y = 0.26;
const SCATTER_A = 0.7;

const R_MIN = 0.62;
const R_MAX = 0.78;
const Y_MIN = -0.02;
const Y_MAX = 2.15;

const RATIO_MIN = 0.36;
const RATIO_MAX = 0.44;
const HOLE_SHARE = 0.45;
const HOLE_MIN = 0.25;
const HOLE_MAX = 0.8;
const HOLE_SCALE = 0.9;
const HOLE_CAP = 0.85;

type Particle = {
  seat: number;
  angle: number;
  radius: number;
  from: number;
  rise: number;
  delay: number;
  span: number;
  size: number;
  ink: number;
  r0: number;
  r1: number;
  hole: number;
  rot: number;
  spin: number;
};

const VERT =`
  attribute float aAlpha;
  attribute float aSize;
  attribute float aRot;
  attribute float aRatio;
  attribute float aHole;
  attribute float aScale;
  attribute vec3 aColor;
  uniform float uPixelRatio;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vRot;
  varying float vRatio;
  varying float vHole;
  varying float vScale;
  varying float vSize;
  void main() {
    vColor = aColor;
    vAlpha = aAlpha;
    vRot = aRot;
    vRatio = aRatio;
    vHole = aHole;
    vScale = aScale;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    // Perspective falloff so a sparkle keeps its world size as the camera
    // moves, times the device ratio — gl_PointSize is in framebuffer pixels,
    // so unscaled it comes out half the size on a retina display.
    gl_PointSize = aSize * uPixelRatio * (300.0 / max(0.001, -mv.z));
    vSize = gl_PointSize;
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG =`
  varying vec3 vColor;
  varying float vAlpha;
  varying float vRot;
  varying float vRatio;
  varying float vHole;
  varying float vScale;
  varying float vSize;

  ${STAR_GLSL}

  void main() {
    if (vAlpha <= 0.002) discard;

    // Quad to -1..1, then turn the sample rather than the quad: points cannot
    // be rotated, and a star at a fixed angle reads as one stamp repeated.
    vec2 p = (gl_PointCoord - 0.5) * 2.0;
    float sr = sin(vRot), cr = cos(vRot);
    p = vec2(p.x * cr - p.y * sr, p.x * sr + p.y * cr);
    // Scaling the sample rather than the quad keeps the shape crisp while it
    // grows and shrinks, since the quad itself never changes size.
    float k = max(0.04, vScale);
    p /= k;

    float mask = starMask(p, vRatio, vHole, 2.0 / max(1.0, vSize) / k * 1.3, STAR_ROUND);
    if (mask <= 0.002) discard;

    // Straight alpha, not additive: the page clears to #ccc and the floor is
    // lighter still, and adding light to an almost-white background is a
    // change of a few percent — which is why an early pass read as nothing.
    gl_FragColor = vec4(vColor, mask * vAlpha);

    // The palette is authored in sRGB and THREE.Color hands it over linear, so
    // it has to be encoded back on the way out. A raw ShaderMaterial gets no
    // encoding unless it asks, and without this every ink lands too dark.
    #include <colorspace_fragment>
  }
`;

const lerp = (a: number, b: number, w: number) => a + w * (b - a);
const easeOut = (u: number) => 1 - Math.pow(1 - u, 1.25);

export type StarSpiralHandle = {
  burst: (seconds: number) => void;
};

export const StarSpiral = forwardRef<StarSpiralHandle>(function StarSpiral(_props, ref) {
  const points = useRef<THREE.Points>(null);
  const clock = useRef({ time: 0, life: 0 });

  const particles = useMemo<Particle[]>(() => {
    let seed = 20260811;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const start = rnd() * Math.PI * 2;
    return Array.from({ length: COUNT }, (_, i) => {
      const seat = Math.min(1, Math.max(0, i / (COUNT - 1) + (rnd() - 0.5) * 0.05));
      return {
        seat,
        angle: start + seat * TURNS * Math.PI * 2 + (rnd() - 0.5) * SCATTER_A,
        radius: R_MIN + rnd() * (R_MAX - R_MIN),
        from: Y_MIN + seat * (Y_MAX - Y_MIN) + (rnd() - 0.5) * SCATTER_Y,
        rise: RISE_MIN + rnd() * (RISE_MAX - RISE_MIN),

        delay: seat * SWEEP,

        span: 0.3 + rnd() * 0.14,
        size: 0.28 + rnd() * 0.46,
        ink: Math.min(PALETTE.length - 1, Math.floor(rnd() * PALETTE.length)),
        r0: lerp(RATIO_MIN, RATIO_MAX, rnd()),
        r1: lerp(RATIO_MIN, RATIO_MAX, rnd()),
        hole:
          rnd() < HOLE_SHARE
            ? Math.min(HOLE_CAP, lerp(HOLE_MIN, HOLE_MAX, rnd()) * HOLE_SCALE)
            : 0,
        rot: rnd() * Math.PI * 2,

        spin: (rnd() - 0.5) * 2.4,
      };
    });
  }, []);

  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const empty = () => new THREE.BufferAttribute(new Float32Array(COUNT), 1);
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(COUNT * 3), 3));
    g.setAttribute('aAlpha', empty());
    g.setAttribute('aRatio', empty());
    g.setAttribute('aScale', empty());
    g.setAttribute('aRot', empty());
    g.setAttribute(
      'aSize',
      new THREE.BufferAttribute(Float32Array.from(particles.map((p) => p.size)), 1),
    );
    g.setAttribute(
      'aHole',
      new THREE.BufferAttribute(Float32Array.from(particles.map((p) => p.hole)), 1),
    );

    const inks = PALETTE.map((hex) => new THREE.Color(hex));
    const rgb = new Float32Array(COUNT * 3);
    particles.forEach((p, i) => inks[p.ink].toArray(rgb, i * 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(rgb, 3));

    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 3);
    return g;
  }, [particles]);

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          uPixelRatio: { value: 1 },
        },
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
      }),
    [],
  );

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
    // Idle, these 60 sprites still rasterise at their full authored size every
    // frame and discard on alpha — `aSize` is filled from the particles at
    // build time, so unlike the puffs they are never zero. Take them out of
    // the scene instead.
    if (points.current) points.current.visible = c.life > 0;
    if (c.life <= 0) return;

    c.time += dt;
    const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
    const alpha = geometry.getAttribute('aAlpha') as THREE.BufferAttribute;
    const ratio = geometry.getAttribute('aRatio') as THREE.BufferAttribute;
    const scale = geometry.getAttribute('aScale') as THREE.BufferAttribute;
    const rot = geometry.getAttribute('aRot') as THREE.BufferAttribute;
    const t = c.time / c.life;

    for (let i = 0; i < COUNT; i++) {
      const p = particles[i];
      p.rot += p.spin * dt;

      const u = (t - p.delay) / p.span;
      if (u <= 0 || u >= 1) {
        alpha.setX(i, 0);
        continue;
      }

      const s = Math.sin(Math.PI * u);
      scale.setX(i, s);
      alpha.setX(i, Math.min(1, s * 1.7));
      ratio.setX(i, lerp(p.r0, p.r1, u));
      rot.setX(i, p.rot);

      const r = p.radius * (0.9 + 0.1 * s);
      pos.setXYZ(
        i,
        Math.cos(p.angle) * r,
        p.from + p.rise * easeOut(u),
        Math.sin(p.angle) * r,
      );
    }

    pos.needsUpdate = true;
    alpha.needsUpdate = true;
    ratio.needsUpdate = true;
    scale.needsUpdate = true;
    rot.needsUpdate = true;

    if (c.time >= c.life) {
      c.life = 0;
      for (let i = 0; i < COUNT; i++) alpha.setX(i, 0);
      alpha.needsUpdate = true;
    }
  });

  return (
    <points
      ref={points}
      geometry={geometry}
      material={material}
      frustumCulled={false}
      visible={false}
    />
  );
});
