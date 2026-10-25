import { useEffect, useRef, useState } from "react";
import { ApiError, geocode, setTaskValues } from "../api/client";
import { newOpId } from "../lib/compat";
import { coordsIn, mapLink, placeLabel, placeNameIn } from "../lib/places";
import { quote } from "../lib/undo";
import { useBoardStore } from "../store/boardStore";
import type { Category, Place, Task } from "../types";

async function savePlace(task: Task, category: Category, place: Place | null): Promise<string | null> {
  const store = useBoardStore.getState();
  const before = store.tasksById[task.id]?.locations?.[category.id] ?? null;
  const withPlace = (p: Place | null): Task => {
    const current = useBoardStore.getState().tasksById[task.id] ?? task;
    const locations = { ...current.locations };
    if (p) locations[category.id] = p;
    else delete locations[category.id];
    return { ...current, locations };
  };
  const opId = newOpId();
  store.registerOp(opId);
  store.upsertTask(withPlace(place));
  try {
    const updated = await setTaskValues(task.id, { [category.id]: place }, { op_id: opId, actor: "board-user" });
    useBoardStore.getState().upsertTask(updated);
    useBoardStore
      .getState()
      .offerUndo(`${category.name}: ${place ? placeLabel(place) : "cleared"} on ${quote(task.title)}`, async () => {
        const restored = await setTaskValues(task.id, { [category.id]: before }, { actor: "board-user" });
        useBoardStore.getState().upsertTask(restored);
      });
    return null;
  } catch (e) {
    const s = useBoardStore.getState();
    s.resolveOp(opId);
    s.upsertTask(withPlace(before));
    return (e instanceof ApiError && e.detail) || "Couldn’t save that.";
  }
}

/** A location category's place on a task: search an address, paste a maps
 * link or coordinates, or use where you are. */
export function LocationInput({ task, category }: { task: Task; category: Category }) {
  const place = task.locations?.[category.id];
  const [editing, setEditing] = useState(!place);
  const [text, setText] = useState("");
  const [results, setResults] = useState<Place[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  useEffect(() => setEditing(!place), [place]);

  // Search as you type (addresses only; links and coordinates are read directly).
  useEffect(() => {
    const t = text.trim();
    if (t.length < 3 || coordsIn(t) || /^https?:\/\//i.test(t)) {
      setResults([]);
      return;
    }
    const mine = ++seq.current;
    const timer = window.setTimeout(async () => {
      try {
        const found = await geocode(t);
        if (mine === seq.current) {
          setResults(found);
          setStatus(found.length ? null : "No places found; try adding the town.");
        }
      } catch (e) {
        if (mine === seq.current) setStatus((e instanceof ApiError && e.detail) || "Address search is unavailable.");
      }
    }, 450);
    return () => window.clearTimeout(timer);
  }, [text]);

  async function choose(p: Place) {
    setBusy(true);
    const failed = await savePlace(task, category, p);
    setBusy(false);
    setStatus(failed);
    if (!failed) {
      setText("");
      setResults([]);
    }
  }

  async function submitText() {
    const t = text.trim();
    if (!t) return;
    const coords = coordsIn(t);
    if (coords) return choose({ ...coords, label: placeNameIn(t) ?? undefined });
    const name = placeNameIn(t);
    if (name) {
      try {
        const [first] = await geocode(name);
        if (first) return choose({ ...first, label: name });
      } catch {
        /* fall through to the message */
      }
      setStatus(`Couldn’t find “${name}”.`);
      return;
    }
    if (results[0]) choose(results[0]);
  }

  function here() {
    if (!navigator.geolocation) {
      setStatus("This browser can’t share where you are.");
      return;
    }
    setStatus("Finding you…");
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        choose({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          label: `Where I was, ${new Date().toLocaleDateString()}`,
        }),
      () => setStatus("Couldn’t get your location (permission?)."),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  }

  return (
    <div className="figure-row location-row">
      <span className="figure-label">
        <span className="subtask-dot" style={{ background: category.color }} />
        {category.name}
      </span>
      {place && !editing ? (
        <span className="location-current">
          <a href={mapLink(place)} target="_blank" rel="noreferrer" title={`${placeLabel(place, true)} (open on OpenStreetMap)`}>
            📍 {placeLabel(place)}
          </a>
          <button type="button" className="link-button" onClick={() => setEditing(true)}>
            Change
          </button>
          <button type="button" className="link-button" disabled={busy} onClick={() => savePlace(task, category, null)}>
            Clear
          </button>
        </span>
      ) : (
        <div className="location-edit">
          <input
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setStatus(null);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                submitText();
              }
              if (e.key === "Escape" && place) setEditing(false);
            }}
            placeholder="Search an address, or paste a maps link"
            aria-label={`${category.name}: search or paste`}
          />
          <div className="location-tools">
            <button type="button" className="link-button" onClick={here}>
              Use where I am
            </button>
            {place && (
              <button type="button" className="link-button" onClick={() => setEditing(false)}>
                Cancel
              </button>
            )}
          </div>
          {results.length > 0 && (
            <ul className="location-results">
              {results.map((r) => (
                <li key={`${r.lat},${r.lng}`}>
                  <button type="button" disabled={busy} onClick={() => choose(r)}>
                    {r.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {status && <p className="figure-note">{status}</p>}
    </div>
  );
}
