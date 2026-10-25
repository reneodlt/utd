/** Spread onto a control inside a card (chip, button, picker trigger) so
 * pressing it doesn't start a drag (mouse or touch sensor), open the
 * card's details, or (Enter/Space) start a keyboard drag. */
const stop = (e: { stopPropagation(): void }) => e.stopPropagation();

export const keepToControl = {
  onPointerDown: stop,
  onMouseDown: stop,
  onTouchStart: stop,
  onKeyDown: stop,
};
