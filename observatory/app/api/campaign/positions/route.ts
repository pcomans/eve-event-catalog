import { fetchAlpacaPositions } from "@/lib/alpaca-source";
import { toPositionDto } from "@/lib/campaign-dto";

// Same proxy shape as /api/campaign/account/route.ts — see that file's
// comment, including why the response is whitelisted rather than passed
// through (Alpaca positions also carry asset_id, exchange, intraday P&L
// fields, etc. this table doesn't render).
export async function GET(request: Request) {
  const positions = await fetchAlpacaPositions(request.signal);
  return Response.json(positions.map(toPositionDto));
}
