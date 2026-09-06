import * as THREE from 'three';

import { STAR_GLSL } from './star';

export const key = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

export const PROP_ROOTS = {
  ds: key('Nintendo DS'),
  pc: key('laptop'),
  phone: key('phone'),
} as const;
export type PropKind = keyof typeof PROP_ROOTS;

export const PROP_FLIP = new Set<PropKind>(['pc', 'phone']);
export const PROP_FLIP_TURN = Math.PI;

export const DS_ROOT = PROP_ROOTS.ds;
export const DS_BODY_MATERIALS = new Set(
  ['blue', 'laptop_body', 'phone_body'].map(key),
);
export const DS_BODY_COLOR = '#377cf6';
export const DS_DARK_MATERIALS = new Set(
  ['black.001', 'laptop_dark', 'phone_dark'].map(key),
);
export const DS_DARK_COLOR = '#1b1b20';
export const DS_NEON_MATERIALS = new Set(['neon.001', 'neon droite.001'].map(key));
export const DS_NEON_COLOR = '#3fff00';
export const DS_SCREEN_MATERIALS = new Set(
  ['screen up.001', 'screen down.001', 'laptop_display', 'phone_screen'].map(key),
);

export const isScreenMaterial = (material: THREE.Material) =>
  DS_SCREEN_MATERIALS.has(key(material.name));

export type TwoToneUniforms = {
  uShade: { value: THREE.Color };
  uSplit: { value: number };
  uSoft: { value: number };
  uShadeDir: { value: THREE.Vector3 };
};

const SHADE_SOFT = 0.07;

export type TwoToneMaterial = THREE.MeshLambertMaterial & {
  userData: { uniforms: TwoToneUniforms };
};

export function createTwoToneMaterial(
  side: THREE.Side,
  map?: THREE.Texture,
  color: THREE.ColorRepresentation = 0xffffff,
  cutout = false,
): TwoToneMaterial {
  const material = new THREE.MeshLambertMaterial({
    name: cutout ? 'face-live' : 'two-tone',
    color,
    side,
    map,

    alphaTest: cutout ? 0.5 : 0,
  }) as TwoToneMaterial;

  const uniforms: TwoToneUniforms = {
    uShade: { value: new THREE.Color(0xc8c8c8) },
    uSplit: { value: 0.15 },
    uSoft: { value: SHADE_SOFT },
    uShadeDir: { value: new THREE.Vector3(0.5, 0.6, 0.6).normalize() },
  };
  material.userData.uniforms = uniforms;

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform vec3 uShade;
        uniform float uSplit;
        uniform float uSoft;
        uniform vec3 uShadeDir;`,
      )
      .replace(
        '#include <opaque_fragment>',
        `{
          // uShadeDir is authored in world space, the normal is in view space.
          vec3 shadeDir = normalize( mat3( viewMatrix ) * uShadeDir );
          float facing = dot( normalize( normal ), shadeDir );

          /*
           * Where the shadow ends, softened twice over.
           *
           * step() drew the terminator exactly on whichever polygon edge it
           * landed on. On a model this low-poly that is what turned the
           * shading into blocks — the sleeve and the forearm shaded in flat
           * facets, because the boundary was following the geometry instead
           * of the form.
           *
           * fwidth is how fast facing changes across one pixel, so feathering
           * by it spreads the edge over exactly the pixel it is crossing and no
           * more: an anti-aliased edge that stays equally crisp however close
           * the camera gets. A constant feather cannot do that — it is a hard
           * edge at one distance and a gradient at another.
           *
           * uSoft is then the drawing decision on top of the correctness one:
           * a little real softness, because skin and cloth do not turn from
           * lit to shadowed across a single pixel. Kept narrow so this stays
           * two tones with a clean edge rather than becoming a gradient.
           */
          float edge = max( uSoft, fwidth( facing ) );
          float lit = smoothstep( uSplit - edge, uSplit + edge, facing );
          vec3 tone = mix( uShade, vec3( 1.0 ), lit );
          // Modulating diffuseColor rather than replacing the light keeps any
          // map intact — the face is drawn on one of these, and it has to
          // survive the shading rather than be painted over by it.
          outgoingLight = diffuseColor.rgb * tone;
        }
        #include <opaque_fragment>`,
      );
  };

  material.customProgramCacheKey = () => 'two-tone-v3';

  return material;
}

