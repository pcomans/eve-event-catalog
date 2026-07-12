// Thin typed client over Alpaca's paper trading + market data APIs. Native
// fetch and Node's built-in WebSocket only — no Alpaca SDK, per the hard
// rule that every infra component maps to a Vercel primitive (an SDK
// wrapping the same two REST bases plus a websocket buys us nothing here).

const TRADING_BASE = "https://paper-api.alpaca.markets/v2";
const DATA_BASE = "https://data.alpaca.markets/v2";

export type DataFeed = "iex" | "test";

function authHeaders(): Record<string, string> {
  const keyId = process.env.ALPACA_API_KEY_ID;
  const secretKey = process.env.ALPACA_API_SECRET_KEY;
  if (!keyId || !secretKey) {
    throw new Error("ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY are not set");
  }
  return { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secretKey };
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { ...authHeaders(), ...init?.headers } });
  if (!res.ok) throw new Error(`alpaca ${init?.method ?? "GET"} ${url} -> ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export interface AlpacaAccount {
  id: string;
  status: string;
  currency: string;
  cash: string;
  portfolio_value: string;
  buying_power: string;
}

export function getAccount(): Promise<AlpacaAccount> {
  return request(`${TRADING_BASE}/account`);
}

export interface AlpacaPosition {
  symbol: string;
  side: string;
  qty: string;
  avg_entry_price: string;
  market_value: string;
  unrealized_pl: string;
}

export function getPositions(): Promise<AlpacaPosition[]> {
  return request(`${TRADING_BASE}/positions`);
}

export interface SubmitOrderInput {
  symbol: string;
  side: "buy" | "sell";
  type: "market";
  time_in_force: "day";
  notional: string;
}

export interface AlpacaOrder {
  id: string;
  symbol: string;
  side: string;
  status: string;
  notional: string | null;
  qty: string | null;
  filled_qty: string;
  filled_avg_price: string | null;
  submitted_at: string;
  filled_at: string | null;
}

export function submitOrder(input: SubmitOrderInput): Promise<AlpacaOrder> {
  return request(`${TRADING_BASE}/orders`, { method: "POST", body: JSON.stringify(input) });
}

export function getOrder(orderId: string): Promise<AlpacaOrder> {
  return request(`${TRADING_BASE}/orders/${orderId}`);
}

export interface LatestTrade {
  price: number;
  timestamp: string;
}

/**
 * GET /stocks/{symbol}/trades/latest. Only meaningful on the `iex` feed —
 * verified empirically that the test feed's synthetic FAKEPACA symbol has
 * no REST trade history at all (`feed=test` is rejected as "invalid feed"
 * for this endpoint, and `feed=iex` returns "no trade found for FAKEPACA").
 * Callers on the test feed must seed the previous price from the first
 * stream tick instead (see alpaca.ts).
 */
export async function getLatestTrade(symbol: string, feed: DataFeed): Promise<LatestTrade> {
  const json = await request<{ trade: { p: number; t: string } }>(
    `${DATA_BASE}/stocks/${symbol}/trades/latest?feed=${feed}`,
  );
  return { price: json.trade.p, timestamp: json.trade.t };
}

export interface Trade {
  symbol: string;
  price: number;
  timestamp: string;
}

type TradeHandler = (trade: Trade) => void;

function log(line: string) {
  console.log(`[alpaca-stream] ${line}`);
}

/**
 * One websocket connection to Alpaca's market data stream, shared across
 * every price subscription — the free plan allows exactly one. Lazily
 * connects on the first `subscribe()` call and stays open for the life of
 * the process; symbols are added/removed as subscriptions come and go via
 * `subscribe`/`unsubscribe`, not by opening new connections.
 */
export class AlpacaStream {
  private ws: WebSocket | null = null;
  private ready: Promise<void> | null = null;
  private readonly subscribedSymbols = new Set<string>();
  private readonly handlers = new Set<TradeHandler>();

  constructor(private readonly feed: DataFeed) {}

  onTrade(handler: TradeHandler): void {
    this.handlers.add(handler);
  }

  /** Opens the connection and completes the connect -> auth handshake. Idempotent. */
  private connect(): Promise<void> {
    if (this.ready) return this.ready;

    this.ready = new Promise((resolve, reject) => {
      const url = `wss://stream.data.alpaca.markets/v2/${this.feed}`;
      const ws = new WebSocket(url);
      this.ws = ws;

      ws.addEventListener("open", () => log(`connect feed=${this.feed}`));

      ws.addEventListener("message", (event) => {
        const messages = JSON.parse(event.data.toString()) as Array<Record<string, unknown>>;
        for (const msg of messages) this.handleMessage(msg, resolve);
      });

      ws.addEventListener("error", () => {
        log(`error feed=${this.feed}`);
        reject(new Error(`alpaca stream error (feed=${this.feed})`));
      });

      ws.addEventListener("close", (event) => {
        log(`closed feed=${this.feed} code=${event.code}`);
      });
    });

    return this.ready;
  }

  private handleMessage(msg: Record<string, unknown>, onAuthenticated: () => void): void {
    if (msg.T === "success" && msg.msg === "connected") {
      this.ws!.send(JSON.stringify({ action: "auth", key: authHeaders()["APCA-API-KEY-ID"], secret: authHeaders()["APCA-API-SECRET-KEY"] }));
      return;
    }
    if (msg.T === "success" && msg.msg === "authenticated") {
      log(`authenticated feed=${this.feed}`);
      onAuthenticated();
      return;
    }
    if (msg.T === "subscription") {
      log(`subscribed feed=${this.feed} trades=${JSON.stringify(msg.trades)}`);
      return;
    }
    if (msg.T === "t") {
      const trade: Trade = { symbol: msg.S as string, price: msg.p as number, timestamp: msg.t as string };
      for (const handler of this.handlers) handler(trade);
      return;
    }
    if (msg.T === "error") {
      log(`error feed=${this.feed} msg=${JSON.stringify(msg)}`);
    }
  }

  /** Adds symbols to the shared subscription. Safe to call before the connection is up — queues behind the handshake. */
  async subscribe(symbols: string[]): Promise<void> {
    const news = symbols.filter((s) => !this.subscribedSymbols.has(s));
    if (news.length === 0) return;
    await this.connect();
    news.forEach((s) => this.subscribedSymbols.add(s));
    this.ws!.send(JSON.stringify({ action: "subscribe", trades: news }));
  }

  /** Drops symbols no subscription needs anymore. */
  async unsubscribe(symbols: string[]): Promise<void> {
    const owned = symbols.filter((s) => this.subscribedSymbols.has(s));
    if (owned.length === 0) return;
    await this.connect();
    owned.forEach((s) => this.subscribedSymbols.delete(s));
    this.ws!.send(JSON.stringify({ action: "unsubscribe", trades: owned }));
  }
}
