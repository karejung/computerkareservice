'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';

import { STAR_PINK, starSprite } from '@/lib/star';
import { SquircleCard } from './SquircleCard';

const RATIO = 0.38;
const OUTER = 0.84;

/*
 * One ring, ten stars, nose to tail: the ring turns and they chase it round.
 *
 * The step is the whole circle divided by the count, so the ring is always
 * closed — the ten of them ring the circle at every instant rather than
 * bunching into an arc with a gap behind it.
 */
const COUNT = 10;
const STEP = 360 / COUNT;

/** How small the back of the tail gets, against 1 at the head. */
const TAIL_END = 0.44;

/*
 * Seconds of the twinkle, matching `--tw` in globals.css. Held here as well
 * because the per-star offset is a share of it, and a share needs the number.
 */
const TWINKLE = 1.25;

/*
 * The ring is one tail, not ten stars in a circle: size and fade both grade
 * along it, from a big solid head down to a small star that has faded to
 * nothing, so it reads as a trail off a wand that happens to close on itself.
 *
 * Both grades run up to the last seat, because the ring turns toward increasing
 * angle and that one leads. Something has to: an evenly graded circle of
 * identical stars turning is rotationally symmetric, and looks still however
 * fast it spins.
 */
function shareAt(index: number): number {
  return COUNT < 2 ? 1 : index / (COUNT - 1);
}

/*
 * SVG stand-in so the stars are there on first paint, before the particle
 * sprite can be stamped. Same inner ratio the shaders use, shrunk so a round
 * join of STAR_ROUND (0.16 in -1..1) sits on the points without clipping.
 */
const STAR_POINTS = Array.from({ length: 10 }, (_, i) => {
  const r = i % 2 === 0 ? OUTER : OUTER * RATIO;
  const a = (i * Math.PI) / 5 - Math.PI / 2;
  return `${(Math.cos(a) * r).toFixed(4)},${(Math.sin(a) * r).toFixed(4)}`;
}).join(' ');

function PinkStar({ src }: { src: string | null }) {
  if (src) {
    return <img className="loader__star-art" src={src} alt="" draggable={false} />;
  }
  return (
    <svg className="loader__star-art" viewBox="-1 -1 2 2" aria-hidden>
      <polygon
        points={STAR_POINTS}
        fill={STAR_PINK}
        stroke={STAR_PINK}
        strokeWidth={0.32}
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Loader({
  done = false,
  onFaded,
}: {
  done?: boolean;
  onFaded?: () => void;
}) {
  const [sprite, setSprite] = useState<string | null>(null);
  const faded = useRef(onFaded);
  faded.current = onFaded;

  useEffect(() => {
    setSprite(starSprite(128, RATIO));
  }, []);

  useEffect(() => {
    if (!done) return;
    const id = window.setTimeout(() => faded.current?.(), 320);
    return () => window.clearTimeout(id);
  }, [done]);

  return (
    <div
      className={`loader${done ? ' is-done' : ''}`}
      role="status"
      aria-live="polite"
      aria-busy={!done}
      aria-label="불러오는 중"
    >
      <SquircleCard id="loader-squircle" className="loader__card">
        <div className="loader__orbit">
          {Array.from({ length: COUNT }, (_, i) => (
            <span
              key={i}
              className="loader__seat"
              style={
                {
                  '--a': `${i * STEP}deg`,
                  '--tail': TAIL_END + (1 - TAIL_END) * shareAt(i),
                  '--fade': shareAt(i),
                  '--tw-delay': `${(-(i / COUNT) * TWINKLE).toFixed(3)}s`,
                } as CSSProperties
              }
            >
              <PinkStar src={sprite} />
            </span>
          ))}
        </div>
      </SquircleCard>
    </div>
  );
}
