import { useBoardStore } from "../store/boardStore";

const LABELS = {
  connecting: "connecting",
  open: "live",
  reconnecting: "reconnecting",
} as const;

export default function ConnectionBadge() {
  const status = useBoardStore((s) => s.status);
  return (
    <span className={`conn conn-${status}`} role="status" aria-live="polite">
      <span className="conn-dot" />
      {LABELS[status]}
    </span>
  );
}
