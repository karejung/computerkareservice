'use client';

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

import { STAR_GLSL } from '@/lib/star';

const COUNT = 20;
const LIFE = 0.6;
const SPREAD = 0.58;
const DRIFT = 0.2;
const ALPHA_STEPS = 5;

const FILL = '#ffffff';
const SHADE = '#eeeeee';

const STAR_COUNT = 9;
const STAR_COLOR = '#ea35d7';
const STAR_SPREAD = 0.9;
const STAR_RATIO_MIN = 0.30;
const STAR_RATIO_MAX = 0.42;
const STAR_SPIN = 3.6;
const STAR_LIFE = LIFE * 2.2;
const SPARKLE_REACH = 0.45;

type Star = {
  dx: number;
  dy: number;
  dz: number;
  reach: number;
  size: number;
  spin: number;
  rate: number;
  delay: number;
  r0: number;
  r1: number;
};

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

  ctx.fillStyle = SHADE;
  blob(1.0);
  ctx.fillStyle = FILL;
  blob(0.92, -0.04, -0.052);

  ctx.filter = 'none';

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

const VERT =`
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

const FRAG =`
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

const STAR_VERT =`
  attribute float aAlpha;
  attribute float aSize;
  attribute float aRot;
  attribute float aRatio;
  attribute float aScale;
  uniform float uPixelRatio;
  varying float vAlpha;
  varying float vRot;
  varying float vRatio;
  varying float vScale;
  varying float vSize;
  void main() {
    vAlpha = aAlpha;
    vRot = aRot;
    vRatio = aRatio;
    vScale = aScale;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uPixelRatio * (300.0 / max(0.001, -mv.z));
    vSize = gl_PointSize;
    gl_Position = projectionMatrix * mv;
  }
`;

const STAR_FRAG =`
  uniform vec3 uColor;
  varying float vAlpha;
  varying float vRot;
  varying float vRatio;
  varying float vScale;
  varying float vSize;

  ${STAR_GLSL}

  void main() {
    if (vAlpha <= 0.002) discard;
    vec2 p = (gl_PointCoord - 0.5) * 2.0;
    float sr = sin(vRot), cr = cos(vRot);
    p = vec2(p.x * cr - p.y * sr, p.x * sr + p.y * cr);
    float k = max(0.04, vScale);
    p /= k;

    float mask = starMask(p, vRatio, 0.0, 2.0 / max(1.0, vSize) / k * 1.3, STAR_ROUND);
    if (mask <= 0.002) discard;
    gl_FragColor = vec4(uColor, mask * vAlpha);
    #include <colorspace_fragment>
  }
`;

const easeOut = (u: number) => 1 - Math.pow(1 - u, 3);

function celAlpha(u: number) {
  if (u < 0.06) return 1;
  const raw = u < 0.5 ? 1 : 1 - (u - 0.5) / 0.5;
  return Math.ceil(Math.max(0, raw) * ALPHA_STEPS) / ALPHA_STEPS;
}

export type PuffBurstHandle = {
  burst: (at: THREE.Vector3, radius?: number, stars?: boolean) => void;
  sparkle: (at: THREE.Vector3) => void;
};

export type PuffBurstProps = {
  tint?: string;
};

