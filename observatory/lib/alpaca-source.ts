import "server-only";

import type { AlpacaAccount, AlpacaPortfolioHistory, AlpacaPosition } from "./alpaca-types.ts";

// Hardcoded, not an env var: paper-api.alpaca.markets is the ONLY permitted
// host for this app (no live-trading endpoint must ever be reachable here by
// a config mistake). GETs only — never add an order/trading call against
// this module.
const ALPACA_BASE_URL = "https://paper-api.alpaca.markets";

function alpacaHeaders(): HeadersInit {
  const keyId = process.env.ALPACA_API_KEY_ID;
  const secretKey = process.env.ALPACA_API_SECRET_KEY;
  if (!keyId || !secretKey) throw new Error("ALPACA_API_KEY_ID/ALPACA_API_SECRET_KEY not set");
  return { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secretKey };
}

async function getAlpacaJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${ALPACA_BASE_URL}${path}`, { headers: alpacaHeaders(), cache: "no-store", signal });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

export function fetchAlpacaAccount(signal?: AbortSignal) {
  return getAlpacaJson<AlpacaAccount>("/v2/account", signal);
}

export function fetchAlpacaPositions(signal?: AbortSignal) {
  return getAlpacaJson<AlpacaPosition[]>("/v2/positions", signal);
}

// timeframe=1D, not intraday: verified live against this campaign's actual
// paper account (created 2026-07-11, ~2.5 days old at the time of writing) —
// intraday timeframes (1H tried first) return nonsensical equity values
// (negative dollar amounts, e.g. -$51 against a real ~$99,950 balance from
// /v2/account) for an account this young. Alpaca's own SDK docs describe why:
// "If not specified, then the baseline calculation is done against the
// earliest returned data item. This could happen for accounts without prior
// closing balances (e.g. new account)" — exactly this account's situation.
// 1D (daily close) does not exhibit the bug; period=1M bounds the request to
// a sane window while still capturing everything this account has.
export function fetchAlpacaPortfolioHistory(signal?: AbortSignal) {
  return getAlpacaJson<AlpacaPortfolioHistory>("/v2/account/portfolio/history?period=1M&timeframe=1D", signal);
}
