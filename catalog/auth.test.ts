import assert from "node:assert/strict";
import { test } from "node:test";

import { assertCatalogApiSecretConfigured, isAuthorizedHeader } from "./auth.ts";

test("isAuthorizedHeader accepts an exact 'Bearer <secret>' match", () => {
  assert.equal(isAuthorizedHeader("Bearer s3cret", "s3cret"), true);
});

test("isAuthorizedHeader rejects a wrong secret", () => {
  assert.equal(isAuthorizedHeader("Bearer wrong", "s3cret"), false);
});

test("isAuthorizedHeader rejects a missing header", () => {
  assert.equal(isAuthorizedHeader(null, "s3cret"), false);
});

test("isAuthorizedHeader rejects a header without the 'Bearer ' prefix", () => {
  assert.equal(isAuthorizedHeader("s3cret", "s3cret"), false);
  assert.equal(isAuthorizedHeader("Basic s3cret", "s3cret"), false);
});

test("isAuthorizedHeader rejects an empty bearer token even against an (misconfigured) empty secret", () => {
  assert.equal(isAuthorizedHeader("Bearer ", ""), false);
});

test("assertCatalogApiSecretConfigured throws when CATALOG_API_SECRET is unset", () => {
  assert.throws(() => assertCatalogApiSecretConfigured({}));
});

test("assertCatalogApiSecretConfigured throws when CATALOG_API_SECRET is an empty string", () => {
  assert.throws(() => assertCatalogApiSecretConfigured({ CATALOG_API_SECRET: "" }));
});

test("assertCatalogApiSecretConfigured does not throw when CATALOG_API_SECRET is set", () => {
  assert.doesNotThrow(() => assertCatalogApiSecretConfigured({ CATALOG_API_SECRET: "s3cret" }));
});
