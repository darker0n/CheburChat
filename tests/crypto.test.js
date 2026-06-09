import assert from "node:assert/strict";
import test from "node:test";

import * as openpgp from "../node_modules/openpgp/dist/openpgp.mjs";
import { PLATFORM, PROTOCOL } from "../src/common/constants.js";
import { base64urlEncodeBytes } from "../src/common/base64url.js";
import { canonicalAnnouncementForSignature, canonicalMessagePayload } from "../src/common/canonical.js";
import {
  decryptMessage,
  encryptMessage,
  generateIdentity,
  importIdentity,
  signAnnouncement,
  verifyAnnouncement
} from "../src/background/crypto.js";

function isIsoTimestamp(value) {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

test("generateIdentity returns valid keypair metadata", async () => {
  const identity = await generateIdentity("");
  const key = await openpgp.readKey({ armoredKey: identity.publicKeyArmored });
  const keyInfos = key
    .getKeys()
    .map((entry) => entry.getAlgorithmInfo())
    .filter(Boolean);
  const hasCurve25519Subkey = keyInfos.some((info) => {
    const algorithm = String(info.algorithm || "").toLowerCase();
    const curve = String(info.curve || "").toLowerCase();
    return algorithm === "ecdh" && curve.includes("curve25519");
  });

  assert.match(identity.publicKeyArmored, /BEGIN PGP PUBLIC KEY BLOCK/);
  assert.match(identity.privateKeyArmored, /BEGIN PGP PRIVATE KEY BLOCK/);
  assert.match(identity.fingerprintFull, /^[A-F0-9]{40}$/);
  assert.match(identity.fingerprintShort, /^[A-F0-9]{4} [A-F0-9]{4} [A-F0-9]{4}$/);
  assert.equal(hasCurve25519Subkey, true);
  assert.equal(identity.schemaVersion, 1);
  assert.equal(isIsoTimestamp(identity.createdAt), true);
  assert.equal(isIsoTimestamp(identity.updatedAt), true);
});

test("importIdentity reproduces public fingerprint from private key", async () => {
  const generated = await generateIdentity("");
  const imported = await importIdentity(generated.privateKeyArmored);

  assert.equal(imported.privateKeyArmored, generated.privateKeyArmored);
  assert.equal(imported.fingerprintFull, generated.fingerprintFull);
  assert.equal(imported.fingerprintShort, generated.fingerprintShort);
});

test("importIdentity rejects passphrase-protected private keys as unusable for MVP", async () => {
  const generated = await openpgp.generateKey({
    type: "ecc",
    curve: "curve25519",
    userIDs: [{ name: "Alice" }],
    passphrase: "secret",
    format: "armored"
  });

  await assert.rejects(
    () => importIdentity(generated.privateKey),
    /must be decrypted|passphrase-protected/i
  );
});

test("announcement signatures verify and fail after payload tampering", async () => {
  const identity = await generateIdentity("");
  const unsignedPayload = {
    v: PROTOCOL.VERSION,
    platform: PLATFORM.VK,
    accountId: "123",
    publicKeyArmored: identity.publicKeyArmored,
    fingerprint: identity.fingerprintFull,
    displayName: "Alice"
  };

  const sig = await signAnnouncement(unsignedPayload, identity.privateKeyArmored);
  assert.match(sig, /^[A-Za-z0-9_-]+$/);

  const signedPayload = { ...unsignedPayload, sig };
  assert.equal(await verifyAnnouncement(signedPayload), true);

  await assert.rejects(() =>
    verifyAnnouncement({
      ...signedPayload,
      displayName: "Mallory"
    })
  );
});

test("verifyAnnouncement accepts signatures with small future clock skew", async () => {
  const identity = await generateIdentity("");
  const unsignedPayload = {
    v: PROTOCOL.VERSION,
    platform: PLATFORM.VK,
    accountId: "123",
    publicKeyArmored: identity.publicKeyArmored,
    fingerprint: identity.fingerprintFull,
    displayName: "Alice"
  };

  const canonical = canonicalAnnouncementForSignature(unsignedPayload);
  const message = await openpgp.createMessage({ binary: new TextEncoder().encode(canonical) });
  const signingKey = await openpgp.readPrivateKey({ armoredKey: identity.privateKeyArmored });
  const signatureBytes = await openpgp.sign({
    message,
    signingKeys: signingKey,
    detached: true,
    format: "binary",
    date: new Date(Date.now() + 2 * 60 * 1000)
  });

  assert.equal(
    await verifyAnnouncement({
      ...unsignedPayload,
      sig: base64urlEncodeBytes(signatureBytes)
    }),
    true
  );
});

test("encryptMessage/decryptMessage roundtrip for recipient and sender copy", async () => {
  const sender = await generateIdentity("");
  const recipient = await generateIdentity("");

  const encrypted = await encryptMessage({
    body: "secret hello",
    senderPlatform: PLATFORM.VK,
    senderAccountId: "100",
    senderPrivateKeyArmored: sender.privateKeyArmored,
    recipientPublicKeyArmored: recipient.publicKeyArmored,
    selfPublicKeyArmored: sender.publicKeyArmored
  });

  assert.match(encrypted.encoded, /^[A-Za-z0-9_-]+$/);
  assert.equal(encrypted.logicalMessage.platform, PLATFORM.VK);
  assert.equal(encrypted.logicalMessage.accountId, "100");
  assert.equal(encrypted.logicalMessage.body, "secret hello");

  const recipientDecrypted = await decryptMessage({
    encodedPayload: encrypted.encoded,
    selfPrivateKeyArmored: recipient.privateKeyArmored,
    senderPublicKeyArmored: sender.publicKeyArmored
  });
  assert.equal(recipientDecrypted.body, "secret hello");
  assert.equal(recipientDecrypted.platform, PLATFORM.VK);
  assert.equal(recipientDecrypted.accountId, "100");

  const senderDecrypted = await decryptMessage({
    encodedPayload: encrypted.encoded,
    selfPrivateKeyArmored: sender.privateKeyArmored,
    senderPublicKeyArmored: sender.publicKeyArmored
  });
  assert.equal(senderDecrypted.body, "secret hello");
});

test("decryptMessage accepts signatures with small future clock skew", async () => {
  const sender = await generateIdentity("");
  const recipient = await generateIdentity("");
  const logicalMessage = {
    v: PROTOCOL.VERSION,
    platform: PLATFORM.VK,
    accountId: "100",
    ts: new Date().toISOString(),
    body: "secret hello"
  };
  const canonical = canonicalMessagePayload(logicalMessage);
  const message = await openpgp.createMessage({ text: canonical });
  const signingKey = await openpgp.readPrivateKey({ armoredKey: sender.privateKeyArmored });
  const recipientKey = await openpgp.readKey({ armoredKey: recipient.publicKeyArmored });
  const selfKey = await openpgp.readKey({ armoredKey: sender.publicKeyArmored });
  const encryptedBytes = await openpgp.encrypt({
    message,
    encryptionKeys: [recipientKey, selfKey],
    signingKeys: signingKey,
    config: {
      preferredCompressionAlgorithm: openpgp.enums.compression.uncompressed
    },
    format: "binary",
    date: new Date(Date.now() + 2 * 60 * 1000)
  });

  const decrypted = await decryptMessage({
    encodedPayload: base64urlEncodeBytes(encryptedBytes),
    selfPrivateKeyArmored: recipient.privateKeyArmored,
    senderPublicKeyArmored: sender.publicKeyArmored
  });

  assert.equal(decrypted.body, "secret hello");
  assert.equal(decrypted.platform, PLATFORM.VK);
  assert.equal(decrypted.accountId, "100");
});

test("decryptMessage fails when verification key does not match signer", async () => {
  const sender = await generateIdentity("");
  const recipient = await generateIdentity("");
  const wrongVerifier = await generateIdentity("");

  const encrypted = await encryptMessage({
    body: "message",
    senderPlatform: PLATFORM.VK,
    senderAccountId: "100",
    senderPrivateKeyArmored: sender.privateKeyArmored,
    recipientPublicKeyArmored: recipient.publicKeyArmored,
    selfPublicKeyArmored: sender.publicKeyArmored
  });

  await assert.rejects(() =>
    decryptMessage({
      encodedPayload: encrypted.encoded,
      selfPrivateKeyArmored: recipient.privateKeyArmored,
      senderPublicKeyArmored: wrongVerifier.publicKeyArmored
    })
  );
});
