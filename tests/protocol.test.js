import assert from "node:assert/strict";
import test from "node:test";

import { PROTOCOL } from "../src/common/constants.js";
import {
  buildEncryptedMessageText,
  buildKeyAnnouncementText,
  detectPayloadKind,
  parseEncryptedMessageText,
  parseKeyAnnouncementText
} from "../src/common/protocol.js";

test("key announcement build/parse roundtrip", () => {
  const payload = {
    v: "v1",
    platform: "vk",
    accountId: "123",
    publicKeyArmored: "pub",
    fingerprint: "ABCD",
    displayName: "Alice",
    sig: "signature"
  };

  const text = buildKeyAnnouncementText(payload);
  const parsed = parseKeyAnnouncementText(text);

  assert.deepEqual(parsed.payload, payload);
  assert.equal(typeof parsed.payloadEncoded, "string");
  assert.ok(parsed.payloadEncoded.length > 0);
});

test("key announcement parser supports CRLF and trimming", () => {
  const payload = { v: "v1", platform: "vk", accountId: "1", sig: "s" };
  const text = buildKeyAnnouncementText(payload).replace(/\n/g, "\r\n");
  const parsed = parseKeyAnnouncementText(`${text}\n\t `);

  assert.deepEqual(parsed.payload, payload);
});

test("key announcement parser accepts key payload line without invite text", () => {
  const payload = { v: "v1", platform: "vk", accountId: "1", sig: "s" };
  const payloadLine = `${PROTOCOL.KEY_PREFIX}${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;

  const parsed = parseKeyAnnouncementText(payloadLine);

  assert.deepEqual(parsed.payload, payload);
});

test("key announcement parser validates expected structure", () => {
  const payload = { v: "v1", platform: "vk", accountId: "1", sig: "s" };
  const text = buildKeyAnnouncementText(payload);

  assert.throws(() => parseKeyAnnouncementText("line-1\nline-2"), /missing key prefix/);
  assert.throws(
    () => parseKeyAnnouncementText(`${PROTOCOL.INVITE_LINE}\n${PROTOCOL.KEY_PREFIX}abc\nextra`),
    /one or two lines/
  );
  assert.throws(() => parseKeyAnnouncementText(`${PROTOCOL.INVITE_LINE}\nmissing-prefix`), /missing key prefix/);
  assert.throws(() => parseKeyAnnouncementText(` ${text}`), /missing key prefix/);
});

test("encrypted message build/parse roundtrip", () => {
  const payload = "abc123-_";
  const text = buildEncryptedMessageText(payload);
  const parsed = parseEncryptedMessageText(text);

  assert.equal(parsed, payload);
});

test("encrypted parser validates prefix", () => {
  assert.throws(() => parseEncryptedMessageText("not-encrypted"), /missing msg prefix/);
  assert.throws(
    () => parseEncryptedMessageText(`${PROTOCOL.MSG_PREFIX}abc\nextra`),
    /invalid msg payload/
  );
});

test("payload kind detection recognizes supported and unsupported wrappers", () => {
  const keyPayload = buildKeyAnnouncementText({ v: "v1", platform: "vk", accountId: "1", sig: "s" });
  assert.equal(detectPayloadKind(keyPayload), "key");
  assert.equal(detectPayloadKind(`${PROTOCOL.KEY_PREFIX}eyJ2IjoidjEiLCJzaWciOiJzIn0`), "key");
  assert.equal(detectPayloadKind(`${PROTOCOL.MSG_PREFIX}x`), "msg");
  assert.equal(detectPayloadKind("CHEBURCHAT:v2:msg:x"), "unsupported");
  assert.equal(detectPayloadKind("CHEBURCHAT:v2:msg:x."), "unsupported");
  assert.equal(detectPayloadKind("CHEBURCHAT:v2:key:eyJ2IjoidjIiLCJzaWciOiJzIn0"), "unsupported");
  assert.equal(
    detectPayloadKind(
      `${PROTOCOL.INVITE_LINE}\nCHEBURCHAT:v2:key:eyJ2IjoidjIiLCJzaWciOiJzIn0`
    ),
    "unsupported"
  );
  assert.equal(
    detectPayloadKind(`${PROTOCOL.INVITE_LINE}\nCHEBURCHAT:v2:key:eyJ2IjoidjIifQ.`),
    "unsupported"
  );
  assert.equal(detectPayloadKind(`x ${PROTOCOL.MSG_PREFIX}x`), "none");
  assert.equal(detectPayloadKind("plain text"), "none");
});

test("payload kind detection keeps malformed wrappers in key/msg classification", () => {
  assert.equal(detectPayloadKind(`${PROTOCOL.MSG_PREFIX}abc.`), "msg");
  assert.equal(detectPayloadKind(`${PROTOCOL.KEY_PREFIX}eyJ2IjoidjEifQ.`), "key");
  assert.equal(
    detectPayloadKind(`${PROTOCOL.INVITE_LINE}\n${PROTOCOL.KEY_PREFIX}eyJ2IjoidjEifQ.`),
    "key"
  );
});

test("payload kind detection does not treat wrapper-like plaintext with spaces as protocol payload", () => {
  assert.equal(detectPayloadKind("CHEBURCHAT:hello:msg:just text"), "none");
  assert.equal(
    detectPayloadKind(`${PROTOCOL.INVITE_LINE}\nCHEBURCHAT:v1:key:not-base64 payload`),
    "none"
  );
});
