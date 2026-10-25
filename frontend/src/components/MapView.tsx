import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { dueLabel, dueState } from "../lib/cardColour";
import { filtersActive, passesFilters } from "../lib/filters";
import { directionsLink, placeLabel } from "../lib/places";
import { useBoardStore } from "../store/boardStore";
import type { Category, Place, Task } from "../types";
import { OwnerBadge } from "./Owners";

/** A "blocks" link between two pinned tasks: drawn as an arrow. */
interface Arrow {
  from: Pin;
  to: Pin;
}

interface Pin {
  key: string;
  task: Task;
  category: Category;
  place: Place;
  laneColor: string;
  laneName: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Every unfinished task with a place (from the board's location
 * categories) on an OpenStreetMap map, zoomed to fit them all. The board's
 * filters apply. Tap a pin for its card. */
export default function MapView() {
  const tasksById = useBoardStore((s) => s.tasksById);
  const lanes = useBoardStore((s) => s.lanes);
  const categoriesById = useBoardStore((s) => s.categoriesById);
  const ownerFilter = useBoardStore((s) => s.ownerFilter);
  const ownersById = useBoardStore((s) => s.ownersById);
  const categoryFilter = useBoardStore((s) => s.categoryFilter);
  const boxRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const arrowsRef = useRef<L.LayerGroup | null>(null);
  const fitted = useRef(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [zoom, setZoom] = useState(5);

  const { pins, unplaced } = useMemo(() => {
    const f = { ownerFilter, ownersById, categoryFilter, categoriesById };
    const filtering = filtersActive(f);
    const pins: Pin[] = [];
    let unplaced = 0;
    const locationCats = new Set(
      Object.values(categoriesById)
        .filter((c) => !c.archived && c.value_type === "location")
        .map((c) => c.id),
    );
    for (const task of Object.values(tasksById)) {
      const lane = lanes.find((l) => l.id === task.lane_id);
      if (!lane || lane.is_final) continue;
      if (filtering && !passesFilters(task, f)) continue;
      const wants = task.category_ids.filter((id) => locationCats.has(id));
      if (!wants.length) continue;
      let placed = false;
      for (const id of wants) {
        const place = task.locations?.[id];
        if (!place) continue;
        placed = true;
        pins.push({ key: `${task.id}:${id}`, task, category: categoriesById[id], place, laneColor: lane.color, laneName: lane.name });
      }
      if (!placed) unplaced += 1;
    }
    return { pins, unplaced };
  }, [tasksById, lanes, categoriesById, ownerFilter, ownersById, categoryFilter]);

  // Arrows: every blocks link whose ends are both on the map (one pin per
  // task; a task placed under two categories uses its first pin).
  const arrows = useMemo(() => {
    const byTask = new Map<string, Pin>();
    for (const p of pins) if (!byTask.has(p.task.id)) byTask.set(p.task.id, p);
    const out: Arrow[] = [];
    for (const from of byTask.values())
      for (const link of from.task.links)
        if (link.link_type === "blocks") {
          const to = byTask.get(link.to_task_id);
          if (to && to !== from) out.push({ from, to });
        }
    return out;
  }, [pins]);

  // The map itself, once.
  useEffect(() => {
    if (!boxRef.current || mapRef.current) return;
    const map = L.map(boxRef.current, { zoomControl: true, attributionControl: true }).setView([54.5, -3], 5);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    arrowsRef.current = L.layerGroup().addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    map.on("click", () => setSelected(null));
    map.on("zoomend", () => setZoom(map.getZoom()));
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(boxRef.current);
    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
      arrowsRef.current = null;
      fitted.current = false;
    };
  }, []);

  // Pins, redrawn as tasks change; fit them all the first time.
  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    const ownersById = useBoardStore.getState().ownersById;
    for (const pin of pins) {
      const due = pin.task.due_date ? dueState(pin.task.due_date) : null;
      const codes = pin.task.owner_ids
        .map((id) => ownersById[id])
        .filter((o) => o && !o.archived)
        .map((o) => `<i style="background:${esc(o.bg)};color:${esc(o.fg)}">${esc(o.emoji || o.code)}</i>`)
        .join("");
      const meta = [
        `<span class="map-pin-lane" style="--pin:${esc(pin.laneColor)}">${esc(pin.laneName)}</span>`,
        pin.task.due_date ? `<span class="map-pin-due due-${due}">${esc(dueLabel(pin.task.due_date))}</span>` : "",
        codes ? `<span class="map-pin-owners">${codes}</span>` : "",
      ].join("");
      // Three levels of detail, shown by zoom (and hover): a dot, a title,
      // a small card. CSS on .map-box picks which.
      const icon = L.divIcon({
        className: "map-pin-wrap",
        html:
          `<span class="map-pin${due === "overdue" ? " is-overdue" : ""}${pin.task.id === selected ? " is-selected" : ""}" style="--pin:${esc(pin.laneColor)}">` +
          `<span class="map-pin-dot"></span>` +
          `<span class="map-pin-card"><b>${esc(pin.task.title)}</b><span class="map-pin-meta">${meta}</span></span>` +
          `</span>`,
        iconSize: [0, 0],
      });
      L.marker([pin.place.lat, pin.place.lng], { icon, title: pin.task.title, keyboard: true, riseOnHover: true })
        .on("click", (e) => {
          L.DomEvent.stopPropagation(e);
          setSelected(pin.task.id);
        })
        .addTo(layer);
    }
    if (!fitted.current && pins.length) {
      fit(map, pins);
      fitted.current = true;
    }
  }, [pins, selected]);

  // Arrows are drawn in pixels (so the head stops at the pin's edge and
  // keeps its size), so they're redrawn whenever the view changes.
  useEffect(() => {
    const map = mapRef.current;
    const layer = arrowsRef.current;
    if (!map || !layer) return;
    const draw = () => {
      layer.clearLayers();
      for (const a of arrows) {
        const p1 = map.latLngToLayerPoint([a.from.place.lat, a.from.place.lng]);
        const p2 = map.latLngToLayerPoint([a.to.place.lat, a.to.place.lng]);
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const len = Math.hypot(dx, dy);
        if (len < 24) continue; // pins on top of each other
        const ux = dx / len;
        const uy = dy / len;
        const start = L.point(p1.x + ux * 12, p1.y + uy * 12); // leave the pin
        const end = L.point(p2.x - ux * 14, p2.y - uy * 14); // stop at the pin's edge
        const title = `${a.from.task.title} → ${a.to.task.title}`;
        L.polyline([map.layerPointToLatLng(start), map.layerPointToLatLng(end)], {
          className: "map-arrow",
          weight: 2.5,
          opacity: 0.9,
          interactive: true,
        })
          .bindTooltip(title, { sticky: true, className: "map-arrow-tip" })
          .addTo(layer);
        const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
        L.marker(map.layerPointToLatLng(end), {
          icon: L.divIcon({
            className: "map-arrowhead-wrap",
            html: `<span class="map-arrowhead" style="transform: rotate(${angle}deg)"></span>`,
            iconSize: [0, 0],
          }),
          interactive: false,
          keyboard: false,
        }).addTo(layer);
      }
    };
    draw();
    map.on("zoomend moveend", draw);
    return () => {
      map.off("zoomend moveend", draw);
    };
  }, [arrows]);

  const chosen = pins.find((p) => p.task.id === selected);

  // Esc leaves the map (after closing a pin's card), unless something else
  // (a drawer, a menu, typing) has it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const s = useBoardStore.getState();
      if (s.detailTaskId || s.menu || s.settingsOpen || s.searchOpen || s.familyOpen || s.lanesOpen) return;
      if ((e.target as HTMLElement | null)?.closest("input, textarea, select")) return;
      if (selected) setSelected(null);
      else s.setView("open");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  return (
    // The detail class goes on the wrapper: Leaflet owns the map box's
    // classes (its own clipping and touch rules live there).
    <main className={`map-view detail-${zoom < 12 ? "dots" : zoom < 15 ? "titles" : "cards"}`}>
      <div className="map-box" ref={boxRef} aria-label="Map of unfinished tasks" />
      <div className="map-bar">
        <button
          type="button"
          className="map-back"
          onClick={() => useBoardStore.getState().setView("open")}
          title="Back to the board (Esc)"
        >
          ← Board
        </button>
        <span className="map-count">
          {pins.length} unfinished task{pins.length === 1 ? "" : "s"} on the map
          {unplaced > 0 && ` · ${unplaced} without a place yet`}
        </span>
        {pins.length > 0 && (
          <button type="button" className="attach-add" onClick={() => mapRef.current && fit(mapRef.current, pins)}>
            Fit all
          </button>
        )}
      </div>
      {pins.length === 0 && (
        <p className="map-empty">
          Nothing to show yet: give unfinished tasks a place (a location category, set in the task’s details).
        </p>
      )}
      {chosen && <PinCard pin={chosen} onClose={() => setSelected(null)} />}
    </main>
  );
}

