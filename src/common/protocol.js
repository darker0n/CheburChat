import { base64urlDecodeUtf8, base64urlEncodeUtf8 } from "./base64url.js";
import { PROTOCOL } from "./constants.js";

const BASE64URL_PATTERN = "[A-Za-z0-9_-]+";

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeTransportText(rawText) {
  return String(rawText || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\n\v\f\r ]+$/g, "");
}

function isAcceptedInviteLine(line) {
  return line === PROTOCOL.INVITE_LINE;
}

function keyPayloadLine(normalizedText) {
  const lines = normalizedText.split("\n");
  if (lines.length === 1) return lines[0];
  if (lines.length === 2 && isAcceptedInviteLine(lines[0])) return lines[1];
  return "";
}

function isSupportedKeyText(normalizedText) {
  const payloadLine = keyPayloadLine(normalizedText);
  const pattern = new RegExp(`^${escapeRegExp(PROTOCOL.KEY_PREFIX)}(${BASE64URL_PATTERN})$`);
  return pattern.test(payloadLine);
}

function isSupportedMessageText(normalizedText) {
  const pattern = new RegExp(`^${escapeRegExp(PROTOCOL.MSG_PREFIX)}(${BASE64URL_PATTERN})$`);
  return pattern.test(normalizedText);
}

function isUnsupportedKeyText(normalizedText) {
  const payloadLine = keyPayloadLine(normalizedText);
  if (!payloadLine) return false;
  const match = payloadLine.match(/^CHEBURCHAT:([^:]+):key:\S+$/);
  return Boolean(match && match[1] !== PROTOCOL.VERSION);
}

function isUnsupportedMessageText(normalizedText) {
  const match = normalizedText.match(/^CHEBURCHAT:([^:]+):msg:\S+$/);
  return Boolean(match && match[1] !== PROTOCOL.VERSION);
}

function looksLikeKeyWrapper(normalizedText) {
  const payloadLine = keyPayloadLine(normalizedText);
  if (!payloadLine) return false;
  return /^CHEBURCHAT:[^:\s]+:key:\S+$/.test(payloadLine);
}

function looksLikeMessageWrapper(normalizedText) {
  return /^CHEBURCHAT:[^:\s]+:msg:\S+$/.test(normalizedText);
}

export function buildKeyAnnouncementText(payloadObject) {
  const payload = base64urlEncodeUtf8(JSON.stringify(payloadObject));
  return `${PROTOCOL.INVITE_LINE}\n${PROTOCOL.KEY_PREFIX}${payload}`;
}

export function parseKeyAnnouncementText(rawText) {
  const normalized = normalizeTransportText(rawText);
  const payloadLine = keyPayloadLine(normalized);
  if (!isSupportedKeyText(normalized)) {
    const lines = normalized.split("\n");
    if (lines.length > 2) throw new Error("key announcement must be one or two lines");
    if (!payloadLine.startsWith(PROTOCOL.KEY_PREFIX)) throw new Error("missing key prefix");
    throw new Error("invalid key payload");
  }

  const payloadEncoded = payloadLine.slice(PROTOCOL.KEY_PREFIX.length);
  const payloadJson = base64urlDecodeUtf8(payloadEncoded);
  const payload = JSON.parse(payloadJson);
  return { payload, payloadEncoded };
}

export function buildEncryptedMessageText(payloadBytesBase64Url) {
  return `${PROTOCOL.MSG_PREFIX}${payloadBytesBase64Url}`;
}

export function parseEncryptedMessageText(rawText) {
  const normalized = normalizeTransportText(rawText);
  if (!normalized.startsWith(PROTOCOL.MSG_PREFIX)) throw new Error("missing msg prefix");
  const payload = normalized.slice(PROTOCOL.MSG_PREFIX.length);
  if (!new RegExp(`^${BASE64URL_PATTERN}$`).test(payload)) throw new Error("invalid msg payload");
  return payload;
}

export function detectPayloadKind(rawText) {
  const normalized = normalizeTransportText(rawText);
  if (isSupportedKeyText(normalized)) return "key";
  if (isSupportedMessageText(normalized)) return "msg";
  if (isUnsupportedKeyText(normalized) || isUnsupportedMessageText(normalized)) return "unsupported";
  if (looksLikeKeyWrapper(normalized)) return "key";
  if (looksLikeMessageWrapper(normalized)) return "msg";
  return "none";
}
