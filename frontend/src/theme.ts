import { useSyncExternalStore } from "react";

/** What the user picked ("system" follows the OS); the <html data-theme>
 * attribute always carries the resolved concrete theme. The inline script in
 * index.html applies the same resolution before first paint. */
export type ThemePreference = "system" | "light" | "dark" | "black";

export const THEME_OPTIONS: { value: ThemePreference; label: string; hint: string }[] = [
  { value: "system", label: "System", hint: "follow the OS" },
  { value: "light", label: "Light", hint: "black on white" },
  { value: "dark", label: "Dark", hint: "the original" },
  { value: "black", label: "Black", hint: "white on black" },
];

const STORAGE_KEY = "utd-theme";
const lightQuery = window.matchMedia("(prefers-color-scheme: light)");
const listeners = new Set<() => void>();

let preference = readStored();

function readStored(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "black") return stored;
  } catch {
    // storage unavailable (private mode etc.) — session-only theming
  }
  return "system";
}

/** Status/browser bar colour per theme (the header's top colour). */
const BAR_COLOURS = { light: "#e9edf4", dark: "#121b29", black: "#000000" } as const;

function apply() {
  const theme = preference === "system" ? (lightQuery.matches ? "light" : "dark") : preference;
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", BAR_COLOURS[theme]);
}

lightQuery.addEventListener("change", () => {
  if (preference === "system") apply();
});

export function setThemePreference(next: ThemePreference) {
  preference = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // non-persistent is fine
  }
  apply();
  for (const listener of listeners) listener();
}

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => preference,
  );
}
