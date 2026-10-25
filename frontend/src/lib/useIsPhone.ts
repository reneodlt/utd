import { useSyncExternalStore } from "react";

/** Narrow, phone-style layout (portrait phones, small windows). Matches the
 * 700px breakpoint in styles.css. */
const QUERY = "(max-width: 700px)";

function subscribe(onChange: () => void) {
  const mql = window.matchMedia(QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

export function useIsPhone(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(QUERY).matches, () => false);
}
