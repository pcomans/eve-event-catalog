"use client";

import { useId, useMemo, useState } from "react";

import type { EquityPoint } from "@/lib/portfolio-metrics";

// Dataviz skill's reference palette, light mode (this app has no dark-mode
// toggle wired up anywhere yet — same scope decision M1/M2 already made for
// the rest of the app, so this chart matches rather than introducing the
// only dark-aware surface in the observatory).
const SERIES_COLOR = "#2a78d6"; // categorical slot 1 (blue) — single series, so no legend box needed
const GRID_COLOR = "#e1e0d9"; // hairline, one step off the chart surface
const AXIS_INK = "#898781"; // muted — axis ticks/labels
const PRIMARY_INK = "#0b0b0b";

const WIDTH = 720;
const HEIGHT = 260;
// right: enough for a 6-figure currency label plus its 8px offset from the
// last point, with margin — a bold "$100,000" was clipping at the old 56px.
const PAD = { top: 16, right: 72, bottom: 28, left: 16 };
// A tick that lands within this many px of the end-label's y is suppressed
// (gridline kept, numeral hidden) rather than drawn on top of it — a flat or
// round-valued series (this campaign's two $100,000 points, for instance)
// otherwise puts a tick label and the bold end-label at the exact same
// (x, y), rendering as garbled overlapping text.
const TICK_COLLISION_PX = 10;
// Alpaca's daily bars are labeled by the exchange's trading day. Formatting
// them in the viewer's local zone would shift the displayed date for a
// public viewer outside US Eastern — always show the exchange's own zone.
const TRADING_TIME_ZONE = "America/New_York";

function formatCurrency(value: number): string {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function niceTicks(min: number, max: number, count: number): number[] {
  if (min === max) return [min];
  const rawStep = (max - min) / count;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const residual = rawStep / magnitude;
  const step = (residual > 5 ? 10 : residual > 2 ? 5 : residual > 1 ? 2 : 1) * magnitude;
  const start = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let t = start; t <= max + step; t += step) ticks.push(t);
  return ticks;
}

