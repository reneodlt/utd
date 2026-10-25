/** Places for location categories: read coordinates out of whatever was
 * pasted (a Google / Apple / OpenStreetMap link, or "51.50, -0.12"), and
 * link back out to a map. */

import type { Place } from "../types";

const NUM = String.raw`(-?\d{1,3}(?:\.\d+)?)`;

function valid(lat: number, lng: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

/** Coordinates in the text, if any. */
export function coordsIn(text: string): { lat: number; lng: number } | null {
  const t = decodeURIComponent(text.trim());
  const patterns = [
    new RegExp(String.raw`!3d${NUM}!4d${NUM}`), // Google place data (most precise)
    new RegExp(String.raw`@${NUM},${NUM}`), // Google "@lat,lng,zoom"
    new RegExp(String.raw`[?&](?:q|ll|query|daddr|center)=${NUM},\s*${NUM}`), // Google / Apple
    new RegExp(String.raw`mlat=${NUM}&mlon=${NUM}`), // OSM marker
    new RegExp(String.raw`#map=\d+/${NUM}/${NUM}`), // OSM view
    new RegExp(String.raw`^${NUM}\s*,\s*${NUM}$`), // plain "lat, lng"
  ];
  for (const p of patterns) {
    const m = p.exec(t);
    if (m) {
      const lat = Number(m[1]);
      const lng = Number(m[2]);
      if (valid(lat, lng)) return { lat, lng };
    }
  }
  return null;
}

/** A place name in a maps link without coordinates ("…/place/Tate+Modern/"
 * or "?q=Tate Modern"), to search for. */
export function placeNameIn(text: string): string | null {
  try {
    const url = new URL(text.trim());
    const place = /\/place\/([^/]+)/.exec(url.pathname);
    if (place) return decodeURIComponent(place[1].replace(/\+/g, " "));
    const q = url.searchParams.get("q") ?? url.searchParams.get("query") ?? url.searchParams.get("address");
    return q ? q.trim() : null;
  } catch {
    return null;
  }
}

/** Its name, or coordinates; `full` keeps a long search result whole
 * (otherwise just its first two parts: "Tate Modern, Bankside"). */
export function placeLabel(p: Place, full = false): string {
  if (!p.label) return `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
  return full ? p.label : p.label.split(",").slice(0, 2).join(",").trim();
}

/** Open it on OpenStreetMap. */
export function mapLink(p: Place): string {
  return `https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lng}#map=17/${p.lat}/${p.lng}`;
}

/** Directions from here, in the phone's maps app where there is one. */
export function directionsLink(p: Place): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`;
}