export const PuffBurst = forwardRef<PuffBurstHandle, PuffBurstProps>(function PuffBurst(
  { tint = '#ffffff' },
  ref,
) {
  const clock = useRef({ time: 0, live: false, smoke: true, stars: true, reach: 1 });
  const origin = useRef(new THREE.Vector3());
  const texture = useMemo(makePuffTexture, []);

  const puffs = useMemo<Puff[]>(() => {
    let seed = 4242;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    return Array.from({ length: COUNT }, () => {
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

  const stars = useMemo<Star[]>(() => {
    let seed = 777;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    return Array.from({ length: STAR_COUNT }, () => {
      const theta = rnd() * Math.PI * 2;
      const z = rnd() * 2 - 1;
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      return {
        dx: Math.cos(theta) * r,
        dy: z * 0.8,
        dz: Math.sin(theta) * r,
        reach: STAR_SPREAD * (0.5 + rnd() * 0.5),
        size: 0.24 + rnd() * 0.26,
        spin: rnd() * Math.PI * 2,
        rate: (rnd() - 0.5) * 2 * STAR_SPIN,
        delay: rnd() * 0.1,
        r0: STAR_RATIO_MIN + rnd() * (STAR_RATIO_MAX - STAR_RATIO_MIN),
        r1: STAR_RATIO_MIN + rnd() * (STAR_RATIO_MAX - STAR_RATIO_MIN),
      };
    });
  }, []);

  const starGeometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const empty = () => new THREE.BufferAttribute(new Float32Array(STAR_COUNT), 1);
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(STAR_COUNT * 3), 3));
    g.setAttribute('aAlpha', empty());
    g.setAttribute('aRatio', empty());
    g.setAttribute('aScale', empty());
    g.setAttribute(
      'aSize',
      new THREE.BufferAttribute(Float32Array.from(stars.map((p) => p.size)), 1),
    );
    g.setAttribute(
      'aRot',
      new THREE.BufferAttribute(Float32Array.from(stars.map((p) => p.spin)), 1),
    );
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4);
    return g;
  }, [stars]);

  const starMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: new THREE.Color(STAR_COLOR) },
          uPixelRatio: { value: 1 },
        },
        vertexShader: STAR_VERT,
        fragmentShader: STAR_FRAG,
        transparent: true,
        depthWrite: false,
      }),
    [],
  );

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
        depthTest: false,
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
      starGeometry.dispose();
      starMaterial.dispose();
    },
    [geometry, material, texture, starGeometry, starMaterial],
  );

  const fire = (at: THREE.Vector3, smoke: boolean, stars: boolean, reach: number) => {
    origin.current.copy(at);
    clock.current.time = 0;
    clock.current.live = true;
    clock.current.smoke = smoke;
    clock.current.stars = stars;
    clock.current.reach = reach;
  };

  useImperativeHandle(ref, () => ({
    burst(at: THREE.Vector3, radius?: number, stars = true) {
      fire(at, true, stars, radius === undefined ? 1 : Math.max(0.15, radius / SPREAD));
    },
    sparkle(at: THREE.Vector3) {
      fire(at, false, true, SPARKLE_REACH);
    },
  }));

  useFrame((state, dt) => {
    material.uniforms.uPixelRatio.value = state.gl.getPixelRatio();
    starMaterial.uniforms.uPixelRatio.value = state.gl.getPixelRatio();

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
      if (!c.smoke || u <= 0 || u >= 1) {
        alpha.setX(i, 0);
        continue;
      }
      const out = easeOut(u) * p.reach * c.reach;
      pos.setXYZ(
        i,
        o.x + p.dx * out,
        o.y + p.dy * out + DRIFT * u * u * c.reach,
        o.z + p.dz * out,
      );

      size.setX(i, p.size * (0.55 + p.grow * easeOut(u)) * c.reach);
      alpha.setX(i, celAlpha(u));
    }

    pos.needsUpdate = true;
    alpha.needsUpdate = true;
    size.needsUpdate = true;

    const st = c.time / STAR_LIFE;
    const sPos = starGeometry.getAttribute('position') as THREE.BufferAttribute;
    const sAlpha = starGeometry.getAttribute('aAlpha') as THREE.BufferAttribute;
    const sRatio = starGeometry.getAttribute('aRatio') as THREE.BufferAttribute;
    const sScale = starGeometry.getAttribute('aScale') as THREE.BufferAttribute;
    const sRot = starGeometry.getAttribute('aRot') as THREE.BufferAttribute;
    for (let i = 0; i < STAR_COUNT; i++) {
      const p = stars[i];

      p.spin += p.rate * dt;
      const u = (st - p.delay) / (1 - p.delay);
      if (!c.stars || u <= 0 || u >= 1) {
        sAlpha.setX(i, 0);
        continue;
      }

      const out = easeOut(u) * p.reach * c.reach;
      sPos.setXYZ(
        i,
        o.x + p.dx * out,
        o.y + p.dy * out + DRIFT * u * u * c.reach,
        o.z + p.dz * out,
      );
      sRot.setX(i, p.spin);
      sScale.setX(i, Math.sin(Math.PI * u));

      sAlpha.setX(i, u < 0.14 ? u / 0.14 : Math.pow(1 - (u - 0.14) / 0.86, 1.5));
      sRatio.setX(i, p.r0 + (p.r1 - p.r0) * u);
    }
    sPos.needsUpdate = true;
    sAlpha.needsUpdate = true;
    sScale.needsUpdate = true;
    sRatio.needsUpdate = true;
    sRot.needsUpdate = true;

    if (c.time >= Math.max(LIFE, STAR_LIFE)) {
      c.live = false;
      for (let i = 0; i < COUNT; i++) alpha.setX(i, 0);
      for (let i = 0; i < STAR_COUNT; i++) sAlpha.setX(i, 0);
      alpha.needsUpdate = true;
      sAlpha.needsUpdate = true;
    }
  });

  return (
    <group>
      <points geometry={geometry} material={material} frustumCulled={false} renderOrder={10} />
      <points geometry={starGeometry} material={starMaterial} frustumCulled={false} />
    </group>
  );
});
