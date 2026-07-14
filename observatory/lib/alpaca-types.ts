// Raw Alpaca paper-trading REST shapes — snake_case as they arrive on the
// wire (verified against live responses from https://paper-api.alpaca.markets
// during development, not from the SDK's camelCase-mapped types, since this
// app calls the REST API directly rather than depending on
// @alpacahq/alpaca-trade-api for two GET endpoints). Numeric fields on
// /v2/account and /v2/positions are strings on the wire; portfolio/history's
// arrays are real JSON numbers. Callers must normalize the string fields
// through lib/parse-wire-number.ts's parseWireNumber — never parseFloat,
// which accepts partial garbage ("100oops" -> 100) and non-finite results
// that parseWireNumber rejects to a validated null.

export interface AlpacaAccount {
  cash: string;
  equity: string;
  last_equity: string;
  buying_power: string;
  portfolio_value: string;
  currency: string;
  status: string;
}

export interface AlpacaPosition {
  symbol: string;
  qty: string;
  avg_entry_price: string;
  current_price: string;
  market_value: string;
  cost_basis: string;
  unrealized_pl: string;
  unrealized_plpc: string;
  side: string;
}

export interface AlpacaPortfolioHistory {
  timestamp: number[]; // UNIX epoch seconds, left-labeled (start of each window)
  // Alpaca's schema allows null entries (a day with no sample) alongside the
  // zero-padding this app already treats as "account didn't exist yet" —
  // null and 0 are different: null means "no data", 0 means "recorded as
  // zero". See portfolio-metrics.ts's toEquitySeries for how each is handled.
  equity: (number | null)[];
  profit_loss: (number | null)[];
  profit_loss_pct: (number | null)[];
  base_value: number | null;
  base_value_asof?: string;
  timeframe: string;
}
