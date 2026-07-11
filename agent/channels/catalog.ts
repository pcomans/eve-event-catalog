import { defineChannel, GET, POST } from "eve/channels";

// The catalog channel owns the demo conversation: it starts each session on a
// stable, caller-chosen `conversationId` and later "wakes" it by sending
// another message on that same token (see docs/channels/custom.mdx). Tracking
// which conversationIds we've actually started lets /catalog/wake refuse to
// wake an unknown id instead of silently starting a fresh session.
interface ConversationRecord {
  sessionId: string;
  startedAt: string;
}

const conversations = new Map<string, ConversationRecord>();

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

      const startedAt = conversations.get(conversationId)?.startedAt ?? new Date().toISOString();
      conversations.set(conversationId, { sessionId: session.id, startedAt });

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
    // the agent can tell this wasn't typed by the user.
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

      const known = conversations.get(conversationId);
      if (!known) {
        log(`wake FAILED conv=${conversationId} reason=unknown-conversation`);
        return Response.json(
          { error: `Unknown conversationId: ${conversationId}` },
          { status: 404 },
        );
      }

      const firedAt = new Date().toISOString();
      const subscribedAt = subscribedAtOverride ?? known.startedAt;
      const wakeMessage = `[event-catalog wake] ${JSON.stringify({
        subscribedAt,
        firedAt,
        now: firedAt,
        ...payload,
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
  ],
});
