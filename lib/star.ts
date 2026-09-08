export const STAR_GLSL =`
  /**
   * p     sample position, -1..1 across the shape
   * r     outer radius, in those same units
   * ratio inner radius as a share of the outer — about 0.38 is the star as it
   *       is normally drawn, lower is spikier, higher is stubbier
   *
   * Negative inside, positive outside, in the units p is measured in.
   */
  float sdStar5(vec2 p, float r, float ratio) {
    // The two mirror planes of a five-fold shape: cos/sin of 36 and 144 deg.
    const vec2 k1 = vec2(0.809016994, -0.587785252);
    const vec2 k2 = vec2(-0.809016994, -0.587785252);
    // Fold the plane down to a single edge, so one segment answers for all ten.
    p.x = abs(p.x);
    p -= 2.0 * max(dot(k1, p), 0.0) * k1;
    p -= 2.0 * max(dot(k2, p), 0.0) * k2;
    p.x = abs(p.x);
    p.y -= r;
    vec2 ba = ratio * vec2(0.587785252, 0.809016994) - vec2(0.0, 1.0);
    float h = clamp(dot(p, ba) / dot(ba, ba), 0.0, r);
    return length(p - ba * h) * sign(p.y * ba.x - p.x * ba.y);
  }

  /**
   * How far the points are rounded off, in the units p is measured in.
   *
   * Lives here rather than in either effect so the spiral and the burst cannot
   * end up with differently shaped stars.
   */
  const float STAR_ROUND = 0.16;

  /**
   * p     sample position, -1..1 across the shape
   * ratio inner radius share, as above
   * hole  inner radius ratio for a hollow star; 0 draws it solid
   * px    one screen pixel, expressed in p's units
   * round corner radius, in p's units; 0 leaves the points sharp
   *
   * Rounding is free here because the distance is exact: subtracting a radius
   * from a signed distance is the shape grown by that radius with every corner
   * filleted, so the outer radius is pulled in by the same amount first and the
   * star keeps the size it was asked for. It softens the five points and the
   * five notches between them alike, which is what reads as a rounded star
   * rather than a blunted one.
   */
  float starMask(vec2 p, float ratio, float hole, float px, float round) {
    float m = 1.0 - smoothstep(-px, px, sdStar5(p, 1.0 - round, ratio) - round);
    if (hole > 0.001) {
      // The hole is the same star scaled down, so a hollow one is a star
      // outline rather than a star with a round bite out of it.
      m *= smoothstep(-px, px, sdStar5(p, hole - round, ratio) - round);
    }
    return m;
  }
`;

const K1 = { x: 0.809016994, y: -0.587785252 };
const K2 = { x: -0.809016994, y: -0.587785252 };

function sdStar5(px: number, py: number, r: number, ratio: number): number {
  let x = Math.abs(px);
  let y = py;
  const fold = (kx: number, ky: number) => {
    const d = x * kx + y * ky;
    if (d > 0) {
      x -= 2 * d * kx;
      y -= 2 * d * ky;
    }
  };
  fold(K1.x, K1.y);
  fold(K2.x, K2.y);
  x = Math.abs(x);
  y -= r;
  const bax = ratio * 0.587785252;
  const bay = ratio * 0.809016994 - 1;
  const h = Math.min(r, Math.max(0, (x * bax + y * bay) / (bax * bax + bay * bay)));
  const qx = x - bax * h;
  const qy = y - bay * h;
  return Math.hypot(qx, qy) * Math.sign(y * bax - x * bay);
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Same mask the particle shaders use, for HTML stand-ins such as the loader. */
export function starMask(
  px: number,
  py: number,
  ratio: number,
  hole: number,
  pixel: number,
  round = 0.16,
): number {
  let m = 1 - smoothstep(-pixel, pixel, sdStar5(px, py, 1 - round, ratio) - round);
  if (hole > 0.001) {
    m *= smoothstep(-pixel, pixel, sdStar5(px, py, hole - round, ratio) - round);
  }
  return m;
}

/** Pink the puff / spiral particles stamp. */
export const STAR_PINK = '#ea35d7';

export function starSprite(size = 128, ratio = 0.38, hole = 0): string {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(size, size);
  const pixel = (2 / size) * 1.3;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = ((x + 0.5) / size) * 2 - 1;
      const v = ((y + 0.5) / size) * 2 - 1;
      const a = starMask(u, v, ratio, hole, pixel);
      const i = (y * size + x) * 4;
      image.data[i] = 0xea;
      image.data[i + 1] = 0x35;
      image.data[i + 2] = 0xd7;
      image.data[i + 3] = Math.round(Math.min(1, Math.max(0, a)) * 255);
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL();
}