export function EquityChart({ points }: { points: EquityPoint[] }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const gradientId = useId();

  const plotWidth = WIDTH - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;

  const { xForIndex, yForValue, yTicks, linePath, areaPath } = useMemo(() => {
    if (points.length === 0) {
      return { xForIndex: () => 0, yForValue: () => 0, yTicks: [] as number[], linePath: "", areaPath: "" };
    }
    const values = points.map((p) => p.equity);
    const minValue = Math.min(...values);
    const maxValue = Math.max(...values);
    // Pad the domain so the line never touches the top/bottom edge. A flat
    // 1-2 point series in the tens of thousands of dollars (this campaign
    // is 2.5 days old — see toEquitySeries) needs a pad scaled to the
    // value itself, not a flat $1: a $1 pad on a $100,000 series forces
    // sub-dollar tick steps, which round to duplicate-looking whole-dollar
    // labels ($100,001 twice, etc).
    const domainPad = Math.max((maxValue - minValue) * 0.15, maxValue * 0.001, 1);
    const domainMin = minValue - domainPad;
    const domainMax = maxValue + domainPad;

    const xFor = (i: number) => (points.length === 1 ? plotWidth / 2 : (i / (points.length - 1)) * plotWidth);
    const yFor = (v: number) => plotHeight - ((v - domainMin) / (domainMax - domainMin)) * plotHeight;

    const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${xFor(i)},${yFor(p.equity)}`).join(" ");
    const area = `${line} L${xFor(points.length - 1)},${plotHeight} L${xFor(0)},${plotHeight} Z`;

    return { xForIndex: xFor, yForValue: yFor, yTicks: niceTicks(domainMin, domainMax, 4), linePath: line, areaPath: area };
  }, [points, plotWidth, plotHeight]);

  if (points.length === 0) {
    return (
      <div className="flex h-[260px] items-center justify-center rounded-md border text-sm text-muted-foreground">
        No portfolio history yet for this account.
      </div>
    );
  }

  const last = points[points.length - 1];
  const hovered = hoverIndex !== null ? points[hoverIndex] : null;

  function handlePointerMove(e: React.PointerEvent<SVGRectElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const relativeX = ((e.clientX - rect.left) / rect.width) * plotWidth;
    // Nearest-point snap, per the skill's crosshair rule: aim at a date, not a 2px line.
    let nearest = 0;
    let nearestDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < points.length; i++) {
      const d = Math.abs(xForIndex(i) - relativeX);
      if (d < nearestDist) {
        nearestDist = d;
        nearest = i;
      }
    }
    setHoverIndex(nearest);
  }

  return (
    <div>
      <svg
        className="w-full"
        height={HEIGHT}
        role="img"
        aria-label={`Equity curve, ${formatCurrency(points[0].equity)} to ${formatCurrency(last.equity)}`}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={SERIES_COLOR} stopOpacity={0.1} />
            <stop offset="100%" stopColor={SERIES_COLOR} stopOpacity={0} />
          </linearGradient>
        </defs>
        <g transform={`translate(${PAD.left},${PAD.top})`}>
          {/* Gridlines + y-axis ticks — hairline, recessive, rounded values.
              A tick within TICK_COLLISION_PX of the end-label's y keeps its
              gridline but drops its numeral — the end-label already shows
              that value, and the two would otherwise render on top of each
              other (see PAD's comment). */}
          {yTicks.map((tick) => {
            const tickY = yForValue(tick);
            const collidesWithEndLabel = Math.abs(tickY - yForValue(last.equity)) < TICK_COLLISION_PX;
            return (
              <g key={tick}>
                <line stroke={GRID_COLOR} strokeWidth={1} x1={0} x2={plotWidth} y1={tickY} y2={tickY} />
                {!collidesWithEndLabel && (
                  <text fill={AXIS_INK} fontSize={10} textAnchor="start" x={plotWidth + 8} y={tickY + 3}>
                    {formatCurrency(tick)}
                  </text>
                )}
              </g>
            );
          })}

          {/* Area wash + line */}
          <path d={areaPath} fill={`url(#${gradientId})`} stroke="none" />
          <path d={linePath} fill="none" stroke={SERIES_COLOR} strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} />

          {/* End marker + direct end-label (value at the end, per the skill's label rule) */}
          <circle cx={xForIndex(points.length - 1)} cy={yForValue(last.equity)} fill={SERIES_COLOR} r={4} stroke="var(--card)" strokeWidth={2} />
          <text fill={PRIMARY_INK} fontSize={12} fontWeight={600} x={xForIndex(points.length - 1) + 8} y={yForValue(last.equity) + 4}>
            {formatCurrency(last.equity)}
          </text>

          {/* Crosshair + tooltip */}
          {hovered && (
            <>
              <line stroke={GRID_COLOR} strokeWidth={1} x1={xForIndex(hoverIndex!)} x2={xForIndex(hoverIndex!)} y1={0} y2={plotHeight} />
              <circle cx={xForIndex(hoverIndex!)} cy={yForValue(hovered.equity)} fill={SERIES_COLOR} r={4} stroke="var(--card)" strokeWidth={2} />
            </>
          )}

          {/* Hit layer: the whole plot is the crosshair's hit target, per the skill's line-chart rule */}
          <rect
            fill="transparent"
            height={plotHeight}
            onPointerLeave={() => setHoverIndex(null)}
            onPointerMove={handlePointerMove}
            width={plotWidth}
            x={0}
            y={0}
          />
        </g>
      </svg>

      {hovered && (
        <div className="mt-1 flex justify-between px-1 text-xs text-muted-foreground">
          <span>
            {new Date(hovered.at).toLocaleString("en-US", {
              dateStyle: "medium",
              timeStyle: "short",
              timeZone: TRADING_TIME_ZONE,
            })}
          </span>
          <span className="font-medium text-foreground">{formatCurrency(hovered.equity)}</span>
        </div>
      )}

      <button className="mt-2 text-xs text-muted-foreground underline" onClick={() => setShowTable((v) => !v)} type="button">
        {showTable ? "Hide table view" : "View as table"}
      </button>
      {showTable && (
        <table className="mt-2 w-full text-xs">
          <thead className="text-muted-foreground">
            <tr>
              <th className="text-left font-normal">Date</th>
              <th className="text-right font-normal">Equity</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.at} className="border-t">
                <td className="py-1 font-mono">
                  {new Date(p.at).toLocaleDateString("en-US", { timeZone: TRADING_TIME_ZONE })}
                </td>
                <td className="py-1 text-right font-mono">{formatCurrency(p.equity)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
