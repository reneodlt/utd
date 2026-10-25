/** Shared state for every audio and video element on the page: only one
 * plays at a time, and the volume you chose is remembered per browser. */

import { create } from "zustand";

const KEY = "utd.mediaVolume";

interface Prefs {
  volume: number; // 0..1
  muted: boolean;
}

function load(): Prefs {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (saved && typeof saved.volume === "number") {
      return { volume: Math.min(1, Math.max(0, saved.volume)), muted: !!saved.muted };
    }
  } catch {
    // Private mode or blocked storage: fall through to the default.
  }
  return { volume: 1, muted: false };
}

interface PlayerPrefs extends Prefs {
  set(next: Partial<Prefs>): void;
}

export const useMediaPrefs = create<PlayerPrefs>((set, get) => ({
  ...load(),
  set(next) {
    const merged = { volume: get().volume, muted: get().muted, ...next };
    if (merged.volume === get().volume && merged.muted === get().muted) return;
    set(merged);
    try {
      localStorage.setItem(KEY, JSON.stringify(merged));
    } catch {
      // Remembering is a convenience; playing still works.
    }
  },
}));

let current: HTMLMediaElement | null = null;

/** Call when an element starts playing: whatever else was playing stops. */
export function claimPlayback(el: HTMLMediaElement): void {
  if (current && current !== el) current.pause();
  current = el;
}

/** Call when an element goes away. */
export function releasePlayback(el: HTMLMediaElement): void {
  if (current === el) current = null;
}

/** 83.4 → "1:23"; unknown → "–:––". */
export function clock(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "–:––";
  const whole = Math.floor(seconds);
  const m = Math.floor(whole / 60);
  const s = String(whole % 60).padStart(2, "0");
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${s}` : `${m}:${s}`;
}
