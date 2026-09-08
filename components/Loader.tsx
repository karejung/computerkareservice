'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';

import { STAR_PINK, starSprite } from '@/lib/star';
import { SquircleCard } from './SquircleCard';

/*
 * Inner radius as a share of the outer. 0.38 is a star as it is normally drawn;
 * this one is well past that, which is what makes it read as a fat sticker star
 * rather than a spark — short points, and plenty of body between them for the
 * 0.16 rounding to work on.
 */
const RATIO = 0.56;
const OUTER = 0.84;

/*
 * One ring, ten stars, big and small about it: the ring turns and every star
 * trades size with the two beside it as it goes.
 *
 * The step is the whole circle divided by the count, so the ring is always
 * closed — the ten of them ring the circle at every instant rather than
 * bunching into an arc with a gap behind it. Even, because alternating wants a
 * count that closes: nine seats would put two of the same size side by side at
 * the seam.
 */
const COUNT = 10;
const STEP = 360 / COUNT;

/*
 * Seconds of one trade, matching `--swap` in globals.css. Held here as well
 * because the per-seat offset is half of it, and a half needs the number.
 */
const SWAP = 1.6;

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
                  /*
                   * Half a trade apart, and nothing else: the seat's place in
                   * the ring says nothing about its size, only which half of
                   * the swing it is currently in. Negative so odd seats open
                   * already small rather than waiting a beat to shrink.
                   */
                  '--swap-delay': `${i % 2 ? -SWAP / 2 : 0}s`,
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
