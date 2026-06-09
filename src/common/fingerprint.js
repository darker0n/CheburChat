export function normalizeFingerprint(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

export function formatFingerprint(value) {
  const normalized = normalizeFingerprint(value);
  if (!normalized) return "";
  return normalized.match(/.{1,4}/g)?.join(" ") || normalized;
}

export function formatShortFingerprint(value) {
  const normalized = normalizeFingerprint(value);
  if (!normalized) return "";
  return formatFingerprint(normalized.slice(0, 12));
}
