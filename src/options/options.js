import { formatFingerprint, formatShortFingerprint } from "../common/fingerprint.js";
import {
  KEY_REPLACEMENT_WARNING,
  buildVkContactShareUrl,
  copyTextToClipboard as copyTextToClipboardShared,
  openUrlInNewTab,
  sendMessage
} from "../common/helpers.js";

let currentIdentity = null;

function setOnboardingVisible(visible) {
  const onboardingSection = safeQuery("#onboarding-section");
  if (!onboardingSection) return;
  onboardingSection.style.display = visible ? "" : "none";
}

function setMessage(text, isError = false) {
  const node = document.querySelector("#message");
  node.textContent = text;
  node.style.color = isError ? "#8f1f1f" : "#0d5a20";
}

function safeQuery(selector) {
  try {
    return document.querySelector(selector);
  } catch (_error) {
    return null;
  }
}

function confirmKeyReplacementIfNeeded() {
  if (!currentIdentity) return true;
  return window.confirm(`${KEY_REPLACEMENT_WARNING}\n\nПродолжить?`);
}

async function copyTextToClipboard(text, successLabel) {
  if (!String(text || "")) {
    setMessage("Нечего копировать.", true);
    return;
  }
  const ok = await copyTextToClipboardShared(text, {
    navigatorApi: navigator,
    documentApi: document
  });
  if (!ok) {
    setMessage(`Не удалось скопировать: ${successLabel}.`, true);
    return;
  }
  setMessage(`Скопировано: ${successLabel}.`);
}

async function refreshIdentity() {
  const response = await sendMessage("mc:get-identity", {}, chrome);
  if (!response.ok) {
    setMessage(response.error || "Не удалось загрузить ключ шифрования", true);
    return;
  }
  const identity = response.identity;
  currentIdentity = identity;
  const status = document.querySelector("#identity-status");
  const shortFingerprint = document.querySelector("#fingerprint-short-output");
  const fullFingerprint = document.querySelector("#fingerprint-full-output");
  const pub = document.querySelector("#public-key-output");
  const priv = document.querySelector("#private-key-output");

  if (!identity) {
    setOnboardingVisible(true);
    status.textContent = "Ключ шифрования не загружен.";
    shortFingerprint.value = "";
    fullFingerprint.value = "";
    pub.value = "";
    priv.value = "";
    return;
  }

  setOnboardingVisible(false);
  const shortFingerprintText = formatShortFingerprint(identity.fingerprintShort || identity.fingerprintFull);
  const fullFingerprintText = formatFingerprint(identity.fingerprintFull);
  status.textContent = `Загружен ключ шифрования: ${shortFingerprintText} (${fullFingerprintText})`;
  shortFingerprint.value = shortFingerprintText;
  fullFingerprint.value = fullFingerprintText;
  pub.value = identity.publicKeyArmored;

  const privResponse = await sendMessage("mc:get-private-key", {}, chrome);
  priv.value = privResponse.ok ? privResponse.privateKeyArmored : "";
}

async function ensureIdentityForKeyShare() {
  if (currentIdentity) return currentIdentity;

  const response = await sendMessage("mc:get-identity", {}, chrome);
  if (!response?.ok) {
    setMessage(response?.error || "Не удалось проверить ключ шифрования.", true);
    return null;
  }
  currentIdentity = response.identity || null;
  if (!currentIdentity) {
    setMessage("Сначала создайте или импортируйте ключ шифрования.", true);
    return null;
  }
  return currentIdentity;
}

async function shareKeyWithContact(contact) {
  const platform = String(contact?.platform || "").trim();
  const accountId = String(contact?.accountId || "").trim();
  const mainLabel = String(contact?.displayName || "").trim() || accountId || "Без имени";

  if (platform !== "vk" || !accountId) {
    setMessage("Повторная отправка ключа сейчас поддерживается только для контактов VK.", true);
    return;
  }

  const identity = await ensureIdentityForKeyShare();
  if (!identity) return;

  const opened = await openUrlInNewTab(buildVkContactShareUrl(accountId), {
    chromeApi: chrome,
    windowApi: window
  });
  if (!opened) {
    setMessage("Не удалось открыть диалог VK для повторной отправки ключа.", true);
    return;
  }
  setMessage(`Открываю диалог с контактом ${mainLabel}. Публичный ключ будет отправлен автоматически.`);
}

