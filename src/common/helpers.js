export const KEY_REPLACEMENT_WARNING = [
  "Если вы замените ключ шифрования, вам нужно будет снова поделиться новым ключом с контактом, а контакту — повторно его верифицировать.",
  "Вы также можете потерять доступ к истории сообщений, которая была зашифрована на старый ключ.",
  "Заменяйте ключ только если понимаете, что старые зашифрованные диалоги могут стать нечитаемыми."
].join("\n");

export function buildVkDialogUrl(accountId) {
  const url = new URL("https://vk.com/im");
  url.searchParams.set("sel", String(accountId || "").trim());
  return url.toString();
}

export async function sendMessage(type, payload = {}, chromeApi = globalThis.chrome) {
  return chromeApi.runtime.sendMessage({ type, payload });
}

export async function openUrlInNewTab(url, deps = {}) {
  const chromeApi = deps.chromeApi || globalThis.chrome;
  const windowApi = deps.windowApi || globalThis.window;

  try {
    if (chromeApi?.tabs?.create) {
      const result = chromeApi.tabs.create({ url });
      if (result && typeof result.then === "function") {
        await result;
      }
      return true;
    }
  } catch (_error) {}

  try {
    const opened = windowApi?.open?.(url, "_blank", "noopener");
    return opened !== null;
  } catch (_error) {
    return false;
  }
}

export async function copyTextToClipboard(text, deps = {}) {
  const value = String(text || "");
  if (!value) return false;

  const navigatorApi = deps.navigatorApi || globalThis.navigator;
  const documentApi = deps.documentApi || globalThis.document;

  try {
    if (navigatorApi?.clipboard?.writeText) {
      await navigatorApi.clipboard.writeText(value);
      return true;
    }
  } catch (_error) {}

  try {
    if (!documentApi?.createElement || !documentApi?.body?.appendChild || typeof documentApi.execCommand !== "function") {
      return false;
    }
    const fallback = documentApi.createElement("textarea");
    fallback.value = value;
    fallback.style.position = "fixed";
    fallback.style.opacity = "0";
    documentApi.body.appendChild(fallback);
    fallback.focus?.();
    fallback.select?.();
    const ok = documentApi.execCommand("copy");
    documentApi.body.removeChild(fallback);
    return Boolean(ok);
  } catch (_error) {
    return false;
  }
}
