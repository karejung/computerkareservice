'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { asset } from '@/lib/asset';
import { squirclePath } from '@/lib/squircle';

/**
 * Draggable stickers over the page.
 *
 * Positions live in a ref and are written straight to `style.transform` rather
 * than held in state: a drag would otherwise re-render the whole set on every
 * pointermove, and there is nothing for React to reconcile — the element is
 * already on screen, only its transform changes.
 *
 * Placement is in viewport fractions, so a resize keeps a sticker where it was
 * relative to the page instead of stranding it off the edge.
 */

type Sticker = {
  id: string;
  file: string;
  /*
   * Long side, as a fraction of the smaller viewport axis — deliberately not
   * tied to the SVG's own dimensions, so a sticker's size on screen is a
   * layout decision rather than whatever Figma last exported at. The catch is
   * that rescaling the artwork in Figma then has no effect until this moves
   * with it: sticker-2 went from a 739px export to a 944px one and needed the
   * same 1.28x here.
   */
  span: number;
  ratio: number;
  /** Stickers that do something when tapped rather than only being moved. */
  action?: 'vsign';
  /** A tangent-space normal map, lit per pixel by the same light as the holo. */
  normal?: string;
  /*
   * The tool this sticker belongs to. When Kare picks a tool up, the sticker
   * for it stays and the rest are swept aside — and a tool with no sticker
   * clears the board, which is what the laptop and the phone do until they
   * have projects of their own.
   */
  project?: 'ds' | 'pc' | 'phone';
  /** Shown in place of the cursor while this sticker is hovered. */
  label?: string;
  /** Opened in a new tab when the sticker is tapped rather than dragged. */
  href?: string;
  /** Stays put when the face zoom sweeps the rest off. */
  stay?: boolean;
};

const STICKERS: Sticker[] = [
  { id: 'one', file: 'sticker-1.svg', span: 0.256, ratio: 590 / 230 },
  { id: 'two', file: 'sticker-2.svg', span: 0.332, ratio: 944 / 192 },
  { id: 'three', file: 'sticker-3.svg', span: 0.2, ratio: 419 / 230 },
  { id: 'four', file: 'sticker-4.svg', span: 0.18, ratio: 438 / 375 },
  { id: 'five', file: 'sticker-5.svg', span: 0.12, ratio: 221 / 216 },
  {
    id: 'six',
    file: 'sticker-6.svg',
    span: 0.2,
    ratio: 1,
    normal: 'ds-normal.svg',
    project: 'ds',
    label: 'Aero Aquarium',
    href: 'https://aeroaquarium.vercel.app/',
  },
  { id: 'vsign', file: 'button.svg', span: 0.075, ratio: 64 / 71, action: 'vsign', stay: true },
  {
    id: 'ig',
    file: 'button-1.svg',
    span: 0.075,
    ratio: 64 / 71,
    label: '@computer.kare.service',
    href: 'https://www.instagram.com/computer.kare.service/',
    stay: true,
  },
  {
    id: 'mail',
    file: 'button-2.svg',
    /*
     * Same 64px disc as button-1, sitting in a 72px frame that holds the drop
     * shadow. Span is scaled so the disc matches rather than the box.
     */
    span: 0.075 * (72 / 64),
    ratio: 1,
    label: 'kareservic3@gmail.com',
    href: 'mailto:kareservic3@gmail.com',
    stay: true,
  },
];

/** Keep the scatter off the edges so nothing lands half out of the window. */
const MARGIN = 0.12;

/*
 * The column the avatar stands in, in fractions of the sticker layer.
 * Scattering is rejection-sampled against it, and against her face separately:
 * a sticker over her arm is scatter, one over her face is in the way.
 *
 * Her head is where the camera puts it, not where anything here declares it —
 * GroundAndFit frames the whole body with 1.35 of padding and centres it, so
 * she runs from about 0.13 to 0.87 down the stage and the head takes the top
 * eighth of that. These are that, rounded out a little.
 */
const KEEP_CLEAR = { left: 0.34, right: 0.66, top: 0.1, bottom: 0.9 };
const FACE_CLEAR = { left: 0.38, right: 0.62, top: 0.08, bottom: 0.3 };
/*
 * How much heavier a square of face counts than a square of body. The face is
 * a fifth of the column's area, so it takes a multiplier this large before
 * clearing it outranks trimming a bigger overlap off her body.
 */
