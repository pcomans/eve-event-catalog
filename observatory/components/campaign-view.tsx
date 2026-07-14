"use client";

import { EquityChart } from "@/components/equity-chart";
import { StatTile } from "@/components/stat-tile";
import type { AccountDto, PortfolioHistoryDto, PositionDto } from "@/lib/campaign-dto";
import { parseWireNumber } from "@/lib/parse-wire-number";
import { computeRealizedPnl, sumUnrealizedPnl, toEquitySeries } from "@/lib/portfolio-metrics";
import { usePolling } from "@/lib/use-polling";

// Equity/positions/history move slowly relative to the catalog's 2s
// subscription/event polling — a paper account's price only updates on
// market ticks, not continuously — so a 60s cadence is plenty to feel live
// without hammering Alpaca's REST API for no visible benefit. On-load-only
// was considered and rejected: the page is meant to stay open on a screen
// during the demo, and 60s is cheap enough not to need finer justification.
const REFRESH_MS = 60_000;

function currency(value: number): string {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function signedCurrency(value: number): string {
  const formatted = currency(Math.abs(value));
  return value >= 0 ? `+${formatted}` : `-${formatted}`;
}

// "—" for an individual value that failed to parse — never a fabricated
// number. Every wire numeric string is parsed exactly once, here, via
// parseWireNumber (see that module for why Number.isFinite + Number()
// rather than parseFloat).
function fmtOrDash(value: number | null, format: (v: number) => string): string {
  return value !== null ? format(value) : "—";
}

interface ParsedPosition {
  symbol: string;
  qty: number | null;
  avgEntryPrice: number | null;
  currentPrice: number | null;
  marketValue: number | null;
  unrealizedPl: number | null;
  unrealizedPlPct: number | null;
}

function parsePosition(p: PositionDto): ParsedPosition {
  return {
    symbol: p.symbol,
    qty: parseWireNumber(p.qty),
    avgEntryPrice: parseWireNumber(p.avg_entry_price),
    currentPrice: parseWireNumber(p.current_price),
    marketValue: parseWireNumber(p.market_value),
    unrealizedPl: parseWireNumber(p.unrealized_pl),
    unrealizedPlPct: parseWireNumber(p.unrealized_plpc),
  };
}

export function CampaignView({ initialEquity }: { initialEquity: number }) {
  const { data: account, error: accountError, loading: accountLoading } = usePolling<AccountDto | null>(
    "/api/campaign/account",
    null,
    REFRESH_MS,
  );
  const {
    data: positions,
    error: positionsError,
    loading: positionsLoading,
  } = usePolling<PositionDto[]>("/api/campaign/positions", [], REFRESH_MS);
  const { data: history, error: historyError } = usePolling<PortfolioHistoryDto | null>(
    "/api/campaign/portfolio-history",
    null,
    REFRESH_MS,
  );

  const error = accountError ?? positionsError ?? historyError;
  const pnlLoading = accountLoading || positionsLoading;

  // Every wire numeric string is parsed exactly once, here — downstream
  // code (tiles, table, computeRealizedPnl) works with number | null and
  // never re-parses or re-risks NaN.
  const equity = account ? parseWireNumber(account.equity) : null;
  const lastEquity = account ? parseWireNumber(account.last_equity) : null;
  const cash = account ? parseWireNumber(account.cash) : null;
  const buyingPower = account ? parseWireNumber(account.buying_power) : null;
  const parsedPositions = positions.map(parsePosition);
  const unrealizedPnl = sumUnrealizedPnl(parsedPositions.map((p) => p.unrealizedPl));
  const realizedPnl =
    equity !== null && unrealizedPnl !== null ? computeRealizedPnl(equity, initialEquity, unrealizedPnl) : null;
  const equityPoints = history ? toEquitySeries(history) : [];

  return (
    <div className="p-6">
      <h1 className="mb-4 text-lg font-semibold">Campaign</h1>
      {error && <p className="mb-4 text-sm text-destructive">Failed to load: {error}</p>}

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatTile
          label="Equity"
          value={accountLoading ? "…" : fmtOrDash(equity, currency)}
          delta={
            equity !== null && lastEquity !== null
              ? { text: `${signedCurrency(equity - lastEquity)} vs. last close`, good: equity - lastEquity >= 0 }
              : undefined
          }
        />
        <StatTile label="Cash" value={fmtOrDash(cash, currency)} />
        <StatTile label="Buying power" value={fmtOrDash(buyingPower, currency)} />
        <StatTile
          label="Unrealized P&L"
          value={positionsLoading ? "…" : fmtOrDash(unrealizedPnl, signedCurrency)}
          delta={
            !positionsLoading && unrealizedPnl !== null
              ? { text: unrealizedPnl >= 0 ? "up" : "down", good: unrealizedPnl >= 0 }
              : undefined
          }
        />
        <StatTile
          label="Realized P&L"
          value={pnlLoading ? "…" : fmtOrDash(realizedPnl, signedCurrency)}
          delta={
            !pnlLoading && realizedPnl !== null
              ? { text: realizedPnl >= 0 ? "up" : "down", good: realizedPnl >= 0 }
              : undefined
          }
        />
      </div>

      <div className="mb-6 rounded-md border p-4">
        <div className="mb-3 text-sm font-medium">Equity curve — daily close</div>
        <EquityChart points={equityPoints} />
      </div>

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left">Symbol</th>
              <th className="px-3 py-2 text-right">Qty</th>
              <th className="px-3 py-2 text-right">Avg entry</th>
              <th className="px-3 py-2 text-right">Current price</th>
              <th className="px-3 py-2 text-right">Market value</th>
              <th className="px-3 py-2 text-right">Unrealized P&L</th>
            </tr>
          </thead>
          <tbody>
            {positionsLoading && (
              <tr>
                <td className="px-3 py-6 text-center text-muted-foreground" colSpan={6}>
                  Loading…
                </td>
              </tr>
            )}
            {!positionsLoading && parsedPositions.length === 0 && !error && (
              <tr>
                <td className="px-3 py-6 text-center text-muted-foreground" colSpan={6}>
                  No open positions.
                </td>
              </tr>
            )}
            {parsedPositions.map((p) => (
              <tr key={p.symbol} className="border-t">
                <td className="px-3 py-2 font-medium">{p.symbol}</td>
                <td className="px-3 py-2 text-right font-mono">{fmtOrDash(p.qty, (v) => v.toFixed(3))}</td>
                <td className="px-3 py-2 text-right font-mono">{fmtOrDash(p.avgEntryPrice, currency)}</td>
                <td className="px-3 py-2 text-right font-mono">{fmtOrDash(p.currentPrice, currency)}</td>
                <td className="px-3 py-2 text-right font-mono">{fmtOrDash(p.marketValue, currency)}</td>
                <td
                  className={`px-3 py-2 text-right font-mono ${
                    p.unrealizedPl === null || p.unrealizedPlPct === null
                      ? "text-muted-foreground"
                      : p.unrealizedPl >= 0
                        ? "text-[#006300]"
                        : "text-destructive"
                  }`}
                >
                  {p.unrealizedPl !== null && p.unrealizedPlPct !== null
                    ? `${signedCurrency(p.unrealizedPl)} (${(p.unrealizedPlPct * 100).toFixed(2)}%)`
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
