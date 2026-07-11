import { defineChannel, GET, POST } from "eve/channels";

import { getConversation, listSubscriptions, recordConversation } from "#catalog/registry.ts";
import { armPendingForConversation } from "#catalog/wake.ts";

// The catalog channel owns the demo conversation: it starts each session on a
// stable, caller-chosen `conversationId` and later "wakes" it by sending
// another message on that same token (see docs/channels/custom.mdx). The
// conversationId -> sessionId map lives in Redis (catalog/registry.ts), not
// an in-process Map: eve's dev server hot-reloads (and wipes in-process
// state) on every .env.local write, and this link is the wake address.
function log(line: string) {
  console.log(`[catalog] ${line}`);
}

export default defineChannel({
  routes: [
    POST("/catalog/chat", async (req, { send }) => {
      const { conversationId, message } = (await req.json()) as {
        conversationId: string;
        message: string;
      };

      const session = await send(message, { auth: null, continuationToken: conversationId });
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
      const {
        conversationId,
        payload,
        subscribedAt: subscribedAtOverride,
      } = (await req.json()) as {
        conversationId: string;
        payload?: Record<string, unknown>;
        subscribedAt?: string;
      };

      const known = await getConversation(conversationId);
      if (!known) {
        log(`wake FAILED conv=${conversationId} reason=unknown-conversation`);
        return Response.json(
          { error: `Unknown conversationId: ${conversationId}` },
          { status: 404 },
        );
      }

      const firedAt = new Date().toISOString();
      // subscribedAt override is an explicit top-level request field (real
      // subscriptions pass their armedAt); payload is spread first so a
      // fired subscription's own field names can never shadow the
      // channel-generated timestamps below.
      const subscribedAt = subscribedAtOverride ?? known.startedAt;
      const wakeMessage = `[event-catalog wake] ${JSON.stringify({
        ...payload,
        subscribedAt,
        firedAt,
      })}`;

      const session = await send(wakeMessage, { auth: null, continuationToken: conversationId });

      // send() falls back to starting a brand-new session when it can't
      // deliver to the continuation token. Compare ids so that failure mode
      // is logged loudly instead of passing as a normal wake.
      if (session.id !== known.sessionId) {
        log(
          `wake FAILED conv=${conversationId} expected=${known.sessionId} got=${session.id} reason=session-mismatch`,
        );
        return Response.json(
          { error: "Wake delivery created a new session instead of resuming the existing one" },
          { status: 500 },
        );
      }

      log(`wake conv=${conversationId} session=${session.id} firedAt=${firedAt}`);

      return Response.json({ conversationId, sessionId: session.id, firedAt });
    }),

    GET("/catalog/subscriptions", async () => {
      const subscriptions = await listSubscriptions();
      return Response.json(subscriptions);
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
