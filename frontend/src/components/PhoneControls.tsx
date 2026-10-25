import { useEffect, useState } from "react";
import { BoardTotal } from "./Figures";
import { useBoardRollup } from "../lib/rollup";
import { useBoardStore } from "../store/boardStore";
import { setThemePreference, THEME_OPTIONS, useThemePreference } from "../theme";
import { CategoryFilter } from "./Categories";
import { ColourBySelect } from "./ColourBy";
import { ViewSwitch } from "./OffBoard";
import { OwnerFilter } from "./Owners";

/** Phone header control: everything the desktop header spreads out (views,
 * filters, theme, settings) in one bottom sheet. The button shows how many
 * filters/views are in effect. */
export default function PhoneControls() {
  const [open, setOpen] = useState(false);
  const active = useBoardStore(
    (s) => s.ownerFilter.length + s.categoryFilter.length + (s.view !== "open" ? 1 : 0),
  );
  const setSettingsOpen = useBoardStore((s) => s.setSettingsOpen);
  const setFamilyOpen = useBoardStore((s) => s.setFamilyOpen);
  const setLanesOpen = useBoardStore((s) => s.setLanesOpen);
  const theme = useThemePreference();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        className={`phone-controls-button${active ? " is-active" : ""}`}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
      >
        <span aria-hidden="true">⚲</span> Filters
        {active > 0 && <span className="phone-controls-badge">{active}</span>}
      </button>
      {open && (
        <>
          <div className="sheet-backdrop" onPointerDown={() => setOpen(false)} />
          <div className="sheet" role="dialog" aria-modal="true" aria-label="Filters and views">
            <div className="sheet-grip" aria-hidden="true" />
            <div className="sheet-head">
              <h2>Filters &amp; views</h2>
              <button type="button" className="sheet-done" onClick={() => setOpen(false)}>
                Done
              </button>
            </div>

            <section className="sheet-section">
              <h3>Show</h3>
              <ViewSwitch />
            </section>

            <section className="sheet-section">
              <h3>Filter</h3>
              <div className="sheet-row">
                <OwnerFilter />
              </div>
              <div className="sheet-row">
                <CategoryFilter />
              </div>
            </section>

            <PhoneTotals onOpen={() => setOpen(false)} />

            <section className="sheet-section">
              <h3>Colour cards by</h3>
              <ColourBySelect variant="sheet" />
            </section>

            <section className="sheet-section">
              <h3>Theme</h3>
              <div className="segmented" role="group" aria-label="Theme">
                {THEME_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    aria-pressed={theme === o.value}
                    onClick={() => setThemePreference(o.value)}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </section>

            <section className="sheet-section sheet-links">
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setSettingsOpen("people");
                }}
              >
                People &amp; companies
              </button>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setSettingsOpen("categories");
                }}
              >
                Categories
              </button>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setFamilyOpen(true);
                }}
              >
                Board family
              </button>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setLanesOpen(true);
                }}
              >
                Lanes
              </button>
            </section>
          </div>
        </>
      )}
    </>
  );
}

/** The board's totals, when any task carries figures. */
function PhoneTotals({ onOpen }: { onOpen: () => void }) {
  const groups = useBoardRollup();
  if (!groups.length) return null;
  return (
    <section className="sheet-section">
      <h3>Totals</h3>
      <BoardTotal variant="sheet" onOpen={onOpen} />
    </section>
  );
}
