import type { AlpacaAccount, AlpacaPortfolioHistory, AlpacaPosition } from "./alpaca-types.ts";

// Field-whitelisted response shapes for the public /api/campaign/* routes.
// Alpaca's raw objects carry identifiers and account-management fields this
// read-only public page never renders (id, account_number, created_at,
// transfer/margin data, ...) — constructing these DTOs explicitly, rather
// than just narrowing the TypeScript type (which strips nothing at
// runtime — a type assertion isn't a filter), keeps that data from ever
// reaching the wire once this page is public.

export interface AccountDto {
  equity: string;
  last_equity: string;
  cash: string;
  buying_power: string;
}

export function toAccountDto(account: AlpacaAccount): AccountDto {
  return {
    equity: account.equity,
    last_equity: account.last_equity,
    cash: account.cash,
    buying_power: account.buying_power,
  };
}

export interface PositionDto {
  symbol: string;
  qty: string;
  avg_entry_price: string;
  current_price: string;
  market_value: string;
  unrealized_pl: string;
  unrealized_plpc: string;
}

export function toPositionDto(position: AlpacaPosition): PositionDto {
  return {
    symbol: position.symbol,
    qty: position.qty,
    avg_entry_price: position.avg_entry_price,
    current_price: position.current_price,
    market_value: position.market_value,
    unrealized_pl: position.unrealized_pl,
    unrealized_plpc: position.unrealized_plpc,
  };
}

export interface PortfolioHistoryDto {
  timestamp: number[];
  equity: (number | null)[];
}

export function toPortfolioHistoryDto(history: AlpacaPortfolioHistory): PortfolioHistoryDto {
  return { timestamp: history.timestamp, equity: history.equity };
}
