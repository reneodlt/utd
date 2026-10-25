import type { AttachmentPlugin } from "./types";

const MAP_URL = /^https?:\/\/(www\.)?(google\.[^/]+\/maps|maps\.google\.|maps\.app\.goo\.gl|goo\.gl\/maps|maps\.apple\.com|(www\.)?openstreetmap\.org)/i;

/** The place named in a maps link, when the link says. */
function placeFrom(url: string): string | null {
  try {
    const u = new URL(url);
    const q = u.searchParams.get("q") ?? u.searchParams.get("query") ?? u.searchParams.get("address");
    if (q) return q;
    const m = u.pathname.match(/\/maps\/(?:place|search)\/([^/@]+)/);
    return m ? decodeURIComponent(m[1].replace(/\+/g, " ")) : null;
  } catch {
    return null;
  }
}

const place: AttachmentPlugin = {
  kind: "place",
  name: "Place",
  icon: "⌖",
  fields: [
    { name: "address", label: "Address or place", input: "text", required: true, placeholder: "10 Downing St, London" },
    { name: "url", label: "Map link", input: "url", placeholder: "Optional: a pinned map link" },
  ],

  detect(text) {
    const t = text.trim();
    if (!MAP_URL.test(t)) return null;
    return { address: placeFrom(t) ?? "Pinned location", url: t };
  },

  summary: (data) => data.address,

  actions(data) {
    const q = encodeURIComponent(data.address);
    return [
      {
        label: "Map",
        href: data.url || `https://www.google.com/maps/search/?api=1&query=${q}`,
        newTab: true,
      },
      { label: "Directions", href: `https://www.google.com/maps/dir/?api=1&destination=${q}`, newTab: true },
      { label: "Apple Maps", href: `https://maps.apple.com/?q=${q}`, newTab: true },
    ];
  },

  copy: (data) => data.address,
};

export default place;
