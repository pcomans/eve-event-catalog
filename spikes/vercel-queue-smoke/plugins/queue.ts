import { definePlugin } from "nitro";
import { QueueClient, registerDevConsumer } from "@vercel/queue";

// In-memory record of everything the dev consumer has received, for the
// /result route to report on — this whole spike only needs to prove one
// round trip, not build real durable state.
export const received: unknown[] = [];

const client = new QueueClient();
export const { send } = client;

export default definePlugin(() => {
  registerDevConsumer({
    topic: "catalog-smoke-test",
    client,
    consumerGroup: "smoke-test-consumer",
    handler: async (message) => {
      received.push(message);
      console.log("[queue-smoke] received:", message);
    },
  });
  console.log("[queue-smoke] dev consumer registered for topic catalog-smoke-test");
});