const FACE_WEIGHT = 12;
const PLACEMENT_TRIES = 48;

type Zone = typeof KEEP_CLEAR;

/** Area the sticker's box shares with a zone; 0 when they are disjoint. */
function overlap(zone: Zone, x: number, y: number, halfW: number, halfH: number) {
  const w = Math.min(zone.right, x + halfW) - Math.max(zone.left, x - halfW);
  const h = Math.min(zone.bottom, y + halfH) - Math.max(zone.top, y - halfH);
  return Math.max(0, w) * Math.max(0, h);
}
const MAX_TILT = 14;

/** The reference clamps its card to 15 degrees; keep that. */
const MAX_TILT_ANGLE = 15;
/** Degrees of hand movement to reach full tilt. */
const GYRO_GAIN = 0.6;
/** The same thing the other way round: hand degrees that reach the clamp. */
const GYRO_SPAN = MAX_TILT_ANGLE / GYRO_GAIN;
/** How far a sticker leans toward the cursor, as a share of its own width. */
const MAGNET = 6;
/** Pointer travel, in px, under which a press counts as a tap and not a drag. */
const CLICK_SLOP = 5;
/*
 * How long a finger has to stay down for the press to count as a click.
 * A touch screen has one gesture where a mouse has two, so the two are spread
 * over time instead: tap does what hover does, press-and-hold does what click
 * does. 450ms is about where a hold stops reading as a slow tap.
 */
const LONG_PRESS = 450;
/** Gap between a tapped sticker and the label naming it, in px. */
const HINT_GAP = 10;
/*
 * The label is the cursor while it is up, so it centres on the pointer rather
 * than hanging off it — which also means there is nothing to flip or clamp at
 * the edges of the window.
 */
/*
 * Where a swept sticker comes to rest, as a fraction of the frame: 0 and 1 are
 * its edges, so a sticker sent there straddles the margin with half of itself
 * outside the canvas. Pushing it clear off screen read as losing them.
 */
const SWEEP_EDGE = 0;

/*
 * Where the highlight sits when nothing is tipping the sticker, and how far it
 * travels from there, both in percent of the sticker's box.
 *
 * Top-right because that is where the 3D scene is lit from: LOOK.shadeAngle 44
 * and shadeHeight 30 give lib/twoTone.ts a uShadeDir of about (+0.60, +0.50,
 * +0.62) — positive x is screen right, positive y is up. The stickers sit in
 * the same room, so they catch the same light.
 *
 * The swing is centred on that rest point rather than on the middle of the
 * sticker, so the highlight drifts around the corner it lives in instead of
 * jumping to the centre the moment a pointer arrives.
 */
const LIGHT_REST = { x: 78, y: 16 };
const LIGHT_SWING = 30;
/*
 * How close to the edge the highlight's centre may get, in percent of the
 * sticker's box. The swing is measured from a rest point already up in the
 * corner, so a full lean took the centre clean off the artwork — 108% across
 * and -14% down — leaving only the dim tail of the disc on the sticker. With a
 * pointer that is a corner of the hover range; with a gyro it is most of the
 * tilt range, which is why the light read as not moving at all on a phone.
 */
const LIGHT_EDGE = 12;

/** Keeps the highlight's centre on the artwork rather than off its corner. */
const onSticker = (v: number) => Math.min(100 - LIGHT_EDGE, Math.max(LIGHT_EDGE, v));

/*
 * The rake of the resting light, in screen terms: up and to the right, the same
 * corner the holographic highlight rests in and the same side the 3D scene is
 * lit from. Without it a sticker at rest would have the light dead-on, and
 * dead-on light casts no relief at all.
 */
const LIGHT_BIAS = { x: 0.55, y: -0.55 };
/** How dark the turned-away side goes, and how bright the lit side comes up. */
const SHADE_DEPTH = 0.55;
const LIGHT_GAIN = 0.5;

/*
 * Per-pixel lighting off a tangent-space normal map, with no shader.
 *
 * A normal map stores N as RGB with N = 2*RGB - 1, so a dot product against a
 * light is affine in R, G and B — exactly what an feColorMatrix row computes,
 * constant term and all. Alpha passes through, so the shading stops where the
 * map does.
 *
 * Only the tangential components are used; blue is dropped. Blue is how much
 * the surface faces the viewer, and on a sticker that is nearly all of it — a
 * full N·L therefore reports "lit" across the whole face and the sheen washes
 * it out uniformly. Dropping it measures the *deviation* from flat instead, so
 * a flat area comes out exactly neutral and only the bumps shade.
 *
 * Two layers rather than one because of what blending greys does to colour.
 * `overlay` reaches its contrast by pulling the backdrop toward black and
 * white, dragging saturation with it. Multiplying by a grey scales R, G and B
 * by the same factor, which moves lightness and leaves hue and saturation
 * exactly where they were; `screen` is the same bargain at the other end.
 *
 * Screen y runs down and normal maps are authored +Y up, hence the flip.
 */
