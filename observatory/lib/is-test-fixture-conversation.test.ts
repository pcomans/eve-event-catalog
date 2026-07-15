import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { isTestFixtureConversationId } from "./is-test-fixture-conversation.ts";

test("isTestFixtureConversationId: matches the real test:<uuid> fixture shape", () => {
  assert.equal(isTestFixtureConversationId(`test:${randomUUID()}`), true);
});

test("isTestFixtureConversationId: matches the real test-<label>-<uuid> fixture shape", () => {
  assert.equal(isTestFixtureConversationId(`test-watcher-host-symbol-${randomUUID()}`), true);
  assert.equal(isTestFixtureConversationId(`test-noop-provider-${randomUUID()}`), true);
});

test("isTestFixtureConversationId: does not match real campaign ids", () => {
  assert.equal(isTestFixtureConversationId("campaign-5"), false);
  assert.equal(isTestFixtureConversationId("campaign-6"), false);
});

// p6k gate (LOW): production reserves neither the "test:" nor the "test-"
// prefix — a real campaign or user-chosen conversationId that merely
// STARTS with one of those strings, but has no genuine UUID tail, must
// never be swallowed by this filter.
test("isTestFixtureConversationId: a real conversationId that merely starts with 'test-' but has no UUID tail is NOT filtered", () => {
  assert.equal(isTestFixtureConversationId("test-drive"), false);
});

test("isTestFixtureConversationId: a real conversationId that merely starts with 'test:' but has no UUID tail is NOT filtered", () => {
  assert.equal(isTestFixtureConversationId("test:not-a-uuid"), false);
});
