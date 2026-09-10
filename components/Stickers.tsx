'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { asset } from '@/lib/asset';
import { onGyro } from '@/lib/gyro';
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
   * Long side, as a fraction of --sticker-base in globals.css — deliberately
   * not tied to the SVG's own dimensions, so a sticker's size on screen is a
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
  /** Its artwork keeps moving after it is drawn; see ClockFace. */
  clock?: boolean;
  /*
   * Lands straight instead of taking a resting tilt. For anything that is read
   * rather than looked at: a clock thrown down at 20 degrees still tells the
   * time, but you have to work out which way is twelve before you can read it.
   */
  upright?: boolean;
};

const STICKERS: Sticker[] = [
  // computer / kare / service: the name of the place, in three pieces. They
  // stay for the face zoom — it is the one view with nothing else in it to say
  // whose face it is.
  { id: 'one', file: 'sticker-1.svg', span: 0.256, ratio: 590 / 230, stay: true },
  { id: 'two', file: 'sticker-2.svg', span: 0.332, ratio: 944 / 192, stay: true },
  { id: 'three', file: 'sticker-3.svg', span: 0.2, ratio: 419 / 230, stay: true },
  { id: 'four', file: 'sticker-4.svg', span: 0.18, ratio: 438 / 375 },
  { id: 'five', file: 'sticker-5.svg', span: 0.12, ratio: 221 / 216 },
  {
    id: 'six',
    file: 'sticker-6.svg',
    /*
     * Smaller than the flat 0.2 the other artwork stickers sit at. It is the
     * only square one, so the same span buys it far more area than a banner of
     * that width — at 0.2 it read as the biggest thing on the board once the
     * width ramp grew everything.
     */
    span: 0.16,
    ratio: 1,
    normal: 'ds-normal.svg',
    project: 'ds',
    label: 'Aero Aquarium',
    href: 'https://aeroaquarium.vercel.app/',
  },
  /*
   * The clock. Its file is the four pieces off the design — the pale dial, the
   * two white bars, the pink star — composed into one 418 square, because a
   * sticker is one file and the pieces are only ever drawn together. The bars
   * are laid out with the centre of their bottom cap on the dial's centre, so a
   * plain rotate about (209, 209) swings them the way a hand swings.
   */
  {
    id: 'clock',
    file: 'clock.svg',
    span: 0.15,
    ratio: 1,
    clock: true,
    upright: true,
    label: 'Seoul (GMT+9)',
  },
  { id: 'vsign', file: 'button.svg', span: 0.075, ratio: 64 / 71, action: 'vsign' },
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
     * The same box as the other two buttons, because the file is: all three are
     * 64x71 around a 64px disc. This one was declared square and a span 72/64
     * larger, to correct for a 72px frame it does not have — which left the art
     * letterboxed in a box wider than itself, and everything measured off that
     * box (the glare's gradient, both blurs) sized to the wrong circle.
     */
    span: 0.075,
    ratio: 64 / 71,
    label: 'kareservic3@gmail.com',
    href: 'mailto:kareservic3@gmail.com',
    stay: true,
  },
];

/*
 * The clock reads Seoul, wherever it is being read from — this is a shop in
 * Seoul, and the time on its wall is the shop's time, not the visitor's.
 *
 * Built once: constructing a formatter per tick is the expensive half of asking
 * what time it is.
 */
const SEOUL = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Seoul',
  hourCycle: 'h23',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** Degrees per hour, per minute and per second on a round face. */
const PER_HOUR = 30;
const PER_MINUTE = 6;
const PER_SECOND = 6;

/*
 * Where the hands pivot, in the file's own units: the centre of a 418 dial.
 * Written into a rotate() rather than set as a transform-origin, because the
 * markup is injected into a document whose stylesheet knows nothing about it.
 */
const PIVOT = 209;

/** Keep the scatter off the edges so nothing lands half out of the window. */
const MARGIN = 0.12;
/*
 * The same thing at the top, and much smaller, because the top is measured
 * differently: this one is the gap left above a sticker's own edge rather than
 * above its centre, so a banner and a button both come as close to the browser's
 * top as each other. At the blanket 0.12 the tall stickers were held a tenth of
 * the window below the ones they were meant to be scattered among, and the
 * whole board sat low. Her head is still kept clear by the zones below, which
 * is a column, not a band across the window.
 */