export function consoleColor(source: THREE.Material): THREE.Color {
  const src = source as THREE.MeshStandardMaterial;
  const lit = src.emissive?.clone().multiplyScalar(src.emissiveIntensity ?? 1);
  const colour =
    !lit || lit.r + lit.g + lit.b < 0.001
      ? (src.color?.clone() ?? new THREE.Color(0xffffff))
      : lit;
  const name = key(src.name);
  if (DS_NEON_MATERIALS.has(name)) colour.set(DS_NEON_COLOR);
  if (DS_BODY_MATERIALS.has(name)) colour.set(DS_BODY_COLOR);
  if (DS_DARK_MATERIALS.has(name)) colour.set(DS_DARK_COLOR);
  return colour;
}

export function createConsoleMaterial(source: THREE.Material): TwoToneMaterial {
  const src = source as THREE.MeshStandardMaterial;
  const material = createTwoToneMaterial(
    src.side,
    src.emissiveMap ?? src.map ?? undefined,
    consoleColor(src),
  );
  material.name = `ds-${src.name}`;
  return material;
}

const SCREEN_COLOR = '#ea35d7';
const SCREEN_CELLS = 4.0;
const SCREEN_STAR = 0.8;
const SCREEN_DRIFT: [number, number] = [0.26, 0.4];
const SCREEN_ROUND = 0.2;

const SCREEN_TIME = { value: 0 };

export function tickScreens(dt: number) {
  SCREEN_TIME.value += dt;
}

const SCREEN_VERT =`
  varying vec2 vPat;
  void main() {
    /*
     * Pattern coordinates straight off the local position, because these meshes
     * have no UVs — they were built from raw boxes and the exporter had nothing
     * to write. The face normal picks which two axes span the face, so the
     * pattern lies flat on it whichever way the box is oriented.
     */
    vec3 a = abs(normal);
    vPat = (a.z > a.x && a.z > a.y) ? position.xy
         : (a.y > a.x) ? position.xz
         : position.zy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SCREEN_FRAG =`
  precision highp float;
  uniform float uOn;
  uniform float uTime;
  uniform float uScale;
  uniform vec3 uColor;
  varying vec2 vPat;

  ${STAR_GLSL}

  void main() {
    vec2 p = vPat * uScale;
    p += vec2(${SCREEN_DRIFT[0].toFixed(3)}, ${SCREEN_DRIFT[1].toFixed(3)}) * uTime;
    // Every other row is half a cell across, so the field reads as a pattern
    // rather than as a grid. Taken after the drift, so the rows stagger with
    // the pattern instead of standing still under it.
    p.x += mod(floor(p.y), 2.0) * 0.5;

    vec2 c = fract(p) - 0.5;
    float px = max(fwidth(p.x), fwidth(p.y)) * 2.0 / ${SCREEN_STAR.toFixed(3)};
    // Same rounding the particles get, through the same function — the screen
    // just asks for more of it than a spark does.
    float m = starMask(c * 2.0 / ${SCREEN_STAR.toFixed(3)}, 0.38, 0.0, px,
                       ${SCREEN_ROUND.toFixed(3)});

    /*
     * On: pink stars on white. Off: black, rather than hidden — a dead screen
     * is part of the object, and multiplying the whole thing by uOn is what
     * takes the white ground away with the stars.
     */
    vec3 lit = mix(vec3(1.0), uColor, m);
    gl_FragColor = vec4(lit * uOn, 1.0);
  }
`;

export function createScreenMaterial(
  source: THREE.Material,
  geometry: THREE.BufferGeometry,
  on = false,
): THREE.ShaderMaterial {
  const src = source as THREE.MeshStandardMaterial;

  geometry.computeBoundingBox();
  const size = new THREE.Vector3();
  geometry.boundingBox?.getSize(size);
  const span = Math.max(size.x, size.y, size.z, 1e-6);

  const material = new THREE.ShaderMaterial({
    name: 'ds-screen',
    uniforms: {
      uOn: { value: on ? 1 : 0 },
      uTime: SCREEN_TIME,
      uScale: { value: SCREEN_CELLS / span },
      uColor: { value: new THREE.Color(SCREEN_COLOR) },
    },
    vertexShader: SCREEN_VERT,
    fragmentShader: SCREEN_FRAG,
    side: src.side,
  });
  return material;
}

export function setScreenOn(material: THREE.ShaderMaterial, on: boolean) {
  material.uniforms.uOn.value = on ? 1 : 0;
}

