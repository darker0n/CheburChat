import { canonicalAnnouncementForSignature, normalizeAccountId, normalizePlatform } from "../common/canonical.js";
import { INTERNAL_ERROR, PROTOCOL, TRUST } from "../common/constants.js";
import { formatShortFingerprint, normalizeFingerprint } from "../common/fingerprint.js";
import {
  buildEncryptedMessageText,
  buildKeyAnnouncementText,
  detectPayloadKind,
  parseEncryptedMessageText,
  parseKeyAnnouncementText
} from "../common/protocol.js";
import {
  decryptMessage,
  encryptMessage,
  generateIdentity,
  importIdentity,
  publicKeyFingerprint,
  signAnnouncement,
  verifyAnnouncement
} from "./crypto.js";
import {
  getAllContacts,
  getBinding,
  getContact,
  getIdentity,
  mergeContact,
  getSettings,
  removeContact,
  setBinding,
  setIdentity,
  setSettings
} from "./store.js";

const RECORD_SCHEMA_VERSION = 1;
const OPTIONS_PAGE_PATH = "src/options/options.html";

function nowIso() {
  return new Date().toISOString();
}

function requiredString(name, value) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function utf8ByteLength(value) {
  return new TextEncoder().encode(String(value || "")).length;
}

function normalizeOptionalMessageId(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const match = text.match(/-?[0-9]+/);
  return match ? match[0] : "";
}

function normalizeOptionalAccountId(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    return normalizeAccountId(text);
  } catch (_error) {
    return "";
  }
}

function isOptionsPageSender(sender) {
  const senderUrl = String(sender?.url || "").trim();
  if (!senderUrl) return false;

  try {
    if (typeof chrome?.runtime?.getURL === "function") {
      return senderUrl === chrome.runtime.getURL(OPTIONS_PAGE_PATH);
    }
  } catch (_error) {}

  return senderUrl.startsWith("chrome-extension://") && senderUrl.endsWith(`/${OPTIONS_PAGE_PATH}`);
}

function isOlderMessageId(incomingMessageId, storedMessageId) {
  if (!incomingMessageId || !storedMessageId) return false;
  try {
    return BigInt(incomingMessageId) < BigInt(storedMessageId);
  } catch (_error) {
    return false;
  }
}

function isCanonicalIsoTimestamp(value) {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function debugLog(enabled, event, meta = {}) {
  if (!enabled) return;
  console.debug("[CheburChat]", event, meta);
}

function classifyKeyParseError(error) {
  const message = String(error?.message || "").toLowerCase();
  if (
    message.includes("payload") ||
    message.includes("json") ||
    message.includes("utf-8") ||
    message.includes("character")
  ) {
    return INTERNAL_ERROR.PAYLOAD_DECODE_FAILURE;
  }
  return INTERNAL_ERROR.WRAPPER_PARSE_FAILURE;
}

function classifyMessageParseError(error) {
  const message = String(error?.message || "").toLowerCase();
  if (message.includes("payload")) return INTERNAL_ERROR.PAYLOAD_DECODE_FAILURE;
  return INTERNAL_ERROR.WRAPPER_PARSE_FAILURE;
}

function classifyOpenPgpFailure(error) {
  const message = String(error?.message || "").toLowerCase();
  if (
    message.includes("signature") ||
    message.includes("digest") ||
    message.includes("signing key") ||
    message.includes("verification")
  ) {
    return INTERNAL_ERROR.ENCRYPTED_MESSAGE_SIGNATURE_VERIFICATION_FAILURE;
  }
  if (
    message.includes("parse") ||
    message.includes("packet") ||
    message.includes("format") ||
    message.includes("malformed")
  ) {
    return INTERNAL_ERROR.OPENPGP_PARSE_FAILURE;
  }
  return INTERNAL_ERROR.DECRYPTION_FAILURE;
}

const SETTINGS_SCHEMA_VERSION = 1;

function buildDefaultSettings(overrides = {}) {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    debugMode: false,
    warningThresholdChars: PROTOCOL.WARNING_THRESHOLD_CHARS,
    needsBackupAcknowledgement: false,
    ...overrides
  };
}

async function ensureSettings() {
  const current = await getSettings();
  const normalized = buildDefaultSettings(current || {});
  if (
    !current ||
    current.schemaVersion !== normalized.schemaVersion ||
    current.debugMode !== normalized.debugMode ||
    current.warningThresholdChars !== normalized.warningThresholdChars ||
    current.needsBackupAcknowledgement !== normalized.needsBackupAcknowledgement
  ) {
    await setSettings(normalized);
  }
  return normalized;
}

