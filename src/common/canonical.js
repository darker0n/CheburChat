import { PLATFORM } from "./constants.js";

export const ANNOUNCEMENT_ORDER = Object.freeze([
  "v",
  "platform",
  "accountId",
  "publicKeyArmored",
  "fingerprint",
  "displayName"
]);

export const MESSAGE_ORDER = Object.freeze(["v", "platform", "accountId", "ts", "body"]);

function assertString(name, value) {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function orderedJson(order, object) {
  const out = {};
  for (const key of order) out[key] = object[key];
  return JSON.stringify(out);
}

export function normalizePlatform(platform) {
  const value = assertString("platform", platform);
  if (value !== PLATFORM.VK) throw new Error("unsupported platform");
  return value;
}

export function normalizeAccountId(accountId) {
  return assertString("accountId", accountId).trim();
}

export function normalizeVkAccountId(accountId) {
  const value = normalizeAccountId(accountId);
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error("invalid VK accountId");
  return value;
}

export function normalizeDisplayName(displayName) {
  if (typeof displayName !== "string") return "";
  return displayName;
}

export function canonicalAnnouncementForSignature(payload) {
  return orderedJson(ANNOUNCEMENT_ORDER, {
    v: assertString("v", payload.v),
    platform: normalizePlatform(payload.platform),
    accountId: normalizeAccountId(payload.accountId),
    publicKeyArmored: assertString("publicKeyArmored", payload.publicKeyArmored),
    fingerprint: assertString("fingerprint", payload.fingerprint),
    displayName: normalizeDisplayName(payload.displayName)
  });
}

export function canonicalMessagePayload(payload) {
  return orderedJson(MESSAGE_ORDER, {
    v: assertString("v", payload.v),
    platform: normalizePlatform(payload.platform),
    accountId: normalizeAccountId(payload.accountId),
    ts: assertString("ts", payload.ts),
    body: assertString("body", payload.body)
  });
}
