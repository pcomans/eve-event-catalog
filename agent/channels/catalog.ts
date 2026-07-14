import { defineChannel, GET, POST } from "eve/channels";
import { context, propagation } from "@opentelemetry/api";

import { getConversation, listSubscriptions, recordConversation } from "#catalog/registry.ts";
// Lives under catalog/ (NOT here): eve discovery-scans agent/channels/ and
// rejects any file that isn't a defineChannel() export — same trap as
// AGENTS.md rule 7 for tests.
import { OBSERVE_PAGE_HTML } from "#catalog/observe-page.ts";
import {
  armPendingForConversation,
  buildWakeEnvelope,
  claimWakeDelivery,
  clearWakeClaim,
  getWakeDeliveryMarker,
  markWakeSent,
  rejectsCallerSuppliedGuidance,
  resolveGuidanceForWakeRequest,
  startRecoverySweep,
} from "#catalog/wake.ts";
import { assertCatalogHonesty } from "#catalog/catalog.ts";
import { assertCatalogApiSecretConfigured, isAuthorizedHeader } from "#catalog/auth.ts";
import { listEvents } from "#catalog/history.ts";
import { createCachedReader } from "#catalog/read-cache.ts";
import { incrementAndCheckTurnCap } from "#catalog/turn-cap.ts";
// Side-effecting imports: register the alpaca and edgar providers
// (registerProvider(...)) at module load. ES module imports fully evaluate
// before this file's own top-level code runs, so assertCatalogHonesty()
// below is guaranteed to see both.
import "#catalog/providers/alpaca.ts";
import "#catalog/providers/edgar.ts";
import "#catalog/providers/clock.ts";

// The catalog channel owns the demo conversation: it starts each session on a
// stable, caller-chosen `conversationId` and later "wakes" it by sending
// another message on that same token (see docs/channels/custom.mdx). The
// conversationId -> sessionId map lives in Redis (catalog/registry.ts), not
// an in-process Map: eve's dev server hot-reloads (and wipes in-process
// state) on every .env.local write, and this link is the wake address.
function log(line: string) {
  console.log(`[catalog] ${line}`);
}

// Demo observatory fix, part 3 (2026-07-13, timeboxed — see
// agent/instrumentation.ts's own comment for the full picture): stamps the
// conversationId onto OTEL baggage for the duration of one send() call, so
// every span created inside that call (AI SDK generation spans, tool
// spans, etc.) inherits it via standard OTEL context propagation —
// instrumentation.ts's ThreadMetadataSpanProcessor reads it back out and
// turns it into the LangSmith run-metadata key ("session_id"/"thread_id")
// Threads needs on every run in the trace, not just the root.
function withConversationBaggage<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
  const baggage = propagation.createBaggage({ conversation_id: { value: conversationId } });
  return context.with(propagation.setBaggage(context.active(), baggage), fn);
}

// Fail-closed: refuses to boot rather than silently running the write
// routes below unauthenticated (see AGENTS.md rule 4's assertCatalogHonesty
// for the same pattern applied to the catalog).
assertCatalogApiSecretConfigured();

// Task #33 (Redis command-burn reduction): GET /catalog/subscriptions and
// GET /catalog/events are polled every ~2s by every open observatory tab
// and catalog/observe-page.ts — without this, N concurrent viewers cost N
// Redis reads per poll tick. 2000ms matches (not exceeds) that client poll
// interval, so the cache never adds staleness beyond what a dashboard
// already tolerates; the client's own polling cadence is unchanged
// (createCachedReader, catalog/read-cache.ts). Module-level, so this is
// only as effective as this module's own instance count (KNOWN_ISSUES.md
// #14's multi-instance caveat) — a correctness non-issue (a cache miss just
// re-reads the same shared Redis), only an efficiency one.
const READ_CACHE_TTL_MS = 2000;
const readSubscriptionsCached = createCachedReader(listSubscriptions, READ_CACHE_TTL_MS);
const readEventsCached = createCachedReader(listEvents, READ_CACHE_TTL_MS);

/**
 * Shared-secret gate for the two write routes (POST /catalog/chat, POST
 * /catalog/wake): `authorization: Bearer $CATALOG_API_SECRET`. Returns a 401
 * Response to send back immediately — checked BEFORE any session-touching
 * code runs, so a rejected request never calls `send()`. Read-only GETs
 * (/catalog/subscriptions, /catalog/events) don't call this.
 */
