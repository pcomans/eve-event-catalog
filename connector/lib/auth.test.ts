import assert from "node:assert/strict";
import { test } from "node:test";
import { mockEvent } from "nitro/h3";

import { requireCronSecret } from "./auth.ts";

const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;

function eventWithAuth(header: string | undefined) {
  return mockEvent("http://localhost/ensure-running", header ? { headers: { authorization: header } } : {});
}

test("requireCronSecret throws 503 when CRON_SECRET is not configured, even with a header present", (t) => {
  delete process.env.CRON_SECRET;
  t.after(() => {
    if (ORIGINAL_CRON_SECRET === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = ORIGINAL_CRON_SECRET;
  });

  assert.throws(() => requireCronSecret(eventWithAuth("Bearer anything")), (err: unknown) => {
    return (err as { statusCode?: number }).statusCode === 503;
  });
});

test("requireCronSecret throws 401 when CRON_SECRET is configured but the header is missing", (t) => {
  process.env.CRON_SECRET = "s3cret";
  t.after(() => {
    if (ORIGINAL_CRON_SECRET === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = ORIGINAL_CRON_SECRET;
  });

  assert.throws(() => requireCronSecret(eventWithAuth(undefined)), (err: unknown) => {
    return (err as { statusCode?: number }).statusCode === 401;
  });
});

test("requireCronSecret throws 401 when the header carries the wrong secret", (t) => {
  process.env.CRON_SECRET = "s3cret";
  t.after(() => {
    if (ORIGINAL_CRON_SECRET === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = ORIGINAL_CRON_SECRET;
  });

  assert.throws(() => requireCronSecret(eventWithAuth("Bearer wrong")), (err: unknown) => {
    return (err as { statusCode?: number }).statusCode === 401;
  });
});

// The exact shape Vercel documents for its own Cron invocations
// (vercel.com/docs/cron-jobs/manage-cron-jobs: "The value of the variable
// will be automatically sent as an Authorization header... Bearer <value>")
// — this is the case that must NOT throw, since it's Vercel itself calling.
test("requireCronSecret does not throw when the header exactly matches CRON_SECRET", (t) => {
  process.env.CRON_SECRET = "s3cret";
  t.after(() => {
    if (ORIGINAL_CRON_SECRET === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = ORIGINAL_CRON_SECRET;
  });

  assert.doesNotThrow(() => requireCronSecret(eventWithAuth("Bearer s3cret")));
});
