const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function base64urlEncodeBytes(bytes) {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64urlDecodeToBytes(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return fromBase64(padded);
}

export function base64urlEncodeUtf8(text) {
  return base64urlEncodeBytes(encoder.encode(text));
}

export function base64urlDecodeUtf8(value) {
  return decoder.decode(base64urlDecodeToBytes(value));
}

export function utf8Encode(text) {
  return encoder.encode(text);
}

export function utf8Decode(bytes) {
  return decoder.decode(bytes);
}
