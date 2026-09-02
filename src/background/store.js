import { STORAGE, TRUST } from "../common/constants.js";

const mutationTails = new Map();

function contactStorageKey(platform, accountId) {
  return `${STORAGE.CONTACT_PREFIX}${platform}:${accountId}`;
}

function bindingStorageKey(platform, accountId) {
  return `${STORAGE.BINDING_PREFIX}${platform}:${accountId}`;
}

function keyShareIntentStorageKey(platform, accountId) {
  return `${STORAGE.KEY_SHARE_INTENT_PREFIX}${platform}:${accountId}`;
}

function runSerialized(storageKey, operation) {
  const previous = mutationTails.get(storageKey) || Promise.resolve();
  const result = previous.catch(() => {}).then(operation);
  const tail = result.then(
    () => {},
    () => {}
  ).finally(() => {
    if (mutationTails.get(storageKey) === tail) mutationTails.delete(storageKey);
  });
  mutationTails.set(storageKey, tail);
  return result;
}

async function waitForMutation(storageKey) {
  const pending = mutationTails.get(storageKey);
  if (pending) await pending.catch(() => {});
}

async function getStoredValue(storageArea, storageKey) {
  await waitForMutation(storageKey);
  const value = await storageArea.get(storageKey);
  return value[storageKey] ?? null;
}

async function updateStoredValue(storageArea, storageKey, updater) {
  return runSerialized(storageKey, async () => {
    const value = await storageArea.get(storageKey);
    const current = value[storageKey] ?? null;
    const updated = await updater(current);
    if (updated !== current) await storageArea.set({ [storageKey]: updated });
    return updated;
  });
}

export async function getIdentity() {
  return getStoredValue(chrome.storage.local, STORAGE.IDENTITY);
}

export async function setIdentity(identity) {
  await updateIdentity(() => identity);
}

export async function updateIdentity(updater) {
  return updateStoredValue(chrome.storage.local, STORAGE.IDENTITY, updater);
}

export async function getSettings() {
  return getStoredValue(chrome.storage.local, STORAGE.SETTINGS);
}

export async function setSettings(settings) {
  await updateSettings(() => settings);
}

export async function updateSettings(updater) {
  return updateStoredValue(chrome.storage.local, STORAGE.SETTINGS, updater);
}

export async function getBinding(platform, accountId) {
  const key = bindingStorageKey(platform, accountId);
  return getStoredValue(chrome.storage.local, key);
}

export async function setBinding(platform, accountId, binding) {
  await updateBinding(platform, accountId, () => binding);
}

export async function updateBinding(platform, accountId, updater) {
  const key = bindingStorageKey(platform, accountId);
  return updateStoredValue(chrome.storage.local, key, updater);
}

export async function getContact(platform, accountId) {
  const key = contactStorageKey(platform, accountId);
  const contact = await getStoredValue(chrome.storage.local, key);
  if (contact) return contact;
  return {
    platform,
    accountId,
    trustState: TRUST.MISSING
  };
}

export async function setContact(contact) {
  await updateContact(contact.platform, contact.accountId, () => contact);
}

export async function updateContact(platform, accountId, updater) {
  const key = contactStorageKey(platform, accountId);
  return updateStoredValue(chrome.storage.local, key, async (storedContact) => {
    const current =
      storedContact ||
      ({
        platform,
        accountId,
        trustState: TRUST.MISSING
      });
    return updater(current);
  });
}

export async function getAllContacts() {
  const pendingMutations = [...new Set(mutationTails.values())];
  await Promise.all(pendingMutations.map((pending) => pending.catch(() => {})));
  const value = await chrome.storage.local.get(null);
  return Object.entries(value)
    .filter(([key]) => key.startsWith(STORAGE.CONTACT_PREFIX))
    .map(([, contact]) => contact);
}

export async function removeContact(platform, accountId) {
  const key = contactStorageKey(platform, accountId);
  await runSerialized(key, () => chrome.storage.local.remove(key));
}

export async function mergeContact(contactPatch) {
  const platform = String(contactPatch?.platform || "");
  const accountId = String(contactPatch?.accountId || "");
  if (!platform || !accountId) {
    throw new Error("mergeContact requires platform and accountId");
  }

  return updateContact(platform, accountId, (current) => ({ ...current, ...contactPatch }));
}

export async function setKeyShareIntent(platform, accountId, intent) {
  const key = keyShareIntentStorageKey(platform, accountId);
  await updateStoredValue(chrome.storage.session, key, () => intent);
}

export async function consumeKeyShareIntent(platform, accountId) {
  const key = keyShareIntentStorageKey(platform, accountId);
  return runSerialized(key, async () => {
    const value = await chrome.storage.session.get(key);
    const intent = value[key] || null;
    if (intent) await chrome.storage.session.remove(key);
    return intent;
  });
}

export async function removeKeyShareIntent(platform, accountId) {
  const key = keyShareIntentStorageKey(platform, accountId);
  await runSerialized(key, () => chrome.storage.session.remove(key));
}
