'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';

import { asset } from '@/lib/asset';
import { CORNER_REACH_RATIO, squirclePath } from '@/lib/squircle';
import type { PropKind } from '@/lib/twoTone';

/*
 * The tile is square, so the unit path is safe here — it scales to the slot
 * without skewing the corners. The stage cannot use one; see components/SquircleCard.
 */
const SQUIRCLE = squirclePath(128, 128, 128 * CORNER_REACH_RATIO);
const SQUIRCLE_UNIT = squirclePath(1, 1, CORNER_REACH_RATIO);
const CLIP_ID = 'inventory-squircle';

const MARK_BOWL =
  'M48.67 90.7L17.76 90.72L17.85 74.2C17.95 56.55 32.25 42.9 49.78 42.6L55.44 42.35C59.14 42.19 61.69 39.18 61.72 35.9C61.76 32.29 59.12 29.5 55.2 29.03L0 29.01V0L57.22 0.02C76.69 0.21 91.64 12.13 93.4 31.56C95.34 52.99 78.61 70.31 57.2 69.55C52.12 69.37 48.57 73.35 48.6 78.09L48.67 90.7Z';
const MARK_DOT =
  'M33.1497 137.05C43.7867 137.05 52.4096 128.427 52.4096 117.79C52.4096 107.153 43.7867 98.5303 33.1497 98.5303C22.5126 98.5303 13.8896 107.153 13.8896 117.79C13.8896 128.427 22.5126 137.05 33.1497 137.05Z';

function UnknownMark() {
  return (
    <svg
      className="inventory__mark"
      viewBox="-18 -18 130 174"
      width="130"
      height="174"
      aria-hidden="true"
    >
      <g className="inventory__mark-edge">
        <path d={MARK_BOWL} />
        <path d={MARK_DOT} />
      </g>

      <g className="inventory__mark-body">
        <path d={MARK_BOWL} />
        <path d={MARK_DOT} />
      </g>
    </svg>
  );
}

/*
 * Baked by app/thumbs out of components/PropRender, which is where the props
 * are actually shaded. Flat images rather than a canvas apiece: three live
 * WebGL contexts to show one item at a time was the most expensive thing on
 * the page, and none of it moved except a float this does in CSS.
 */
const THUMBS: Record<PropKind, string> = {
  ds: 'ds.png',
  pc: 'laptop.png',
  phone: 'phone.png',
};

type SlotKind = PropKind | 'unknown';
type Slot = { id: string; kind: SlotKind };

const SLOTS: Slot[] = [
  { id: 'unknown', kind: 'unknown' },
  { id: 'nintendo', kind: 'ds' },
  { id: 'laptop', kind: 'pc' },
  { id: 'phone', kind: 'phone' },
];

const FIRST_SLOT = 0;
const EMPTY_SLOT = SLOTS.findIndex((s) => s.kind === 'unknown');

const HALF = Math.floor(SLOTS.length / 2);
const offsetOf = (slot: number, centre: number) =>
  ((slot - centre + HALF + SLOTS.length) % SLOTS.length) - HALF;

export type InventoryProps = {
  onSelect: (kind: SlotKind) => void;
  onArrow: (by: number) => void;
  onSettled?: () => void;
  busy?: boolean;
};

export type InventoryHandle = {
  step: (by: number) => void;
  toEmpty: () => void;
};

export const Inventory = forwardRef<InventoryHandle, InventoryProps>(function Inventory(
  { onSelect, onArrow, onSettled, busy = false },
  ref,
) {
  const [index, setIndex] = useState(FIRST_SLOT);
  const [slide, setSlide] = useState(0);

  const current = SLOTS[index];

  const step = (by: number) => {
    if (slide !== 0) return;
    setIndex((i) => (i + by + SLOTS.length) % SLOTS.length);
    setSlide(by);
  };

  const toEmpty = () => {
    const by = offsetOf(EMPTY_SLOT, index);
    if (by !== 0) step(by);
  };

  useImperativeHandle(ref, () => ({ step, toEmpty }));

  const settled = useRef(onSettled);
  useEffect(() => {
    settled.current = onSettled;
  });

  useEffect(() => {
    if (slide === 0) return;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        setSlide(0);
        settled.current?.();
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [slide]);

  const select = useRef(onSelect);
  useEffect(() => {
    select.current = onSelect;
  });
  useEffect(() => {
    select.current(current.kind);
  }, [current.kind]);

  return (
    <aside className="inventory" aria-label="Inventory">
      <svg className="inventory__defs" aria-hidden="true">
        <defs>
          <clipPath id={CLIP_ID} clipPathUnits="objectBoundingBox">
            <path d={SQUIRCLE_UNIT} />
          </clipPath>
        </defs>
      </svg>

      <div className="inventory__rail">
        <button
          type="button"
          className="inventory__arrow is-prev"
          aria-label="Previous item"
          disabled={busy}
          onClick={() => onArrow(-1)}
        >
          <img
            className="inventory__arrow-orb"
            src={asset('/image/basebutton.png')}
            alt=""
            draggable={false}
          />
          <span className="inventory__arrow-glyph">&#8249;</span>
        </button>

        <div className="inventory__viewport">
          <div className="inventory__slot" aria-hidden="true">
            <div className="inventory__ground">
              <div className="inventory__ground-art" />
            </div>
            <svg
              className="inventory__frame"
              viewBox="0 0 128 128"
              preserveAspectRatio="none"
            >
              <path d={SQUIRCLE} />
            </svg>
          </div>

          <div
            className={`inventory__track${slide === 0 ? '' : ' is-jumped'}`}
            style={{ '--slide': slide } as React.CSSProperties}
          >
            {SLOTS.map((slot, i) => {
              const offset = offsetOf(i, index);
              const centred = offset === 0;
              return (
                <div
                  key={slot.id}
                  className="inventory__cell"
                  style={{ '--d': offset } as React.CSSProperties}
                >
                  <div className={`inventory__lift${centred ? ' is-center' : ''}`}>
                    {slot.kind !== 'unknown' ? (
                      <div className="inventory__item">
                        <img
                          className="inventory__art"
                          src={asset(`/image/thumbs/${THUMBS[slot.kind]}`)}
                          alt=""
                          draggable={false}
                        />
                      </div>
                    ) : (
                      <div className="inventory__item inventory__unknown" aria-hidden>
                        <UnknownMark />
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <button
          type="button"
          className="inventory__arrow is-next"
          aria-label="Next item"
          disabled={busy}
          onClick={() => onArrow(1)}
        >
          <img
            className="inventory__arrow-orb"
            src={asset('/image/basebutton.png')}
            alt=""
            draggable={false}
          />
          <span className="inventory__arrow-glyph">&#8250;</span>
        </button>
      </div>

    </aside>
  );
});
