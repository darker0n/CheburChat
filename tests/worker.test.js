import assert from "node:assert/strict";
import test from "node:test";

import { INTERNAL_ERROR, PLATFORM, PROTOCOL, STORAGE, TRUST } from "../src/common/constants.js";
import { base64urlEncodeBytes } from "../src/common/base64url.js";
import {
  buildEncryptedMessageText,
  buildKeyAnnouncementText,
  parseKeyAnnouncementText
} from "../src/common/protocol.js";
import { encryptMessage, generateIdentity, signAnnouncement, verifyAnnouncement } from "../src/background/crypto.js";
import * as openpgp from "../node_modules/openpgp/dist/openpgp.mjs";

function createChromeMock() {
  const state = new Map();
  const installedListeners = [];
  const messageListeners = [];
  let openOptionsPageCalls = 0;
  let openPopupCalls = 0;

  const chrome = {
    storage: {
      local: {
        async get(key) {
          if (typeof key === "string") {
            return state.has(key) ? { [key]: state.get(key) } : {};
          }
          if (key === null) {
            return Object.fromEntries(state.entries());
          }
          return {};
        },
        async set(value) {
          for (const [k, v] of Object.entries(value)) {
            state.set(k, v);
          }
        },
        async remove(key) {
          state.delete(key);
        }
      }
    },
    runtime: {
      onInstalled: {
        addListener(listener) {
          installedListeners.push(listener);
        }
      },
      onMessage: {
        addListener(listener) {
          messageListeners.push(listener);
        }
      },
      async openOptionsPage() {
        openOptionsPageCalls += 1;
      },
      getURL(path) {
        return new URL(String(path || ""), "chrome-extension://mockid/").href;
      }
    },
    action: {
      async openPopup() {
        openPopupCalls += 1;
      }
    }
  };

  return {
    chrome,
    state,
    installedListeners,
    messageListeners,
    get openOptionsPageCalls() {
      return openOptionsPageCalls;
    },
    get openPopupCalls() {
      return openPopupCalls;
    }
  };
}

const mock = createChromeMock();
globalThis.chrome = mock.chrome;

await import("../src/background/worker.js");

assert.equal(mock.installedListeners.length, 1, "worker should register exactly one onInstalled listener");
assert.equal(mock.messageListeners.length, 1, "worker should register exactly one onMessage listener");

const onMessage = mock.messageListeners[0];

async function dispatchMessage(type, payload = {}, sender = {}) {
  return await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) reject(new Error(`timed out waiting for response: ${type}`));
    }, 20000);

    try {
      const returnedTrue = onMessage({ type, payload }, sender, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(response);
      });
      assert.equal(returnedTrue, true);
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}

async function createSignedAnnouncement({ accountId, identity, displayName = "" }) {
  const unsigned = {
    v: PROTOCOL.VERSION,
    platform: PLATFORM.VK,
    accountId,
    publicKeyArmored: identity.publicKeyArmored,
    fingerprint: identity.fingerprintFull,
    displayName
  };
  const sig = await signAnnouncement(unsigned, identity.privateKeyArmored);
  const payload = { ...unsigned, sig };
  await verifyAnnouncement(payload);
  return buildKeyAnnouncementText(payload);
}

async function buildSignedEncryptedRawText({
  payloadObject,
  senderPrivateKeyArmored,
  senderPublicKeyArmored,
  recipientPublicKeyArmored
}) {
  const message = await openpgp.createMessage({
    text: JSON.stringify(payloadObject)
  });
  const signingKey = await openpgp.readPrivateKey({ armoredKey: senderPrivateKeyArmored });
  const senderKey = await openpgp.readKey({ armoredKey: senderPublicKeyArmored });
  const recipientKey = await openpgp.readKey({ armoredKey: recipientPublicKeyArmored });

  const encryptedBytes = await openpgp.encrypt({
    message,
    encryptionKeys: [recipientKey, senderKey],
    signingKeys: signingKey,
    config: {
      preferredCompressionAlgorithm: openpgp.enums.compression.uncompressed
    },
    format: "binary"
  });

  return buildEncryptedMessageText(base64urlEncodeBytes(encryptedBytes));
}

test.beforeEach(() => {
  mock.state.clear();
});

test("onInstalled initializes default settings", async () => {
  await mock.installedListeners[0]();

  const settings = mock.state.get(STORAGE.SETTINGS);
  assert.deepEqual(settings, {
    schemaVersion: 1,
    debugMode: false,
    warningThresholdChars: PROTOCOL.WARNING_THRESHOLD_CHARS,
    needsBackupAcknowledgement: false
  });
  assert.equal(mock.openOptionsPageCalls, 0);
});

test("onInstalled does not open options on fresh install", async () => {
  await mock.installedListeners[0]({ reason: "install" });
  assert.equal(mock.openOptionsPageCalls, 0);
});

