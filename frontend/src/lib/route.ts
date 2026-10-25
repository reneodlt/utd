/** Hash routing: one URL per board (#/b/<slug>), no router dependency.
 * Hash-based so it works identically under the Vite dev server and any
 * static hosting without history-fallback config. */

export function boardRefFromHash(): string | null {
  const match = window.location.hash.match(/^#\/b\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function navigateToBoard(slug: string, replace = false) {
  const hash = `#/b/${encodeURIComponent(slug)}`;
  if (window.location.hash === hash) return;
  // Already on this board with a card link: keep the card link.
  if (replace && boardRefFromHash() === slug && taskRefFromHash()) return;
  if (replace) {
    const url = new URL(window.location.href);
    url.hash = hash;
    window.history.replaceState(null, "", url);
    // replaceState doesn't emit hashchange; listeners still need to know.
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    window.location.hash = hash;
  }
}

/** "#/b/<slug>/t/<taskId>": a link straight to a card's details. */
export function taskRefFromHash(): string | null {
  const match = window.location.hash.match(/^#\/b\/[^/]+\/t\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function taskLink(boardSlug: string, taskId: string): string {
  return `#/b/${encodeURIComponent(boardSlug)}/t/${encodeURIComponent(taskId)}`;
}

/** Drop "/t/<id>" from the address (after opening it), quietly. */
export function clearTaskRef() {
  const board = boardRefFromHash();
  if (!board || !taskRefFromHash()) return;
  const url = new URL(window.location.href);
  url.hash = `#/b/${encodeURIComponent(board)}`;
  window.history.replaceState(null, "", url);
}

/** Go to a board and open one of its cards once it has loaded. */
export function navigateToTask(boardSlug: string, taskId: string) {
  window.location.hash = taskLink(boardSlug, taskId);
}

export function navigateHome() {
  if (window.location.hash === "" || window.location.hash === "#/") {
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    window.location.hash = "#/";
  }
}
