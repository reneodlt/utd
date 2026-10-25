import type { TargetAndTransition } from "motion/react";

/** Named flash animations external systems can request via meta.animation.
 * "slide" is intentionally empty: plain moves are handled by Motion's
 * layout animation, so it needs no flash overlay. The board's
 * animation_catalogue.enabled list (server-side) is the source of truth
 * for what's allowed; unknown names degrade to a plain slide. */
export const CATALOGUE: Record<string, TargetAndTransition> = {
  slide: {},
  pulse: {
    scale: [1, 1.07, 1],
    transition: { duration: 0.5, ease: "easeOut" },
  },
  celebrate: {
    scale: [1, 1.12, 0.97, 1],
    rotate: [0, -2, 2, 0],
    boxShadow: [
      "0 0 0 0px rgba(250, 204, 21, 0)",
      "0 0 0 5px rgba(250, 204, 21, 0.55)",
      "0 0 22px 10px rgba(250, 204, 21, 0.25)",
      "0 0 0 0px rgba(250, 204, 21, 0)",
    ],
    transition: { duration: 0.9, ease: "easeInOut" },
  },
  alarm: {
    x: [0, -7, 7, -5, 5, 0],
    boxShadow: [
      "0 0 0 0px rgba(239, 68, 68, 0)",
      "0 0 0 4px rgba(239, 68, 68, 0.6)",
      "0 0 0 4px rgba(239, 68, 68, 0.6)",
      "0 0 0 3px rgba(239, 68, 68, 0.4)",
      "0 0 0 2px rgba(239, 68, 68, 0.25)",
      "0 0 0 0px rgba(239, 68, 68, 0)",
    ],
    transition: { duration: 0.7, ease: "easeInOut" },
  },
};

/** True when the name maps to a real flash (not just a layout slide). */
export function isFlashAnimation(name: string): boolean {
  return name in CATALOGUE && Object.keys(CATALOGUE[name]).length > 0;
}

export const CARD_REST: TargetAndTransition = {
  opacity: 1,
  scale: 1,
  x: 0,
  rotate: 0,
};
