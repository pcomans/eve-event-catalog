import { fetchSessionStream } from "@/lib/catalog-source";

// The upstream stream never closes on its own (fetchSessionStream's own
// comment) — on Vercel this function is still bound by the plan's Function
// duration ceiling regardless, so it WILL be cut mid-stream for any session
// that stays open longer than this. 800s matches the project's existing
// Fluid GA ceiling choice (connector/nitro.config.ts's own maxDuration:800,
// docs/plan-vercel-production.md's "800s GA" over the 1800s beta option) —
// not a new decision, just the same ceiling applied here. This is safe only
// because the client (use-session-transcript.ts) already reconnects on any
// stream end/error and the upstream replays full history from index 0 on
// every reconnect — a forced cutoff here degrades to "reconnects and
// re-renders" for the viewer, not a permanently broken page.
export const maxDuration = 800;

// Raw streaming proxy — not the getJson-based shape the other /api/* routes
// use. The eve app's session stream is durable/never-closing (see
// fetchSessionStream's comment), so this forwards the upstream body straight
// through as our own Response body instead of buffering it, exactly like the
// eve app's own inline observe page (catalog/observe-page.ts) reads this
// same upstream route today. request.signal is forwarded so a client abort
// (tab navigated away) cancels the proxy-to-eve request too, not just the
// browser-to-proxy leg — same fix as the other routes' p5d round.
export async function GET(request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  const upstream = await fetchSessionStream(sessionId, request.signal);
  if (!upstream.ok || !upstream.body) {
    // upstream.status alone isn't safe to reuse here: this branch can be
    // reached with a 2xx/204 status (an ok response with no body), and
    // passing a non-error status through would make the client treat this
    // JSON error payload as a valid (if empty) stream, or — for 204 — throw,
    // since a 204 Response cannot carry a JSON body at all.
    const status = upstream.status >= 400 ? upstream.status : 502;
    return Response.json({ error: `stream ${upstream.status}` }, { status });
  }
  return new Response(upstream.body, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8" },
  });
}
