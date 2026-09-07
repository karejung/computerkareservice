'use client';

import { useEffect, useRef, type ReactNode } from 'react';

import { CORNER_REACH_RATIO, squirclePath } from '@/lib/squircle';

/**
 * A panel cornered to match the inventory tile.
 *
 * A `clipPathUnits="objectBoundingBox"` path — what the tile itself uses — is
 * expressed in fractions of the box, so on an oblong element the corners come
 * out stretched, at a different radius on each axis. This builds the path in
 * real pixels from the measured size instead.
 *
 * The reach is read off `--ui`, the tile's own side length. Custom properties
 * inherit, so any descendant of .scene-root can read it, and globals.css
 * registers it as a `<length>` so it computes to px rather than handing back
 * the raw clamp() text.
 */
export function SquircleCard({
  id,
  className,
  children,
}: {
  id: string;
  className: string;
  children?: ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null);
  const outline = useRef<SVGPathElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;

    let raf = 0;
    let tries = 0;

    const measure = () => {
      const { width, height } = el.getBoundingClientRect();
      const ui = parseFloat(getComputedStyle(el).getPropertyValue('--ui'));

      if (!width || !height || !(ui > 0)) {
        // --ui is a container query against an ancestor, so it can resolve a
        // frame or two after mount. Nothing changes size when it does, which
        // means the observer below would never fire — poll until it lands.
        if (tries++ < 120) raf = requestAnimationFrame(measure);
        return;
      }

      tries = 0;
      /*
       * Written straight to the attribute rather than through React state. A
       * drag resize fires this observer every frame, and a setState would land
       * the new corner a frame or more after the box it is meant to be cutting
       * — which is exactly when the lag shows.
       */
      outline.current?.setAttribute('d', squirclePath(width, height, ui * CORNER_REACH_RATIO));
      el.style.clipPath = `url(#${id})`;
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [id]);

  return (
    <div ref={host} className={className}>
      <svg className="squircle-defs" aria-hidden="true">
        <defs>
          <clipPath id={id} clipPathUnits="userSpaceOnUse">
            <path ref={outline} />
          </clipPath>
        </defs>
      </svg>
      {children}
    </div>
  );
}