const MARGIN_TOP = 0.02;

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
/*
 * How much heavier a square shared with another sticker counts than one shared
 * with her body. Above the body's weight on purpose: a sticker over her sleeve
 * is the scatter doing its job, while two stickers on the same spot hide each
 * other's artwork, so when only one of the two can be avoided this is the one
 * to avoid. Still under FACE_WEIGHT — nothing is worth covering her face for.
 */
const PEER_WEIGHT = 6;
/*
 * How much of its own box a sticker may share with the ones already down before
 * it is charged anything for it.
 *
 * There was a gap demanded here instead, and between that and the search
 * keeping the single least-overlapping draw of 240, the board came out with
 * every sticker in its own clearing — tidy, and duller than a board anyone has
 * actually stuck stickers on. A real one has corners riding over each other.
 *
 * So a bite this size is free and only what is past it costs. It doubles as the
 * search's stopping condition, since a cost of zero ends the loop: the first
 * draw that overlaps no more than this is taken, rather than the whole 240
 * being spent grinding toward the emptiest spot on the layer.
 */
const PEER_FREE = 0.22;
/*
 * Draws per sticker. Higher than it was, because avoiding the others as well as
 * her is a much narrower target than avoiding her alone — the free ground is
 * two tall bands beside her, and hitting a free stretch of one by chance takes
 * more than a couple of dozen throws. It is a one-off loop over nine stickers,
 * so the cost of being thorough here is nothing.
 */
const PLACEMENT_TRIES = 240;

type Zone = typeof KEEP_CLEAR;

/** Area the sticker's box shares with a zone; 0 when they are disjoint. */
function overlap(zone: Zone, x: number, y: number, halfW: number, halfH: number) {
  const w = Math.min(zone.right, x + halfW) - Math.max(zone.left, x - halfW);
  const h = Math.min(zone.bottom, y + halfH) - Math.max(zone.top, y - halfH);
  return Math.max(0, w) * Math.max(0, h);
}
/*
 * The resting lean, in degrees off upright.
 *
 * Drawn away from zero rather than around it. A plain +-14 draw puts as many
 * stickers within a couple of degrees of straight as it does at a real angle,
 * and a board of nearly-straight stickers reads as a board someone lined up
 * badly rather than one they threw down — so there is a floor, and no sticker
 * lands upright by accident.
 *
 * TILT_BIAS shapes the magnitude inside the range: under 1 it leans the draw
 * toward the far end, so the average lean sits high in the range instead of in
 * the middle of it. Both signs stay equally likely.
 */
const TILT_MIN = 6;
const TILT_MAX = 24;
const TILT_BIAS = 0.6;

function restingTilt() {
  const sign = Math.random() < 0.5 ? -1 : 1;
  const reach = Math.pow(Math.random(), TILT_BIAS);
  return sign * (TILT_MIN + (TILT_MAX - TILT_MIN) * reach);
}

/** The reference clamps its card to 15 degrees; keep that. */
const MAX_TILT_ANGLE = 15;
/** Degrees of hand movement to reach full tilt. */
const GYRO_GAIN = 0.6;
/*
 * How much of each new orientation reading to believe, 0..1.
 *
 * A phone lying still still reports a degree or two of wander, and the light
 * disc is placed off those angles by LIGHT_SWING, so the raw signal put the
 * highlight in a slightly different place every single frame — which on a
 * layer whose brightness *is* its position reads as a flicker rather than as
 * movement. A one-pole low pass over the reading costs about six frames of lag
 * and takes the jitter down to roughly a third.
 */
const GYRO_EASE = 0.15;
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
 * The way back, in ms, and the stagger it shares with the way out.
 *
 * The return has to be marked as its own state rather than left to the base
 * transition, because of who else writes to `transform`. A gyro drives every
 * sticker on every reading and stamps `is-tilting` on each one, which drops the
 * transform transition so a lean lands the instant the hand moves — right for a
 * lean, fatal for anything else mid-flight. The trip *out* was already immune:
 * both the pointer and the gyro skip anything wearing `is-away`. Coming back,
 * that class is gone on the first frame, so on a phone the next reading — under
 * 16ms later — killed the transition and the stickers arrived home instantly.
 * So a returning sticker keeps a class of its own, and both of them skip that
 * too until it has landed.
 */
