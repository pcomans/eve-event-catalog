export type CrossingDirection = "below" | "above";

/**
 * Edge-triggered threshold crossing, shared by price.crossesBelow and
 * price.crossesAbove. Fires only when `previous` was still on the
 * threshold's at-or-beyond side and `current` has moved strictly past it —
 * a tick that starts already past the threshold (e.g. the seeded value) is
 * not itself a crossing.
 */
export function crosses(
  direction: CrossingDirection,
  previous: number,
  current: number,
  threshold: number,
): boolean {
  return direction === "below"
    ? previous >= threshold && current < threshold
    : previous <= threshold && current > threshold;
}
