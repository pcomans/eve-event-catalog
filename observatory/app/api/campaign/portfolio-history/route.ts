import { fetchAlpacaPortfolioHistory } from "@/lib/alpaca-source";
import { toPortfolioHistoryDto } from "@/lib/campaign-dto";

// Same proxy shape as /api/campaign/account/route.ts — see that file's
// comment. Only timestamp/equity are whitelisted through: profit_loss(_pct)
// and base_value aren't rendered anywhere (realized P&L is derived from
// CAMPAIGN_INITIAL_EQUITY instead of base_value — see portfolio-metrics.ts).
export async function GET(request: Request) {
  const history = await fetchAlpacaPortfolioHistory(request.signal);
  return Response.json(toPortfolioHistoryDto(history));
}
