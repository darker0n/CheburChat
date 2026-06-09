import { STORAGE, TRUST } from "../common/constants.js";

function contactStorageKey(platform, accountId) {
  return `${STORAGE.CONTACT_PREFIX}${platform}:${accountId}`;
}

function bindingStorageKey(platform, accountId) {
  return `${STORAGE.BINDING_PREFIX}${platform}:${accountId}`;
}

export async function getIdentity() {
  const value = await chrome.storage.local.get(STORAGE.IDENTITY);
  return value[STORAGE.IDENTITY] || null;
}

export async function setIdentity(identity) {
  await chrome.storage.local.set({ [STORAGE.IDENTITY]: identity });
}

export async function getSettings() {
  const value = await chrome.storage.local.get(STORAGE.SETTINGS);
  return value[STORAGE.SETTINGS] || null;
}

export async function setSettings(settings) {
  await chrome.storage.local.set({ [STORAGE.SETTINGS]: settings });
}

export async function getBinding(platform, accountId) {
  const key = bindingStorageKey(platform, accountId);
  const value = await chrome.storage.local.get(key);
  return value[key] || null;
}

export async function setBinding(platform, accountId, binding) {
  const key = bindingStorageKey(platform, accountId);
  await chrome.storage.local.set({ [key]: binding });
}

export async function getContact(platform, accountId) {
  const key = contactStorageKey(platform, accountId);
  const value = await chrome.storage.local.get(key);
  if (value[key]) return value[key];
  return {
    platform,
    accountId,
    trustState: TRUST.MISSING
  };
}

export async function setContact(contact) {
  const key = contactStorageKey(contact.platform, contact.accountId);
  await chrome.storage.local.set({ [key]: contact });
}

export async function getAllContacts() {
  const value = await chrome.storage.local.get(null);
  return Object.entries(value)
    .filter(([key]) => key.startsWith(STORAGE.CONTACT_PREFIX))
    .map(([, contact]) => contact);
}

export async function removeContact(platform, accountId) {
  const key = contactStorageKey(platform, accountId);
  await chrome.storage.local.remove(key);
}

export async function mergeContact(contactPatch) {
  const platform = String(contactPatch?.platform || "");
  const accountId = String(contactPatch?.accountId || "");
  if (!platform || !accountId) {
    throw new Error("mergeContact requires platform and accountId");
  }

  const key = contactStorageKey(platform, accountId);
  const value = await chrome.storage.local.get(key);
  const current =
    value[key] ||
    ({
      platform,
      accountId,
      trustState: TRUST.MISSING
    });
  const merged = { ...current, ...contactPatch };
  await chrome.storage.local.set({ [key]: merged });
  return merged;
}
