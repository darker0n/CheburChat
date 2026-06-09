import assert from "node:assert/strict";
import test from "node:test";

import {
  base64urlDecodeToBytes,
  base64urlDecodeUtf8,
  base64urlEncodeBytes,
  base64urlEncodeUtf8,
  utf8Decode,
  utf8Encode
} from "../src/common/base64url.js";

test("base64url byte roundtrip keeps original bytes", () => {
  const input = Uint8Array.from([0, 1, 2, 3, 250, 251, 252, 253, 254, 255]);
  const encoded = base64urlEncodeBytes(input);
  const decoded = base64urlDecodeToBytes(encoded);

  assert.deepEqual(decoded, input);
});

test("base64url UTF-8 roundtrip keeps original text", () => {
  const text = "hello world 123";
  const encoded = base64urlEncodeUtf8(text);
  const decoded = base64urlDecodeUtf8(encoded);

  assert.equal(decoded, text);
});

test("base64url output is URL-safe and unpadded", () => {
  const encoded = base64urlEncodeBytes(Uint8Array.from([251, 255, 239]));

  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
  assert.ok(!encoded.includes("="));
  assert.ok(!encoded.includes("+"));
  assert.ok(!encoded.includes("/"));
});

test("base64url decoder supports values without padding", () => {
  const encoded = "Zm9vYmFy";
  const decoded = base64urlDecodeUtf8(encoded);
  assert.equal(decoded, "foobar");
});

test("utf8Encode/utf8Decode roundtrip", () => {
  const text = "cheburchat";
  const decoded = utf8Decode(utf8Encode(text));
  assert.equal(decoded, text);
});
