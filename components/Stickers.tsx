'use client';

import { useEffect, useRef } from 'react';

import { asset } from '@/lib/asset';

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
  /** Long side, as a fraction of the smaller viewport axis. */
  span: number;
  ratio: number;
};

const STICKERS: Sticker[] = [
  { id: 'one', file: 'sticker-1.svg', span: 0.2, ratio: 419 / 230 },
  { id: 'two', file: 'sticker-2.svg', span: 0.26, ratio: 739 / 150 },
  { id: 'three', file: 'sticker-3.svg', span: 0.12, ratio: 221 / 216 },
  { id: 'four', file: 'sticker-4.svg', span: 0.18, ratio: 438 / 375 },
];

/** Keep the scatter off the edges so nothing lands half out of the window. */
const MARGIN = 0.12;
const MAX_TILT = 14;

/** The reference clamps its card to 15 degrees; keep that. */
const MAX_TILT_ANGLE = 15;
/** Degrees of hand movement to reach full tilt. */
const GYRO_GAIN = 0.6;
/** How far a sticker leans toward the cursor, as a share of its own width. */
const MAGNET = 6;

const clamp = (v: number) => Math.min(MAX_TILT_ANGLE, Math.max(-MAX_TILT_ANGLE, v));

type Placed = { x: number; y: number; turn: number };

export function Stickers() {
  const layer = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, HTMLElement>());
  const placed = useRef(new Map<string, Placed>());

  const write = (id: string) => {
    const node = nodes.current.get(id);
    const at = placed.current.get(id);
    if (!node || !at) return;
    node.style.left = `${at.x * 100}%`;
    node.style.top = `${at.y * 100}%`;
    node.style.transform = `translate(-50%, -50%) rotate(${at.turn}deg)`;
  };

  // Scatter once. Scene mounts client-only, so there is no server render to
  // disagree with.
  useEffect(() => {
    for (const sticker of STICKERS) {
      placed.current.set(sticker.id, {
        x: MARGIN + Math.random() * (1 - MARGIN * 2),
        y: MARGIN + Math.random() * (1 - MARGIN * 2),
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
  const tilt = (node: HTMLElement, rx: number, ry: number, pull?: { x: number; y: number }) => {
    node.style.setProperty('--rx', `${rx}deg`);
    node.style.setProperty('--ry', `${ry}deg`);
    // Only the pointer has somewhere to be pulled toward; a gyro reading does
    // not, so the sticker stays put and only tilts.
    node.style.setProperty('--mx', pull ? `${pull.x * MAGNET}%` : '0%');
    node.style.setProperty('--my', pull ? `${pull.y * MAGNET}%` : '0%');
    /*
     * Where the gradient sits, as the reference computes it: the ramp spans
     * twice the card and its origin slides half a card across the tilt range,
     * which in CSS is a 200% background travelling 0% -> 100%.
     */
    node.style.setProperty('--gx', `${(0.5 + 0.5 * (ry / MAX_TILT_ANGLE)) * 100}%`);
    node.style.setProperty('--gy', `${(0.5 + 0.5 * (rx / MAX_TILT_ANGLE)) * 100}%`);
  };

  const rest = (node: HTMLElement) => {
    node.classList.remove('is-tilting');
    node.style.removeProperty('--rx');
    node.style.removeProperty('--ry');
    node.style.removeProperty('--mx');
    node.style.removeProperty('--my');
    node.style.removeProperty('--gx');
    node.style.removeProperty('--gy');
  };

  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      for (const node of nodes.current.values()) {
        const box = node.getBoundingClientRect();
        const nx = (e.clientX - (box.left + box.width / 2)) / (box.width / 2);
        const ny = (e.clientY - (box.top + box.height / 2)) / (box.height / 2);

        if (Math.abs(nx) > 1 || Math.abs(ny) > 1) {
          rest(node);
          continue;
        }
        node.classList.add('is-tilting');
        tilt(node, clamp(-ny * MAX_TILT_ANGLE), clamp(nx * MAX_TILT_ANGLE), { x: nx, y: ny });
      }
    };
    window.addEventListener('pointermove', move);
    return () => window.removeEventListener('pointermove', move);
  }, []);

  useEffect(() => {
    let base: { beta: number; gamma: number } | null = null;

    const turn = (e: DeviceOrientationEvent) => {
      if (e.beta === null || e.gamma === null) return;
      if (!base) base = { beta: e.beta, gamma: e.gamma };
      const rx = clamp((e.beta - base.beta) * GYRO_GAIN);
      const ry = clamp((e.gamma - base.gamma) * GYRO_GAIN);
      for (const node of nodes.current.values()) {
        node.classList.add('is-tilting');
        tilt(node, rx, ry);
      }
    };

    /*
     * iOS hands out orientation only after an explicit grant, and only from a
     * gesture — so ask on the first touch and never again either way.
     */
    const permission = (
      DeviceOrientationEvent as unknown as {
        requestPermission?: () => Promise<PermissionState>;
      }
    ).requestPermission;

    const start = () => window.addEventListener('deviceorientation', turn);

    if (typeof permission !== 'function') {
      start();
      return () => window.removeEventListener('deviceorientation', turn);
    }

    const ask = () => {
      window.removeEventListener('touchend', ask);
      permission()
        .then((state) => {
          if (state === 'granted') start();
        })
        .catch(() => {});
    };
    window.addEventListener('touchend', ask, { once: true });

    return () => {
      window.removeEventListener('touchend', ask);
      window.removeEventListener('deviceorientation', turn);
    };
  }, []);

  const grab = (id: string) => (e: React.PointerEvent<HTMLDivElement>) => {
    const node = e.currentTarget;
    const at = placed.current.get(id);
    if (!at) return;

    // Capture so the drag survives the pointer crossing the 3D canvas, and stop
    // the event before OrbitControls reads it as a camera drag.
    node.setPointerCapture(e.pointerId);
    e.stopPropagation();
    node.classList.add('is-held');

    const startX = e.clientX;
    const startY = e.clientY;
    const from = { ...at };

    const drag = (move: PointerEvent) => {
      const next = placed.current.get(id);
      if (!next) return;
      next.x = Math.min(1, Math.max(0, from.x + (move.clientX - startX) / window.innerWidth));
      next.y = Math.min(1, Math.max(0, from.y + (move.clientY - startY) / window.innerHeight));
      write(id);
    };

    const drop = () => {
      node.classList.remove('is-held');
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
      {STICKERS.map((sticker) => {
        const art = `url("${asset(`/image/stickers/${sticker.file}`)}")`;
        return (
          <div
            key={sticker.id}
            className="sticker"
            ref={(node) => {
              if (node) nodes.current.set(sticker.id, node);
              else nodes.current.delete(sticker.id);
            }}
            onPointerDown={grab(sticker.id)}
            style={
              {
                '--art': art,
                '--span': sticker.span,
                aspectRatio: String(sticker.ratio),
              } as React.CSSProperties
            }
          >
            <div className="sticker__art" />
            <div className="sticker__holo" />
            <div className="sticker__glare" />
          </div>
        );
      })}
    </div>
  );
}
