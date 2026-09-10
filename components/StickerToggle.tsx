'use client';

/**
 * The sticker switch: top centre, between the two controls in the upper corners.
 *
 * Flat where the rest of the controls glow. The question mark and the arrows
 * are marks lit from inside — that is the register for something you press to
 * make a thing happen. This one only says whether a layer is on, so it is drawn
 * in the inventory tile's own outline, and the only lit part is the knob once it
 * has been pushed across.
 *
 * `role="switch"` rather than a plain button: it has a state a reader needs
 * announced, and `aria-checked` is the only thing that carries it. The name is
 * on the element rather than beside it — there is no writing anywhere else in
 * the controls, and a word up here read as a caption for the scene.
 */
export function StickerToggle({
  on,
  onToggle,
}: {
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="sticker-toggle"
      role="switch"
      aria-checked={on}
      aria-label="Stickers"
      onClick={onToggle}
    >
      <span className="sticker-toggle__knob" aria-hidden="true" />
    </button>
  );
}
