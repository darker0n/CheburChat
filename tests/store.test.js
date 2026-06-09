import assert from "node:assert/strict";
import test from "node:test";

import { STORAGE, TRUST } from "../src/common/constants.js";

function createChromeStorageMock() {
  const state = new Map();

  return {
    state,
    chrome: {
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
            for (const [key, data] of Object.entries(value)) {
              state.set(key, data);
            }
          },
          async remove(key) {
            state.delete(key);
          }
        }
      }
    }
  };
}

const { chrome, state } = createChromeStorageMock();
globalThis.chrome = chrome;

const store = await import("../src/background/store.js");

test.beforeEach(() => {
  state.clear();
});

test("setIdentity/getIdentity roundtrip", async () => {
  const identity = { fingerprintFull: "ABCD", schemaVersion: 1 };
  await store.setIdentity(identity);
  const actual = await store.getIdentity();

  assert.deepEqual(actual, identity);
  assert.deepEqual(state.get(STORAGE.IDENTITY), identity);
});

test("getIdentity returns null when identity is missing", async () => {
  const identity = await store.getIdentity();
  assert.equal(identity, null);
});

test("setSettings/getSettings roundtrip", async () => {
  const settings = { schemaVersion: 1, debugMode: false };
  await store.setSettings(settings);
  const actual = await store.getSettings();

  assert.deepEqual(actual, settings);
});

test("setBinding/getBinding uses platform/account scoped key", async () => {
  const binding = { platform: "vk", accountId: "42", displayName: "Alice" };
  await store.setBinding("vk", "42", binding);
  const actual = await store.getBinding("vk", "42");

  assert.deepEqual(actual, binding);
});

test("getBinding returns null when value is missing", async () => {
  const actual = await store.getBinding("vk", "missing");
  assert.equal(actual, null);
});

test("getContact returns default missing-trust contact when absent", async () => {
  const contact = await store.getContact("vk", "100");

  assert.deepEqual(contact, {
    platform: "vk",
    accountId: "100",
    trustState: TRUST.MISSING
  });
});

test("setContact/getContact roundtrip", async () => {
  const contact = {
    platform: "vk",
    accountId: "55",
    trustState: TRUST.TRUSTED,
    fingerprintFull: "FFFF"
  };
  await store.setContact(contact);
  const actual = await store.getContact("vk", "55");

  assert.deepEqual(actual, contact);
});

test("getAllContacts returns only contact records", async () => {
  state.set(STORAGE.IDENTITY, { fingerprintFull: "IDENTITY" });
  state.set(`${STORAGE.CONTACT_PREFIX}vk:55`, {
    platform: "vk",
    accountId: "55",
    trustState: TRUST.TRUSTED
  });
  state.set(`${STORAGE.CONTACT_PREFIX}vk:66`, {
    platform: "vk",
    accountId: "66",
    trustState: TRUST.NEW
  });
  state.set(`${STORAGE.BINDING_PREFIX}vk:100`, { accountId: "100" });

  const contacts = await store.getAllContacts();

  assert.deepEqual(contacts, [
    {
      platform: "vk",
      accountId: "55",
      trustState: TRUST.TRUSTED
    },
    {
      platform: "vk",
      accountId: "66",
      trustState: TRUST.NEW
    }
  ]);
});

test("removeContact deletes only targeted contact record", async () => {
  const firstKey = `${STORAGE.CONTACT_PREFIX}vk:100`;
  const secondKey = `${STORAGE.CONTACT_PREFIX}vk:200`;
  state.set(firstKey, { platform: "vk", accountId: "100", trustState: TRUST.NEW });
  state.set(secondKey, { platform: "vk", accountId: "200", trustState: TRUST.TRUSTED });

  await store.removeContact("vk", "100");

  assert.equal(state.has(firstKey), false);
  assert.equal(state.has(secondKey), true);
});

test("mergeContact updates existing contact fields without dropping previous values", async () => {
  const original = {
    platform: "vk",
    accountId: "77",
    trustState: TRUST.NEW,
    displayName: "Alice",
    fingerprintFull: "AAAA",
    lastUpdatedAt: "2026-03-20T00:00:00.000Z"
  };
  await store.setContact(original);

  const merged = await store.mergeContact({
    platform: "vk",
    accountId: "77",
    displayName: "Alice Updated",
    lastUpdatedAt: "2026-03-20T01:00:00.000Z"
  });

  assert.deepEqual(merged, {
    platform: "vk",
    accountId: "77",
    trustState: TRUST.NEW,
    displayName: "Alice Updated",
    fingerprintFull: "AAAA",
    lastUpdatedAt: "2026-03-20T01:00:00.000Z"
  });
});

test("mergeContact updates only targeted contact key and keeps unrelated records intact", async () => {
  const firstKey = `${STORAGE.CONTACT_PREFIX}vk:100`;
  const secondKey = `${STORAGE.CONTACT_PREFIX}vk:200`;
  state.set(firstKey, {
    platform: "vk",
    accountId: "100",
    trustState: TRUST.NEW,
    displayName: "First"
  });
  state.set(secondKey, {
    platform: "vk",
    accountId: "200",
    trustState: TRUST.TRUSTED,
    displayName: "Second"
  });

  await store.mergeContact({
    platform: "vk",
    accountId: "100",
    displayName: "First Updated"
  });

  assert.deepEqual(state.get(firstKey), {
    platform: "vk",
    accountId: "100",
    trustState: TRUST.NEW,
    displayName: "First Updated"
  });
  assert.deepEqual(state.get(secondKey), {
    platform: "vk",
    accountId: "200",
    trustState: TRUST.TRUSTED,
    displayName: "Second"
  });
});