const RETURN_MS = 650;
const SWEEP_STAGGER = 55;

/*
 * The first arrival: one sticker at a time, each landing with a bounce. Longer
 * between them than the sweep's stagger, which is a handful of stickers leaving
 * together — this one is meant to be counted, so the board reads as being laid
 * out rather than switched on. The curve itself is in globals.css
 * (`sticker-pop`); the duration is here so the class can come off on time.
 */
const POP_MS = 720;
const POP_STAGGER = 85;

/*
 * And the way back out, when the switch turns the layer off. Quicker and in a
 * tighter stagger than the arrival: clearing the board is not the part worth
 * watching, and the wait before the last one goes is dead time on a control
 * whose whole job is to get them out of the way.
 */
const DROP_MS = 260;
const DROP_STAGGER = 30;

/** Out of play for the pointer and the gyro alike: in flight, either way. */
const inFlight = (node: HTMLElement) =>
  node.classList.contains('is-away') || node.classList.contains('is-settling');

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
 * Poses are quantised before they are written, and a node that already wears
 * the pose is not written to at all.
 *
 * Both matter more here than they would on a plain transform. The holo's mask
 * is a *generated image* — `radial-gradient(circle at var(--gx) var(--gy))` is
 * a different image at every position, so it is re-synthesised from scratch on
 * every write — and there is a full-size blur over it, and a blend under it.
 * So a write that moves the light by a twentieth of a pixel costs the same
 * repaint as one that moves it across the sticker, and the pointer path was
 * paying it for all eleven stickers on every mousemove: the ten the cursor is
 * nowhere near were being sent their unchanged resting pose, feColorMatrix
 * rewrite and all, at the mouse's polling rate.
 */
const ANGLE_STEP = 0.1;
const PULL_STEP = 0.002;
/* Rounded twice: to the step, then off the float dust the step leaves — these
 * land in inline styles, and `-4.800000000000001deg` is nobody's friend. */
const quantise = (v: number, step: number) =>
  Math.round(Math.round(v / step) * step * 1000) / 1000;
/** The pose each node was last written, so an identical one can be skipped. */
const poses = new WeakMap<HTMLElement, string>();
const REST_POSE = 'rest';

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
  sticker,
  hostRef,
}: {
  sticker: Sticker;
  hostRef: React.RefObject<HTMLDivElement | null>;
}) {
  const label = sticker.label ?? '';
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
      {/* The arrow is a promise that something opens. A label that only names
          what it is on — the clock saying which city it keeps — makes no such
          promise, so it goes without. */}
      {sticker.href && (
        <img className="hint__arrow" src={asset('/image/arrow.svg')} alt="" draggable={false} />
      )}
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

/*
 * The clock's face: the one sticker whose artwork keeps changing after it has
 * been drawn.
 *
 * It owns the element it writes into rather than being driven from the shared
 * node map. Through the map, finding the hands depends on two unrelated things
 * — the ref callback and the fetch that supplies the markup — having landed in
 * the right order, and on nothing rewriting the markup afterwards. Here the
 * host is this component's own ref and the hands are looked up per tick, so
 * there is no order to get wrong and nothing to go stale.
 *
 * Ticks are scheduled to the next whole second off the wall clock rather than
 * on a flat 1000ms interval: a backgrounded tab wakes with its timers coalesced
 * and would otherwise drift out of step with the seconds it is displaying.
 *
 * The hour and minute hands carry the fraction below them, so the hour hand
 * sits a third of the way past 4 at twenty past rather than jumping an hour at
 * a time.
 */
function ClockFace({ art }: { art: { __html: string } | undefined }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el || !art) return;

    let timer = 0;
    const tick = () => {
      const parts = SEOUL.formatToParts(new Date());
      const at = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
      const s = at('second');
      const m = at('minute');
      const h = at('hour') % 12;

      const turn = (name: string, deg: number) =>
        el
          .querySelector(`[data-hand="${name}"]`)
          ?.setAttribute('transform', `rotate(${deg.toFixed(3)} ${PIVOT} ${PIVOT})`);

      turn('hour', (h + m / 60) * PER_HOUR);
      turn('minute', (m + s / 60) * PER_MINUTE);
      turn('second', s * PER_SECOND);

      timer = window.setTimeout(tick, 1000 - (Date.now() % 1000));
    };

    tick();
    return () => window.clearTimeout(timer);
  }, [art]);

  return <div className="sticker__art" ref={host} dangerouslySetInnerHTML={art} />;
}