test("settings roundtrip supports debug mode toggle", async () => {
  const initial = await dispatchMessage("mc:get-settings");
  assert.equal(initial.ok, true);
  assert.equal(initial.settings.debugMode, false);
  assert.equal(initial.settings.warningThresholdChars, PROTOCOL.WARNING_THRESHOLD_CHARS);
  assert.equal(initial.settings.needsBackupAcknowledgement, false);

  const updated = await dispatchMessage("mc:set-debug-mode", {
    debugMode: true
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.settings.debugMode, true);

  const fetched = await dispatchMessage("mc:get-settings");
  assert.equal(fetched.ok, true);
  assert.equal(fetched.settings.debugMode, true);
  assert.equal(mock.state.get(STORAGE.SETTINGS).debugMode, true);
});

test("settings roundtrip supports warning threshold update", async () => {
  const initial = await dispatchMessage("mc:get-settings");
  assert.equal(initial.ok, true);
  assert.equal(initial.settings.warningThresholdChars, PROTOCOL.WARNING_THRESHOLD_CHARS);
  assert.equal(initial.settings.needsBackupAcknowledgement, false);

  const updated = await dispatchMessage("mc:set-warning-threshold", {
    warningThresholdChars: 2048
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.settings.warningThresholdChars, 2048);

  const fetched = await dispatchMessage("mc:get-settings");
  assert.equal(fetched.ok, true);
  assert.equal(fetched.settings.warningThresholdChars, 2048);
  assert.equal(mock.state.get(STORAGE.SETTINGS).warningThresholdChars, 2048);
});

test("set-warning-threshold rejects out-of-range values", async () => {
  const response = await dispatchMessage("mc:set-warning-threshold", {
    warningThresholdChars: 0
  });
  assert.equal(response.ok, false);
  assert.match(response.error, /warningThresholdChars must be between 1 and 4096/);
});

test("returns unsupported_message_type for unknown messages", async () => {
  const response = await dispatchMessage("mc:unknown");
  assert.deepEqual(response, { ok: false, error: "unsupported_message_type" });
});

test("identity init/get flow works", async () => {
  const init = await dispatchMessage("mc:init-identity", { displayName: "" });
  assert.equal(init.ok, true);
  assert.ok(init.identity?.privateKeyArmored);
  assert.equal(mock.state.get(STORAGE.SETTINGS).needsBackupAcknowledgement, true);

  const get = await dispatchMessage("mc:get-identity");
  assert.equal(get.ok, true);
  assert.equal(get.identity.fingerprintFull, init.identity.fingerprintFull);
  assert.equal(get.identity.privateKeyArmored, undefined, "mc:get-identity must not expose private key");
});

test("set-backup-acknowledged clears persisted backup requirement", async () => {
  await dispatchMessage("mc:init-identity", { displayName: "" });
  assert.equal(mock.state.get(STORAGE.SETTINGS).needsBackupAcknowledgement, true);

  const response = await dispatchMessage("mc:set-backup-acknowledged", { acknowledged: true });
  assert.equal(response.ok, true);
  assert.equal(response.settings.needsBackupAcknowledgement, false);
  assert.equal(mock.state.get(STORAGE.SETTINGS).needsBackupAcknowledgement, false);
});

test("import-identity clears backup acknowledgement requirement", async () => {
  await dispatchMessage("mc:init-identity", { displayName: "" });
  assert.equal(mock.state.get(STORAGE.SETTINGS).needsBackupAcknowledgement, true);

  const generated = await generateIdentity("");
  const response = await dispatchMessage("mc:import-identity", {
    privateKeyArmored: generated.privateKeyArmored
  });
  assert.equal(response.ok, true);
  assert.equal(mock.state.get(STORAGE.SETTINGS).needsBackupAcknowledgement, false);
});

test("mc:open-popup calls chrome.action.openPopup", async () => {
  const response = await dispatchMessage("mc:open-popup");
  assert.equal(response.ok, true);
  assert.equal(mock.openPopupCalls, 1);
});

test("mc:get-private-key returns private key separately", async () => {
  await dispatchMessage("mc:init-identity", { displayName: "" });
  const result = await dispatchMessage("mc:get-private-key");
  assert.equal(result.ok, true);
  assert.ok(result.privateKeyArmored);
});

test("mc:get-private-key returns error when no identity exists", async () => {
  const result = await dispatchMessage("mc:get-private-key");
  assert.equal(result.ok, false);
  assert.equal(result.error, "no_identity");
});

test("upsert-binding trims account id and persists by normalized key", async () => {
  const response = await dispatchMessage("mc:upsert-binding", {
    platform: PLATFORM.VK,
    accountId: "  500  ",
    displayName: "Alice"
  });

  assert.equal(response.ok, true);
  assert.equal(response.binding.accountId, "500");
  assert.equal(response.binding.schemaVersion, 1);
  assert.equal(mock.state.has(`${STORAGE.BINDING_PREFIX}${PLATFORM.VK}:500`), true);
});

test("sync-contact-profile stores known dialog display name without requiring a key", async () => {
  const response = await dispatchMessage("mc:sync-contact-profile", {
    platform: PLATFORM.VK,
    accountId: " 700 ",
    displayName: "VK Support"
  });

  assert.equal(response.ok, true);
  assert.equal(response.contact.accountId, "700");
  assert.equal(response.contact.displayName, "VK Support");
  assert.equal(response.contact.schemaVersion, 1);
  assert.equal(response.contact.trustState, TRUST.MISSING);
  assert.equal(mock.state.get(`${STORAGE.CONTACT_PREFIX}${PLATFORM.VK}:700`).displayName, "VK Support");
});

test("sync-contact-profile does not overwrite existing key and trust fields", async () => {
  mock.state.set(`${STORAGE.CONTACT_PREFIX}${PLATFORM.VK}:701`, {
    schemaVersion: 1,
    platform: PLATFORM.VK,
    accountId: "701",
    displayName: "Old Name",
    publicKeyArmored: "PUBKEY",
    fingerprintFull: "A".repeat(40),
    fingerprintShort: "AAAA AAAA AAAA",
    trustState: TRUST.TRUSTED,
    firstSeenAt: "2026-03-20T00:00:00.000Z",
    lastUpdatedAt: "2026-03-20T00:00:00.000Z",
    hasKeyConflict: false,
    previousFingerprintFull: null
  });

  const response = await dispatchMessage("mc:sync-contact-profile", {
    platform: PLATFORM.VK,
    accountId: "701",
    displayName: "New Name"
  });

  assert.equal(response.ok, true);
  assert.equal(response.contact.displayName, "New Name");
  assert.equal(response.contact.trustState, TRUST.TRUSTED);
  assert.equal(response.contact.publicKeyArmored, "PUBKEY");
  assert.equal(response.contact.fingerprintFull, "A".repeat(40));
});

test("list-contacts returns stored contacts without unrelated records", async () => {
  mock.state.set(STORAGE.IDENTITY, { fingerprintFull: "IDENTITY" });
  mock.state.set(`${STORAGE.CONTACT_PREFIX}${PLATFORM.VK}:700`, {
    schemaVersion: 1,
    platform: PLATFORM.VK,
    accountId: "700",
    displayName: "Бета",
    trustState: TRUST.NEW
  });
  mock.state.set(`${STORAGE.CONTACT_PREFIX}${PLATFORM.VK}:701`, {
    schemaVersion: 1,
    platform: PLATFORM.VK,
    accountId: "701",
    displayName: "Альфа",
    trustState: TRUST.TRUSTED
  });

  const response = await dispatchMessage("mc:list-contacts");

  assert.equal(response.ok, true);
  assert.deepEqual(response.contacts.map((contact) => contact.accountId), ["701", "700"]);
});

test("remove-contact deletes stored contact by normalized account id", async () => {
  const key = `${STORAGE.CONTACT_PREFIX}${PLATFORM.VK}:700`;
  mock.state.set(key, {
    schemaVersion: 1,
    platform: PLATFORM.VK,
    accountId: "700",
    displayName: "Contact",
    trustState: TRUST.NEW
  });

  const response = await dispatchMessage("mc:remove-contact", {
    platform: PLATFORM.VK,
    accountId: " 700 "
  }, {
    url: "chrome-extension://mockid/src/options/options.html"
  });

  assert.equal(response.ok, true);
  assert.equal(mock.state.has(key), false);
});

test("remove-contact rejects requests outside options page", async () => {
  const key = `${STORAGE.CONTACT_PREFIX}${PLATFORM.VK}:700`;
  mock.state.set(key, {
    schemaVersion: 1,
    platform: PLATFORM.VK,
    accountId: "700",
    displayName: "Contact",
    trustState: TRUST.NEW
  });

  const response = await dispatchMessage("mc:remove-contact", {
    platform: PLATFORM.VK,
    accountId: "700"
  }, {
    url: "https://vk.com/im?sel=700"
  });

  assert.equal(response.ok, false);
  assert.equal(response.error, "remove_contact_requires_options_page");
  assert.equal(mock.state.has(key), true);
});

test("create-key-announcement requires initialized identity", async () => {
  const missingIdentity = await dispatchMessage("mc:create-key-announcement", {
    platform: PLATFORM.VK,
    accountId: "100",
    displayName: ""
  });
  assert.equal(missingIdentity.ok, false);
  assert.match(missingIdentity.error, /identity not initialized/);

  const init = await dispatchMessage("mc:init-identity", { displayName: "" });
  const created = await dispatchMessage("mc:create-key-announcement", {
    platform: PLATFORM.VK,
    accountId: "100",
    displayName: ""
  });
  assert.equal(created.ok, true);
  assert.ok(created.text.startsWith(PROTOCOL.INVITE_LINE));
  assert.equal(created.payload.publicKeyArmored, init.identity.publicKeyArmored);
});

test("mark-own-key-shared stores local fingerprint marker on contact", async () => {
  const init = await dispatchMessage("mc:init-identity", { displayName: "" });
  const response = await dispatchMessage("mc:mark-own-key-shared", {
    platform: PLATFORM.VK,
    accountId: "205"
  });

  assert.equal(response.ok, true);
  assert.equal(response.contact.accountId, "205");
  assert.equal(response.contact.lastOwnKeyFingerprintShared, init.identity.fingerprintFull);
  assert.ok(response.contact.lastOwnKeySharedAt);
});

test("process-outgoing returns plaintext when contact key is missing", async () => {
  await dispatchMessage("mc:init-identity", { displayName: "" });

  const result = await dispatchMessage("mc:process-outgoing", {
    platform: PLATFORM.VK,
    accountId: "200",
    senderAccountId: "100",
    body: "hello"
  });

  assert.deepEqual(result, {
    ok: true,
    mode: "plaintext",
    text: "hello",
    trustState: TRUST.MISSING
  });
});

test("process-outgoing returns plaintext when contact key is rejected", async () => {
  await dispatchMessage("mc:init-identity", { displayName: "" });
  const remote = await generateIdentity("");
  mock.state.set(`${STORAGE.CONTACT_PREFIX}${PLATFORM.VK}:209`, {
    schemaVersion: 1,
    platform: PLATFORM.VK,
    accountId: "209",
    displayName: "Rejected Contact",
    publicKeyArmored: remote.publicKeyArmored,
    fingerprintFull: remote.fingerprintFull,
    fingerprintShort: remote.fingerprintShort,
    trustState: TRUST.REJECTED,
    firstSeenAt: "2026-03-20T00:00:00.000Z",
    lastUpdatedAt: "2026-03-20T00:00:00.000Z",
    hasKeyConflict: false,
    previousFingerprintFull: null
  });

  const result = await dispatchMessage("mc:process-outgoing", {
    platform: PLATFORM.VK,
    accountId: "209",
    senderAccountId: "100",
    body: "hello"
  });

  assert.deepEqual(result, {
    ok: true,
    mode: "plaintext",
    text: "hello",
    trustState: TRUST.REJECTED
  });
});

test("get-chat-state normalizes missing trust to known when contact key exists", async () => {
  const remote = await generateIdentity("");
  mock.state.set(`${STORAGE.CONTACT_PREFIX}${PLATFORM.VK}:201`, {
    schemaVersion: 1,
    platform: PLATFORM.VK,
    accountId: "201",
    displayName: "Legacy Contact",
    publicKeyArmored: remote.publicKeyArmored,
    fingerprintFull: remote.fingerprintFull,
    fingerprintShort: remote.fingerprintShort,
    trustState: TRUST.MISSING,
    firstSeenAt: "2026-03-20T00:00:00.000Z",
    lastUpdatedAt: "2026-03-20T00:00:00.000Z",
    hasKeyConflict: false,
    previousFingerprintFull: null
  });

  const state = await dispatchMessage("mc:get-chat-state", {
    platform: PLATFORM.VK,
    accountId: "201"
  });

  assert.equal(state.ok, true);
  assert.equal(state.hasKey, true);
  assert.equal(state.trustState, TRUST.NEW);
});

test("process-outgoing blocks encryption when contact key exists but trust is still new", async () => {
  await dispatchMessage("mc:init-identity", { displayName: "" });
  const remote = await generateIdentity("");
  mock.state.set(`${STORAGE.CONTACT_PREFIX}${PLATFORM.VK}:202`, {
    schemaVersion: 1,
    platform: PLATFORM.VK,
    accountId: "202",
    displayName: "Legacy Contact",
    publicKeyArmored: remote.publicKeyArmored,
    fingerprintFull: remote.fingerprintFull,
    fingerprintShort: remote.fingerprintShort,
    trustState: TRUST.MISSING,
    firstSeenAt: "2026-03-20T00:00:00.000Z",
    lastUpdatedAt: "2026-03-20T00:00:00.000Z",
    hasKeyConflict: false,
    previousFingerprintFull: null
  });

  const result = await dispatchMessage("mc:process-outgoing", {
    platform: PLATFORM.VK,
    accountId: "202",
    senderAccountId: "100",
    body: "encrypt despite legacy missing trust"
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "blocked");
  assert.equal(result.reason, "untrusted_key");
  assert.match(result.message, /еще не проверен|доверенный/i);
});

test("get-chat-state treats hasKeyConflict as changed even if stored trust state is known", async () => {
  const remote = await generateIdentity("");
  mock.state.set(`${STORAGE.CONTACT_PREFIX}${PLATFORM.VK}:203`, {
    schemaVersion: 1,
    platform: PLATFORM.VK,
    accountId: "203",
    displayName: "Conflict Contact",
    publicKeyArmored: remote.publicKeyArmored,
    fingerprintFull: remote.fingerprintFull,
    fingerprintShort: remote.fingerprintShort,
    trustState: TRUST.NEW,
    firstSeenAt: "2026-03-20T00:00:00.000Z",
    lastUpdatedAt: "2026-03-20T00:00:00.000Z",
    hasKeyConflict: true,
    previousFingerprintFull: "PREVIOUS"
  });

  const state = await dispatchMessage("mc:get-chat-state", {
    platform: PLATFORM.VK,
    accountId: "203"
  });

  assert.equal(state.ok, true);
  assert.equal(state.hasKey, true);
  assert.equal(state.trustState, TRUST.CHANGED);
});

test("process-outgoing blocks when hasKeyConflict is true even if stored trust state is known", async () => {
  await dispatchMessage("mc:init-identity", { displayName: "" });
  const remote = await generateIdentity("");
  mock.state.set(`${STORAGE.CONTACT_PREFIX}${PLATFORM.VK}:204`, {
    schemaVersion: 1,
    platform: PLATFORM.VK,
    accountId: "204",
    displayName: "Conflict Contact",
    publicKeyArmored: remote.publicKeyArmored,
    fingerprintFull: remote.fingerprintFull,
    fingerprintShort: remote.fingerprintShort,
    trustState: TRUST.NEW,
    firstSeenAt: "2026-03-20T00:00:00.000Z",
    lastUpdatedAt: "2026-03-20T00:00:00.000Z",
    hasKeyConflict: true,
    previousFingerprintFull: "PREVIOUS"
  });

  const result = await dispatchMessage("mc:process-outgoing", {
    platform: PLATFORM.VK,
    accountId: "204",
    senderAccountId: "100",
    body: "blocked due to unresolved conflict"
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "blocked");
  assert.equal(result.reason, "changed_key");
});

test("process-outgoing blocks when sender account id is missing for encrypted path", async () => {
  const local = await dispatchMessage("mc:init-identity", { displayName: "" });
  const remote = await generateIdentity("");
  const keyAnnouncementText = await createSignedAnnouncement({
    accountId: "200",
    identity: remote
  });
  const incoming = await dispatchMessage("mc:process-incoming", {
    platform: PLATFORM.VK,
    dialogAccountId: "200",
    messageAuthorAccountId: "200",
    localAccountId: "100",
    rawText: keyAnnouncementText
  });
  assert.equal(incoming.ok, true);
  assert.equal(incoming.kind, "key");
  assert.equal(local.ok, true);
  const trustUpdated = await dispatchMessage("mc:set-trust", {
    platform: PLATFORM.VK,
    accountId: "200",
    trustState: TRUST.TRUSTED
  });
  assert.equal(trustUpdated.ok, true);

  const blocked = await dispatchMessage("mc:process-outgoing", {
    platform: PLATFORM.VK,
    accountId: "200",
    senderAccountId: "",
    body: "hello"
  });

  assert.equal(blocked.ok, true);
  assert.equal(blocked.mode, "blocked");
  assert.equal(blocked.reason, "missing_sender_account");
});

test("process-outgoing warning threshold uses UTF-8 bytes", async () => {
  await dispatchMessage("mc:init-identity", { displayName: "" });
  const remote = await generateIdentity("");
  const keyAnnouncementText = await createSignedAnnouncement({
    accountId: "201",
    identity: remote
  });
  const incoming = await dispatchMessage("mc:process-incoming", {
    platform: PLATFORM.VK,
    dialogAccountId: "201",
    messageAuthorAccountId: "201",
    localAccountId: "100",
    rawText: keyAnnouncementText
  });
  assert.equal(incoming.ok, true);
  assert.equal(incoming.kind, "key");
  const trustUpdated = await dispatchMessage("mc:set-trust", {
    platform: PLATFORM.VK,
    accountId: "201",
    trustState: TRUST.TRUSTED
  });
  assert.equal(trustUpdated.ok, true);

  const outgoing = await dispatchMessage("mc:process-outgoing", {
    platform: PLATFORM.VK,
    accountId: "201",
    senderAccountId: "100",
    body: "Ж".repeat(910)
  });
  assert.equal(outgoing.ok, true);
  assert.equal(outgoing.mode, "encrypted");
  assert.equal(outgoing.warning, "size_warning");
});

test("process-outgoing warning threshold respects saved settings value", async () => {
  await dispatchMessage("mc:init-identity", { displayName: "" });
  const remote = await generateIdentity("");
  const keyAnnouncementText = await createSignedAnnouncement({
    accountId: "206",
    identity: remote
  });
  const incoming = await dispatchMessage("mc:process-incoming", {
    platform: PLATFORM.VK,
    dialogAccountId: "206",
    messageAuthorAccountId: "206",
    localAccountId: "100",
    rawText: keyAnnouncementText
  });
  assert.equal(incoming.ok, true);
  assert.equal(incoming.kind, "key");
  const trustUpdated = await dispatchMessage("mc:set-trust", {
    platform: PLATFORM.VK,
    accountId: "206",
    trustState: TRUST.TRUSTED
  });
  assert.equal(trustUpdated.ok, true);

  const thresholdSaved = await dispatchMessage("mc:set-warning-threshold", {
    warningThresholdChars: 10
  });
  assert.equal(thresholdSaved.ok, true);

  const outgoing = await dispatchMessage("mc:process-outgoing", {
    platform: PLATFORM.VK,
    accountId: "206",
    senderAccountId: "100",
    body: "1234567890"
  });
  assert.equal(outgoing.ok, true);
  assert.equal(outgoing.mode, "encrypted");
  assert.equal(outgoing.warning, "size_warning");
});

test("incoming key result reports when own key was already shared earlier", async () => {
  const init = await dispatchMessage("mc:init-identity", { displayName: "" });
  const remote = await generateIdentity("");
  mock.state.set(`${STORAGE.CONTACT_PREFIX}${PLATFORM.VK}:208`, {
    schemaVersion: 1,
    platform: PLATFORM.VK,
    accountId: "208",
    trustState: TRUST.MISSING,
    lastOwnKeyFingerprintShared: init.identity.fingerprintFull,
    lastOwnKeySharedAt: "2026-03-20T00:00:00.000Z"
  });

  const keyAnnouncementText = await createSignedAnnouncement({
    accountId: "208",
    identity: remote
  });
  const incoming = await dispatchMessage("mc:process-incoming", {
    platform: PLATFORM.VK,
    dialogAccountId: "208",
    messageAuthorAccountId: "208",
    localAccountId: "100",
    rawText: keyAnnouncementText
  });

  assert.equal(incoming.ok, true);
  assert.equal(incoming.kind, "key");
  assert.equal(incoming.trustState, TRUST.NEW);
  assert.equal(incoming.ownKeyAlreadyShared, true);
});

test("key rotation marks contact as changed and blocks encrypted send", async () => {
  await dispatchMessage("mc:init-identity", { displayName: "" });
  const firstIdentity = await generateIdentity("");
  const secondIdentity = await generateIdentity("");

  const firstAnnouncement = await createSignedAnnouncement({
    accountId: "300",
    identity: firstIdentity
  });
  const firstResult = await dispatchMessage("mc:process-incoming", {
    platform: PLATFORM.VK,
    dialogAccountId: "300",
    messageAuthorAccountId: "300",
    localAccountId: "100",
    rawText: firstAnnouncement
  });
  assert.equal(firstResult.kind, "key");
  assert.equal(firstResult.trustState, TRUST.NEW);

  const secondAnnouncement = await createSignedAnnouncement({
    accountId: "300",
    identity: secondIdentity
  });
  const secondResult = await dispatchMessage("mc:process-incoming", {
    platform: PLATFORM.VK,
    dialogAccountId: "300",
    messageAuthorAccountId: "300",
    localAccountId: "100",
    rawText: secondAnnouncement
  });
  assert.equal(secondResult.kind, "key");
  assert.equal(secondResult.trustState, TRUST.CHANGED);
  assert.equal(secondResult.eventType, INTERNAL_ERROR.CONTACT_KEY_CONFLICT);

  const outgoing = await dispatchMessage("mc:process-outgoing", {
    platform: PLATFORM.VK,
    accountId: "300",
    senderAccountId: "100",
    body: "do not encrypt"
  });
  assert.equal(outgoing.ok, true);
  assert.equal(outgoing.mode, "blocked");
  assert.equal(outgoing.reason, "changed_key");
  assert.match(outgoing.message, /могут стать недоступны/i);
});

test("older key announcements are ignored when a newer announcement id is already stored", async () => {
  await dispatchMessage("mc:init-identity", { displayName: "" });
  const firstIdentity = await generateIdentity("");
  const secondIdentity = await generateIdentity("");

  const firstAnnouncement = await createSignedAnnouncement({
    accountId: "306",
    identity: firstIdentity
  });
  const firstResult = await dispatchMessage("mc:process-incoming", {
    platform: PLATFORM.VK,
    dialogAccountId: "306",
    messageAuthorAccountId: "306",
    localAccountId: "100",
    messageId: "200",
    rawText: firstAnnouncement
  });
  assert.equal(firstResult.ok, true);
  assert.equal(firstResult.kind, "key");
  assert.equal(firstResult.trustState, TRUST.NEW);

  const secondAnnouncement = await createSignedAnnouncement({
    accountId: "306",
    identity: secondIdentity
  });
  const secondResult = await dispatchMessage("mc:process-incoming", {
    platform: PLATFORM.VK,
    dialogAccountId: "306",
    messageAuthorAccountId: "306",
    localAccountId: "100",
    messageId: "300",
    rawText: secondAnnouncement
  });
  assert.equal(secondResult.ok, true);
  assert.equal(secondResult.kind, "key");
  assert.equal(secondResult.trustState, TRUST.CHANGED);

  const accepted = await dispatchMessage("mc:set-trust", {
    platform: PLATFORM.VK,
    accountId: "306",
    trustState: TRUST.NEW
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.contact.trustState, TRUST.NEW);
  assert.equal(accepted.contact.hasKeyConflict, false);

  const staleReplay = await dispatchMessage("mc:process-incoming", {
    platform: PLATFORM.VK,
    dialogAccountId: "306",
    messageAuthorAccountId: "306",
    localAccountId: "100",
    messageId: "100",
    rawText: firstAnnouncement
  });
  assert.equal(staleReplay.ok, true);
  assert.equal(staleReplay.kind, "key_ignored_stale");
  assert.equal(staleReplay.reason, "stale_announcement");

  const stored = mock.state.get(`${STORAGE.CONTACT_PREFIX}${PLATFORM.VK}:306`);
  assert.equal(stored.trustState, TRUST.NEW);
  assert.equal(stored.hasKeyConflict, false);
  assert.equal(stored.fingerprintFull, secondIdentity.fingerprintFull);
  assert.equal(stored.lastAnnouncementMessageId, "300");
});

test("legacy contact without fingerprint enters changed state when announced key differs", async () => {
  await dispatchMessage("mc:init-identity", { displayName: "" });
  const firstIdentity = await generateIdentity("");
  const secondIdentity = await generateIdentity("");

  mock.state.set(`${STORAGE.CONTACT_PREFIX}${PLATFORM.VK}:307`, {
    schemaVersion: 1,
    platform: PLATFORM.VK,
    accountId: "307",
    displayName: "Legacy Contact",
    publicKeyArmored: firstIdentity.publicKeyArmored,
    fingerprintFull: "",
    fingerprintShort: "",
    trustState: TRUST.TRUSTED,
    firstSeenAt: "2026-03-20T00:00:00.000Z",
    lastUpdatedAt: "2026-03-20T00:00:00.000Z",
    hasKeyConflict: false,
    previousFingerprintFull: null
  });

  const secondAnnouncement = await createSignedAnnouncement({
    accountId: "307",
    identity: secondIdentity
  });
  const result = await dispatchMessage("mc:process-incoming", {
    platform: PLATFORM.VK,
    dialogAccountId: "307",
    messageAuthorAccountId: "307",
    localAccountId: "100",
    rawText: secondAnnouncement
  });

  assert.equal(result.ok, true);
  assert.equal(result.kind, "key");
  assert.equal(result.trustState, TRUST.CHANGED);
  assert.equal(result.eventType, INTERNAL_ERROR.CONTACT_KEY_CONFLICT);

  const stored = mock.state.get(`${STORAGE.CONTACT_PREFIX}${PLATFORM.VK}:307`);
  assert.equal(stored.trustState, TRUST.CHANGED);
  assert.equal(stored.hasKeyConflict, true);
  assert.equal(stored.previousFingerprintFull, firstIdentity.fingerprintFull);
});

test("legacy contact without fingerprint remains trusted when same key is reannounced", async () => {
  await dispatchMessage("mc:init-identity", { displayName: "" });
  const identity = await generateIdentity("");

  mock.state.set(`${STORAGE.CONTACT_PREFIX}${PLATFORM.VK}:308`, {
    schemaVersion: 1,
    platform: PLATFORM.VK,
    accountId: "308",
    displayName: "Legacy Contact",
    publicKeyArmored: identity.publicKeyArmored,
    fingerprintFull: "",
    fingerprintShort: "",
    trustState: TRUST.TRUSTED,
    firstSeenAt: "2026-03-20T00:00:00.000Z",
    lastUpdatedAt: "2026-03-20T00:00:00.000Z",
    hasKeyConflict: false,
    previousFingerprintFull: null
  });

  const announcement = await createSignedAnnouncement({
    accountId: "308",
    identity
  });
  const result = await dispatchMessage("mc:process-incoming", {
    platform: PLATFORM.VK,
    dialogAccountId: "308",
    messageAuthorAccountId: "308",
    localAccountId: "100",
    rawText: announcement
  });

  assert.equal(result.ok, true);
  assert.equal(result.kind, "key");
  assert.equal(result.trustState, TRUST.TRUSTED);
  assert.equal(result.eventType, null);

  const stored = mock.state.get(`${STORAGE.CONTACT_PREFIX}${PLATFORM.VK}:308`);
  assert.equal(stored.trustState, TRUST.TRUSTED);
  assert.equal(stored.hasKeyConflict, false);
  assert.equal(stored.fingerprintFull, identity.fingerprintFull);
});

test("same new key reannouncement keeps unresolved changed-key conflict markers", async () => {
  await dispatchMessage("mc:init-identity", { displayName: "" });
  const firstIdentity = await generateIdentity("");
  const secondIdentity = await generateIdentity("");

  const firstAnnouncement = await createSignedAnnouncement({
    accountId: "306",
    identity: firstIdentity
  });
  await dispatchMessage("mc:process-incoming", {
    platform: PLATFORM.VK,
    dialogAccountId: "306",
    messageAuthorAccountId: "306",
    localAccountId: "100",
    rawText: firstAnnouncement
  });

  const secondAnnouncement = await createSignedAnnouncement({
    accountId: "306",
    identity: secondIdentity
  });
  const changed = await dispatchMessage("mc:process-incoming", {
    platform: PLATFORM.VK,
    dialogAccountId: "306",
    messageAuthorAccountId: "306",
    localAccountId: "100",
    rawText: secondAnnouncement
  });
  assert.equal(changed.ok, true);
  assert.equal(changed.kind, "key");
  assert.equal(changed.trustState, TRUST.CHANGED);

  const repeated = await dispatchMessage("mc:process-incoming", {
    platform: PLATFORM.VK,
    dialogAccountId: "306",
    messageAuthorAccountId: "306",
    localAccountId: "100",
    rawText: secondAnnouncement
  });
  assert.equal(repeated.ok, true);
  assert.equal(repeated.kind, "key");
  assert.equal(repeated.trustState, TRUST.CHANGED);
  assert.equal(repeated.eventType, null);

  const stored = mock.state.get(`${STORAGE.CONTACT_PREFIX}${PLATFORM.VK}:306`);
  assert.equal(stored.trustState, TRUST.CHANGED);
  assert.equal(stored.hasKeyConflict, true);
  assert.equal(stored.previousFingerprintFull, firstIdentity.fingerprintFull);
});

test("same-key reannouncement keeps unresolved conflict when legacy record has conflict marker", async () => {
  await dispatchMessage("mc:init-identity", { displayName: "" });
  const firstIdentity = await generateIdentity("");
  const secondIdentity = await generateIdentity("");

  mock.state.set(`${STORAGE.CONTACT_PREFIX}${PLATFORM.VK}:309`, {
    schemaVersion: 1,
    platform: PLATFORM.VK,
    accountId: "309",
    displayName: "Legacy Conflict Contact",
    publicKeyArmored: secondIdentity.publicKeyArmored,
    fingerprintFull: secondIdentity.fingerprintFull,
    fingerprintShort: secondIdentity.fingerprintShort,
    trustState: TRUST.NEW,
    firstSeenAt: "2026-03-20T00:00:00.000Z",
    lastUpdatedAt: "2026-03-20T00:00:00.000Z",
    hasKeyConflict: true,
    previousFingerprintFull: firstIdentity.fingerprintFull
  });

  const secondAnnouncement = await createSignedAnnouncement({
    accountId: "309",
    identity: secondIdentity
  });
  const repeated = await dispatchMessage("mc:process-incoming", {
    platform: PLATFORM.VK,
    dialogAccountId: "309",
    messageAuthorAccountId: "309",
    localAccountId: "100",
    rawText: secondAnnouncement
  });

  assert.equal(repeated.ok, true);
  assert.equal(repeated.kind, "key");
  assert.equal(repeated.trustState, TRUST.CHANGED);
  assert.equal(repeated.eventType, null);

  const stored = mock.state.get(`${STORAGE.CONTACT_PREFIX}${PLATFORM.VK}:309`);
  assert.equal(stored.trustState, TRUST.CHANGED);
  assert.equal(stored.hasKeyConflict, true);
  assert.equal(stored.previousFingerprintFull, firstIdentity.fingerprintFull);
});

test("same-key reannouncement preserves trusted state", async () => {
  await dispatchMessage("mc:init-identity", { displayName: "" });
  const remoteIdentity = await generateIdentity("");

  const firstAnnouncement = await createSignedAnnouncement({
    accountId: "305",
    identity: remoteIdentity
  });
  const firstResult = await dispatchMessage("mc:process-incoming", {
    platform: PLATFORM.VK,
    dialogAccountId: "305",
    messageAuthorAccountId: "305",
    localAccountId: "100",
    rawText: firstAnnouncement
  });
  assert.equal(firstResult.ok, true);
  assert.equal(firstResult.kind, "key");
  assert.equal(firstResult.trustState, TRUST.NEW);

  const trusted = await dispatchMessage("mc:set-trust", {
    platform: PLATFORM.VK,
    accountId: "305",
    trustState: TRUST.TRUSTED
  });
  assert.equal(trusted.ok, true);
  assert.equal(trusted.contact.trustState, TRUST.TRUSTED);

  const secondAnnouncement = await createSignedAnnouncement({
    accountId: "305",
    identity: remoteIdentity
  });
  const secondResult = await dispatchMessage("mc:process-incoming", {
    platform: PLATFORM.VK,
    dialogAccountId: "305",
    messageAuthorAccountId: "305",
    localAccountId: "100",
    rawText: secondAnnouncement
  });

  assert.equal(secondResult.ok, true);
  assert.equal(secondResult.kind, "key");
  assert.equal(secondResult.trustState, TRUST.TRUSTED);
  assert.equal(secondResult.eventType, null);

  const stored = mock.state.get(`${STORAGE.CONTACT_PREFIX}${PLATFORM.VK}:305`);
  assert.equal(stored.trustState, TRUST.TRUSTED);
  assert.equal(stored.hasKeyConflict, false);
});

test("same-key reannouncement preserves rejected state", async () => {
  await dispatchMessage("mc:init-identity", { displayName: "" });
  const remoteIdentity = await generateIdentity("");

  const firstAnnouncement = await createSignedAnnouncement({
    accountId: "315",
    identity: remoteIdentity
  });
  const firstResult = await dispatchMessage("mc:process-incoming", {
    platform: PLATFORM.VK,
    dialogAccountId: "315",
    messageAuthorAccountId: "315",
    localAccountId: "100",
    rawText: firstAnnouncement
  });
  assert.equal(firstResult.ok, true);
  assert.equal(firstResult.kind, "key");
  assert.equal(firstResult.trustState, TRUST.NEW);

  const rejected = await dispatchMessage("mc:set-trust", {
    platform: PLATFORM.VK,
    accountId: "315",
    trustState: TRUST.REJECTED
  });
  assert.equal(rejected.ok, true);
  assert.equal(rejected.contact.trustState, TRUST.REJECTED);

  const secondAnnouncement = await createSignedAnnouncement({
    accountId: "315",
    identity: remoteIdentity
  });
  const secondResult = await dispatchMessage("mc:process-incoming", {
    platform: PLATFORM.VK,
    dialogAccountId: "315",
    messageAuthorAccountId: "315",
    localAccountId: "100",
    rawText: secondAnnouncement
  });

  assert.equal(secondResult.ok, true);
  assert.equal(secondResult.kind, "key");
  assert.equal(secondResult.trustState, TRUST.REJECTED);
  assert.equal(secondResult.eventType, null);

  const stored = mock.state.get(`${STORAGE.CONTACT_PREFIX}${PLATFORM.VK}:315`);
  assert.equal(stored.trustState, TRUST.REJECTED);
  assert.equal(stored.hasKeyConflict, false);
});

test("process-incoming marks unsupported wrappers as unsupported_version", async () => {
  await dispatchMessage("mc:init-identity", { displayName: "" });

  const result = await dispatchMessage("mc:process-incoming", {
    platform: PLATFORM.VK,
    dialogAccountId: "200",
    messageAuthorAccountId: "200",
    localAccountId: "100",
    rawText: "CHEBURCHAT:v2:msg:abc"
  });

  assert.equal(result.ok, true);
  assert.equal(result.kind, "unsupported_version");
  assert.equal(result.errorType, INTERNAL_ERROR.UNSUPPORTED_PROTOCOL_VERSION);
});

test("process-incoming returns identity_missing for wrapped payloads when identity is not initialized", async () => {
  const result = await dispatchMessage("mc:process-incoming", {
    platform: PLATFORM.VK,
    dialogAccountId: "200",
    messageAuthorAccountId: "200",
    localAccountId: "100",
    rawText: `${PROTOCOL.MSG_PREFIX}abc`
  });

  assert.equal(result.ok, true);
  assert.equal(result.kind, "identity_missing");
});

test("process-incoming keeps malformed unknown-version wrappers in unsupported_version", async () => {
  await dispatchMessage("mc:init-identity", { displayName: "" });

  const result = await dispatchMessage("mc:process-incoming", {
    platform: PLATFORM.VK,
    dialogAccountId: "200",
    messageAuthorAccountId: "200",
    localAccountId: "100",
    rawText: "CHEBURCHAT:v2:msg:abc."
  });

  assert.equal(result.ok, true);
  assert.equal(result.kind, "unsupported_version");
  assert.equal(result.errorType, INTERNAL_ERROR.UNSUPPORTED_PROTOCOL_VERSION);
});

test("process-incoming classifies malformed encrypted wrappers as decrypt_failed", async () => {
  await dispatchMessage("mc:init-identity", { displayName: "" });

  const result = await dispatchMessage("mc:process-incoming", {
    platform: PLATFORM.VK,
    dialogAccountId: "200",
    messageAuthorAccountId: "200",
    localAccountId: "100",
    rawText: `${PROTOCOL.MSG_PREFIX}abc.`
  });

  assert.equal(result.ok, true);
  assert.equal(result.kind, "decrypt_failed");
  assert.equal(result.errorType, INTERNAL_ERROR.PAYLOAD_DECODE_FAILURE);
});

test("process-incoming returns decrypt_failed when message author account id is missing", async () => {
  await dispatchMessage("mc:init-identity", { displayName: "" });

  const result = await dispatchMessage("mc:process-incoming", {
    platform: PLATFORM.VK,
    dialogAccountId: "200",
    messageAuthorAccountId: "",
    localAccountId: "100",
    rawText: `${PROTOCOL.MSG_PREFIX}abc`
  });

  assert.equal(result.ok, true);
  assert.equal(result.kind, "decrypt_failed");
  assert.equal(result.reason, "missing_author_id");
  assert.equal(result.errorType, INTERNAL_ERROR.STORAGE_MISMATCH);
});

test("process-incoming returns invalid_key for malformed key wrapper payload", async () => {
  await dispatchMessage("mc:init-identity", { displayName: "" });

  const malformedKeyText = `${PROTOCOL.INVITE_LINE}\n${PROTOCOL.KEY_PREFIX}abc.`;
  const result = await dispatchMessage("mc:process-incoming", {
    platform: PLATFORM.VK,
    dialogAccountId: "200",
    messageAuthorAccountId: "200",
    localAccountId: "100",
    rawText: malformedKeyText
  });

  assert.equal(result.ok, true);
  assert.equal(result.kind, "invalid_key");
  assert.equal(typeof result.reason, "string");
  assert.ok(result.reason.length > 0);
});

test("process-incoming validates key payload fields before signature verification", async () => {
  await dispatchMessage("mc:init-identity", { displayName: "" });

  const basePayload = {
    v: PROTOCOL.VERSION,
    platform: PLATFORM.VK,
    accountId: "202",
    publicKeyArmored: "pub",
    fingerprint: "ABCD",
    displayName: "",
    sig: "sig"
  };

  const cases = [
    {
      name: "unsupported_version",
      payload: { v: "v2" },
      authorId: "202",
      expectedReason: "unsupported_version",
      expectedErrorType: INTERNAL_ERROR.UNSUPPORTED_PROTOCOL_VERSION
    },
    {
      name: "invalid_account_id",
      payload: { accountId: 202 },
      authorId: "202",
      expectedReason: "invalid_account_id",
      expectedErrorType: INTERNAL_ERROR.PAYLOAD_DECODE_FAILURE
    },
    {
      name: "invalid_display_name",
      payload: { displayName: 123 },
      authorId: "202",
      expectedReason: "invalid_display_name",
      expectedErrorType: INTERNAL_ERROR.PAYLOAD_DECODE_FAILURE
    },
    {
      name: "invalid_public_key",
      payload: { publicKeyArmored: "" },
      authorId: "202",
      expectedReason: "invalid_public_key",
      expectedErrorType: INTERNAL_ERROR.PAYLOAD_DECODE_FAILURE
    },
    {
      name: "missing_signature",
      payload: { sig: "" },
      authorId: "202",
      expectedReason: "missing_signature",
      expectedErrorType: INTERNAL_ERROR.PAYLOAD_DECODE_FAILURE
    },
    {
      name: "platform_mismatch",
      payload: { platform: "telegram" },
      authorId: "202",
      expectedReason: "platform_mismatch",
      expectedErrorType: INTERNAL_ERROR.STORAGE_MISMATCH
    },
    {
      name: "author_mismatch",
      payload: { accountId: "999" },
      authorId: "202",
      expectedReason: "author_mismatch",
      expectedErrorType: INTERNAL_ERROR.STORAGE_MISMATCH
    }
  ];

  for (const testCase of cases) {
    const result = await dispatchMessage("mc:process-incoming", {
      platform: PLATFORM.VK,
      dialogAccountId: "202",
      messageAuthorAccountId: testCase.authorId,
      localAccountId: "100",
      rawText: buildKeyAnnouncementText({
        ...basePayload,
        ...testCase.payload
      })
    });

    assert.equal(result.ok, true, testCase.name);
    assert.equal(result.kind, "invalid_key", testCase.name);
    assert.equal(result.reason, testCase.expectedReason, testCase.name);
    assert.equal(result.errorType, testCase.expectedErrorType, testCase.name);
  }
});

test("process-incoming returns invalid_key for key announcement dialog mismatch", async () => {
  await dispatchMessage("mc:init-identity", { displayName: "" });
  const remote = await generateIdentity("");
  const announcement = await createSignedAnnouncement({
    accountId: "500",
    identity: remote
  });

  const result = await dispatchMessage("mc:process-incoming", {
    platform: PLATFORM.VK,
    dialogAccountId: "501",
    messageAuthorAccountId: "500",
    localAccountId: "100",
    rawText: announcement
  });

  assert.equal(result.ok, true);
  assert.equal(result.kind, "invalid_key");
  assert.equal(result.reason, "dialog_mismatch");
  assert.equal(result.errorType, INTERNAL_ERROR.STORAGE_MISMATCH);
});

test("process-incoming returns invalid_key for announcement signature mismatch", async () => {
  await dispatchMessage("mc:init-identity", { displayName: "" });
  const remote = await generateIdentity("");
  const validText = await createSignedAnnouncement({
    accountId: "202",
    identity: remote,
    displayName: "Alice"
  });
  const parsed = parseKeyAnnouncementText(validText);
  const tamperedPayload = {
    ...parsed.payload,
    displayName: "Mallory"
  };
  const tamperedText = buildKeyAnnouncementText(tamperedPayload);

  const result = await dispatchMessage("mc:process-incoming", {
    platform: PLATFORM.VK,
    dialogAccountId: "202",
    messageAuthorAccountId: "202",
    localAccountId: "100",
    rawText: tamperedText
  });

  assert.equal(result.ok, true);
  assert.equal(result.kind, "invalid_key");
  assert.equal(result.errorType, INTERNAL_ERROR.ANNOUNCEMENT_SIGNATURE_VERIFICATION_FAILURE);
});

test("process-incoming returns invalid_key for announcement fingerprint mismatch", async () => {
  await dispatchMessage("mc:init-identity", { displayName: "" });
  const remote = await generateIdentity("");
  const unsigned = {
    v: PROTOCOL.VERSION,
    platform: PLATFORM.VK,
    accountId: "202",
    publicKeyArmored: remote.publicKeyArmored,
    fingerprint: "F".repeat(40),
    displayName: "Alice"
  };
  const sig = await signAnnouncement(unsigned, remote.privateKeyArmored);
  const rawText = buildKeyAnnouncementText({ ...unsigned, sig });

  const result = await dispatchMessage("mc:process-incoming", {
    platform: PLATFORM.VK,
    dialogAccountId: "202",
    messageAuthorAccountId: "202",
    localAccountId: "100",
    rawText
  });

  assert.equal(result.ok, true);
  assert.equal(result.kind, "invalid_key");
  assert.equal(result.reason, "fingerprint_mismatch");
  assert.equal(result.errorType, INTERNAL_ERROR.PAYLOAD_DECODE_FAILURE);
});

test("process-incoming returns invalid_key when key announcement author account id is missing", async () => {
  await dispatchMessage("mc:init-identity", { displayName: "" });
  const remote = await generateIdentity("");
  const rawText = await createSignedAnnouncement({
    accountId: "202",
    identity: remote
  });

  const result = await dispatchMessage("mc:process-incoming", {
    platform: PLATFORM.VK,
    dialogAccountId: "202",
    messageAuthorAccountId: "",
    localAccountId: "100",
    rawText
  });

  assert.equal(result.ok, true);
  assert.equal(result.kind, "invalid_key");
  assert.equal(result.reason, "missing_author_id");
  assert.equal(result.errorType, INTERNAL_ERROR.STORAGE_MISMATCH);
});

test("process-incoming key stores normalized message id for announcement tracking", async () => {
  await dispatchMessage("mc:init-identity", { displayName: "" });
  const remote = await generateIdentity("");
  const announcement = await createSignedAnnouncement({
    accountId: "901",
    identity: remote
  });

  const processed = await dispatchMessage("mc:process-incoming", {
    platform: PLATFORM.VK,
    dialogAccountId: "901",
    messageAuthorAccountId: "901",
    localAccountId: "100",
    messageId: "msg_12345_tail",
    rawText: announcement
  });

  assert.equal(processed.ok, true);
  assert.equal(processed.kind, "key");
  const storedContact = mock.state.get(`${STORAGE.CONTACT_PREFIX}${PLATFORM.VK}:901`);
  assert.equal(storedContact.schemaVersion, 1);
  assert.equal(storedContact.lastAnnouncementMessageId, "12345");
});

test("process-incoming ignores self-authored key announcement for another dialog", async () => {
  const init = await dispatchMessage("mc:init-identity", { displayName: "" });
  const localIdentity = init.identity;
  const announcement = await createSignedAnnouncement({
    accountId: "100",
    identity: localIdentity
  });

  const processed = await dispatchMessage("mc:process-incoming", {
    platform: PLATFORM.VK,
    dialogAccountId: "200",
    messageAuthorAccountId: "100",
    localAccountId: "100",
    rawText: announcement
  });

  assert.equal(processed.ok, true);
  assert.equal(processed.kind, "key_self_announcement");
  assert.equal(mock.state.get(`${STORAGE.CONTACT_PREFIX}${PLATFORM.VK}:100`), undefined);
  const dialogContact = mock.state.get(`${STORAGE.CONTACT_PREFIX}${PLATFORM.VK}:200`);
  assert.equal(dialogContact.platform, PLATFORM.VK);
  assert.equal(dialogContact.accountId, "200");
  assert.equal(dialogContact.trustState, TRUST.MISSING);
  assert.equal(dialogContact.lastOwnKeyFingerprintShared, localIdentity.fingerprintFull);
  assert.ok(dialogContact.lastOwnKeySharedAt);
});

test("process-incoming rejects self-authored announcement when key does not match local identity", async () => {
  await dispatchMessage("mc:init-identity", { displayName: "" });
  const otherIdentity = await generateIdentity("");
  const announcement = await createSignedAnnouncement({
    accountId: "100",
    identity: otherIdentity
  });

  const processed = await dispatchMessage("mc:process-incoming", {
    platform: PLATFORM.VK,
    dialogAccountId: "200",
    messageAuthorAccountId: "100",
    localAccountId: "100",
    rawText: announcement
  });

  assert.equal(processed.ok, true);
  assert.equal(processed.kind, "invalid_key");
  assert.equal(processed.reason, "self_key_mismatch");
  assert.equal(processed.errorType, INTERNAL_ERROR.STORAGE_MISMATCH);
  assert.equal(mock.state.get(`${STORAGE.CONTACT_PREFIX}${PLATFORM.VK}:100`), undefined);
  assert.equal(mock.state.get(`${STORAGE.CONTACT_PREFIX}${PLATFORM.VK}:200`), undefined);
});

test("process-incoming classifies missing remote contact key as storage mismatch", async () => {
  const localInit = await dispatchMessage("mc:init-identity", { displayName: "" });
  const localIdentity = localInit.identity;
  const remoteIdentity = await generateIdentity("");
  const remoteEncrypted = await encryptMessage({
    body: "cannot verify without key",
    senderPlatform: PLATFORM.VK,
    senderAccountId: "777",
    senderPrivateKeyArmored: remoteIdentity.privateKeyArmored,
    recipientPublicKeyArmored: localIdentity.publicKeyArmored,
    selfPublicKeyArmored: remoteIdentity.publicKeyArmored
  });

  const result = await dispatchMessage("mc:process-incoming", {
    platform: PLATFORM.VK,
    dialogAccountId: "777",
    messageAuthorAccountId: "777",
    localAccountId: "100",
    rawText: buildEncryptedMessageText(remoteEncrypted.encoded)
  });

  assert.equal(result.ok, true);
  assert.equal(result.kind, "decrypt_failed");
  assert.equal(result.reason, "missing_contact_key");
  assert.equal(result.errorType, INTERNAL_ERROR.STORAGE_MISMATCH);
});

test("process-incoming rejects decrypted payload with invalid scalar fields", async () => {
  const localInit = await dispatchMessage("mc:init-identity", { displayName: "" });
  const localIdentity = localInit.identity;
  const remoteIdentity = await generateIdentity("");

  const keyAnnouncementText = await createSignedAnnouncement({
    accountId: "880",
    identity: remoteIdentity
  });
  const keyProcessed = await dispatchMessage("mc:process-incoming", {
    platform: PLATFORM.VK,
    dialogAccountId: "880",
    messageAuthorAccountId: "880",
    localAccountId: "100",
    rawText: keyAnnouncementText
  });
  assert.equal(keyProcessed.ok, true);
  assert.equal(keyProcessed.kind, "key");

  const cases = [
    {
      name: "invalid_platform",
      payload: {
        v: PROTOCOL.VERSION,
        platform: 123,
        accountId: "880",
        ts: new Date().toISOString(),
        body: "x"
      },
      expectedReason: "invalid_platform"
    },
    {
      name: "invalid_account_id",
      payload: {
        v: PROTOCOL.VERSION,
        platform: PLATFORM.VK,
        accountId: 880,
        ts: new Date().toISOString(),
        body: "x"
      },
      expectedReason: "invalid_account_id"
    },
    {
      name: "invalid_timestamp",
      payload: {
        v: PROTOCOL.VERSION,
        platform: PLATFORM.VK,
        accountId: "880",
        ts: "not-iso",
        body: "x"
      },
      expectedReason: "invalid_timestamp"
    },
    {
      name: "invalid_body",
      payload: {
        v: PROTOCOL.VERSION,
        platform: PLATFORM.VK,
        accountId: "880",
        ts: new Date().toISOString(),
        body: { text: "x" }
      },
      expectedReason: "invalid_body"
    }
  ];

  for (const testCase of cases) {
    const rawText = await buildSignedEncryptedRawText({
      payloadObject: testCase.payload,
      senderPrivateKeyArmored: remoteIdentity.privateKeyArmored,
      senderPublicKeyArmored: remoteIdentity.publicKeyArmored,
      recipientPublicKeyArmored: localIdentity.publicKeyArmored
    });

    const incoming = await dispatchMessage("mc:process-incoming", {
      platform: PLATFORM.VK,
      dialogAccountId: "880",
      messageAuthorAccountId: "880",
      localAccountId: "100",
      rawText
    });

    assert.equal(incoming.ok, true, testCase.name);
    assert.equal(incoming.kind, "decrypt_failed", testCase.name);
    assert.equal(incoming.reason, testCase.expectedReason, testCase.name);
    assert.equal(incoming.errorType, INTERNAL_ERROR.PAYLOAD_DECODE_FAILURE, testCase.name);
  }
});

test("process-incoming classifies encrypted signature mismatch", async () => {
  const localInit = await dispatchMessage("mc:init-identity", { displayName: "" });
  const localIdentity = localInit.identity;
  const remoteStoredIdentity = await generateIdentity("");
  const remoteActualSignerIdentity = await generateIdentity("");

  const keyAnnouncementText = await createSignedAnnouncement({
    accountId: "778",
    identity: remoteStoredIdentity
  });
  const keyProcessed = await dispatchMessage("mc:process-incoming", {
    platform: PLATFORM.VK,
    dialogAccountId: "778",
    messageAuthorAccountId: "778",
    localAccountId: "100",
    rawText: keyAnnouncementText
  });
  assert.equal(keyProcessed.ok, true);
  assert.equal(keyProcessed.kind, "key");

  const signedByDifferentKey = await encryptMessage({
    body: "signature mismatch",
    senderPlatform: PLATFORM.VK,
    senderAccountId: "778",
    senderPrivateKeyArmored: remoteActualSignerIdentity.privateKeyArmored,
    recipientPublicKeyArmored: localIdentity.publicKeyArmored,
    selfPublicKeyArmored: remoteActualSignerIdentity.publicKeyArmored
  });

  const incoming = await dispatchMessage("mc:process-incoming", {
    platform: PLATFORM.VK,
    dialogAccountId: "778",
    messageAuthorAccountId: "778",
    localAccountId: "100",
    rawText: buildEncryptedMessageText(signedByDifferentKey.encoded)
  });

  assert.equal(incoming.ok, true);
  assert.equal(incoming.kind, "decrypt_failed");
  assert.equal(incoming.errorType, INTERNAL_ERROR.ENCRYPTED_MESSAGE_SIGNATURE_VERIFICATION_FAILURE);
});

test("process-incoming returns sender_mismatch for remote author payload mismatch", async () => {
  const localInit = await dispatchMessage("mc:init-identity", { displayName: "" });
  const localIdentity = localInit.identity;
  const remoteIdentity = await generateIdentity("");

  const keyAnnouncementText = await createSignedAnnouncement({
    accountId: "881",
    identity: remoteIdentity
  });
  const keyProcessed = await dispatchMessage("mc:process-incoming", {
    platform: PLATFORM.VK,
    dialogAccountId: "881",
    messageAuthorAccountId: "881",
    localAccountId: "100",
    rawText: keyAnnouncementText
  });
  assert.equal(keyProcessed.ok, true);
  assert.equal(keyProcessed.kind, "key");

  const mismatchedAccount = await encryptMessage({
    body: "sender mismatch",
    senderPlatform: PLATFORM.VK,
    senderAccountId: "999",
    senderPrivateKeyArmored: remoteIdentity.privateKeyArmored,
    recipientPublicKeyArmored: localIdentity.publicKeyArmored,
    selfPublicKeyArmored: remoteIdentity.publicKeyArmored
  });

  const incoming = await dispatchMessage("mc:process-incoming", {
    platform: PLATFORM.VK,
    dialogAccountId: "881",
    messageAuthorAccountId: "881",
    localAccountId: "100",
    rawText: buildEncryptedMessageText(mismatchedAccount.encoded)
  });

  assert.equal(incoming.ok, true);
  assert.equal(incoming.kind, "decrypt_failed");
  assert.equal(incoming.reason, "sender_mismatch");
  assert.equal(incoming.errorType, INTERNAL_ERROR.STORAGE_MISMATCH);
});

test("process-outgoing exposes message_too_long classification", async () => {
  await dispatchMessage("mc:init-identity", { displayName: "" });
  const remote = await generateIdentity("");
  const keyAnnouncementText = await createSignedAnnouncement({
    accountId: "779",
    identity: remote
  });
  const incoming = await dispatchMessage("mc:process-incoming", {
    platform: PLATFORM.VK,
    dialogAccountId: "779",
    messageAuthorAccountId: "779",
    localAccountId: "100",
    rawText: keyAnnouncementText
  });
  assert.equal(incoming.ok, true);
  assert.equal(incoming.kind, "key");
  const trustUpdated = await dispatchMessage("mc:set-trust", {
    platform: PLATFORM.VK,
    accountId: "779",
    trustState: TRUST.TRUSTED
  });
  assert.equal(trustUpdated.ok, true);

  const blocked = await dispatchMessage("mc:process-outgoing", {
    platform: PLATFORM.VK,
    accountId: "779",
    senderAccountId: "100",
    body: "x".repeat(10000)
  });

  assert.equal(blocked.ok, true);
  assert.equal(blocked.mode, "blocked");
  assert.equal(blocked.reason, "too_long");
  assert.equal(blocked.errorType, INTERNAL_ERROR.MESSAGE_TOO_LONG);
});

test("process-incoming decrypts self-sent message using bound local account id", async () => {
  const localInit = await dispatchMessage("mc:init-identity", { displayName: "" });
  const localIdentity = localInit.identity;
  const remoteIdentity = await generateIdentity("");

  // Simulate a binding where runtime local id (999) maps to canonical account id (100).
  mock.state.set(`${STORAGE.BINDING_PREFIX}${PLATFORM.VK}:999`, {
    platform: PLATFORM.VK,
    accountId: "100",
    displayName: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });

  const selfSentEncrypted = await encryptMessage({
    body: "my own encrypted message",
    senderPlatform: PLATFORM.VK,
    senderAccountId: "100",
    senderPrivateKeyArmored: localIdentity.privateKeyArmored,
    recipientPublicKeyArmored: remoteIdentity.publicKeyArmored,
    selfPublicKeyArmored: localIdentity.publicKeyArmored
  });

  const incoming = await dispatchMessage("mc:process-incoming", {
    platform: PLATFORM.VK,
    dialogAccountId: "200",
    messageAuthorAccountId: "100",
    localAccountId: "999",
    rawText: buildEncryptedMessageText(selfSentEncrypted.encoded)
  });

  assert.equal(incoming.ok, true);
  assert.equal(incoming.kind, "decrypted");
  assert.equal(incoming.body, "my own encrypted message");
});

test("process-incoming returns sender_mismatch for self-authored payload mismatch", async () => {
  const localInit = await dispatchMessage("mc:init-identity", { displayName: "" });
  const localIdentity = localInit.identity;
  const remoteIdentity = await generateIdentity("");

  mock.state.set(`${STORAGE.BINDING_PREFIX}${PLATFORM.VK}:999`, {
    platform: PLATFORM.VK,
    accountId: "100",
    displayName: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });

  const badSelfPayload = await encryptMessage({
    body: "wrong self account id",
    senderPlatform: PLATFORM.VK,
    senderAccountId: "101",
    senderPrivateKeyArmored: localIdentity.privateKeyArmored,
    recipientPublicKeyArmored: remoteIdentity.publicKeyArmored,
    selfPublicKeyArmored: localIdentity.publicKeyArmored
  });

  const incoming = await dispatchMessage("mc:process-incoming", {
    platform: PLATFORM.VK,
    dialogAccountId: "200",
    messageAuthorAccountId: "100",
    localAccountId: "999",
    rawText: buildEncryptedMessageText(badSelfPayload.encoded)
  });

  assert.equal(incoming.ok, true);
  assert.equal(incoming.kind, "decrypt_failed");
  assert.equal(incoming.reason, "sender_mismatch");
  assert.equal(incoming.errorType, INTERNAL_ERROR.STORAGE_MISMATCH);
});

test("incoming key + trusted contact enables encrypted outgoing and decrypt incoming", async () => {
  const localInit = await dispatchMessage("mc:init-identity", { displayName: "" });
  const localIdentity = localInit.identity;
  const remoteIdentity = await generateIdentity("");

  const keyAnnouncementText = await createSignedAnnouncement({
    accountId: "200",
    identity: remoteIdentity
  });
  const keyProcessed = await dispatchMessage("mc:process-incoming", {
    platform: PLATFORM.VK,
    dialogAccountId: "200",
    messageAuthorAccountId: "200",
    localAccountId: "100",
    rawText: keyAnnouncementText
  });
  assert.equal(keyProcessed.ok, true);
  assert.equal(keyProcessed.kind, "key");
  assert.equal(keyProcessed.trustState, TRUST.NEW);

  const trustUpdated = await dispatchMessage("mc:set-trust", {
    platform: PLATFORM.VK,
    accountId: "200",
    trustState: TRUST.TRUSTED
  });
  assert.equal(trustUpdated.ok, true);
  assert.equal(trustUpdated.contact.trustState, TRUST.TRUSTED);

  const outgoing = await dispatchMessage("mc:process-outgoing", {
    platform: PLATFORM.VK,
    accountId: "200",
    senderAccountId: "100",
    body: "secure hello"
  });
  assert.equal(outgoing.ok, true);
  assert.equal(outgoing.mode, "encrypted");
  assert.ok(outgoing.text.startsWith(PROTOCOL.MSG_PREFIX));

  const remoteToLocal = await encryptMessage({
    body: "reply from contact",
    senderPlatform: PLATFORM.VK,
    senderAccountId: "200",
    senderPrivateKeyArmored: remoteIdentity.privateKeyArmored,
    recipientPublicKeyArmored: localIdentity.publicKeyArmored,
    selfPublicKeyArmored: remoteIdentity.publicKeyArmored
  });
  const incomingRawText = buildEncryptedMessageText(remoteToLocal.encoded);
  const incoming = await dispatchMessage("mc:process-incoming", {
    platform: PLATFORM.VK,
    dialogAccountId: "200",
    messageAuthorAccountId: "200",
    localAccountId: "100",
    rawText: incomingRawText
  });
  assert.equal(incoming.ok, true);
  assert.equal(incoming.kind, "decrypted");
  assert.equal(incoming.body, "reply from contact");
});

test("set-trust rejects invalid trust state", async () => {
  const result = await dispatchMessage("mc:set-trust", {
    platform: PLATFORM.VK,
    accountId: "200",
    trustState: "bad-state"
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /invalid trust state/);
});

test("set-trust rejects known/trusted/changed/rejected states when contact key is missing", async () => {
  for (const trustState of [TRUST.NEW, TRUST.TRUSTED, TRUST.CHANGED, TRUST.REJECTED]) {
    const result = await dispatchMessage("mc:set-trust", {
      platform: PLATFORM.VK,
      accountId: "200",
      trustState
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /contact key is missing/);
  }
});

test("set-trust persists schemaVersion for newly materialized missing-state contact", async () => {
  const updated = await dispatchMessage("mc:set-trust", {
    platform: PLATFORM.VK,
    accountId: "200",
    trustState: TRUST.MISSING
  });

  assert.equal(updated.ok, true);
  assert.equal(updated.contact.schemaVersion, 1);
  assert.equal(updated.contact.trustState, TRUST.MISSING);
  const stored = mock.state.get(`${STORAGE.CONTACT_PREFIX}${PLATFORM.VK}:200`);
  assert.equal(stored.schemaVersion, 1);
});

test("set-trust clears hasKeyConflict when leaving changed state", async () => {
  await dispatchMessage("mc:init-identity", { displayName: "" });
  const firstIdentity = await generateIdentity("");
  const secondIdentity = await generateIdentity("");

  const firstAnnouncement = await createSignedAnnouncement({
    accountId: "300",
    identity: firstIdentity
  });
  await dispatchMessage("mc:process-incoming", {
    platform: PLATFORM.VK,
    dialogAccountId: "300",
    messageAuthorAccountId: "300",
    localAccountId: "100",
    rawText: firstAnnouncement
  });

  const secondAnnouncement = await createSignedAnnouncement({
    accountId: "300",
    identity: secondIdentity
  });
  const changed = await dispatchMessage("mc:process-incoming", {
    platform: PLATFORM.VK,
    dialogAccountId: "300",
    messageAuthorAccountId: "300",
    localAccountId: "100",
    rawText: secondAnnouncement
  });
  assert.equal(changed.ok, true);
  assert.equal(changed.kind, "key");
  assert.equal(changed.trustState, TRUST.CHANGED);

  const accepted = await dispatchMessage("mc:set-trust", {
    platform: PLATFORM.VK,
    accountId: "300",
    trustState: TRUST.NEW
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.contact.trustState, TRUST.NEW);
  assert.equal(accepted.contact.hasKeyConflict, false);
  assert.equal(accepted.contact.previousFingerprintFull, null);
});
