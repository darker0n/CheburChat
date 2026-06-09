import {
  sendMessage,
  copyTextToClipboard,
  openUrlInNewTab,
  buildVkDialogUrl,
  buildVkContactShareUrl,
  KEY_REPLACEMENT_WARNING
} from "../common/helpers.js";
import { formatFingerprint, formatShortFingerprint } from "../common/fingerprint.js";
import { TRUST, PLATFORM } from "../common/constants.js";

const TRUST_LABEL = {
  [TRUST.TRUSTED]: "Доверенный",
  [TRUST.NEW]: "Не проверен",
  [TRUST.CHANGED]: "Ключ изменён",
  [TRUST.REJECTED]: "Отклонён"
};

// Lucide glyphs reused for JS-rendered rows (kept in sync with popup.html chrome).
const SIGIL_SVG = {
  [TRUST.TRUSTED]: '<svg data-lucide viewBox="0 0 24 24" aria-hidden="true"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  [TRUST.NEW]: '<svg data-lucide viewBox="0 0 24 24" aria-hidden="true"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>',
  [TRUST.CHANGED]: '<svg data-lucide viewBox="0 0 24 24" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>',
  [TRUST.REJECTED]: '<svg data-lucide viewBox="0 0 24 24" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m14.5 9.5-5 5"/><path d="m9.5 9.5 5 5"/></svg>'
};
const CHEVRON_SVG = '<svg data-lucide viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';
const CHECK_SVG = '<svg data-lucide viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
const FB_SUCCESS = '<svg viewBox="0 0 52 52" aria-hidden="true"><circle class="fb-ring" cx="26" cy="26" r="24" fill="none" stroke="currentColor" stroke-width="3"/><path class="fb-glyph" d="M16 27l7 7 14-15" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const FB_ERROR = '<svg viewBox="0 0 52 52" aria-hidden="true"><circle class="fb-ring" cx="26" cy="26" r="24" fill="none" stroke="currentColor" stroke-width="3"/><path class="fb-glyph" d="M18 18 34 34M34 18 18 34" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

let feedbackBackView = "view-main";

function $(id) { return document.getElementById(id); }
function setText(id, text) { const el = $(id); if (el) el.textContent = text; }

function showView(id) {
  const views = document.querySelectorAll(".view");
  for (const v of views) v.classList.remove("active");
  const el = $(id);
  if (el) el.classList.add("active");
}

// Mirror of the worker's effectiveTrustState — list-contacts returns raw records.
function effectiveTrustState(contact) {
  if (!contact?.publicKeyArmored) return TRUST.MISSING;
  if (contact.hasKeyConflict) return TRUST.CHANGED;
  const trustState = contact.trustState;
  if (trustState === TRUST.TRUSTED || trustState === TRUST.CHANGED || trustState === TRUST.REJECTED) return trustState;
  return TRUST.NEW;
}

function contactAccountId(contact) { return String(contact?.accountId || ""); }
function contactPlatform(contact) { return String(contact?.platform || PLATFORM.VK); }

// ---------- bootstrap ----------

async function bootstrap() {
  showView("view-loading");
  let identity;
  let contacts;
  let settings;
  try {
    const [idRes, listRes, settingsRes] = await Promise.all([
      sendMessage("mc:get-identity", {}),
      sendMessage("mc:list-contacts", {}),
      sendMessage("mc:get-settings", {})
    ]);
    if (!idRes?.ok || !listRes?.ok || !settingsRes?.ok) {
      return showLoadError("Не удалось загрузить данные расширения.");
    }
    identity = idRes.identity;
    contacts = listRes.contacts || [];
    settings = settingsRes.settings || {};
  } catch (_error) {
    return showLoadError("Не удалось загрузить данные расширения.");
  }

  if (!identity) return showView("view-onboarding");
  if (settings.needsBackupAcknowledgement) return showBackupOnReopen();
  renderMain(identity, contacts);
  showView("view-main");
}

function showLoadError(message) {
  if (message) setText("load-error-msg", message);
  showView("view-load-error");
}

async function reloadMain() {
  const [idRes, listRes] = await Promise.all([
    sendMessage("mc:get-identity", {}),
    sendMessage("mc:list-contacts", {})
  ]);
  if (idRes?.ok && listRes?.ok) renderMain(idRes.identity, listRes.contacts || []);
  showView("view-main");
}

// ---------- main / contacts ----------

function renderMain(identity, contacts) {
  setText("fp-value", formatShortFingerprint(identity?.fingerprintFull) || "—");
  const list = $("contacts-list");
  list.replaceChildren();
  const visible = (contacts || []).filter((c) => effectiveTrustState(c) !== TRUST.MISSING);
  setText("contacts-count", String(visible.length));
  const empty = $("contacts-empty");
  if (empty) empty.hidden = visible.length > 0;
  list.hidden = visible.length === 0;
  for (const contact of visible) list.appendChild(buildContactRow(contact));
}