function requireAuth(req: Request): Response | null {
  const secret = process.env.CATALOG_API_SECRET!; // asserted present at boot, above
  if (isAuthorizedHeader(req.headers.get("authorization"), secret)) return null;
  log(`auth FAILED path=${new URL(req.url).pathname}`);
  return Response.json({ error: "unauthorized: missing or invalid bearer token" }, { status: 401 });
}

/**
 * Runaway/loop protection (turn-cap.ts), not a cost cap — a per-UTC-day
 * ceiling on turns started, checked BEFORE send() at both entry points that
 * start a turn (POST /catalog/chat, POST /catalog/wake) so a turn that would
 * exceed it never reaches send() at all. 429, deliberately not 400/404: a
 * wake route caller is deliverWake (catalog/wake.ts), whose only two
 * PERMANENT-failure statuses are 400 (guidance-rejected) and 404
 * (unknown-conversation) — a 429 here is treated as retryable, leaving the
 * subscription "delivering" for the recovery sweep to retry once the day
 * rolls over (or the cap is raised), exactly like any other transient error.
 */
async function checkTurnCap(): Promise<Response | null> {
  const cap = await incrementAndCheckTurnCap();
  if (cap.allowed) return null;
  log(`turn-cap REJECTED count=${cap.count} limit=${cap.limit}`);
  return Response.json(
    { error: `daily turn cap reached (${cap.count}/${cap.limit}) — runaway/loop protection, resets at UTC midnight` },
    { status: 429 },
  );
}

