import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalAnnouncementForSignature,
  canonicalMessagePayload,
  normalizeAccountId,
  normalizeDisplayName,
  normalizePlatform
} from "../src/common/canonical.js";
import { PLATFORM } from "../src/common/constants.js";

test("normalizePlatform accepts VK and rejects unsupported platforms", () => {
  assert.equal(normalizePlatform(PLATFORM.VK), PLATFORM.VK);
  assert.throws(() => normalizePlatform("telegram"), /unsupported platform/);
});

test("normalizeAccountId trims whitespace", () => {
  assert.equal(normalizeAccountId("  12345  "), "12345");
});

test("normalizeDisplayName returns empty string for non-string values", () => {
  assert.equal(normalizeDisplayName(null), "");
  assert.equal(normalizeDisplayName(42), "");
  assert.equal(normalizeDisplayName("Alice"), "Alice");
});

test("canonicalAnnouncementForSignature creates stable ordered json", () => {
  const canonical = canonicalAnnouncementForSignature({
    v: "v1",
    platform: "vk",
    accountId: " 123 ",
    publicKeyArmored: "pub-key",
    fingerprint: "ABCD1234",
    displayName: "Alice"
  });

  assert.equal(
    canonical,
    '{"v":"v1","platform":"vk","accountId":"123","publicKeyArmored":"pub-key","fingerprint":"ABCD1234","displayName":"Alice"}'
  );
});

test("canonicalMessagePayload validates required string fields", () => {
  assert.throws(
    () =>
      canonicalMessagePayload({
        v: "v1",
        platform: "vk",
        accountId: "1",
        ts: "2026-01-01T00:00:00.000Z",
        body: 123
      }),
    /body must be a string/
  );
});

test("canonicalMessagePayload trims account id and keeps field order", () => {
  const canonical = canonicalMessagePayload({
    v: "v1",
    platform: "vk",
    accountId: " 77 ",
    ts: "2026-01-01T00:00:00.000Z",
    body: "hello"
  });

  assert.equal(
    canonical,
    '{"v":"v1","platform":"vk","accountId":"77","ts":"2026-01-01T00:00:00.000Z","body":"hello"}'
  );
});