export function Stickers({
  onVsign,
  swept = false,
  holding = 'idle',
  off = false,
}: {
  onVsign?: () => void;
  /** Face zoom is on: clear every sticker out of the way, except those that stay. */
  swept?: boolean;
  /** What Kare has in her hands, so its own sticker can stay. */
  holding?: 'idle' | 'ds' | 'pc' | 'phone';
  /*
   * The switch is off: the whole layer goes, `stay` and all. Kept mounted while
   * it is, so the scatter is not re-rolled and anything dragged somewhere better
   * is still there when it comes back.
   */
  off?: boolean;
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
  /*
   * The id of the sticker the label is for, or null — the id rather than the
   * label itself, because the chip needs to know more about it than what it
   * says: whether it links anywhere, which is what earns the arrow.
   */
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

  /*
   * The markup, wrapped once each.
   *
   * React compares dangerouslySetInnerHTML by *reference*, not by the string
   * inside it, so a fresh `{ __html }` written inline in the JSX is a new prop
   * on every render and the element's innerHTML is set again — the artwork
   * reparsed and replaced with fresh nodes. For eight static stickers that is
   * only waste, paid on every hover, since what lands looks identical. For the
   * clock it was the bug: the replacement arrives at 12 o'clock and the hands
   * the tick had been moving are detached, so the first hover froze it there
   * for good.
   */
  const inner = useMemo(
    () => Object.fromEntries(Object.entries(markup).map(([id, m]) => [id, { __html: m }] as const)),
    [markup],
  );

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
    const spot = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

    /*
     * Measured rather than derived: --size is a fraction of --sticker-base,
     * which ramps with the window's width, and the layer is the stage inset
     * from that window. The rendered box already knows all of it. Read
     * before write(), so no rotation is in it yet — a resting tilt grows the box
     * by a few percent, which is inside the slack the zones are padded with.
     */
    const half = new Map<string, { halfW: number; halfH: number }>();
    for (const sticker of STICKERS) {
      const box = nodes.current.get(sticker.id)?.getBoundingClientRect();
      half.set(sticker.id, {
        halfW: box ? box.width / 2 / w : 0,
        halfH: box ? box.height / 2 / h : 0,
      });
    }

    /*
     * Biggest first. Whoever goes last is choosing from what is left, and a
     * banner-sized sticker left until then has nowhere to be — where a button
     * in the same position still has plenty of gaps to drop into.
     */
    const order = [...STICKERS].sort((a, b) => {
      const A = half.get(a.id)!;
      const B = half.get(b.id)!;
      return B.halfW * B.halfH - A.halfW * A.halfH;
    });

    /* The boxes already spoken for, as zones to charge for sharing. */
    const taken: Zone[] = [];

    for (const sticker of order) {
      const { halfW, halfH } = half.get(sticker.id)!;

      /*
       * How high this one may ride, as its own half-height clear of the top.
       * Clamped to the middle so a sticker taller than the band it is allowed
       * cannot invert the range and sample outside it.
       */
      const ceiling = Math.min(0.5, MARGIN_TOP + halfH);
      const floor = Math.max(0.5, 1 - MARGIN - halfH);

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
        const x = spot(MARGIN, 1 - MARGIN);
        const y = spot(ceiling, floor);
        let c =
          overlap(KEEP_CLEAR, x, y, halfW, halfH) +
          FACE_WEIGHT * overlap(FACE_CLEAR, x, y, halfW, halfH);
        /*
         * A sticker already down is another zone to share with, and sharing is
         * only charged past PEER_FREE. Summed over all of them first, so the
         * allowance is what this sticker may give away in total rather than a
         * fresh one against each neighbour.
         */
        let shared = 0;
        for (const zone of taken) shared += overlap(zone, x, y, halfW, halfH);
        c += PEER_WEIGHT * Math.max(0, shared - PEER_FREE * 4 * halfW * halfH);
        if (c < cost) {
          cost = c;
          best = { x, y };
        }
      }

      taken.push({
        left: best.x - halfW,
        right: best.x + halfW,
        top: best.y - halfH,
        bottom: best.y + halfH,
      });

      placed.current.set(sticker.id, {
        ...best,
        turn: sticker.upright ? 0 : restingTilt(),
      });
      write(sticker.id);
    }

    // Everything has somewhere to be now, so let them be seen. What they do on
    // the way in is the next effect's, which runs after this one and again
    // every time the switch moves.
    field?.classList.add('is-placed');
  }, []);

  /*
   * On and off. `is-entering` carries the bounce and has to come off again:
   * while it is on it holds the transform transition off, which the drag and
   * the gyro both want back once the board has settled. The last sticker starts
   * the full stagger late, so that is when the trip is over.
   *
   * `is-off` is the opposite and stays on, since being gone is a state rather
   * than a trip. Declared after the scatter so it runs after it on the mount
   * they share, which is what puts the first bounce on placed stickers.
   */
  useEffect(() => {
    const field = layer.current;
    if (!field) return;

    if (off) {
      field.classList.remove('is-entering');
      field.classList.add('is-off');
      return;
    }

    field.classList.remove('is-off');
    field.classList.add('is-entering');
    const landed = window.setTimeout(
      () => field.classList.remove('is-entering'),
      POP_MS + (STICKERS.length - 1) * POP_STAGGER,
    );
    return () => {
      window.clearTimeout(landed);
      field.classList.remove('is-entering');
    };
  }, [off]);

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
    /*
     * Quantised up front rather than at each write, so that everything below —
     * the angles, the magnet, the light and both feColorMatrix rows — is a
     * function of the same rounded pair and the pose either differs from the
     * one already on the node or is skipped whole. A tenth of a degree and a
     * five-hundredth of a half-width are both well under a pixel at the size
     * these are drawn.
     */
    const qx = quantise(rx, ANGLE_STEP);
    const qy = quantise(ry, ANGLE_STEP);
    const px = pull ? quantise(pull.x, PULL_STEP) : 0;
    const py = pull ? quantise(pull.y, PULL_STEP) : 0;

    /*
     * Centre of the highlight, -1..1 across the sticker. The reference slides a
     * 200% band by this; here it is a disc, so the same number is its position
     * rather than an offset. The pointer knows where it is directly, and a gyro
     * reading only has angles, so that path normalises them back.
     */
    // Negated: this is a reflection, so it slides away from whatever is tipping
    // the sticker rather than pooling under it.
    const lx = pull ? -px : -qy / MAX_TILT_ANGLE;
    const ly = pull ? -py : qx / MAX_TILT_ANGLE;

    const shade = shadeMatrix(lx, ly);
    const sheen = sheenMatrix(lx, ly);
    const pose = `${qx} ${qy} ${px} ${py} ${pull ? 1 : 0} ${shade}`;
    if (poses.get(node) === pose) return;
    poses.set(node, pose);

    node.style.setProperty('--rx', `${qx}deg`);
    node.style.setProperty('--ry', `${qy}deg`);
    // Only the pointer has somewhere to be pulled toward; a gyro reading does
    // not, so the sticker stays put and only tilts.
    node.style.setProperty('--mx', pull ? `${px * MAGNET}%` : '0%');
    node.style.setProperty('--my', pull ? `${py * MAGNET}%` : '0%');
    node.style.setProperty('--gx', `${onSticker(LIGHT_REST.x + lx * LIGHT_SWING)}%`);
    node.style.setProperty('--gy', `${onSticker(LIGHT_REST.y + ly * LIGHT_SWING)}%`);

    node.querySelector('.sticker__lit--shade feColorMatrix')?.setAttribute('values', shade);
    node.querySelector('.sticker__lit--sheen feColorMatrix')?.setAttribute('values', sheen);
  };

  const rest = (node: HTMLElement) => {
    if (poses.get(node) === REST_POSE) return;
    poses.set(node, REST_POSE);

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
  const leanToward = (node: HTMLElement, x: number, y: number, measured?: DOMRect) => {
    const box = measured ?? node.getBoundingClientRect();
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
    let at: { x: number; y: number } | null = null;
    let frame = 0;

    const place = () => {
      frame = 0;
      const cursor = at;
      if (!cursor) return;

      /*
       * Every measurement first, every write after.
       *
       * These used to be interleaved — measure a sticker, pose it, measure the
       * next — and a pose write dirties the layout that the next measurement
       * then has to rebuild before it can answer. Eleven stickers carrying
       * masks, blurs and blend modes meant eleven forced synchronous layouts
       * per mousemove. Split in two, it is one.
       *
       * A swept sticker is out of play: no label, no tilt, no magnet. Read off
       * the class rather than recomputed, because this listener is registered
       * once and would otherwise be holding the `swept` and `holding` it saw
       * on mount.
       */
      const measured: Array<{ sticker: Sticker; node: HTMLElement; box: DOMRect }> = [];
      for (const sticker of STICKERS) {
        const node = nodes.current.get(sticker.id);
        if (!node || inFlight(node)) continue;
        measured.push({ sticker, node, box: node.getBoundingClientRect() });
      }
      const chip = hintNode.current;
      const chipBox = chip?.getBoundingClientRect();

      let over: string | null = null;
      for (const { sticker, node, box } of measured) {
        if (!leanToward(node, cursor.x, cursor.y, box)) continue;
        if (over === null && sticker.label) over = sticker.id;
      }

      // A mouse has taken the label over; it is no longer a tapped one.
      hintFor.current = null;

      setHint((was) => (was === over ? was : over));
      /*
       * Positioned by writing the transform, not through state: the label
       * follows every pointermove and React has nothing to reconcile — the
       * element is already there, only its offset changes.
       */
      if (chip && chipBox) {
        chip.style.transform = `translate3d(${cursor.x - chipBox.width / 2}px, ${
          cursor.y - chipBox.height / 2
        }px, 0)`;
      }
    };

    /*
     * The event only records where the cursor is; the frame does the work. A
     * mouse reports faster than the screen redraws — often twice per frame, and
     * a trackpad more than that — and every one of those reports was repainting
     * the holo's generated mask and the blur over it. Coalescing to one pose
     * per frame throws away nothing anyone could have seen.
     */
    const move = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      at = { x: e.clientX, y: e.clientY };
      if (!frame) frame = requestAnimationFrame(place);
    };
    window.addEventListener('pointermove', move);
    return () => {
      window.removeEventListener('pointermove', move);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    let base: { beta: number; gamma: number } | null = null;
    let eased: { beta: number; gamma: number } | null = null;
    let angles: { rx: number; ry: number } | null = null;
    let frame = 0;

    /*
     * One pose per frame for the whole board. Orientation arrives on its own
     * clock and does not wait for the screen — a reading that lands twice
     * between two paints used to repaint every sticker twice, and the second
     * one was never shown.
     */
    const pose = () => {
      frame = 0;
      if (!angles) return;
      for (const [id, node] of nodes.current) {
        /*
         * A tapped sticker is leaning toward the finger and a swept one is on
         * its way off screen; the gyro drives everything else.
         */
        if (id === hintFor.current || inFlight(node)) continue;
        node.classList.add('is-tilting');
        tilt(node, angles.rx, angles.ry);
      }
    };

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

      /*
       * The reading, eased rather than taken. Through `swing` for the same
       * reason the baseline is: an average that runs the long way round the
       * ±180 seam would crawl across the whole range instead of settling.
       */
      if (!eased) eased = { beta: e.beta, gamma: e.gamma };
      else {
        eased.beta += swing(e.beta, eased.beta) * GYRO_EASE;
        eased.gamma += swing(e.gamma, eased.gamma) * GYRO_EASE;
      }

      if (!base) base = { beta: eased.beta, gamma: eased.gamma };

      const db = swing(eased.beta, base.beta);
      const dg = swing(eased.gamma, base.gamma);

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

      angles = { rx: clamp(db * GYRO_GAIN), ry: clamp(dg * GYRO_GAIN) };
      if (!frame) frame = requestAnimationFrame(pose);
    };

    /*
     * Subscription only. Asking for the permission is the page's job now — see
     * lib/gyro.ts — because on iOS the ask has to be riding a listener when the
     * reader's first tap lands, and this layer does not exist yet at that
     * point: Scene holds it back until the model is live.
     */
    const off = onGyro(turn);
    return () => {
      off();
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  /*
   * A tapped label is placed once, on the sticker's own centre — the same place
   * a mouse one sits, which is under the cursor. It hung above the sticker at
   * first, to stay out from under the finger that asked for it, and that put it
   * somewhere no label ever appears on a desktop and left it drifting off the
   * top of the board for anything near the edge. A finger covers part of a
   * sticker, not the middle of the air above it.
   *
   * Re-run on every change, because the chip is only in the DOM while there is
   * something to say.
   */
  useEffect(() => {
    const chip = hintNode.current;
    const node = hintFor.current ? nodes.current.get(hintFor.current) : null;
    if (!chip || !node) return;

    const box = node.getBoundingClientRect();
    const { width, height } = chip.getBoundingClientRect();
    chip.style.transform = `translate3d(${box.left + box.width / 2 - width / 2}px, ${
      box.top + box.height / 2 - height / 2
    }px, 0)`;
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
    const landing: { node: HTMLElement; timer: number }[] = [];

    STICKERS.forEach((sticker, i) => {
      const node = nodes.current.get(sticker.id);
      const at = placed.current.get(sticker.id);
      if (!node || !at) return;

      // Face zoom clears everything that does not stay; a held tool clears
      // everything but its own.
      const away =
        (swept && !sticker.stay) || (holding !== 'idle' && sticker.project !== holding);
      const returning = !away && node.classList.contains('is-away');
      node.classList.toggle('is-away', away);

      if (!away) {
        if (returning) {
          // Same two chores as the way out, for the same reason: the tilt has
          // to go, and the trip needs a state that outlives this frame.
          rest(node);
          node.classList.add('is-settling');
          landing.push({
            node,
            timer: window.setTimeout(
              () => node.classList.remove('is-settling'),
              RETURN_MS + i * SWEEP_STAGGER,
            ),
          });
        }
        node.style.removeProperty('--sx');
        node.style.removeProperty('--sy');
        return;
      }

      // Tilt state has to go with it, or the transition it suppresses never runs.
      rest(node);
      const toX = (at.x < 0.5 ? SWEEP_EDGE : 1 - SWEEP_EDGE) - at.x;
      const toY = (at.y < 0.5 ? SWEEP_EDGE : 1 - SWEEP_EDGE) - at.y;
      node.style.setProperty('--sx', `calc(${toX} * (100vw - 2 * var(--gutter)))`);
      // --app-h, not 100vh: on iOS vh is the URL-bar-hidden height, which is the
      // one measurement the rest of the layout has stopped trusting.
      node.style.setProperty('--sy', `calc(${toY} * (var(--app-h, 100dvh) - 2 * var(--gutter)))`);
    });

    /*
     * A sweep that arrives mid-return takes the trip over: the class would
     * otherwise sit there past its timer and keep the sticker out of the
     * pointer's reach for good.
     */
    return () => {
      for (const { node, timer } of landing) {
        window.clearTimeout(timer);
        node.classList.remove('is-settling');
      }
    };
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
      setHint(sticker.label ? sticker.id : null);

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

  const named = hint ? STICKERS.find((sticker) => sticker.id === hint) : undefined;

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
                '--sweep-delay': `${i * SWEEP_STAGGER}ms`,
                // Its turn in the queue, in and out. Source order, which puts
                // the three pieces of the name down first and the buttons last.
                '--pop-delay': `${i * POP_STAGGER}ms`,
                '--pop-ms': `${POP_MS}ms`,
                '--drop-delay': `${i * DROP_STAGGER}ms`,
                '--drop-ms': `${DROP_MS}ms`,
                aspectRatio: String(sticker.ratio),
              } as React.CSSProperties
            }
          >
            {sticker.clock ? (
              <ClockFace art={inner[sticker.id]} />
            ) : (
              <div className="sticker__art" dangerouslySetInnerHTML={inner[sticker.id]} />
            )}
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

      {named && createPortal(<StickerHint sticker={named} hostRef={hintNode} />, document.body)}
    </div>
  );
}