function effectiveTrustState(contact) {
  const hasKey = Boolean(contact?.publicKeyArmored);
  const trustState = contact?.trustState;
  if (!hasKey) return TRUST.MISSING;
  if (Boolean(contact?.hasKeyConflict)) return TRUST.CHANGED;
  if (trustState === TRUST.TRUSTED || trustState === TRUST.CHANGED || trustState === TRUST.REJECTED) return trustState;
  return TRUST.NEW;
}

async function resolveChatState(platform, accountId) {
  const contact = await getContact(platform, accountId);
  const trustState = effectiveTrustState(contact);
  return {
    trustState,
    hasKey: Boolean(contact.publicKeyArmored),
    contact
  };
}

async function resolveKeyConflict(existingContact, incomingFingerprint, incomingPublicKeyArmored) {
  const existingPublicKeyArmored = String(existingContact?.publicKeyArmored || "");
  if (!existingPublicKeyArmored) {
    return { changed: false, previousFingerprintFull: existingContact?.previousFingerprintFull || null };
  }

  const storedExistingFingerprint = normalizeFingerprint(existingContact?.fingerprintFull);
  if (storedExistingFingerprint) {
    return {
      changed: storedExistingFingerprint !== incomingFingerprint,
      previousFingerprintFull: storedExistingFingerprint
    };
  }

  try {
    const derivedExistingFingerprint = normalizeFingerprint(await publicKeyFingerprint(existingPublicKeyArmored));
    if (derivedExistingFingerprint) {
      return {
        changed: derivedExistingFingerprint !== incomingFingerprint,
        previousFingerprintFull: derivedExistingFingerprint
      };
    }
  } catch (_error) {}

  const sameArmoredKey = existingPublicKeyArmored === String(incomingPublicKeyArmored || "");
  return {
    changed: !sameArmoredKey,
    previousFingerprintFull: existingContact?.previousFingerprintFull || null
  };
}

async function onInitIdentity({ displayName }) {
  const identity = await generateIdentity(displayName || "");
  await setIdentity(identity);
  const settings = await ensureSettings();
  await setSettings({ ...settings, needsBackupAcknowledgement: true });
  return { ok: true, identity };
}

async function onImportIdentity({ privateKeyArmored }) {
  const identity = await importIdentity(privateKeyArmored);
  await setIdentity(identity);
  const settings = await ensureSettings();
  await setSettings({ ...settings, needsBackupAcknowledgement: false });
  return { ok: true, identity };
}

async function onGetIdentity() {
  const identity = await getIdentity();
  if (!identity) return { ok: true, identity: null };
  const publicIdentity = { ...identity };
  delete publicIdentity.privateKeyArmored;
  return { ok: true, identity: publicIdentity };
}

async function onGetPrivateKey() {
  const identity = await getIdentity();
  if (!identity) return { ok: false, error: "no_identity" };
  return { ok: true, privateKeyArmored: identity.privateKeyArmored };
}

async function onGetSettings() {
  return { ok: true, settings: await ensureSettings() };
}

async function onSetDebugMode({ debugMode }) {
  if (typeof debugMode !== "boolean") throw new Error("debugMode must be boolean");
  const current = await ensureSettings();
  const updated = {
    ...current,
    debugMode
  };
  await setSettings(updated);
  return { ok: true, settings: updated };
}

async function onSetWarningThreshold({ warningThresholdChars }) {
  const threshold = Number(warningThresholdChars);
  if (!Number.isFinite(threshold) || !Number.isInteger(threshold)) {
    throw new Error("warningThresholdChars must be an integer");
  }
  if (threshold < 1 || threshold > PROTOCOL.HARD_LIMIT_CHARS) {
    throw new Error(`warningThresholdChars must be between 1 and ${PROTOCOL.HARD_LIMIT_CHARS}`);
  }

  const current = await ensureSettings();
  const updated = {
    ...current,
    warningThresholdChars: threshold
  };
  await setSettings(updated);
  return { ok: true, settings: updated };
}

async function onListContacts() {
  const contacts = await getAllContacts();
  contacts.sort((left, right) => {
    const leftName = String(left?.displayName || left?.accountId || "");
    const rightName = String(right?.displayName || right?.accountId || "");
    return leftName.localeCompare(rightName, "ru");
  });
  return { ok: true, contacts };
}