function lightVector(lx: number, ly: number) {
  const sx = lx + LIGHT_BIAS.x;
  const sy = ly + LIGHT_BIAS.y;
  const len = Math.hypot(sx, sy) || 1;
  return { x: sx / len, y: -sy / len };
}

/** 1 where flat, down to 1 - SHADE_DEPTH where the surface turns away. */
function shadeMatrix(lx: number, ly: number) {
  const { x, y } = lightVector(lx, ly);
  const d = SHADE_DEPTH;
  const row = `${2 * d * x} ${2 * d * y} 0 0 ${1 - d * (x + y)}`;
  return `${row} ${row} ${row} 0 0 0 1 0`;
}

/** 0 where flat, up to LIGHT_GAIN where the surface turns into the light. */
function sheenMatrix(lx: number, ly: number) {
  const { x, y } = lightVector(lx, ly);
  const g = LIGHT_GAIN;
  const row = `${2 * g * x} ${2 * g * y} 0 0 ${-g * (x + y)}`;
  return `${row} ${row} ${row} 0 0 0 1 0`;
}

const clamp = (v: number) => Math.min(MAX_TILT_ANGLE, Math.max(-MAX_TILT_ANGLE, v));

type Placed = { x: number; y: number; turn: number };

/*
 * The tile's outline weight, and the tile's construction with it: the stroke
 * sits on the path and the shape clips itself, so the outer half is cut and 8
 * shows as 4. Insetting the path instead — which is what this did at first —
 * keeps the whole 8 and comes out twice as heavy as the thing it is matching.
 */
const HINT_STROKE = 8;

/** Anything past half the label's height caps out; 9999 is the CSS idiom. */
const HINT_RADIUS = 9999;

/*
 * The label that replaces the cursor over a sticker that has one. Same outline
 * and the same corner as the inventory tile — the checker bed and the icon are
 * what it drops — so it reads as a piece of the same set.
 *
 * The corner has to be built in pixels: the tile gets away with an
 * objectBoundingBox path because it is square, and this is a wide, text-sized
 * box that would come out with a different radius on each axis.
 */
