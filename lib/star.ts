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