async function onRemoveContact({ platform, accountId }, sender) {
  if (!isOptionsPageSender(sender)) {
    throw new Error("remove_contact_requires_options_page");
  }
  const normalizedPlatform = normalizePlatform(platform);
  const normalizedAccountId = normalizeAccountId(accountId);
  await removeContact(normalizedPlatform, normalizedAccountId);
  return { ok: true };
}

async function onMarkOwnKeyShared({ platform, accountId }) {
  const normalizedPlatform = normalizePlatform(platform);
  const normalizedAccountId = normalizeAccountId(accountId);
  const identity = await getIdentity();
  if (!identity?.fingerprintFull) {
    throw new Error("identity not initialized");
  }
  const contact = await mergeContact({
    schemaVersion: RECORD_SCHEMA_VERSION,
    platform: normalizedPlatform,
    accountId: normalizedAccountId,
    lastOwnKeySharedAt: nowIso(),
    lastOwnKeyFingerprintShared: normalizeFingerprint(identity.fingerprintFull)
  });
  return { ok: true, contact };
}

async function onUpsertBinding({ platform, accountId, displayName }) {
  normalizePlatform(platform);
  const normalizedAccountId = normalizeAccountId(accountId);
  const normalizedDisplayName = typeof displayName === "string" ? displayName.trim() : "";
  const now = nowIso();
  const existing = await getBinding(platform, normalizedAccountId);
  const updated = {
    schemaVersion: existing?.schemaVersion || RECORD_SCHEMA_VERSION,
    platform,
    accountId: normalizedAccountId,
    displayName: normalizedDisplayName || existing?.displayName || "",
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
  await setBinding(platform, normalizedAccountId, updated);
  return { ok: true, binding: updated };
}

async function onCreateKeyAnnouncement({ platform, accountId, displayName }) {
  normalizePlatform(platform);
  const normalizedAccountId = normalizeAccountId(accountId);
  const identity = await getIdentity();
  if (!identity) throw new Error("identity not initialized");

  const unsigned = canonicalAnnouncementForSignature({
    v: PROTOCOL.VERSION,
    platform,
    accountId: normalizedAccountId,
    publicKeyArmored: identity.publicKeyArmored,
    fingerprint: identity.fingerprintFull,
    displayName: displayName || ""
  });

  const unsignedObject = JSON.parse(unsigned);
  const sig = await signAnnouncement(unsignedObject, identity.privateKeyArmored);
  const payload = { ...unsignedObject, sig };
  return { ok: true, text: buildKeyAnnouncementText(payload), payload };
}

async function onSyncContactProfile({ platform, accountId, displayName }) {
  normalizePlatform(platform);
  const normalizedAccountId = normalizeAccountId(accountId);
  const normalizedDisplayName = typeof displayName === "string" ? displayName.trim() : "";
  const existing = await getContact(platform, normalizedAccountId);

  if (!normalizedDisplayName) {
    return { ok: true, contact: existing };
  }

  const updated = await mergeContact({
    schemaVersion: existing.schemaVersion || RECORD_SCHEMA_VERSION,
    platform,
    accountId: normalizedAccountId,
    displayName: normalizedDisplayName,
    firstSeenAt: existing.firstSeenAt || nowIso(),
    lastUpdatedAt: nowIso()
  });
  return { ok: true, contact: updated };
}

async function onProcessOutgoing({ platform, accountId, senderAccountId, body }) {
  const settings = await ensureSettings();
  const debugEnabled = Boolean(settings.debugMode);
  const configuredWarningThreshold = Number(settings.warningThresholdChars);
  const warningThresholdChars =
    Number.isFinite(configuredWarningThreshold) && configuredWarningThreshold > 0
      ? configuredWarningThreshold
      : PROTOCOL.WARNING_THRESHOLD_CHARS;
  normalizePlatform(platform);
  const normalizedDialogAccountId = normalizeAccountId(accountId);
  const normalizedSenderAccountId = senderAccountId ? normalizeAccountId(senderAccountId) : "";
  requiredString("body", body);

  const identity = await getIdentity();
  if (!identity) throw new Error("identity not initialized");

  const contact = await getContact(platform, normalizedDialogAccountId);
  const trustState = effectiveTrustState(contact);
  if (!contact.publicKeyArmored || trustState === TRUST.MISSING || trustState === TRUST.REJECTED) {
    debugLog(debugEnabled, "outgoing.plaintext", {
      platform,
      accountId: normalizedDialogAccountId
    });
    return { ok: true, mode: "plaintext", text: body, trustState };
  }

  if (trustState === TRUST.NEW) {
    debugLog(debugEnabled, "outgoing.blocked", {
      reason: "untrusted_key",
      platform,
      accountId: normalizedDialogAccountId
    });
    return {
      ok: true,
      mode: "blocked",
      reason: "untrusted_key",
      message:
        "Ключ контакта еще не проверен. Сначала проверьте отпечаток ключа (fingerprint) и пометьте контакт как доверенный."
    };
  }

  if (!normalizedSenderAccountId) {
    debugLog(debugEnabled, "outgoing.blocked", {
      reason: "missing_sender_account",
      platform,
      accountId: normalizedDialogAccountId
    });
    return {
      ok: true,
      mode: "blocked",
      reason: "missing_sender_account",
      message: "Не удалось определить ваш ID аккаунта VK для зашифрованной отправки."
    };
  }

  if (trustState === TRUST.CHANGED) {
    debugLog(debugEnabled, "outgoing.blocked", {
      reason: "changed_key",
      platform,
      accountId: normalizedDialogAccountId
    });
    return {
      ok: true,
      mode: "blocked",
      reason: "changed_key",
      message:
        "Ключ контакта изменен. Старые зашифрованные сообщения, отправленные на прежний ключ, могут стать недоступны. Примите новый ключ или отправьте обычный текст."
    };
  }

  const encrypted = await encryptMessage({
    body,
    senderPlatform: platform,
    senderAccountId: normalizedSenderAccountId,
    senderPrivateKeyArmored: identity.privateKeyArmored,
    recipientPublicKeyArmored: contact.publicKeyArmored,
    selfPublicKeyArmored: identity.publicKeyArmored
  });
  const wrapped = buildEncryptedMessageText(encrypted.encoded);
  if (wrapped.length > PROTOCOL.HARD_LIMIT_CHARS) {
    debugLog(debugEnabled, "outgoing.blocked", {
      reason: INTERNAL_ERROR.MESSAGE_TOO_LONG,
      platform,
      accountId: normalizedDialogAccountId,
      wrappedLength: wrapped.length
    });
    return {
      ok: true,
      mode: "blocked",
      reason: "too_long",
      errorType: INTERNAL_ERROR.MESSAGE_TOO_LONG,
      message: "Зашифрованное сообщение слишком длинное для VK."
    };
  }

  const hasWarning = utf8ByteLength(body) >= warningThresholdChars;
  debugLog(debugEnabled, "outgoing.encrypted", {
    platform,
    accountId: normalizedDialogAccountId,
    warning: hasWarning,
    warningThresholdChars
  });
  return {
    ok: true,
    mode: "encrypted",
    text: wrapped,
    warning: hasWarning ? "size_warning" : null
  };
}

async function onProcessIncoming({
  platform,
  dialogAccountId,
  messageAuthorAccountId,
  localAccountId,
  messageId,
  rawText
}) {
  const settings = await ensureSettings();
  const debugEnabled = Boolean(settings.debugMode);
  normalizePlatform(platform);
  const normalizedDialogId = normalizeAccountId(dialogAccountId);
  const normalizedAuthorId = normalizeOptionalAccountId(messageAuthorAccountId);
  const normalizedLocalId = normalizeOptionalAccountId(localAccountId);
  const normalizedMessageId = normalizeOptionalMessageId(messageId);
  let normalizedBoundLocalId = normalizedLocalId;
  if (normalizedLocalId) {
    const binding = await getBinding(platform, normalizedLocalId);
    if (binding?.accountId) {
      normalizedBoundLocalId = normalizeAccountId(binding.accountId);
    }
  }
  const kind = detectPayloadKind(rawText);
  if (kind === "none") return { ok: true, kind: "none" };
  if (kind === "unsupported") {
    debugLog(debugEnabled, "incoming.unsupported_version", {
      errorType: INTERNAL_ERROR.UNSUPPORTED_PROTOCOL_VERSION,
      platform,
      dialogAccountId: normalizedDialogId,
      messageAuthorAccountId: normalizedAuthorId,
      messageId: normalizedMessageId
    });
    return {
      ok: true,
      kind: "unsupported_version",
      errorType: INTERNAL_ERROR.UNSUPPORTED_PROTOCOL_VERSION
    };
  }
  const identity = await getIdentity();
  if (!identity) {
    debugLog(debugEnabled, "incoming.identity_missing", {
      platform,
      dialogAccountId: normalizedDialogId,
      messageAuthorAccountId: normalizedAuthorId,
      messageId: normalizedMessageId
    });
    return { ok: true, kind: "identity_missing" };
  }
  if (!normalizedAuthorId) {
    if (kind === "key") {
      return {
        ok: true,
        kind: "invalid_key",
        reason: "missing_author_id",
        errorType: INTERNAL_ERROR.STORAGE_MISMATCH
      };
    }
    return {
      ok: true,
      kind: "decrypt_failed",
      reason: "missing_author_id",
      errorType: INTERNAL_ERROR.STORAGE_MISMATCH
    };
  }

  if (kind === "key") {
    let parsed;
    try {
      parsed = parseKeyAnnouncementText(rawText);
    } catch (error) {
      return {
        ok: true,
        kind: "invalid_key",
        reason: error.message || "wrapper_parse_failed",
        errorType: classifyKeyParseError(error)
      };
    }

    const payload = parsed.payload;
    if (payload.v !== PROTOCOL.VERSION) {
      return {
        ok: true,
        kind: "invalid_key",
        reason: "unsupported_version",
        errorType: INTERNAL_ERROR.UNSUPPORTED_PROTOCOL_VERSION
      };
    }
    if (typeof payload.accountId !== "string") {
      return {
        ok: true,
        kind: "invalid_key",
        reason: "invalid_account_id",
        errorType: INTERNAL_ERROR.PAYLOAD_DECODE_FAILURE
      };
    }
    if (typeof payload.displayName !== "string") {
      return {
        ok: true,
        kind: "invalid_key",
        reason: "invalid_display_name",
        errorType: INTERNAL_ERROR.PAYLOAD_DECODE_FAILURE
      };
    }
    if (typeof payload.publicKeyArmored !== "string" || payload.publicKeyArmored.length === 0) {
      return {
        ok: true,
        kind: "invalid_key",
        reason: "invalid_public_key",
        errorType: INTERNAL_ERROR.PAYLOAD_DECODE_FAILURE
      };
    }
    if (typeof payload.sig !== "string" || payload.sig.length === 0) {
      return {
        ok: true,
        kind: "invalid_key",
        reason: "missing_signature",
        errorType: INTERNAL_ERROR.PAYLOAD_DECODE_FAILURE
      };
    }
    if (typeof payload.fingerprint !== "string" || payload.fingerprint.length === 0) {
      return {
        ok: true,
        kind: "invalid_key",
        reason: "invalid_fingerprint",
        errorType: INTERNAL_ERROR.PAYLOAD_DECODE_FAILURE
      };
    }

    if (payload.platform !== platform) {
      return {
        ok: true,
        kind: "invalid_key",
        reason: "platform_mismatch",
        errorType: INTERNAL_ERROR.STORAGE_MISMATCH
      };
    }
    if (payload.accountId !== normalizedAuthorId) {
      return {
        ok: true,
        kind: "invalid_key",
        reason: "author_mismatch",
        errorType: INTERNAL_ERROR.STORAGE_MISMATCH
      };
    }
    try {
      await verifyAnnouncement(payload);
    } catch (error) {
      return {
        ok: true,
        kind: "invalid_key",
        reason: error.message || "invalid_signature",
        errorType: INTERNAL_ERROR.ANNOUNCEMENT_SIGNATURE_VERIFICATION_FAILURE
      };
    }

    const normalizedFingerprint = normalizeFingerprint(payload.fingerprint);
    if (!normalizedFingerprint) {
      return {
        ok: true,
        kind: "invalid_key",
        reason: "invalid_fingerprint",
        errorType: INTERNAL_ERROR.PAYLOAD_DECODE_FAILURE
      };
    }
    let normalizedDerivedFingerprint = "";
    try {
      normalizedDerivedFingerprint = normalizeFingerprint(await publicKeyFingerprint(payload.publicKeyArmored));
    } catch (_error) {
      return {
        ok: true,
        kind: "invalid_key",
        reason: "invalid_public_key",
        errorType: INTERNAL_ERROR.PAYLOAD_DECODE_FAILURE
      };
    }
    if (normalizedFingerprint !== normalizedDerivedFingerprint) {
      return {
        ok: true,
        kind: "invalid_key",
        reason: "fingerprint_mismatch",
        errorType: INTERNAL_ERROR.PAYLOAD_DECODE_FAILURE
      };
    }

    if (payload.accountId !== normalizedDialogId) {
      const selfAuthoredAnnouncement =
        Boolean(normalizedBoundLocalId) &&
        payload.accountId === normalizedBoundLocalId &&
        normalizedAuthorId === normalizedBoundLocalId;
      if (selfAuthoredAnnouncement) {
        const normalizedIdentityFingerprint = normalizeFingerprint(identity.fingerprintFull);
        const identityKeyMatches = payload.publicKeyArmored === identity.publicKeyArmored;
        const identityFingerprintMatches =
          Boolean(normalizedIdentityFingerprint) &&
          normalizedDerivedFingerprint === normalizedIdentityFingerprint;
        if (!identityKeyMatches && !identityFingerprintMatches) {
          return {
            ok: true,
            kind: "invalid_key",
            reason: "self_key_mismatch",
            errorType: INTERNAL_ERROR.STORAGE_MISMATCH
          };
        }
        await mergeContact({
          schemaVersion: RECORD_SCHEMA_VERSION,
          platform,
          accountId: normalizedDialogId,
          lastOwnKeySharedAt: nowIso(),
          lastOwnKeyFingerprintShared: normalizedIdentityFingerprint
        });
        debugLog(debugEnabled, "incoming.key_ignored_self_announcement", {
          platform,
          dialogAccountId: normalizedDialogId,
          messageAuthorAccountId: normalizedAuthorId,
          messageId: normalizedMessageId
        });
        return { ok: true, kind: "key_self_announcement" };
      }
      return {
        ok: true,
        kind: "invalid_key",
        reason: "dialog_mismatch",
        errorType: INTERNAL_ERROR.STORAGE_MISMATCH
      };
    }

    const existing = await getContact(platform, payload.accountId);
    const normalizedStoredAnnouncementMessageId = normalizeOptionalMessageId(existing.lastAnnouncementMessageId);
    if (isOlderMessageId(normalizedMessageId, normalizedStoredAnnouncementMessageId)) {
      debugLog(debugEnabled, "incoming.key_ignored_stale", {
        platform,
        accountId: payload.accountId,
        messageId: normalizedMessageId,
        lastAnnouncementMessageId: normalizedStoredAnnouncementMessageId
      });
      return {
        ok: true,
        kind: "key_ignored_stale",
        reason: "stale_announcement"
      };
    }
    const conflict = await resolveKeyConflict(existing, normalizedDerivedFingerprint, payload.publicKeyArmored);
    const changed = conflict.changed;
    const unresolvedConflict = existing.trustState === TRUST.CHANGED || Boolean(existing.hasKeyConflict);
    const ownKeyAlreadyShared =
      normalizeFingerprint(existing.lastOwnKeyFingerprintShared) === normalizeFingerprint(identity.fingerprintFull);
    const updated = await mergeContact({
      schemaVersion: existing.schemaVersion || RECORD_SCHEMA_VERSION,
      platform,
      accountId: payload.accountId,
      displayName: payload.displayName || "",
      publicKeyArmored: payload.publicKeyArmored,
      fingerprintFull: normalizedDerivedFingerprint,
      fingerprintShort: formatShortFingerprint(normalizedDerivedFingerprint),
      firstSeenAt: existing.firstSeenAt || nowIso(),
      lastUpdatedAt: nowIso(),
      hasKeyConflict: changed || unresolvedConflict,
      previousFingerprintFull: changed
        ? conflict.previousFingerprintFull || existing.previousFingerprintFull || null
        : existing.previousFingerprintFull,
      lastAnnouncementMessageId: normalizedMessageId || existing.lastAnnouncementMessageId || null,
      trustState:
        changed || unresolvedConflict
          ? TRUST.CHANGED
          : existing.trustState === TRUST.MISSING
            ? TRUST.NEW
            : existing.trustState
    });
    if (changed) {
      debugLog(debugEnabled, "incoming.contact_key_conflict", {
        errorType: INTERNAL_ERROR.CONTACT_KEY_CONFLICT,
        platform,
        accountId: payload.accountId,
        messageId: normalizedMessageId
      });
    }
    debugLog(debugEnabled, "incoming.key_processed", {
      platform,
      accountId: payload.accountId,
      messageId: normalizedMessageId,
      trustState: updated.trustState
    });
    return {
      ok: true,
      kind: "key",
      trustState: updated.trustState,
      fingerprintFull: updated.fingerprintFull || "",
      fingerprintShort: updated.fingerprintShort || "",
      previousFingerprintFull: updated.previousFingerprintFull || "",
      ownKeyAlreadyShared,
      eventType: changed ? INTERNAL_ERROR.CONTACT_KEY_CONFLICT : null
    };
  }

  let encodedPayload = "";
  try {
    encodedPayload = parseEncryptedMessageText(rawText);
  } catch (error) {
    return {
      ok: true,
      kind: "decrypt_failed",
      reason: error.message || "wrapper_parse_failed",
      errorType: classifyMessageParseError(error)
    };
  }

  const authorIsLocal = Boolean(normalizedBoundLocalId && normalizedAuthorId === normalizedBoundLocalId);
  let senderPublicKeyArmored = "";

  if (authorIsLocal) {
    senderPublicKeyArmored = identity.publicKeyArmored;
  } else {
    const contact = await getContact(platform, normalizedAuthorId);
    if (!contact.publicKeyArmored) {
      return {
        ok: true,
        kind: "decrypt_failed",
        reason: "missing_contact_key",
        errorType: INTERNAL_ERROR.STORAGE_MISMATCH
      };
    }
    senderPublicKeyArmored = contact.publicKeyArmored;
  }

  try {
    const decrypted = await decryptMessage({
      encodedPayload,
      selfPrivateKeyArmored: identity.privateKeyArmored,
      senderPublicKeyArmored
    });

    if (!decrypted || typeof decrypted !== "object" || Array.isArray(decrypted)) {
      debugLog(debugEnabled, "incoming.decrypt_failed", {
        errorType: INTERNAL_ERROR.PAYLOAD_DECODE_FAILURE,
        reason: "invalid_payload_shape",
        platform,
        dialogAccountId: normalizedDialogId,
        messageAuthorAccountId: normalizedAuthorId,
        messageId: normalizedMessageId
      });
      return {
        ok: true,
        kind: "decrypt_failed",
        reason: "invalid_payload_shape",
        errorType: INTERNAL_ERROR.PAYLOAD_DECODE_FAILURE
      };
    }
    if (decrypted.v !== PROTOCOL.VERSION) {
      return {
        ok: true,
        kind: "decrypt_failed",
        reason: "unsupported_version",
        errorType: INTERNAL_ERROR.UNSUPPORTED_PROTOCOL_VERSION
      };
    }
    if (typeof decrypted.platform !== "string") {
      return {
        ok: true,
        kind: "decrypt_failed",
        reason: "invalid_platform",
        errorType: INTERNAL_ERROR.PAYLOAD_DECODE_FAILURE
      };
    }
    if (typeof decrypted.accountId !== "string") {
      return {
        ok: true,
        kind: "decrypt_failed",
        reason: "invalid_account_id",
        errorType: INTERNAL_ERROR.PAYLOAD_DECODE_FAILURE
      };
    }
    if (!isCanonicalIsoTimestamp(decrypted.ts)) {
      return {
        ok: true,
        kind: "decrypt_failed",
        reason: "invalid_timestamp",
        errorType: INTERNAL_ERROR.PAYLOAD_DECODE_FAILURE
      };
    }
    if (typeof decrypted.body !== "string") {
      return {
        ok: true,
        kind: "decrypt_failed",
        reason: "invalid_body",
        errorType: INTERNAL_ERROR.PAYLOAD_DECODE_FAILURE
      };
    }

    if (decrypted.platform !== platform) {
      debugLog(debugEnabled, "incoming.decrypt_failed", {
        reason: "platform_mismatch",
        platform,
        dialogAccountId: normalizedDialogId,
        messageAuthorAccountId: normalizedAuthorId,
        messageId: normalizedMessageId
      });
      return {
        ok: true,
        kind: "decrypt_failed",
        reason: "platform_mismatch",
        errorType: INTERNAL_ERROR.STORAGE_MISMATCH
      };
    }

    if (authorIsLocal) {
      if (decrypted.accountId !== normalizedBoundLocalId) {
        return {
          ok: true,
          kind: "decrypt_failed",
          reason: "sender_mismatch",
          errorType: INTERNAL_ERROR.STORAGE_MISMATCH
        };
      }
    } else if (decrypted.accountId !== normalizedAuthorId || decrypted.accountId !== normalizedDialogId) {
      return {
        ok: true,
        kind: "decrypt_failed",
        reason: "sender_mismatch",
        errorType: INTERNAL_ERROR.STORAGE_MISMATCH
      };
    }

    debugLog(debugEnabled, "incoming.decrypted", {
      platform,
      dialogAccountId: normalizedDialogId,
      messageAuthorAccountId: normalizedAuthorId,
      messageId: normalizedMessageId,
      authorIsLocal
    });
    return { ok: true, kind: "decrypted", body: decrypted.body, ts: decrypted.ts };
  } catch (error) {
    const errorType = classifyOpenPgpFailure(error);
    debugLog(debugEnabled, "incoming.decrypt_failed", {
      errorType,
      reason: error.message || "decrypt_failed",
      platform,
      dialogAccountId: normalizedDialogId,
      messageAuthorAccountId: normalizedAuthorId,
      messageId: normalizedMessageId
    });
    return {
      ok: true,
      kind: "decrypt_failed",
      reason: error.message || "decrypt_failed",
      errorType
    };
  }
}

async function onSetTrust({ platform, accountId, trustState }) {
  normalizePlatform(platform);
  const normalizedAccountId = normalizeAccountId(accountId);
  if (![TRUST.NEW, TRUST.TRUSTED, TRUST.CHANGED, TRUST.MISSING, TRUST.REJECTED].includes(trustState)) {
    throw new Error("invalid trust state");
  }
  const contact = await getContact(platform, normalizedAccountId);
  const requiresKnownKey = [TRUST.NEW, TRUST.TRUSTED, TRUST.CHANGED, TRUST.REJECTED].includes(trustState);
  if (requiresKnownKey && !contact.publicKeyArmored) {
    throw new Error("contact key is missing");
  }
  const keepConflictMarkers = trustState === TRUST.CHANGED;
  const updated = await mergeContact({
    schemaVersion: contact.schemaVersion || RECORD_SCHEMA_VERSION,
    platform,
    accountId: normalizedAccountId,
    trustState,
    hasKeyConflict: keepConflictMarkers ? Boolean(contact.hasKeyConflict) : false,
    previousFingerprintFull: keepConflictMarkers ? contact.previousFingerprintFull || null : null,
    lastUpdatedAt: nowIso()
  });
  return { ok: true, contact: updated };
}

async function onGetChatState({ platform, accountId }) {
  normalizePlatform(platform);
  const normalizedAccountId = normalizeAccountId(accountId);
  const state = await resolveChatState(platform, normalizedAccountId);
  return { ok: true, ...state };
}

async function onSetBackupAcknowledgement({ acknowledged }) {
  if (typeof acknowledged !== "boolean") throw new Error("acknowledged must be boolean");
  const current = await ensureSettings();
  const updated = { ...current, needsBackupAcknowledgement: !acknowledged };
  await setSettings(updated);
  return { ok: true, settings: updated };
}

async function onOpenPopup() {
  if (typeof chrome?.action?.openPopup !== "function") {
    return { ok: false, error: "popup_open_unavailable" };
  }
  try {
    await chrome.action.openPopup();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || "popup_open_failed" };
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureSettings();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const run = async () => {
    switch (message?.type) {
      case "mc:init-identity":
        return onInitIdentity(message.payload || {});
      case "mc:import-identity":
        return onImportIdentity(message.payload || {});
      case "mc:get-identity":
        return onGetIdentity();
      case "mc:get-private-key":
        return onGetPrivateKey();
      case "mc:get-settings":
        return onGetSettings();
      case "mc:set-debug-mode":
        return onSetDebugMode(message.payload || {});
      case "mc:set-warning-threshold":
        return onSetWarningThreshold(message.payload || {});
      case "mc:set-backup-acknowledged":
        return onSetBackupAcknowledgement(message.payload || {});
      case "mc:list-contacts":
        return onListContacts();
      case "mc:remove-contact":
        return onRemoveContact(message.payload || {}, sender);
      case "mc:mark-own-key-shared":
        return onMarkOwnKeyShared(message.payload || {});
      case "mc:upsert-binding":
        return onUpsertBinding(message.payload || {});
      case "mc:create-key-announcement":
        return onCreateKeyAnnouncement(message.payload || {});
      case "mc:sync-contact-profile":
        return onSyncContactProfile(message.payload || {});
      case "mc:process-outgoing":
        return onProcessOutgoing(message.payload || {});
      case "mc:process-incoming":
        return onProcessIncoming(message.payload || {});
      case "mc:set-trust":
        return onSetTrust(message.payload || {});
      case "mc:get-chat-state":
        return onGetChatState(message.payload || {});
      case "mc:open-popup":
        return onOpenPopup();
      default:
        return { ok: false, error: "unsupported_message_type" };
    }
  };

  run()
    .then((result) => sendResponse(result))
    .catch((error) =>
      sendResponse({
        ok: false,
        error: error.message || String(error)
      })
    );
  return true;
});
