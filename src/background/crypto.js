import * as openpgp from "../../node_modules/openpgp/dist/openpgp.mjs";
import { base64urlDecodeToBytes, base64urlEncodeBytes, utf8Decode, utf8Encode } from "../common/base64url.js";
import { canonicalAnnouncementForSignature, canonicalMessagePayload, normalizeDisplayName } from "../common/canonical.js";
import { PROTOCOL } from "../common/constants.js";
import { formatShortFingerprint } from "../common/fingerprint.js";

// Accept a small future-skew window to tolerate modest client clock drift without
// widening signature validity more than necessary for the MVP.
const CLOCK_TOLERANCE_MS = 5 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function tolerantDate() {
  return new Date(Date.now() + CLOCK_TOLERANCE_MS);
}

function hasCurve25519EncryptionSubkey(key) {
  const infos = key
    .getKeys()
    .map((entry) => entry?.getAlgorithmInfo?.())
    .filter(Boolean);
  return infos.some((info) => {
    const algorithm = String(info.algorithm || "").toLowerCase();
    const curve = String(info.curve || "").toLowerCase();
    return algorithm === "ecdh" && curve.includes("curve25519");
  });
}

async function assertImportedPrivateKeyUsable(privateKey) {
  if (typeof privateKey?.isDecrypted === "function" && !privateKey.isDecrypted()) {
    throw new Error("imported private key must be decrypted; passphrase-protected keys are not supported in MVP");
  }

  try {
    const probeMessage = await openpgp.createMessage({ text: "cheburchat-import-probe" });
    await openpgp.sign({
      message: probeMessage,
      signingKeys: privateKey,
      detached: true,
      format: "binary"
    });
  } catch (_error) {
    throw new Error("imported private key is not usable for signing");
  }
}

export async function generateIdentity(displayName = "") {
  const generated = await openpgp.generateKey({
    type: "ecc",
    curve: "curve25519",
    userIDs: [{ name: normalizeDisplayName(displayName) }],
    format: "armored"
  });

  const publicKey = await openpgp.readKey({ armoredKey: generated.publicKey });
  if (!hasCurve25519EncryptionSubkey(publicKey)) {
    throw new Error("generated identity must include curve25519 encryption subkey");
  }
  const fingerprintFull = publicKey.getFingerprint().toUpperCase();

  return {
    publicKeyArmored: generated.publicKey,
    privateKeyArmored: generated.privateKey,
    fingerprintFull,
    fingerprintShort: formatShortFingerprint(fingerprintFull),
    createdAt: nowIso(),
    updatedAt: nowIso(),
    schemaVersion: 1
  };
}

export async function importIdentity(privateKeyArmored) {
  const privateKey = await openpgp.readPrivateKey({ armoredKey: privateKeyArmored });
  await assertImportedPrivateKeyUsable(privateKey);
  const publicKey = privateKey.toPublic();
  const publicKeyArmored = publicKey.armor();
  const fingerprintFull = publicKey.getFingerprint().toUpperCase();

  return {
    publicKeyArmored,
    privateKeyArmored,
    fingerprintFull,
    fingerprintShort: formatShortFingerprint(fingerprintFull),
    createdAt: nowIso(),
    updatedAt: nowIso(),
    schemaVersion: 1
  };
}

export async function publicKeyFingerprint(publicKeyArmored) {
  const publicKey = await openpgp.readKey({ armoredKey: publicKeyArmored });
  return publicKey.getFingerprint().toUpperCase();
}

export async function signAnnouncement(announcementPayloadWithoutSig, privateKeyArmored) {
  const canonical = canonicalAnnouncementForSignature(announcementPayloadWithoutSig);
  const message = await openpgp.createMessage({ binary: utf8Encode(canonical) });
  const signingKey = await openpgp.readPrivateKey({ armoredKey: privateKeyArmored });

  const signatureBytes = await openpgp.sign({
    message,
    signingKeys: signingKey,
    detached: true,
    format: "binary"
  });

  return base64urlEncodeBytes(signatureBytes);
}

export async function verifyAnnouncement(announcementPayloadWithSig) {
  const { sig, ...unsigned } = announcementPayloadWithSig;
  const canonical = canonicalAnnouncementForSignature(unsigned);
  const message = await openpgp.createMessage({ binary: utf8Encode(canonical) });
  const signature = await openpgp.readSignature({
    binarySignature: base64urlDecodeToBytes(sig)
  });
  const publicKey = await openpgp.readKey({ armoredKey: unsigned.publicKeyArmored });

  const result = await openpgp.verify({
    message,
    signature,
    verificationKeys: publicKey,
    format: "binary",
    date: tolerantDate()
  });

  await result.signatures[0].verified;
  return true;
}

export async function encryptMessage({
  body,
  senderPlatform,
  senderAccountId,
  senderPrivateKeyArmored,
  recipientPublicKeyArmored,
  selfPublicKeyArmored
}) {
  const logicalMessage = {
    v: PROTOCOL.VERSION,
    platform: senderPlatform,
    accountId: senderAccountId,
    ts: nowIso(),
    body
  };
  const canonical = canonicalMessagePayload(logicalMessage);

  const message = await openpgp.createMessage({ text: canonical });
  const signingKey = await openpgp.readPrivateKey({ armoredKey: senderPrivateKeyArmored });
  const recipientKey = await openpgp.readKey({ armoredKey: recipientPublicKeyArmored });
  const selfKey = await openpgp.readKey({ armoredKey: selfPublicKeyArmored });

  const encryptedBytes = await openpgp.encrypt({
    message,
    encryptionKeys: [recipientKey, selfKey],
    signingKeys: signingKey,
    config: {
      preferredCompressionAlgorithm: openpgp.enums.compression.uncompressed
    },
    format: "binary"
  });

  return {
    encoded: base64urlEncodeBytes(encryptedBytes),
    logicalMessage
  };
}

export async function decryptMessage({
  encodedPayload,
  selfPrivateKeyArmored,
  senderPublicKeyArmored
}) {
  const binaryMessage = base64urlDecodeToBytes(encodedPayload);
  const message = await openpgp.readMessage({ binaryMessage });
  const privateKey = await openpgp.readPrivateKey({ armoredKey: selfPrivateKeyArmored });
  const senderKey = await openpgp.readKey({ armoredKey: senderPublicKeyArmored });

  const decrypted = await openpgp.decrypt({
    message,
    decryptionKeys: privateKey,
    verificationKeys: senderKey,
    format: "binary",
    date: tolerantDate()
  });

  if (!decrypted.signatures || decrypted.signatures.length === 0) {
    throw new Error("missing message signature");
  }
  await decrypted.signatures[0].verified;
  return JSON.parse(utf8Decode(decrypted.data));
}
