import { defineHandler } from "nitro";
import { send } from "../plugins/queue.ts";

// GET /send — triggers one send() to the smoke-test topic. In dev mode
// (NODE_ENV=development, no VERCEL_DEPLOYMENT_ID) the SDK hits the real
// Vercel Queue Service, then invokes the registered dev consumer's handler
// in-process — see server/plugins/queue.ts and GET /result.
export default defineHandler(async () => {
  const result = await send("catalog-smoke-test", {
    hello: "from a Nitro route",
    sentAt: new Date().toISOString(),
  });
  return result;
});
