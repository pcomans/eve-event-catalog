// Pure formatting: "Xs/Xm/Xh/Xd ago" relative to `now`. Split out from the
// event feed page so it's testable without DOM/server scaffolding.
export function relativeTime(isoTimestamp: string, now: Date = new Date()): string {
  const deltaMs = now.getTime() - new Date(isoTimestamp).getTime();
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return "just now";

  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