async function createIdentity() {
  if (!confirmKeyReplacementIfNeeded()) return;

  const response = await sendMessage("mc:init-identity", {
    displayName: ""
  }, chrome);
  if (!response.ok) {
    setMessage(response.error || "Не удалось создать ключ шифрования", true);
    return;
  }
  setMessage("Ключ шифрования создан.");
  await refreshIdentity();
}

async function importIdentity() {
  const input = document.querySelector("#private-key-input");
  const privateKeyArmored = input.value.trim();
  if (!privateKeyArmored) {
    setMessage("Требуется приватный ключ.", true);
    return;
  }
  if (currentIdentity) {
    if (!confirmKeyReplacementIfNeeded()) return;
  }

  const response = await sendMessage("mc:import-identity", { privateKeyArmored }, chrome);
  if (!response.ok) {
    setMessage(response.error || "Не удалось импортировать ключ шифрования", true);
    return;
  }
  setMessage("Ключ шифрования импортирован.");
  await refreshIdentity();
}

async function refreshSettingsControls() {
  const toggle = safeQuery("#debug-mode-toggle");
  const thresholdInput = safeQuery("#warning-threshold-input");
  if (!toggle && !thresholdInput) return;

  const response = await sendMessage("mc:get-settings", {}, chrome);
  if (!response?.ok) {
    setMessage(response?.error || "Не удалось загрузить настройки.", true);
    return;
  }
  if (toggle) {
    toggle.checked = Boolean(response.settings?.debugMode);
  }
  if (thresholdInput) {
    const threshold = Number(response.settings?.warningThresholdChars);
    thresholdInput.value = String(Number.isFinite(threshold) && threshold > 0 ? threshold : 1800);
  }
}

async function saveDebugMode() {
  const toggle = safeQuery("#debug-mode-toggle");
  if (!toggle) return;

  const response = await sendMessage("mc:set-debug-mode", {
    debugMode: Boolean(toggle.checked)
  }, chrome);
  if (!response?.ok) {
    setMessage(response?.error || "Не удалось обновить режим отладки.", true);
    return;
  }
  setMessage(`Режим отладки ${toggle.checked ? "включен" : "выключен"}.`);
}

async function saveWarningThreshold() {
  const thresholdInput = safeQuery("#warning-threshold-input");
  if (!thresholdInput) return;

  const threshold = Number(thresholdInput.value);
  if (!Number.isFinite(threshold) || !Number.isInteger(threshold)) {
    setMessage("Порог предупреждения должен быть целым числом.", true);
    return;
  }

  const response = await sendMessage("mc:set-warning-threshold", {
    warningThresholdChars: threshold
  }, chrome);
  if (!response?.ok) {
    setMessage(response?.error || "Не удалось сохранить порог предупреждения.", true);
    return;
  }
  const savedThreshold = Number(response.settings?.warningThresholdChars);
  thresholdInput.value = String(Number.isFinite(savedThreshold) && savedThreshold > 0 ? savedThreshold : threshold);
  setMessage("Порог предупреждения сохранен.");
}

