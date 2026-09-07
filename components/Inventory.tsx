'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';

import { asset } from '@/lib/asset';
import { CORNER_REACH_RATIO, squirclePath } from '@/lib/squircle';
import type { PropKind } from '@/lib/twoTone';

const SQUIRCLE = squirclePath(128, 128, 128 * CORNER_REACH_RATIO);
const SQUIRCLE_UNIT = squirclePath(1, 1, CORNER_REACH_RATIO);
const CLIP_ID = 'inventory-squircle';

/*
 * The empty-hands mark, inlined rather than loaded as an image so it can take
 * the question mark's colour and glow — fill and filter do nothing to an <img>.
 * The file's clipPath was a full-bounds rect, i.e. a no-op, and is dropped.
 */
const TOOL_BODY =
  'M29.3965 27.7501L31.0528 27.8282C31.5684 27.8438 32.0997 28.1876 32.3809 28.7032L35.209 33.9063C35.4747 34.4063 35.5372 34.7813 35.2403 35.0782L33.4122 36.9063C33.0997 37.2188 32.7247 37.1407 32.2559 36.9063L27.0215 34.0469C26.4903 33.7813 26.1622 33.2344 26.1465 32.7501L26.0684 31.0938L19.0754 24.1008C19.9318 23.0153 20.94 21.8241 22.142 20.5095L29.3965 27.7501ZM10.3653 3.32817L19.6872 12.6633C19.7784 12.9255 19.886 13.1835 20.0059 13.4376C16.1186 17.2723 13.1519 19.598 10.784 21.1818L1.64653 12.0313C-0.540968 9.8438 -0.540968 7.50005 1.59966 5.35942L3.67778 3.2813C5.81841 1.14067 8.16216 1.14067 10.3653 3.32817Z';
const TOOL_HANDLE =
  'M2.44343 35.5464C5.16218 38.2339 8.8028 38.2652 11.4747 35.5777C14.834 32.1871 14.3028 28.3746 24.5528 17.9683C27.8965 19.5464 31.9434 19.0152 34.6309 16.3433C37.4434 13.5308 37.9278 9.09336 35.834 5.49961L31.584 9.74961C31.1622 10.1714 30.6309 10.2027 30.1778 9.74961L28.2715 7.82773C27.8184 7.35898 27.7715 6.81211 28.1934 6.39023L32.459 2.15586C28.8965 0.0777322 24.4747 0.546482 21.6622 3.37461C18.9747 6.06211 18.4278 10.0933 20.0059 13.4371C9.6153 23.6871 5.8028 23.1558 2.41218 26.4996C-0.290949 29.1714 -0.259699 32.8277 2.44343 35.5464ZM23.3497 14.6402C20.5684 11.8589 20.459 7.45273 23.1153 4.82773C24.6153 3.31211 26.7559 2.70273 28.8028 3.03086L26.5372 5.29648C25.3809 6.43711 25.4122 7.90586 26.6153 9.07773L28.9278 11.3746C30.084 12.5308 31.5684 12.5621 32.6622 11.4527L34.959 9.14023C35.3028 11.2183 34.6778 13.3589 33.1622 14.8902C30.5215 17.5308 26.1465 17.4058 23.3497 14.6402ZM3.9903 33.9996C2.19343 32.1714 2.22468 29.8433 3.94343 28.1089C7.72468 24.3589 9.97468 25.9527 21.0528 15.1246C21.3028 15.4683 21.584 15.7808 21.8809 16.0933C22.1778 16.3902 22.5059 16.6871 22.8497 16.9371C12.0372 28.0152 13.6309 30.2652 9.88093 34.0152C8.14655 35.7652 5.8028 35.7808 3.9903 33.9996ZM6.89655 33.0621C7.95905 33.0621 8.83405 32.1871 8.83405 31.1246C8.83405 30.0621 7.95905 29.2027 6.89655 29.2027C5.83405 29.2027 4.97468 30.0621 4.97468 31.1246C4.97468 32.1871 5.83405 33.0621 6.89655 33.0621Z';

/*
 * Baked by app/thumbs out of components/PropRender, which is where the props
 * are actually shaded. Flat images rather than a live canvas: the tile shows
 * one item at a time and nothing about it moves except a float that CSS can do.
 */
