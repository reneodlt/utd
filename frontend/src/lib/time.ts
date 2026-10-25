/** Compact human duration: 42s, 7m, 3h, 5d. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, seconds);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function secondsSince(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 1000;
}
