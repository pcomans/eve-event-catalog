import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveCatalogBaseUrl } from "./wake.ts";

// Deliberately its own file, not catalog/wake.test.ts: that file's other
// tests exercise deliverWake/delivering state and aren't safe to run solo
// per this project's process rules — see resolveCatalogBaseUrl's own
// comment in wake.ts. This file is pure logic only: no Redis, no HTTP, no
// subscription/delivery state of any kind.

test("resolveCatalogBaseUrl prefers an explicit CATALOG_BASE_URL over everything else", () => {
  assert.equal(
    resolveCatalogBaseUrl({ CATALOG_BASE_URL: "https://explicit.example", VERCEL_URL: "my-app.vercel.app", PORT: "3000" }),
    "https://explicit.example",
  );
});

test("resolveCatalogBaseUrl derives https://<VERCEL_URL> when deployed and no explicit override is set", () => {
  assert.equal(resolveCatalogBaseUrl({ VERCEL_URL: "my-app-git-main-team.vercel.app" }), "https://my-app-git-main-team.vercel.app");
});

test("resolveCatalogBaseUrl adds the https:// protocol itself — VERCEL_URL is hostname-only", () => {
  const result = resolveCatalogBaseUrl({ VERCEL_URL: "my-app.vercel.app" });
  assert.ok(!result.startsWith("https://https://"), "must not double-prefix the protocol");
  assert.equal(result, "https://my-app.vercel.app");
});

test("resolveCatalogBaseUrl falls back to localhost:$PORT when neither is set (local dev)", () => {
  assert.equal(resolveCatalogBaseUrl({}), "http://localhost:2000");
  assert.equal(resolveCatalogBaseUrl({ PORT: "4000" }), "http://localhost:4000");
});

test("resolveCatalogBaseUrl never falls through to localhost when VERCEL_URL is set (the deploy-gap bug this fixes)", () => {
  const result = resolveCatalogBaseUrl({ VERCEL_URL: "my-app.vercel.app", PORT: "2000" });
  assert.ok(!result.includes("localhost"), "a deployed environment must never resolve to localhost");
});