function buildContactRow(contact) {
  const state = effectiveTrustState(contact);

  const row = document.createElement("div");
  row.className = "contact";

  const sigil = document.createElement("div");
  sigil.className = `sigil ${state}`;
  sigil.innerHTML = SIGIL_SVG[state] || SIGIL_SVG[TRUST.NEW];

  const body = document.createElement("div");
  body.className = "c-body";

  const name = document.createElement("div");
  name.className = "c-name";
  name.textContent = contact.displayName || contactAccountId(contact) || "—";

  const meta = document.createElement("div");
  meta.className = "c-meta";

  const fp = document.createElement("span");
  fp.className = "c-fp";
  fp.textContent = formatShortFingerprint(contact.fingerprintFull) || "—";

  const dot = document.createElement("span");
  dot.className = "c-dot";

  const trust = document.createElement("span");
  trust.className = `c-trust ${state}`;
  trust.textContent = TRUST_LABEL[state] || "";

  meta.append(fp, dot, trust);
  body.append(name, meta);

  const chev = document.createElement("div");
  chev.className = "chev";
  chev.innerHTML = CHEVRON_SVG;

  row.append(sigil, body, chev);
  row.addEventListener("click", () => openContact(contact));
  return row;
}

// ---------- contact detail ----------

function openContact(contact) {
  const state = effectiveTrustState(contact);

  setText("contact-name", contact.displayName || contactAccountId(contact) || "—");
  setText("contact-acct", `${contactPlatform(contact)}:${contactAccountId(contact) || "—"}`);

  const badge = $("contact-trust");
  badge.textContent = TRUST_LABEL[state] || "";
  badge.className = `trust-badge ${state}`;

  if (state === TRUST.NEW) setText("contact-fp-label", "Отпечаток контакта для проверки");
  else if (state === TRUST.CHANGED) setText("contact-fp-label", "Новый отпечаток");
  else setText("contact-fp-label", "Отпечаток контакта");
  setText("contact-fp", formatFingerprint(contact.fingerprintFull) || "—");

  const prevBlock = $("contact-prev-block");
  if (state === TRUST.CHANGED && contact.previousFingerprintFull) {
    prevBlock.hidden = false;
    setText("contact-prev-fp", formatFingerprint(contact.previousFingerprintFull) || "—");
  } else {
    prevBlock.hidden = true;
  }

  renderContactActions(contact, state);
  showView("view-contact");
}

function renderContactActions(contact, state) {
  const wrap = $("contact-actions");
  wrap.replaceChildren();

  const addButton = (label, variant, handler) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `btn ${variant}`;
    button.textContent = label;
    button.addEventListener("click", handler);
    wrap.appendChild(button);
  };

  const setTrust = async (trustState) => {
    const response = await sendMessage("mc:set-trust", {
      platform: contactPlatform(contact),
      accountId: contactAccountId(contact),
      trustState
    });
    if (!response?.ok) return showFeedback(false, "Не удалось обновить статус контакта.", "view-contact");
    await reloadMain();
  };
  const openDialog = () => openUrlInNewTab(buildVkDialogUrl(contactAccountId(contact)));
  const shareKey = () => openUrlInNewTab(buildVkContactShareUrl(contactAccountId(contact)));

  if (state === TRUST.NEW) {
    addButton("Проверил отпечаток", "btn-primary", () => setTrust(TRUST.TRUSTED));
    addButton("Поделиться ключом", "btn-secondary", shareKey);
    addButton("Открыть диалог", "btn-secondary", openDialog);
    addButton("Отклонить", "btn-danger", () => setTrust(TRUST.REJECTED));
  } else if (state === TRUST.TRUSTED) {
    addButton("Открыть диалог", "btn-primary", openDialog);
    addButton("Поделиться ключом", "btn-secondary", shareKey);
  } else if (state === TRUST.CHANGED) {
    addButton("Принять новый ключ", "btn-primary", () => setTrust(TRUST.TRUSTED));
    addButton("Открыть диалог", "btn-secondary", openDialog);
    addButton("Отклонить", "btn-danger", () => setTrust(TRUST.REJECTED));
  } else if (state === TRUST.REJECTED) {
    addButton("Вернуть в непроверенные", "btn-primary", () => setTrust(TRUST.NEW));
    addButton("Открыть диалог", "btn-secondary", openDialog);
  }
}

// ---------- create / backup ----------