function StickerHint({
  label,
  hostRef,
}: {
  label: string;
  hostRef: React.RefObject<HTMLDivElement | null>;
}) {
  const host = hostRef;

  useEffect(() => {
    const el = host.current;
    if (!el) return;

    const measure = () => {
      const { width, height } = el.getBoundingClientRect();
      if (!width || !height) return;

      /*
       * Fully round: squirclePath clamps the reach to half the shorter side, so
       * any reach past that lands on the maximum and the ends come out as caps
       * however wide the text makes the box. No smoothing, unlike the tile —
       * a smoothed corner at full reach gives a superellipse tip rather than
       * the semicircle a pill needs.
       */
      const d = squirclePath(width, height, HINT_RADIUS, 0);
      el.querySelector('svg')?.setAttribute('viewBox', `0 0 ${width} ${height}`);
      // Both copies: one draws, one clips it back to itself.
      for (const path of el.querySelectorAll('path')) path.setAttribute('d', d);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [label]);

  return (
    <div className="hint" ref={host}>
      <svg className="hint__frame" aria-hidden="true" preserveAspectRatio="none">
        <defs>
          <linearGradient id="hint-bed" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--ground-top)" />
            <stop offset="1" stopColor="var(--ground-bottom)" />
          </linearGradient>
          <clipPath id="hint-clip">
            <path />
          </clipPath>
        </defs>
        <path
          fill="url(#hint-bed)"
          strokeWidth={HINT_STROKE}
          clipPath="url(#hint-clip)"
        />
      </svg>
      <span className="hint__text">{label}</span>
      <img className="hint__arrow" src={asset('/image/arrow.svg')} alt="" draggable={false} />
    </div>
  );
}

/*
 * One pass of the normal-mapped shading. Rendered twice per sticker — see
 * shadeMatrix / sheenMatrix — because the two halves need different blend
 * modes, and that is a property of the element.
 *
 * The map is referenced as a whole file rather than unpacked: Figma places it
 * at x=31 y=33 in a 391 box inside a 458 frame, and letting the SVG carry its
 * own placement keeps it in step with the artwork through any re-export.
 */
function NormalLight({
  sticker,
  mode,
  values,
}: {
  sticker: Sticker;
  mode: 'shade' | 'sheen';
  values: string;
}) {
  const id = `lit-${sticker.id}-${mode}`;
  return (
    <svg
      className={`sticker__lit sticker__lit--${mode}`}
      viewBox="0 0 458 458"
      aria-hidden="true"
    >
      <filter
        id={id}
        x="0"
        y="0"
        width="100%"
        height="100%"
        colorInterpolationFilters="sRGB"
      >
        <feColorMatrix type="matrix" values={values} />
      </filter>
      <image
        href={asset(`/image/stickers/${sticker.normal}`)}
        x="0"
        y="0"
        width="458"
        height="458"
        filter={`url(#${id})`}
      />
    </svg>
  );
}

export function Stickers({
  onVsign,
  swept = false,
  holding = 'idle',
}: {
  onVsign?: () => void;
  /** Face zoom is on: clear every sticker out of the way, except those that stay. */
  swept?: boolean;
  /** What Kare has in her hands, so its own sticker can stay. */
  holding?: 'idle' | 'ds' | 'pc' | 'phone';
}) {
  /*
   * The artwork is inlined rather than left as a background image. Three of
   * these files carry Figma inner shadows — SVG <filter> elements — and an SVG
   * referenced as an image is rasterised in its own isolated context, so those
   * filters come out soft no matter how much room they are given: the three
   * blurry ones are exactly the three with filters, and two of them are being
   * *downscaled*. Inlined, the filters render in this document and rasterise
   * with the layer.
   *
   * The masks keep using the file by URL. A mask only reads alpha, and the
   * silhouette has no filter on it.
   */
  const [markup, setMarkup] = useState<Record<string, string>>({});
  /** The hovered sticker's label, or null. Only set when it actually changes. */
  const [hint, setHint] = useState<string | null>(null);
  const hintNode = useRef<HTMLDivElement>(null);
  /*
   * Which sticker a *tap* named, or null when the label is following a mouse.
   * A mouse label is placed on every pointermove and centres on the cursor; a
   * tapped one has no cursor to centre on and a finger sitting on top of it,
   * so it is placed once, off the sticker's own box.
   */
  const hintFor = useRef<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all(
      STICKERS.map((sticker) =>
        fetch(asset(`/image/stickers/${sticker.file}`))
          .then((r) => (r.ok ? r.text() : ''))
          .then((markup) => [sticker.id, markup] as const)
          .catch(() => [sticker.id, ''] as const),
      ),
    ).then((pairs) => {
      if (live) setMarkup(Object.fromEntries(pairs.filter(([, m]) => m)));
    });
    return () => {
      live = false;
    };
  }, []);

  const layer = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, HTMLElement>());
  const placed = useRef(new Map<string, Placed>());

  const write = (id: string) => {
    const node = nodes.current.get(id);
    const at = placed.current.get(id);
    if (!node || !at) return;
    node.style.left = `${at.x * 100}%`;
    node.style.top = `${at.y * 100}%`;
    /*
     * The resting angle goes out as a custom property, not as `style.transform`.
     * An inline transform wins outright over the stylesheet's, which composes
     * the drag position, the magnet and the tilt together — writing the whole
     * thing here would silently drop everything but the rotation.
     */
    node.style.setProperty('--turn', `${at.turn}deg`);
  };

  // Scatter once. Scene mounts client-only, so there is no server render to
  // disagree with.
  useEffect(() => {
    const field = layer.current;
    const w = field?.clientWidth || window.innerWidth;
    const h = field?.clientHeight || window.innerHeight;
    const spot = () => MARGIN + Math.random() * (1 - MARGIN * 2);

    for (const sticker of STICKERS) {
      /*
       * Measured rather than derived: --size is a fraction of the viewport's
       * vmin and the layer is the stage inset from it, with a scale that
       * changes at the phone breakpoint on top. The rendered box already knows
       * all of that. Read before write(), so no rotation is in it yet — a
       * resting tilt grows the box by a few percent, which is inside the slack
       * the zones are padded with.
       */
      const box = nodes.current.get(sticker.id)?.getBoundingClientRect();
      const halfW = box ? box.width / 2 / w : 0;
      const halfH = box ? box.height / 2 / h : 0;

      /*
       * Bounded, and it keeps the least bad draw rather than the last one: a
       * phone-sized sticker can be wider than the gap beside her, so there may
       * be no placement that clears her at all — and one overlapping her
       * sleeve beats a loop that will not end, or a scatter that gives up and
       * drops the thing on her face.
       */
      let best = { x: 0.5, y: 0.5 };
      let cost = Infinity;
      for (let i = 0; i < PLACEMENT_TRIES && cost > 0; i++) {
        const x = spot();
        const y = spot();
        const c =
          overlap(KEEP_CLEAR, x, y, halfW, halfH) +
          FACE_WEIGHT * overlap(FACE_CLEAR, x, y, halfW, halfH);
        if (c < cost) {
          cost = c;
          best = { x, y };
        }
      }

      placed.current.set(sticker.id, {
        ...best,
        turn: (Math.random() * 2 - 1) * MAX_TILT,
      });
      write(sticker.id);
    }
  }, []);

  /*
   * Tilt, ported from DongGukMon/TiltHologramCard. That component reads a
   * gyroscope; the web has two inputs and they want different treatment:
   *
   *   pointer — hover gives a per-sticker angle, the card leaning toward the
   *             cursor, which is what a mouse can express and a gyro cannot.
   *   gyro    — no hover on a phone, so device orientation drives every sticker
   *             at once, off a baseline taken from the first reading rather
   *             than a guess at how the phone is being held.
   *
   * Both end up writing the same four custom properties, and the CSS in
   * globals.css does not care which one moved them.
   */
  /*
   * The stickers stay flat — no perspective, no rotateX/rotateY. The angles are
   * still what drives the light, because that is how the reference positions
   * its gradient, but they are consumed here rather than written out as a 3D
   * transform.
   */
  const tilt = (node: HTMLElement, rx: number, ry: number, pull?: { x: number; y: number }) => {
    node.style.setProperty('--rx', `${rx}deg`);
    node.style.setProperty('--ry', `${ry}deg`);
    // Only the pointer has somewhere to be pulled toward; a gyro reading does
    // not, so the sticker stays put and only tilts.
    node.style.setProperty('--mx', pull ? `${pull.x * MAGNET}%` : '0%');
    node.style.setProperty('--my', pull ? `${pull.y * MAGNET}%` : '0%');

    /*
     * Centre of the highlight, -1..1 across the sticker. The reference slides a
     * 200% band by this; here it is a disc, so the same number is its position
     * rather than an offset. The pointer knows where it is directly, and a gyro
     * reading only has angles, so that path normalises them back.
     */
    // Negated: this is a reflection, so it slides away from whatever is tipping
    // the sticker rather than pooling under it.
    const lx = pull ? -pull.x : -ry / MAX_TILT_ANGLE;
    const ly = pull ? -pull.y : rx / MAX_TILT_ANGLE;
    node.style.setProperty('--gx', `${onSticker(LIGHT_REST.x + lx * LIGHT_SWING)}%`);
    node.style.setProperty('--gy', `${onSticker(LIGHT_REST.y + ly * LIGHT_SWING)}%`);

    node
      .querySelector('.sticker__lit--shade feColorMatrix')
      ?.setAttribute('values', shadeMatrix(lx, ly));
    node
      .querySelector('.sticker__lit--sheen feColorMatrix')
      ?.setAttribute('values', sheenMatrix(lx, ly));
  };

  const rest = (node: HTMLElement) => {
    node.classList.remove('is-tilting');
    node.style.removeProperty('--rx');
    node.style.removeProperty('--ry');
    node.style.removeProperty('--mx');
    node.style.removeProperty('--my');
    node.style.setProperty('--gx', `${LIGHT_REST.x}%`);
    node.style.setProperty('--gy', `${LIGHT_REST.y}%`);

    node
      .querySelector('.sticker__lit--shade feColorMatrix')
      ?.setAttribute('values', shadeMatrix(0, 0));
    node
      .querySelector('.sticker__lit--sheen feColorMatrix')
      ?.setAttribute('values', sheenMatrix(0, 0));
  };

  /*
   * Lean a sticker toward a point on screen and slide its light away from it.
   * False when the point is outside the sticker, which is also the signal to
   * let it back to rest.
   *
   * Deliberately measured off the *drawn* box. getBoundingClientRect includes
   * the magnet's own offset, so the pull shrinks as it lands and the two settle
   * a few pixels in — a lean toward the pointer rather than a lunge at it.
   */
  const leanToward = (node: HTMLElement, x: number, y: number) => {
    const box = node.getBoundingClientRect();
    const nx = (x - (box.left + box.width / 2)) / (box.width / 2);
    const ny = (y - (box.top + box.height / 2)) / (box.height / 2);

    if (Math.abs(nx) > 1 || Math.abs(ny) > 1) {
      rest(node);
      return false;
    }
    node.classList.add('is-tilting');
    tilt(node, clamp(-ny * MAX_TILT_ANGLE), clamp(nx * MAX_TILT_ANGLE), { x: nx, y: ny });
    return true;
  };

  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      let over: string | null = null;

      for (const sticker of STICKERS) {
        const node = nodes.current.get(sticker.id);
        if (!node) continue;

        /*
         * A swept sticker is out of play: no label, no tilt, no magnet. Read
         * off the class rather than recomputed, because this listener is
         * registered once and would otherwise be holding the `swept` and
         * `holding` it saw on mount.
         */
        if (node.classList.contains('is-away')) continue;
        if (!leanToward(node, e.clientX, e.clientY)) continue;
        if (over === null) over = sticker.label ?? null;
      }

      // A mouse has taken the label over; it is no longer a tapped one.
      hintFor.current = null;

      setHint((was) => (was === over ? was : over));
      /*
       * Positioned by writing the transform, not through state: the label
       * follows every pointermove and React has nothing to reconcile — the
       * element is already there, only its offset changes.
       */
      const chip = hintNode.current;
      if (chip) {
        const { width, height } = chip.getBoundingClientRect();
        chip.style.transform = `translate3d(${e.clientX - width / 2}px, ${
          e.clientY - height / 2
        }px, 0)`;
      }
    };
    window.addEventListener('pointermove', move);
    return () => window.removeEventListener('pointermove', move);
  }, []);

  useEffect(() => {
    let base: { beta: number; gamma: number } | null = null;

    /*
     * Shortest way round. beta wraps at ±180, so a phone held near the seam
     * reads a two-degree nod as a 358-degree lurch and pins the tilt.
     */
    const swing = (now: number, from: number) => {
      const d = (now - from) % 360;
      if (d > 180) return d - 360;
      if (d < -180) return d + 360;
      return d;
    };

    const turn = (e: DeviceOrientationEvent) => {
      if (e.beta === null || e.gamma === null) return;
      if (!base) base = { beta: e.beta, gamma: e.gamma };

      const db = swing(e.beta, base.beta);
      const dg = swing(e.gamma, base.gamma);

      /*
       * The baseline is dragged along by however far the reading has gone past
       * the point where the tilt clamps. Its first value is whatever angle the
       * phone happened to be at when the page loaded — flat on a desk, say —
       * and a hand that then settles somewhere else is permanently outside the
       * range: the tilt sticks at 15 degrees and the highlight sits parked off
       * the artwork's corner, which is exactly "only the tilt moves and the
       * light never shows". Inside the range the baseline does not move, so a
       * phone held normally still has a stable rest orientation.
       */
      base.beta += db - Math.min(GYRO_SPAN, Math.max(-GYRO_SPAN, db));
      base.gamma += dg - Math.min(GYRO_SPAN, Math.max(-GYRO_SPAN, dg));

      const rx = clamp(db * GYRO_GAIN);
      const ry = clamp(dg * GYRO_GAIN);
      for (const [id, node] of nodes.current) {
        /*
         * A tapped sticker is leaning toward the finger and a swept one is on
         * its way off screen; the gyro drives everything else.
         */
        if (id === hintFor.current || node.classList.contains('is-away')) continue;
        node.classList.add('is-tilting');
        tilt(node, rx, ry);
      }
    };

    /*
     * iOS hands out orientation only after an explicit grant, and only from a
     * gesture — so ask on the first touch and never again either way.
     */
    if (typeof DeviceOrientationEvent === 'undefined') return;

    const permission = (
      DeviceOrientationEvent as unknown as {
        requestPermission?: () => Promise<PermissionState>;
      }
    ).requestPermission;

    /*
     * Two names for the same reading. Chrome on Android fires the plain one;
     * some builds only ever fire the absolute one, and a browser that sends
     * both just overwrites the same four properties twice.
     */
    const start = () => {
      window.addEventListener('deviceorientation', turn);
      window.addEventListener('deviceorientationabsolute', turn as EventListener);
    };
    const stop = () => {
      window.removeEventListener('deviceorientation', turn);
      window.removeEventListener('deviceorientationabsolute', turn as EventListener);
    };

    if (typeof permission !== 'function') {
      start();
      return stop;
    }

    const ask = () => {
      window.removeEventListener('touchend', ask);
      window.removeEventListener('pointerup', ask);
      permission()
        .then((state) => {
          if (state === 'granted') start();
        })
        .catch(() => {});
    };
    // Either gesture will do; whichever lands first takes the other one down.
    window.addEventListener('touchend', ask, { once: true });
    window.addEventListener('pointerup', ask, { once: true });

    return () => {
      window.removeEventListener('touchend', ask);
      window.removeEventListener('pointerup', ask);
      stop();
    };
  }, []);

  /*
   * A tapped label is placed once, against the sticker rather than the finger —
   * centred on it would be under the hand that asked for it. Above by default,
   * below when there is no room, and re-run on every change because the chip is
   * only in the DOM while there is something to say.
   */
  useEffect(() => {
    const chip = hintNode.current;
    const node = hintFor.current ? nodes.current.get(hintFor.current) : null;
    if (!chip || !node) return;

    const box = node.getBoundingClientRect();
    const { width, height } = chip.getBoundingClientRect();
    const above = box.top - HINT_GAP - height;
    const top = above < HINT_GAP ? box.bottom + HINT_GAP : above;
    chip.style.transform = `translate3d(${box.left + box.width / 2 - width / 2}px, ${top}px, 0)`;
  }, [hint]);

  /*
   * A tap elsewhere puts the label away — on a mouse that is what leaving the
   * sticker does, and a finger has no leaving.
   */
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' || !hintFor.current) return;
      const node = nodes.current.get(hintFor.current);
      if (node && e.target instanceof Node && node.contains(e.target)) return;
      if (node) rest(node);
      hintFor.current = null;
      setHint(null);
    };
    window.addEventListener('pointerdown', away);
    return () => window.removeEventListener('pointerdown', away);
  }, []);

  /*
   * Swept aside, each one to whichever corner it is already nearest — the way a
   * five-finger swipe throws windows off a desktop rather than fading them out
   * in place. Distances are written as calc() against the frame rather than
   * resolved to pixels, so a resize while they are out there carries them with
   * it.
   */
  useEffect(() => {
    for (const sticker of STICKERS) {
      const node = nodes.current.get(sticker.id);
      const at = placed.current.get(sticker.id);
      if (!node || !at) continue;

      // Face zoom clears everything that does not stay; a held tool clears
      // everything but its own.
      const away =
        (swept && !sticker.stay) || (holding !== 'idle' && sticker.project !== holding);
      node.classList.toggle('is-away', away);

      if (!away) {
        node.style.removeProperty('--sx');
        node.style.removeProperty('--sy');
        continue;
      }

      // Tilt state has to go with it, or the transition it suppresses never runs.
      rest(node);
      const toX = (at.x < 0.5 ? SWEEP_EDGE : 1 - SWEEP_EDGE) - at.x;
      const toY = (at.y < 0.5 ? SWEEP_EDGE : 1 - SWEEP_EDGE) - at.y;
      node.style.setProperty('--sx', `calc(${toX} * (100vw - 2 * var(--gutter)))`);
      node.style.setProperty('--sy', `calc(${toY} * (100vh - 2 * var(--gutter)))`);
    }
  }, [swept, holding]);

  const grab = (sticker: Sticker) => (e: React.PointerEvent<HTMLDivElement>) => {
    const node = e.currentTarget;
    const at = placed.current.get(sticker.id);
    if (!at) return;

    // Capture so the drag survives the pointer crossing the 3D canvas, and stop
    // the event before OrbitControls reads it as a camera drag.
    node.setPointerCapture(e.pointerId);
    e.stopPropagation();
    node.classList.add('is-held');

    const startX = e.clientX;
    const startY = e.clientY;
    const from = { ...at };
    let travelled = 0;

    /*
     * Touch gets both desktop gestures out of one finger. A tap stands in for
     * hover — the same lean, the same light, the same label — and only a press
     * held past LONG_PRESS stands in for a click.
     *
     * The timer only arms it; the act itself waits for the release, because
     * window.open outside a user gesture is what a phone browser blocks. So
     * the hold says "this has taken" and lifting is what spends it.
     */
    const touch = e.pointerType !== 'mouse';
    let armed = false;
    let arming = 0;

    if (touch) {
      for (const [id, other] of nodes.current) {
        if (id !== sticker.id) rest(other);
      }
      hintFor.current = sticker.id;
      leanToward(node, e.clientX, e.clientY);
      setHint(sticker.label ?? null);

      arming = window.setTimeout(() => {
        armed = true;
        arming = 0;
        node.classList.add('is-armed');
        navigator.vibrate?.(8);
      }, LONG_PRESS);
    }

    const disarm = () => {
      if (arming) window.clearTimeout(arming);
      arming = 0;
      armed = false;
      node.classList.remove('is-armed');
    };

    const drag = (move: PointerEvent) => {
      const next = placed.current.get(sticker.id);
      if (!next) return;
      travelled = Math.max(travelled, Math.hypot(move.clientX - startX, move.clientY - startY));
      /*
       * Once it is being dragged it is not being read: the hold stops counting
       * toward a click and the label goes, the same way a mouse label goes when
       * the cursor leaves.
       */
      if (touch && travelled >= CLICK_SLOP) {
        disarm();
        if (hintFor.current === sticker.id) {
          hintFor.current = null;
          setHint(null);
        }
      }
      const field = layer.current;
      const w = field?.clientWidth || window.innerWidth;
      const h = field?.clientHeight || window.innerHeight;
      next.x = Math.min(1, Math.max(0, from.x + (move.clientX - startX) / w));
      next.y = Math.min(1, Math.max(0, from.y + (move.clientY - startY) / h));
      write(sticker.id);
    };

    const drop = (end: PointerEvent) => {
      node.classList.remove('is-held');
      /*
       * A sticker is draggable first, so a press only counts as a tap if the
       * pointer barely moved — otherwise dropping one at the end of a drag
       * would fire whatever it does.
       */
      const tapped = end.type === 'pointerup' && travelled < CLICK_SLOP;
      // On touch the tap has already been spent on the hover, so only a press
      // that armed goes on to act.
      const acts = tapped && (!touch || armed);
      disarm();
      if (acts && sticker.action === 'vsign') onVsign?.();
      if (acts && sticker.href) {
        /*
         * mailto: through window.open(_blank) leaves an empty tab behind the
         * mail client. Assigning it on this window is what the protocol is
         * for — the page stays put, the composer opens.
         */
        if (sticker.href.startsWith('mailto:')) window.location.assign(sticker.href);
        else window.open(sticker.href, '_blank', 'noopener');
      }
      node.removeEventListener('pointermove', drag);
      node.removeEventListener('pointerup', drop);
      node.removeEventListener('pointercancel', drop);
    };

    node.addEventListener('pointermove', drag);
    node.addEventListener('pointerup', drop);
    node.addEventListener('pointercancel', drop);
  };

  return (
    <div className="stickers" ref={layer} aria-hidden="true">
      {STICKERS.map((sticker, i) => {
        const art = `url("${asset(`/image/stickers/${sticker.file}`)}")`;
        return (
          <div
            key={sticker.id}
            className="sticker"
            ref={(node) => {
              if (node) nodes.current.set(sticker.id, node);
              else nodes.current.delete(sticker.id);
            }}
            onPointerDown={grab(sticker)}
            style={
              {
                '--art': art,
                '--span': sticker.span,
                // Staggered, so they leave as a handful rather than in lockstep.
                '--sweep-delay': `${i * 55}ms`,
                aspectRatio: String(sticker.ratio),
              } as React.CSSProperties
            }
          >
            <div
              className="sticker__art"
              dangerouslySetInnerHTML={
                markup[sticker.id] ? { __html: markup[sticker.id] } : undefined
              }
            />
            {sticker.normal && (
              <>
                <NormalLight sticker={sticker} mode="shade" values={shadeMatrix(0, 0)} />
                <NormalLight sticker={sticker} mode="sheen" values={sheenMatrix(0, 0)} />
              </>
            )}
            <div className="sticker__holo" />
            <div className="sticker__glare" />
          </div>
        );
      })}

      {hint && createPortal(<StickerHint label={hint} hostRef={hintNode} />, document.body)}
    </div>
  );
}
