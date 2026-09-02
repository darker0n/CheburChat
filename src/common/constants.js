export const PROTOCOL = Object.freeze({
  VERSION: "v1",
  KEY_PREFIX: "CHEBURCHAT:v1:key:",
  MSG_PREFIX: "CHEBURCHAT:v1:msg:",
  INVITE_LINE:
    "Я поделился с вами своим ключом шифрования CheburChat. Установите CheburChat, чтобы включить защищённый чат: https://cheburchat.com/install",
  INSTALL_URL: "https://cheburchat.com/install",
  WARNING_THRESHOLD_CHARS: 1800,
  HARD_LIMIT_CHARS: 4096
});

export const TRUST = Object.freeze({
  MISSING: "missing",
  NEW: "new",
  TRUSTED: "trusted",
  CHANGED: "changed",
  REJECTED: "rejected"
});

export const STORAGE = Object.freeze({
  IDENTITY: "identity",
  SETTINGS: "settings",
  BINDING_PREFIX: "binding:",
  CONTACT_PREFIX: "contact:",
  KEY_SHARE_INTENT_PREFIX: "key-share-intent:"
});

export const PLATFORM = Object.freeze({
  VK: "vk"
});

export const INTERNAL_ERROR = Object.freeze({
  WRAPPER_PARSE_FAILURE: "wrapper_parse_failure",
  PAYLOAD_DECODE_FAILURE: "payload_decode_failure",
  OPENPGP_PARSE_FAILURE: "openpgp_parse_failure",
  DECRYPTION_FAILURE: "decryption_failure",
  ANNOUNCEMENT_SIGNATURE_VERIFICATION_FAILURE: "announcement_signature_verification_failure",
  ENCRYPTED_MESSAGE_SIGNATURE_VERIFICATION_FAILURE: "encrypted_message_signature_verification_failure",
  STORAGE_MISMATCH: "storage_mismatch",
  CONTACT_KEY_CONFLICT: "contact_key_conflict",
  UNSUPPORTED_PROTOCOL_VERSION: "unsupported_protocol_version",
  MESSAGE_TOO_LONG: "message_too_long"
});
