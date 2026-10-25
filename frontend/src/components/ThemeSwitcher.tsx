import { useEffect, useRef, useState } from "react";
import { setThemePreference, THEME_OPTIONS, useThemePreference } from "../theme";

/** Header pill that opens the theme menu: system / light / dark / black. */
export default function ThemeSwitcher() {
  const preference = useThemePreference();
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      panelRef.current?.querySelector<HTMLElement>("[role=menuitemradio]")?.focus();
    }
  }, [open]);

  return (
    <div className="popover-anchor">
      <button
        type="button"
        className="theme-button"
        title={`Theme: ${preference}`}
        aria-label={`Theme: ${preference}. Change theme`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        ◐
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onPointerDown={() => setOpen(false)} />
          <div
            ref={panelRef}
            className="popover popover-right"
            role="menu"
            aria-label="Theme"
            onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
          >
            <p className="menu-label">Theme</p>
            {THEME_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={preference === option.value}
                className="menu-item"
                onClick={() => {
                  setThemePreference(option.value);
                  setOpen(false);
                }}
              >
                <span>
                  {option.label} <span className="menu-hint">{option.hint}</span>
                </span>
                {preference === option.value && <span className="menu-check">✓</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