const THUMBS: Record<PropKind, string> = {
  ds: 'ds.png',
  pc: 'laptop.png',
  phone: 'phone.png',
};

/*
 * The prop picker: two arrows at the edges of the frame, and a tile in the
 * corner showing what they landed on. The carousel that used to sit between
 * them is gone — the arrows step the selection directly, and the tile is a
 * readout of it. Empty-handed shows an empty tile rather than a placeholder.
 */

type SlotKind = PropKind | 'unknown';

const SLOTS: SlotKind[] = ['unknown', 'ds', 'pc', 'phone'];
const FIRST_SLOT = 0;
const EMPTY_SLOT = SLOTS.indexOf('unknown');

export type InventoryProps = {
  onSelect: (kind: SlotKind) => void;
  onArrow: (by: number) => void;
  onSettled?: () => void;
  busy?: boolean;
  /** Face zoom is on: the picker is beside the point, so it goes quiet. */
  dimmed?: boolean;
};

export type InventoryHandle = {
  step: (by: number) => void;
  toEmpty: () => void;
};

export const Inventory = forwardRef<InventoryHandle, InventoryProps>(function Inventory(
  { onSelect, onArrow, onSettled, busy = false, dimmed = false },
  ref,
) {
  const [index, setIndex] = useState(FIRST_SLOT);

  const step = (by: number) => setIndex((i) => (i + by + SLOTS.length) % SLOTS.length);
  const toEmpty = () => setIndex(EMPTY_SLOT);

  useImperativeHandle(ref, () => ({ step, toEmpty }));

  const settled = useRef(onSettled);
  useEffect(() => {
    settled.current = onSettled;
  });

  const select = useRef(onSelect);
  useEffect(() => {
    select.current = onSelect;
  });

  /*
   * Kept even though nothing slides any more: Scene clears its `busy` flag on
   * this, and without it an arrow press would lock the controls for good.
   */
  useEffect(() => {
    select.current(SLOTS[index]);
    const raf = requestAnimationFrame(() => settled.current?.());
    return () => cancelAnimationFrame(raf);
  }, [index]);

  const held = SLOTS[index];

  return (
    <>
      <aside className={`inventory${dimmed ? ' is-dim' : ''}`} aria-label="Held item">
        <svg className="inventory__defs" aria-hidden="true">
          <defs>
            <clipPath id={CLIP_ID} clipPathUnits="objectBoundingBox">
              <path d={SQUIRCLE_UNIT} />
            </clipPath>
          </defs>
        </svg>

        <div className="inventory__ground">
          <div className="inventory__ground-art" />
        </div>
        <svg className="inventory__frame" viewBox="0 0 128 128" preserveAspectRatio="none">
          <path d={SQUIRCLE} />
        </svg>

        <div className="inventory__item">
          {held === 'unknown' ? (
            // Empty hands. A placeholder rather than a held object, so it sits
            // still while the thumbnails float.
            <svg className="inventory__empty" viewBox="0 0 38 38" aria-hidden="true">
              <path d={TOOL_BODY} />
              <path d={TOOL_HANDLE} />
            </svg>
          ) : (
            <img
              className="inventory__art"
              src={asset(`/image/thumbs/${THUMBS[held]}`)}
              alt=""
              draggable={false}
            />
          )}
        </div>
      </aside>

      <button
        type="button"
        className="pick pick--prev"
        aria-label="Previous item"
        disabled={busy || dimmed}
        onClick={() => onArrow(-1)}
      >
        <img className="pick__orb" src={asset('/image/basebutton.png')} alt="" draggable={false} />
        <img className="pick__art" src={asset('/image/arrow.svg')} alt="" draggable={false} />
      </button>

      <button
        type="button"
        className="pick pick--next"
        aria-label="Next item"
        disabled={busy || dimmed}
        onClick={() => onArrow(1)}
      >
        <img className="pick__orb" src={asset('/image/basebutton.png')} alt="" draggable={false} />
        {/* One file for both; the next arrow is the same art flipped in CSS. */}
        <img className="pick__art" src={asset('/image/arrow.svg')} alt="" draggable={false} />
      </button>
    </>
  );
});
