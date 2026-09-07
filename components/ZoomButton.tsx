'use client';

/**
 * The face-zoom control: the question mark, top right.
 *
 * It used to be the inventory's empty slot and the zoom lived on a camera
 * button; both are gone, and the mark took the job. Only the glow survives of
 * its old treatment — the white stroke that used to ring it is dropped, so what
 * is left is the shape and the bloom around it.
 */

const MARK_BOWL =
  'M48.67 90.7L17.76 90.72L17.85 74.2C17.95 56.55 32.25 42.9 49.78 42.6L55.44 42.35C59.14 42.19 61.69 39.18 61.72 35.9C61.76 32.29 59.12 29.5 55.2 29.03L0 29.01V0L57.22 0.02C76.69 0.21 91.64 12.13 93.4 31.56C95.34 52.99 78.61 70.31 57.2 69.55C52.12 69.37 48.57 73.35 48.6 78.09L48.67 90.7Z';
const MARK_DOT =
  'M33.1497 137.05C43.7867 137.05 52.4096 128.427 52.4096 117.79C52.4096 107.153 43.7867 98.5303 33.1497 98.5303C22.5126 98.5303 13.8896 107.153 13.8896 117.79C13.8896 128.427 22.5126 137.05 33.1497 137.05Z';

export function ZoomButton({
  active,
  onToggle,
}: {
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="zoom"
      aria-label={active ? 'Full body' : 'Face zoom'}
      aria-pressed={active}
      onClick={onToggle}
    >
      <svg className="zoom__mark" viewBox="-18 -18 130 174" aria-hidden="true">
        <path d={MARK_BOWL} />
        <path d={MARK_DOT} />
      </svg>
    </button>
  );
}
