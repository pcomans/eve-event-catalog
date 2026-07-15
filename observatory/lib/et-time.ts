// Every displayed time in this app is the exchange's own zone (US/Eastern),
// not the viewer's local zone: Alpaca/EDGAR events happen on Eastern market
// hours regardless of who's looking at the page, and mixing zones across
// tiles/tables/charts would make times incomparable. Intl's `timeZone`
// option (not a fixed UTC offset) is what actually handles the EST/EDT DST
// switch correctly across the year — a bare `.slice(11, 19)` on the ISO
// string shows raw UTC with no zone label at all.
export const ET_TIME_ZONE = "America/New_York";

/**
 * Formats an ISO-8601 UTC timestamp as "HH:MM:SS ET" (24-hour, US/Eastern).
 * `hourCycle: "h23"` is explicit (not `hour12: false`) so midnight renders
 * as "00" rather than risking ICU's "24" for hour12:false in some locales.
 */
export function formatEtTime(isoTimestamp: string): string {
  const time = new Date(isoTimestamp).toLocaleTimeString("en-US", {
    timeZone: ET_TIME_ZONE,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return `${time} ET`;
}
