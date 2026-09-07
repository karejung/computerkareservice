/**
 * Figma's corner smoothing, as an SVG path.
 *
 * Each corner is a bezier–arc–bezier run. `reach` is how far along the edge the
 * corner starts — it, not the radius, is what the eye reads as "how round" —
 * and smoothing trades the arc away for bezier at a fixed reach, until at
 * s = 1 there is no arc left at all.
 *
 *   radius = reach / (1 + s)
 *   arc    = 90° · (1 − s)
 *   theta  = 45° · s
 *
 * Unlike a `clipPathUnits="objectBoundingBox"` path, this takes real width and
 * height, so the corners come out the same size on both axes however oblong
 * the box is. That is the whole reason it exists: the inventory tile is square
 * and could get away with the unit path, the stage cannot.
 *
 * tools/squircle.mjs prints paths from this same construction, and was checked
 * against the hand-authored path this replaced: s = 0.6, reach = 60.324 on a
 * 128 box reproduces it character for character.
 */

/** Figma's corner smoothing slider, 0..1. 1 is the 100% end. */
export const CORNER_SMOOTHING = 1;

/** Corner reach as a fraction of the inventory tile's side. */
export const CORNER_REACH_RATIO = 60.324 / 128;

const rad = (deg: number) => (deg * Math.PI) / 180;

const round = (value: number, places: number) => {
  const r = Number(value.toFixed(places));
  // -0 serialises as "-0" and reads as a mistake in a path string.
  return Object.is(r, -0) ? 0 : r;
};

export function squirclePath(
  width: number,
  height: number,
  reach: number,
  smoothing: number = CORNER_SMOOTHING,
  places = 4,
): string {
  // Two corners share each side, so no corner may reach past the halfway point.
  const p = Math.min(reach, Math.min(width, height) / 2);
  const radius = p / (1 + smoothing);

  const arcMeasure = 90 * (1 - smoothing);
  const arcSection = Math.sin(rad(arcMeasure / 2)) * radius * Math.SQRT2;
  const theta = 45 * smoothing;
  const c = radius * Math.tan(rad(theta / 2)) * Math.cos(rad(theta));
  const d = c * Math.tan(rad(theta));
  const b = (p - arcSection - c - d) / 3;
  const a = 2 * b;

  const N = (v: number) => round(v, places);
  const A = N(a);
  const B = N(a + b);
  const C = N(a + b + c);
  const D = N(d);
  const BC = N(b + c);
  const CC = N(c);
  const R = N(radius);
  const K = N(arcSection);
  const P = N(p);

  // At s = 1 the arc is zero-length; the SVG spec drops such a segment anyway,
  // and leaving it out keeps the path honest about having no arc in it.
  const arc = (x: number, y: number) => (K === 0 ? '' : `a ${R} ${R} 0 0 1 ${x} ${y} `);

  return (
    `M ${N(width - p)} 0 ` +
    `c ${A} 0 ${B} 0 ${C} ${D} ` +
    arc(K, K) +
    `c ${D} ${CC} ${D} ${BC} ${D} ${C} ` +
    `L ${N(width)} ${N(height - p)} ` +
    `c 0 ${A} 0 ${B} ${-D} ${C} ` +
    arc(-K, K) +
    `c ${-CC} ${D} ${-BC} ${D} ${-C} ${D} ` +
    `L ${P} ${N(height)} ` +
    `c ${-A} 0 ${-B} 0 ${-C} ${-D} ` +
    arc(-K, -K) +
    `c ${-D} ${-CC} ${-D} ${-BC} ${-D} ${-C} ` +
    `L 0 ${P} ` +
    `c 0 ${-A} 0 ${-B} ${D} ${-C} ` +
    arc(K, -K) +
    `c ${CC} ${-D} ${BC} ${-D} ${C} ${-D} ` +
    `Z`
  );
}