function fit(map: L.Map, pins: Pin[]) {
  if (pins.length === 1) {
    map.setView([pins[0].place.lat, pins[0].place.lng], 15);
    return;
  }
  map.fitBounds(L.latLngBounds(pins.map((p) => [p.place.lat, p.place.lng] as [number, number])), { padding: [48, 48], maxZoom: 16 });
}

function PinCard({ pin, onClose }: { pin: Pin; onClose: () => void }) {
  const openDetail = useBoardStore((s) => s.openDetail);
  const ownersById = useBoardStore((s) => s.ownersById);
  const tasksById = useBoardStore((s) => s.tasksById);
  const titleOf = (id: string) => tasksById[id]?.title ?? "a task elsewhere";
  const waitingOn = pin.task.blocked_by.map(titleOf);
  const unblocks = pin.task.links.filter((l) => l.link_type === "blocks").map((l) => titleOf(l.to_task_id));
  const owners = pin.task.owner_ids.map((id) => ownersById[id]).filter((o) => o && !o.archived);
  const due = pin.task.due_date;
  return (
    <div className="map-card" role="dialog" aria-label={pin.task.title}>
      <button type="button" className="drawer-close map-card-close" onClick={onClose} aria-label="Close">
        ×
      </button>
      <p className="map-card-lane">
        <span className="subtask-dot" style={{ background: pin.laneColor } as CSSProperties} /> {pin.laneName}
      </p>
      <h3 className="map-card-title">{pin.task.title}</h3>
      <p className="map-card-place">
        <span title={placeLabel(pin.place, true)}>📍 {placeLabel(pin.place)}</span>{" "}
        <span className="map-card-cat">· {pin.category.name}</span>
      </p>
      {(waitingOn.length > 0 || unblocks.length > 0) && (
        <p className="map-card-flow">
          {waitingOn.length > 0 && <span className="map-card-waiting">waiting on {waitingOn.join(", ")}</span>}
          {waitingOn.length > 0 && unblocks.length > 0 && " · "}
          {unblocks.length > 0 && <span>then {unblocks.join(", ")}</span>}
        </p>
      )}
      <div className="map-card-meta">
        {owners.map((o) => (
          <OwnerBadge key={o.id} owner={o} size="sm" />
        ))}
        {due && <span className={`badge badge-due due-${dueState(due)}`}>{dueLabel(due)}</span>}
      </div>
      <div className="map-card-actions">
        <a className="attach-add" href={directionsLink(pin.place)} target="_blank" rel="noreferrer">
          Directions
        </a>
        <button type="button" className="primary" onClick={() => openDetail(pin.task.id)}>
          Open task
        </button>
      </div>
    </div>
  );
}
