// Stat-tile contract per the dataviz skill: label (sentence case, no
// trailing colon) · value (semibold, proportional figures — not
// tabular-nums, that's reserved for table/axis columns) · optional signed
// delta, colored by direction × whether up is good for this metric.
//
// `valueMuted` downgrades the value out of its normal bold/emphasized
// styling — for a tile whose value is a fallback (e.g. "n/a" for an
// absent/malformed figure), not a genuine number: a tile isn't a table, so
// it doesn't get the "—" no-value placeholder (Philipp's rule reserves that
// for table cells), and a fallback string shouldn't visually compete with
// real figures on the same row either.
export function StatTile({
  label,
  value,
  valueMuted,
  delta,
}: {
  label: string;
  value: string;
  valueMuted?: boolean;
  delta?: { text: string; good: boolean };
}) {
  return (
    <div className="rounded-md border p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${valueMuted ? "text-muted-foreground" : ""}`}>{value}</div>
      {delta && (
        <div className={`mt-1 text-xs ${delta.good ? "text-[#006300]" : "text-destructive"}`}>{delta.text}</div>
      )}
    </div>
  );
}