async function refreshContacts() {
  const list = safeQuery("#contacts-list");
  if (!list) return;

  const response = await sendMessage("mc:list-contacts", {}, chrome);
  if (!response?.ok) {
    setMessage(response?.error || "Не удалось загрузить контакты.", true);
    return;
  }

  list.innerHTML = "";
  const contacts = Array.isArray(response.contacts) ? response.contacts : [];
  if (contacts.length === 0) {
    list.textContent = "Нет сохраненных контактов.";
    return;
  }

  for (const contact of contacts) {
    const row = document.createElement("div");
    row.className = "contact-row";

    const summary = document.createElement("span");
    const displayName = String(contact?.displayName || "").trim();
    const accountId = String(contact?.accountId || "").trim();
    const platform = String(contact?.platform || "").trim();
    const trustState = String(contact?.trustState || "").trim();
    const fingerprintShort = formatShortFingerprint(contact?.fingerprintShort || contact?.fingerprintFull);
    const mainLabel = displayName || accountId || "Без имени";
    summary.textContent = `${mainLabel} (${platform}:${accountId}) — ${trustState}${fingerprintShort ? ` — ${fingerprintShort}` : ""}`;

    const actions = document.createElement("div");
    actions.className = "contact-actions";

    const shareButton = document.createElement("button");
    shareButton.type = "button";
    shareButton.textContent = "Поделиться ключом";
    shareButton.addEventListener("click", async () => {
      await shareKeyWithContact(contact);
    });

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "contact-remove-button";
    removeButton.textContent = "Удалить";
    removeButton.addEventListener("click", async () => {
      const confirmed = window.confirm(
        `Удалить сохраненный ключ контакта ${mainLabel} (${platform}:${accountId})?`
      );
      if (!confirmed) return;

      const removeResponse = await sendMessage("mc:remove-contact", {
        platform,
        accountId
      }, chrome);
      if (!removeResponse?.ok) {
        setMessage(removeResponse?.error || "Не удалось удалить контакт.", true);
        return;
      }
      setMessage(`Контакт ${mainLabel} удален.`);
      await refreshContacts();
    });

    actions.appendChild(shareButton);
    actions.appendChild(removeButton);
    row.appendChild(summary);
    row.appendChild(actions);
    list.appendChild(row);
  }
}

function openImportOnboarding() {
  const input = safeQuery("#private-key-input");
  if (!input) return;
  if (typeof input.focus === "function") input.focus();
  setMessage("Вставьте приватный ключ в текстовом формате и нажмите «Импортировать».");
}

document.querySelector("#create-identity").addEventListener("click", createIdentity);
document.querySelector("#refresh-identity").addEventListener("click", refreshIdentity);
document.querySelector("#import-identity").addEventListener("click", importIdentity);
document.querySelector("#copy-fingerprint-short").addEventListener("click", async () => {
  await copyTextToClipboard(
    document.querySelector("#fingerprint-short-output").value,
    "короткий отпечаток ключа (fingerprint)"
  );
});
document.querySelector("#copy-fingerprint-full").addEventListener("click", async () => {
  await copyTextToClipboard(
    document.querySelector("#fingerprint-full-output").value,
    "полный отпечаток ключа (fingerprint)"
  );
});
document.querySelector("#copy-public-key").addEventListener("click", async () => {
  await copyTextToClipboard(document.querySelector("#public-key-output").value, "публичный ключ");
});
document.querySelector("#copy-private-key").addEventListener("click", async () => {
  await copyTextToClipboard(document.querySelector("#private-key-output").value, "приватный ключ");
});
const saveDebugModeButton = safeQuery("#save-debug-mode");
if (saveDebugModeButton) {
  saveDebugModeButton.addEventListener("click", saveDebugMode);
}
const saveWarningThresholdButton = safeQuery("#save-warning-threshold");
if (saveWarningThresholdButton) {
  saveWarningThresholdButton.addEventListener("click", saveWarningThreshold);
}
const refreshContactsButton = safeQuery("#refresh-contacts");
if (refreshContactsButton) {
  refreshContactsButton.addEventListener("click", refreshContacts);
}
const onboardingCreateButton = safeQuery("#onboarding-create");
if (onboardingCreateButton) {
  onboardingCreateButton.addEventListener("click", createIdentity);
}
const onboardingImportButton = safeQuery("#onboarding-import");
if (onboardingImportButton) {
  onboardingImportButton.addEventListener("click", openImportOnboarding);
}

refreshIdentity();
void refreshSettingsControls();
void refreshContacts();
