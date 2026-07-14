// Stat-tile contract per the dataviz skill: label (sentence case, no
// trailing colon) · value (semibold, proportional figures — not
// tabular-nums, that's reserved for table/axis columns) · optional signed
// delta, colored by direction × whether up is good for this metric.
export function StatTile({
  label,
  value,
  delta,
}: {
  label: string;
  value: string;
  delta?: { text: string; good: boolean };
}) {
  return (
    <div className="rounded-md border p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
      {delta && (
        <div className={`mt-1 text-xs ${delta.good ? "text-[#006300]" : "text-destructive"}`}>{delta.text}</div>
      )}
    </div>
  );
}
