import { defineHandler } from "nitro";
import { received } from "../plugins/queue.ts";

// GET /result — reports everything the dev consumer has received so far,
// so the smoke test can confirm the round trip without scraping console logs.
export default defineHandler(() => ({ received }));