async function createIdentity() {
  showView("view-loading");
  const response = await sendMessage("mc:init-identity", { displayName: "" });
  if (!response?.ok || !response.identity) {
    return showFeedback(false, "Не удалось создать ключ.", "view-onboarding");
  }
  $("backup-key").value = response.identity.privateKeyArmored || "";
  showView("view-backup");
}

// On re-open while backup is still pending the private key is fetched explicitly —
// mc:get-identity intentionally never returns it.
async function showBackupOnReopen() {
  const response = await sendMessage("mc:get-private-key", {});
  $("backup-key").value = response?.ok ? response.privateKeyArmored || "" : "";
  showView("view-backup");
}

async function acknowledgeBackup() {
  await sendMessage("mc:set-backup-acknowledged", { acknowledged: true });
  $("backup-key").value = "";
  await reloadMain();
}

async function copyBackupKey() {
  const value = $("backup-key").value || "";
  const ok = await copyTextToClipboard(value, { navigatorApi: globalThis.navigator, documentApi: document });
  showFeedback(ok, ok ? "Приватный ключ скопирован." : "Не удалось скопировать ключ.", "view-backup");
}

function downloadBackupKey() {
  const value = $("backup-key").value || "";
  const ok = downloadTextFile("cheburchat-private-key.asc", value);
  showFeedback(ok, ok ? "Файл сохранён." : "Не удалось сохранить файл.", "view-backup");
}

function downloadTextFile(filename, text) {
  try {
    const blob = new Blob([String(text || "")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    return true;
  } catch (_error) {
    return false;
  }
}

// ---------- import ----------

async function submitImport() {
  const text = ($("import-text").value || "").trim();
  if (!text) return showFeedback(false, "Вставьте ключ или выберите файл.", "view-import");

  const idResponse = await sendMessage("mc:get-identity", {});
  if (idResponse?.ok && idResponse.identity) {
    if (!globalThis.confirm(KEY_REPLACEMENT_WARNING)) return;
  }

  showView("view-loading");
  const response = await sendMessage("mc:import-identity", { privateKeyArmored: text });
  if (!response?.ok) {
    return showFeedback(false, "Не удалось импортировать ключ. Проверьте формат.", "view-import");
  }
  await reloadMain();
}

function readImportFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    $("import-text").value = String(reader.result || "");
    setText("import-file-label", file.name);
  };
  reader.onerror = () => showFeedback(false, "Не удалось прочитать файл ключа.", "view-import");
  reader.readAsText(file);
}

// ---------- feedback / misc ----------

function showFeedback(ok, message, backView) {
  feedbackBackView = backView || "view-main";
  const mark = $("fb-mark");
  if (mark) {
    mark.className = `fb-mark ${ok ? "ok" : "err"}`;
    mark.innerHTML = ok ? FB_SUCCESS : FB_ERROR;
  }
  setText("fb-title", ok ? "Готово" : "Ошибка");
  setText("fb-msg", message || "");
  showView("view-feedback");
}

async function copyOwnFingerprint() {
  const value = ($("fp-value").textContent || "").trim();
  if (!value || value === "—") return;
  const ok = await copyTextToClipboard(value, { navigatorApi: globalThis.navigator, documentApi: document });
  if (!ok) return;
  flashCopied("fp-copy");
}

function flashCopied(buttonId) {
  const button = $(buttonId);
  if (!button) return;
  const original = button.innerHTML;
  button.innerHTML = CHECK_SVG;
  globalThis.setTimeout?.(() => { button.innerHTML = original; }, 1100);
}

function openSettings() {
  globalThis.chrome?.runtime?.openOptionsPage?.();
}

// ---------- wiring ----------

function on(id, event, handler) {
  const el = $(id);
  if (el) el.addEventListener(event, handler);
}

function wireEvents() {
  on("retry-btn", "click", bootstrap);
  on("onboarding-create", "click", createIdentity);
  on("onboarding-import", "click", () => showView("view-import"));
  on("backup-copy", "click", copyBackupKey);
  on("backup-download", "click", downloadBackupKey);
  on("backup-ack", "click", acknowledgeBackup);
  on("fp-copy", "click", copyOwnFingerprint);
  on("open-settings", "click", openSettings);
  on("contact-back", "click", () => showView("view-main"));
  on("import-back", "click", () => showView("view-main"));
  on("import-submit", "click", submitImport);
  on("import-file", "change", (event) => readImportFile(event.target?.files?.[0]));
  on("fb-back", "click", () => showView(feedbackBackView));
}

if (typeof document !== "undefined") {
  wireEvents();
  bootstrap();
}

export {
  effectiveTrustState,
  TRUST_LABEL,
  bootstrap,
  renderMain,
  openContact,
  showView
};