export default defineChannel({
  routes: [
    POST("/catalog/chat", async (req, { send }) => {
      const unauthorized = requireAuth(req);
      if (unauthorized) return unauthorized;

      const { conversationId, message } = (await req.json()) as {
        conversationId: string;
        message: string;
      };

      const capExceeded = await checkTurnCap();
      if (capExceeded) return capExceeded;

      const session = await withConversationBaggage(conversationId, () =>
        send(message, { auth: null, continuationToken: conversationId }),
      );
      await recordConversation(conversationId, session.id);

      log(`chat conv=${conversationId} session=${session.id}`);

      return Response.json({
        conversationId,
        sessionId: session.id,
        streamUrl: `/catalog/sessions/${session.id}/stream`,
      });
    }),

    GET("/catalog/sessions/:sessionId/stream", async (_req, { getSession, params }) => {
      const session = getSession(params.sessionId);
      const events = await session.getEventStream();

      // getEventStream() yields event objects, not bytes: encode each as one
      // NDJSON line before handing the stream to Response (the eve.ts built-in
      // channel does the same encoding internally).
      const encoder = new TextEncoder();
      const stream = events.pipeThrough(
        new TransformStream({
          transform(event, controller) {
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          },
        }),
      );

      return new Response(stream, {
        headers: { "content-type": "application/x-ndjson; charset=utf-8" },
      });
    }),

    // Resumes a parked session from outside the conversation, e.g. a fired
    // subscription. `payload` is folded into a machine-originated message so
    // the agent can tell this wasn't typed by the user. This is the single
    // implementation of "deliver a wake" — catalog/wake.ts's internal
    // callers (expiry timers, provider ticks) call this same route over
    // HTTP rather than duplicating it.
    POST("/catalog/wake", async (req, { send }) => {
      const unauthorized = requireAuth(req);
      if (unauthorized) return unauthorized;

      const body = (await req.json()) as {
        conversationId: string;
        payload?: Record<string, unknown>;
        subscribedAt?: string;
        firedAt?: string;
        subscriptionId?: string;
        reason?: "fired" | "expired";
        guidance?: unknown;
      };

      // guidance is the one field the agent is told to trust as instructions
      // rather than data (see AGENTS.md rule 4). Even with the bearer-secret
      // gate above, accepting a caller-supplied guidance string would be a
      // trusted-instruction injection vector for anyone holding the secret —
      // reject outright (loud 400, not a silent overwrite) rather than
      // resolve it here from the subscription instead. wake.ts's deliverWake
      // never sends this field; only subscriptionId + reason, below.
      if (rejectsCallerSuppliedGuidance(body)) {
        log(`wake FAILED conv=${body.conversationId} reason=guidance-rejected`);
        return Response.json(
          { error: "guidance is resolved server-side from catalog.json; callers must not supply it" },
          { status: 400 },
        );
      }

      const {
        conversationId,
        payload,
        subscribedAt: subscribedAtOverride,
        firedAt: firedAtOverride,
        subscriptionId,
        reason,
      } = body;

      const known = await getConversation(conversationId);
      if (!known) {
        log(`wake FAILED conv=${conversationId} reason=unknown-conversation`);
        return Response.json(
          { error: `Unknown conversationId: ${conversationId}` },
          { status: 404 },
        );
      }

      // Checked before the delivery claim below, so a rejected wake never
      // takes (and then has to release) a claim it was never going to use.
      const capExceeded = await checkTurnCap();
      if (capExceeded) return capExceeded;

      // Route-side dedupe by subscriptionId (correctness prerequisite 4:
      // "queue consumers dedupe by subscriptionId"), two-phase: claim the
      // right to send BEFORE calling send() (phase "sending", short TTL,
      // under a fresh owner token), upgrade to phase "sent" only after
      // send() actually succeeds, via a token-CAS (see markWakeSent/
      // clearWakeClaim's own comments in wake.ts — this route is the one
      // place that actually knows whether send() succeeded, so it's the
      // authoritative check; deliverWake's own marker check is only a fast
      // path on top of this). A synthetic wake with no subscriptionId
      // (AT-2) has no one-shot subscription to dedupe against and always
      // proceeds, claim-free.
      let claimToken: string | null = null;
      if (subscriptionId) {
        claimToken = await claimWakeDelivery(subscriptionId);
        if (!claimToken) {
          const marker = await getWakeDeliveryMarker(subscriptionId);
          if (marker?.phase === "sent") {
            log(`wake ALREADY-DELIVERED conv=${conversationId} subscriptionId=${subscriptionId}`);
            return Response.json({ conversationId, subscriptionId, alreadyDelivered: true, firedAt: marker.firedAt });
          }
          // phase === "sending": another caller (or an earlier attempt of
          // this same one, mid-crash-recovery) is actively sending this
          // subscription's wake right now. Not an error — just nothing this
          // call should also do; the claim's TTL bounds how long a truly
          // stalled claim blocks a retry.
          log(`wake ALREADY-IN-FLIGHT conv=${conversationId} subscriptionId=${subscriptionId}`);
          return Response.json({ conversationId, subscriptionId, alreadyInFlight: true });
        }
      }

      // subscribedAt/firedAt overrides are explicit top-level request
      // fields (real subscriptions pass sub.armedAt and the exact instant
      // wake.ts already stored on the subscription, so Redis and the
      // agent's envelope show the same timestamp); a synthetic wake with no
      // subscription (AT-2) mints its own. `payload` is nested under its
      // own key in buildWakeEnvelope, not spread, so nothing in it can ever
      // shadow these two fields. `guidance` is resolved HERE, from
      // subscriptionId + reason, by looking the subscription up and reading
      // catalog.json (resolveGuidanceForWakeRequest) — never trusted from
      // the request body. A synthetic wake with no subscriptionId (AT-2)
      // resolves to no guidance, which the agent handles gracefully.
      const subscribedAt = subscribedAtOverride ?? known.startedAt;
      const firedAt = firedAtOverride ?? new Date().toISOString();
      const guidance = await resolveGuidanceForWakeRequest(subscriptionId, reason);
      const wakeMessage = `[event-catalog wake] ${JSON.stringify(buildWakeEnvelope(subscribedAt, firedAt, payload, guidance))}`;

      let session;
      try {
        session = await withConversationBaggage(conversationId, () =>
          send(wakeMessage, { auth: null, continuationToken: conversationId }),
        );
      } catch (err) {
        // A genuine, caught send() failure — release the claim immediately
        // so a retry doesn't have to wait out its TTL (a crash instead of a
        // clean throw skips this entirely; the claim's own TTL recovers
        // that case on the next sweep round — see clearWakeClaim's comment).
        if (subscriptionId && claimToken) await clearWakeClaim(subscriptionId, claimToken);
        throw err;
      }

      // send() falls back to starting a brand-new session when it can't
      // deliver to the continuation token. Compare ids so that failure mode
      // is logged loudly instead of passing as a normal wake.
      if (session.id !== known.sessionId) {
        if (subscriptionId && claimToken) await clearWakeClaim(subscriptionId, claimToken);
        log(
          `wake FAILED conv=${conversationId} expected=${known.sessionId} got=${session.id} reason=session-mismatch`,
        );
        return Response.json(
          { error: "Wake delivery created a new session instead of resuming the existing one" },
          { status: 500 },
        );
      }

      // Upgraded only after send() has actually succeeded AND resumed the
      // right session — see markWakeSent's doc comment in wake.ts for the
      // honestly-accepted narrow window this two-phase design still leaves.
      // If the upgrade itself fails (CAS miss, or the call throws — e.g. a
      // transient Redis error), that is NEVER a reason to report this wake
      // as failed: the agent's session already resumed successfully, which
      // is the fact that matters. Log it loudly instead and let
      // deliverWake's own terminal-status write (a separate step) handle
      // reaching "fired"/"expired" — if THAT also fails, the subscription
      // simply stays "delivering" and the next sweep round completes it.
      let markerUpgradeFailed = false;
      if (subscriptionId && claimToken) {
        try {
          const upgraded = await markWakeSent(subscriptionId, firedAt, claimToken);
          if (!upgraded) markerUpgradeFailed = true;
        } catch {
          markerUpgradeFailed = true;
        }
        if (markerUpgradeFailed) {
          log(
            `wake MARKER-UPGRADE-FAILED conv=${conversationId} subscriptionId=${subscriptionId} session=${session.id} ` +
              `— the wake WAS delivered to the agent; only the delivery marker's bookkeeping failed to upgrade`,
          );
        }
      }

      log(`wake conv=${conversationId} session=${session.id} firedAt=${firedAt}`);

      return Response.json({
        conversationId,
        sessionId: session.id,
        firedAt,
        delivered: true,
        ...(markerUpgradeFailed ? { markerUpgradeFailed: true } : {}),
      });
    }),

    GET("/catalog/subscriptions", async () => {
      const subscriptions = await readSubscriptionsCached();
      return Response.json(subscriptions);
    }),

    // Public, read-only, append-only event-history feed (AT-10): every
    // subscription lifecycle transition and wake delivery, newest first.
    // No auth — same openness as GET /catalog/subscriptions — and nothing
    // in a history entry is a secret (catalog/history.ts).
    GET("/catalog/events", async () => {
      const events = await readEventsCached();
      return Response.json(events);
    }),

    // Resolves a conversationId to its sessionId — used by the observatory
    // page (below) so its Live Transcript panel can accept a conversationId
    // and find the right session stream to poll. Public and read-only, same
    // openness as the other GETs on this channel: a ConversationRecord has
    // nothing secret in it (conversationId, sessionId, startedAt).
    GET("/catalog/conversations/:conversationId", async (_req, { params }) => {
      const record = await getConversation(params.conversationId);
      if (!record) return Response.json({ error: "unknown conversationId" }, { status: 404 });
      return Response.json(record);
    }),

    // The demo observatory (2026-07-13, timeboxed live-visibility tool while
    // LangSmith was quota-dead): one self-contained, read-only HTML page —
    // no secrets, no writes, only calls the public GETs above plus the
    // existing session stream route. HTML/CSS/JS lives in observe-page.ts to
    // keep this file's own route list readable.
    GET("/catalog/observe", async () => {
      return new Response(OBSERVE_PAGE_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    }),
  ],

  events: {
    // Subscriptions stay "pending" during the agent's turn and only arm once
    // the turn ends — arming mid-turn would race a tick against a session
    // that hasn't parked yet. `channel.continuationToken` is the runtime's
    // fully-qualified token ("catalog:<conversationId>"), not the raw
    // conversationId route handlers pass to `send()` — the framework
    // prepends the channel name (see docs/channels/custom.mdx).
    async "turn.completed"(_data, channel) {
      const conversationId = channel.continuationToken.slice("catalog:".length);
      await armPendingForConversation(conversationId);
    },
  },
});

// Boot honesty check: fails loudly if catalog.json advertises an "active"
// event type with no registered, supporting provider. Runs once, at module
// load, after the alpaca provider-registering import above has fully
// evaluated (see that import's comment).
assertCatalogHonesty();

// Correctness prerequisite 4: recovers any subscription left stuck in
// "delivering" by a crash between claiming the delivery lease and finishing
// the wake POST. See catalog/wake.ts's sweepStrandedDeliveries.
startRecoverySweep();
