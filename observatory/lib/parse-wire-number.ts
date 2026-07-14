/**
 * Normalizes one untrusted wire-format numeric string into a validated
 * finite number, or null if it isn't one. The single boundary function for
 * every numeric string this app reads off the wire (Alpaca's account/
 * position fields, the CAMPAIGN_INITIAL_EQUITY env var) — call it once per
 * value at the point it enters the app, then work with number | null
 * downstream instead of re-parsing (and re-risking NaN) at each call site.
 *
 * Number(), not parseFloat(): parseFloat silently accepts a numeric prefix
 * and ignores trailing garbage ("100oops" -> 100); Number() rejects the
 * whole string ("100oops" -> NaN). Number.isFinite additionally rejects
 * Infinity/-Infinity/NaN, all of which Number() can itself produce
 * ("Infinity" -> Infinity). An empty/whitespace-only string is handled
 * explicitly: Number("") is 0 by a JS coercion quirk, but a blank wire
 * value is missing data, not a legitimate zero.
 */
export function parseWireNumber(value: string): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
