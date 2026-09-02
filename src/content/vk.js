(function main() {
  const PLATFORM = "vk";
  const vkPureHelpers = globalThis.__CHEBURCHAT_VK_PURE__;
  if (!vkPureHelpers) return;
  const {
    parseSelToken,
    parseSelFromParams,
    parseDialogFromPath,
    parseAccountIdFromHref,
    parseOwnAccountIdFromNavHref,
    parseDialogFromHref,
    guessMessageAuthorAccountIdFromClass
  } = vkPureHelpers;

  const TRUST = {
    MISSING: "missing",
    NEW: "new",
    TRUSTED: "trusted",
    CHANGED: "changed",
    REJECTED: "rejected"
  };
  const KEY_LINE_PATTERN = /^CHEBURCHAT:[^:\s]+:key:[A-Za-z0-9_-]+$/;
  const MSG_LINE_PATTERN = /^CHEBURCHAT:[^:\s]+:msg:[A-Za-z0-9_-]+$/;
  const SUPPORTED_PROTOCOL_VERSION = "v1";
  const MAX_INCOMING_NODES_PER_CYCLE = 10;

  let guardSend = false;
  let pendingPlaintextSend = false;
  let pendingPlaintextText = "";
  let pendingPlaintextTimer = null;
  let pendingOwnKeyShareAccountId = "";
  let indicatorNode = null;
  let indicatorAnchor = null;
  let sizeWarningNode = null;
  let sizeWarningAnchor = null;
  let lastSyncedBindingAccountId = "";
  let lastSyncedContactProfileKey = "";
  let lastChatTrustState = TRUST.MISSING;
  let warningThresholdBytes = 1800;
  let warningThresholdLoaded = false;
  const MUTATION_DEBOUNCE_MS = 60;
  const EMPTY_ATTR_SENTINEL = "__CHEBURCHAT_EMPTY__";
  let mutationDebounceTimer = null;
  let mutationRefreshInFlight = false;
  let mutationRefreshQueued = false;
  let styledSendButton = null;
  let keyShareIntentCheckInFlight = false;
  let checkedKeyShareIntentAccountId = "";
  const testCleanupHooks = globalThis.__CHEBURCHAT_VK_TEST_CLEANUPS__;
  const testApi = globalThis.__CHEBURCHAT_VK_TEST_API__;
  const idleWaiters = [];

  function flushIdleWaitersIfReady() {
    if (mutationDebounceTimer !== null) return;
    if (mutationRefreshQueued) return;
    if (mutationRefreshInFlight) return;
    while (idleWaiters.length > 0) {
      const resolve = idleWaiters.shift();
      try {
        resolve?.();
      } catch (_error) {}
    }
  }

  function waitForIdle() {
    return new Promise((resolve) => {
      idleWaiters.push(resolve);
      flushIdleWaitersIfReady();
    });
  }

  function isDirectDialogAccountId(accountId) {
    return /^[1-9][0-9]*$/.test(String(accountId || "").trim());
  }

  function normalizedText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function formatFingerprint(value) {
    const normalized = normalizeFingerprint(value);
    if (!normalized) return "";
    return normalized.match(/.{1,4}/g)?.join(" ") || normalized;
  }

  function normalizeFingerprint(value) {
    return String(value || "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
  }

  function parseDialogFromDom() {
    const selectors = [
      "[data-peer-id]",
      "[data-peer]",
      "[data-dialog-id]",
      "[data-chat-id]"
    ];
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      if (!node) continue;
      const raw =
        node.getAttribute("data-peer-id") ||
        node.getAttribute("data-peer") ||
        node.getAttribute("data-dialog-id") ||
        node.getAttribute("data-chat-id") ||
        "";
      const parsed = parseSelToken(raw);
      if (parsed) return parsed;
    }
    return "";
  }

  function parseDialogFromLinks() {
    const selectors = [
      ".ConvoHeader a[href]",
      ".ConvoTitle a[href]",
      ".ConvoListItem--selected a[href]",
      "[class*='ConvoListItem'][class*='selected'] a[href]"
    ];
    for (const selector of selectors) {
      const nodes = document.querySelectorAll(selector);
      for (const node of nodes) {
        const href = node.getAttribute("href") || "";
        const parsed = parseDialogFromHref(href);
        if (parsed) return parsed;
      }
    }
    return "";
  }

  function getDialogAccountId() {
    const url = new URL(window.location.href);
    return (
      parseSelToken(url.searchParams.get("sel")) ||
      parseSelFromParams(url.hash) ||
      parseDialogFromPath(url.pathname) ||
      parseDialogFromDom() ||
      parseDialogFromLinks()
    );
  }

  function getLocalAccountId() {
    const candidates = [
      window?.vk?.id,
      window?.cur?.oid,
      document.body?.dataset?.userId,
      document.querySelector("meta[name='vk-user-id']")?.getAttribute("content")
    ];
    for (const candidate of candidates) {
      const value = String(candidate || "").trim();
      if (/^[0-9]+$/.test(value)) return value;
    }
    // Content scripts run in an isolated world, so window.vk.id is never visible here, and
    // current VK ships no vk-user-id meta/dataset. Fall back to the logged-in user's own
    // nav sections (/photos<id>, /audios<id>), which carry the own account id and — unlike
    // bare /id links — do not appear in chat content (so we never bind a stranger's id).
    const navLinks = document.querySelectorAll("a[href*='photos'], a[href*='audios']");
    for (const link of navLinks) {
      const id = parseOwnAccountIdFromNavHref(link.getAttribute("href"));
      if (id) return id;
    }
    return "";
  }

  function textFromSelectors(selectors) {
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      const text = normalizedText(node?.textContent || node?.getAttribute?.("alt") || "");
      if (text) return text;
    }
    return "";
  }

  function getLocalDisplayName(localAccountId) {
    const normalizedAccountId = String(localAccountId || "").trim();
    if (!normalizedAccountId) return "";

    const escapedAccountId = normalizedAccountId.replace(/"/g, '\\"');
    const hrefSelectors = [
      `a[href='https://vk.com/id${escapedAccountId}'] img[alt]`,
      `a[href='/id${escapedAccountId}'] img[alt]`,
      `a[href*='id${escapedAccountId}'] img[alt]`,
      `a[href='https://vk.com/id${escapedAccountId}']`,
      `a[href='/id${escapedAccountId}']`,
      `a[href*='id${escapedAccountId}'].ConvoMessageHeader__authorLink`,
      `a[href*='id${escapedAccountId}'] .ConvoMessageHeader__authorLink`
    ];
    return textFromSelectors(hrefSelectors);
  }

  function getDialogDisplayName() {
    return textFromSelectors([
      ".ConvoHeader__title .ConvoTitle__author",
      ".ConvoHeader__title .PeerTitle__title",
      ".ConvoTitle__author",
      ".PeerTitle__title"
    ]);
  }

  function detectCompose() {
    const selectors = [
      "textarea",
      "[contenteditable='true'][role='textbox']",
      "[contenteditable='true'][data-testid*='input']",
      ".im_editable",
      "div[contenteditable='true']"
    ];
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element) return element;
    }
    return null;
  }

  function detectSendButton() {
    const compose = detectCompose();
    const selectors = [
      "button[type='submit']",
      "button[aria-label*='Send']",
      "button[aria-label*='Отправ']",
      "[data-testid*='send']",
      ".im-send-btn button",
      ".im-send-btn",
      "[class*='sendButton--']"
    ];
    const candidates = [];
    const seen = new Set();
    const pushCandidate = (button) => {
      if (!button || seen.has(button)) return;
      const classText = String(button.className || "").toLowerCase();
      if (classText.includes("mc-lock-indicator") || classText.includes("mc-inline-action-button")) return;
      seen.add(button);
      candidates.push(button);
    };

    for (const selector of selectors) {
      const matches = document.querySelectorAll(selector);
      for (const match of matches) {
        pushCandidate(match);
      }
    }

    const composerRoot = compose?.closest?.(".ConvoComposer") || compose?.parentElement || null;
    if (composerRoot?.querySelectorAll) {
      const localButtons = composerRoot.querySelectorAll("button, [role='button']");
      for (const button of localButtons) {
        const classText = String(button.className || "").toLowerCase();
        const ariaLabel = String(button.getAttribute?.("aria-label") || "").toLowerCase();
        const title = String(button.getAttribute?.("title") || "").toLowerCase();
        const dataTestId = String(button.getAttribute?.("data-testid") || "").toLowerCase();
        const sendHint =
          classText.includes("sendbutton--") ||
          classText.includes("im-send-btn") ||
          ariaLabel.includes("send") ||
          ariaLabel.includes("отправ") ||
          title.includes("send") ||
          title.includes("отправ") ||
          dataTestId.includes("send");
        if (sendHint) pushCandidate(button);
      }
    }

    if (candidates.length === 0) return null;

    const scoreButton = (button) => {
      const classText = String(button.className || "").toLowerCase();
      const ariaLabel = String(button.getAttribute?.("aria-label") || "").toLowerCase();
      const title = String(button.getAttribute?.("title") || "").toLowerCase();
      const type = String(button.getAttribute?.("type") || "").toLowerCase();
      const dataTestId = String(button.getAttribute?.("data-testid") || "").toLowerCase();
      const sendLabelHint =
        ariaLabel.includes("send") ||
        ariaLabel.includes("отправ") ||
        title.includes("send") ||
        title.includes("отправ");
      let score = 0;
      if (/sendbutton--(submit|send)\b/.test(classText)) score += 8;
      if (type === "submit") score += 6;
      if (sendLabelHint) score += 4;
      if (dataTestId.includes("send")) score += 3;
      if (classText.includes("sendbutton--") || classText.includes("im-send-btn")) score += 2;
      if (isMicrophoneSendButton(button)) score -= 10;
      return score;
    };

    let selected = candidates[0];
    let bestScore = scoreButton(selected);
    for (let index = 1; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const candidateScore = scoreButton(candidate);
      if (candidateScore > bestScore) {
        selected = candidate;
        bestScore = candidateScore;
      }
    }
    return selected;
  }

  function readComposeText(composeNode) {
    if ("value" in composeNode) return String(composeNode.value || "").trim();
    return (composeNode.innerText || composeNode.textContent || "").trim();
  }

  function utf8ByteLength(value) {
    return new TextEncoder().encode(String(value || "")).length;
  }

  function isTrustedForEncryptedSend(trustState) {
    return trustState === TRUST.TRUSTED;
  }

  function writeComposeText(composeNode, text) {
    if ("value" in composeNode) {
      composeNode.value = text;
      composeNode.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    composeNode.focus();
    const selection = document.getSelection();
    if (selection && typeof selection.selectAllChildren === "function") {
      selection.selectAllChildren(composeNode);
    }
    if (typeof document.execCommand === "function") {
      // Deprecated, but still the most reliable way to update VK contenteditable inputs
      // while preserving the editor's internal state and undo history.
      document.execCommand("insertText", false, text);
    } else {
      composeNode.textContent = text;
      composeNode.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  async function sendMessage(type, payload) {
    return chrome.runtime.sendMessage({ type, payload });
  }

  function getPopupSetupFallbackText() {
    return "Нажмите на иконку расширения Чебурчат в панели браузера, чтобы создать или импортировать ключ.";
  }

  async function openPopupSetupFlow() {
    const response = await sendMessage("mc:open-popup", {});
    if (response?.ok) return true;
    window.alert(getPopupSetupFallbackText());
    return false;
  }

  function showInlineIdentitySetupPrompt(node) {
    setOverlayText(
      node,
      "Чтобы использовать шифрование, сначала создайте или импортируйте свой ключ в расширении Чебурчат.",
      ["mc-message-system", "mc-message-warning"]
    );
    setInlineActions(node, {
      title: "Сначала настройте свой ключ.",
      description: "Откройте расширение Чебурчат и завершите первичную настройку ключа.",
      actions: [
        {
          label: "Создать ключ",
          onClick: async () => {
            await openPopupSetupFlow();
            return false;
          }
        }
      ]
    });
  }

  async function loadWarningThreshold() {
    if (warningThresholdLoaded) return;
    warningThresholdLoaded = true;
    const response = await sendMessage("mc:get-settings", {});
    const threshold = Number(response?.settings?.warningThresholdChars);
    if (response?.ok && Number.isFinite(threshold) && threshold > 0) {
      warningThresholdBytes = threshold;
    }
  }

  function isMicrophoneSendButton(sendButton) {
    if (!sendButton) return false;
    const classText = String(sendButton.className || "").toLowerCase();
    if (/sendbutton--(submit|send)\b/.test(classText)) return false;
    const ariaLabel = String(sendButton.getAttribute?.("aria-label") || "").toLowerCase();
    const title = String(sendButton.getAttribute?.("title") || "").toLowerCase();
    return (
      classText.includes("sendbutton--mic") ||
      /\bmic\b/.test(classText) ||
      ariaLabel.includes("микроф") ||
      ariaLabel.includes("голос") ||
      title.includes("микроф") ||
      title.includes("голос")
    );
  }

  function restoreSendButtonStyle(sendButton) {
    if (!sendButton) return;
    sendButton.classList.remove("mc-send-encrypted", "mc-send-changed", "mc-send-native-hidden");
    const originalAriaLabel = sendButton.dataset.mcOriginalAriaLabel;
    if (originalAriaLabel === EMPTY_ATTR_SENTINEL) {
      sendButton.removeAttribute("aria-label");
    } else if (typeof originalAriaLabel === "string") {
      sendButton.setAttribute("aria-label", originalAriaLabel);
    }

    const originalTitle = sendButton.dataset.mcOriginalTitle;
    if (originalTitle === EMPTY_ATTR_SENTINEL) {
      sendButton.removeAttribute("title");
    } else if (typeof originalTitle === "string") {
      sendButton.setAttribute("title", originalTitle);
    }
  }

  function updateSendButtonStyle(sendButton, trustState, contact = {}) {
    if (styledSendButton && styledSendButton !== sendButton) {
      restoreSendButtonStyle(styledSendButton);
      styledSendButton = null;
    }

    if (!sendButton) return;
    if (!Object.prototype.hasOwnProperty.call(sendButton.dataset, "mcOriginalAriaLabel")) {
      sendButton.dataset.mcOriginalAriaLabel = sendButton.getAttribute("aria-label") ?? EMPTY_ATTR_SENTINEL;
    }
    if (!Object.prototype.hasOwnProperty.call(sendButton.dataset, "mcOriginalTitle")) {
      sendButton.dataset.mcOriginalTitle = sendButton.getAttribute("title") ?? EMPTY_ATTR_SENTINEL;
    }

    const currentAriaLabel = sendButton.getAttribute("aria-label") ?? EMPTY_ATTR_SENTINEL;
    const currentTitle = sendButton.getAttribute("title") ?? EMPTY_ATTR_SENTINEL;
    const storedAriaLabel = sendButton.dataset.mcOriginalAriaLabel;
    const storedTitle = sendButton.dataset.mcOriginalTitle;
    const currentLooksLikeSend = /send|отправ/i.test(String(currentAriaLabel)) || /send|отправ/i.test(String(currentTitle));
    const storedLooksLikeMic = /микроф|голос/i.test(String(storedAriaLabel)) || /микроф|голос/i.test(String(storedTitle));
    if (!isMicrophoneSendButton(sendButton) && currentLooksLikeSend && storedLooksLikeMic) {
      sendButton.dataset.mcOriginalAriaLabel = currentAriaLabel;
      sendButton.dataset.mcOriginalTitle = currentTitle;
    }

    restoreSendButtonStyle(sendButton);
    styledSendButton = sendButton;
    if (isMicrophoneSendButton(sendButton)) return;
    if (trustState !== TRUST.TRUSTED) return;

    sendButton.classList.add("mc-send-native-hidden");
    sendButton.setAttribute("title", contact.fingerprintFull ? `Отпечаток ключа (fingerprint): ${formatFingerprint(contact.fingerprintFull)}` : "");
  }

  async function promoteToTrusted(accountId, contact, { errorText = "" } = {}) {
    const identityState = await sendMessage("mc:get-identity", {});
    const ownKeyAlreadyShared =
      Boolean(identityState?.ok && identityState.identity?.fingerprintFull) &&
      normalizeFingerprint(contact.lastOwnKeyFingerprintShared) === normalizeFingerprint(identityState.identity.fingerprintFull);

    if (!ownKeyAlreadyShared) {
      const prepared = await shareOwnKey({ shareAccountId: accountId });
      if (!prepared?.ok) return false;
      await wireUi();
      return true;
    }

    const updated = await sendMessage("mc:set-trust", {
      platform: PLATFORM,
      accountId,
      trustState: TRUST.TRUSTED
    });
    if (!updated?.ok) {
      window.alert(updated?.error || errorText || "Не удалось установить доверенный статус.");
      return false;
    }
    await wireUi();
    return true;
  }

  async function onIndicatorClick() {
    const accountId = getDialogAccountId();
    if (!isDirectDialogAccountId(accountId)) return;
    if (!accountId) return;
    const response = await sendMessage("mc:get-chat-state", {
      platform: PLATFORM,
      accountId
    });
    if (!response?.ok) return;

    const contact = response.contact || {};

    if (response.trustState === TRUST.TRUSTED) {
      const composeNode = detectCompose();
      const sendButton = detectSendButton();
      if (!composeNode || !sendButton) return;
      await handleSend(sendButton, composeNode);
      return;
    }

    if (response.trustState === TRUST.CHANGED) {
      const lines = [
        "Ключ шифрования этого контакта изменился."
      ];
      if (contact.previousFingerprintFull) lines.push(`Предыдущий ключ: ${formatFingerprint(contact.previousFingerprintFull)}`);
      if (contact.fingerprintFull) lines.push(`Новый ключ: ${formatFingerprint(contact.fingerprintFull)}`);
      lines.push("\nПринять новый ключ и пометить контакт как доверенный?");
      const accepted = window.confirm(lines.join("\n"));
      if (!accepted) return;
      await acceptChangedKey(accountId);
      return;
    }

    if (response.trustState === TRUST.NEW) {
      const details = contact.fingerprintFull ? `\nОтпечаток ключа (fingerprint): ${formatFingerprint(contact.fingerprintFull)}` : "";
      const shouldTrust = window.confirm(
        `Ключ этого контакта не проверен.${details}\n\nПометить контакт как доверенный?`
      );
      if (!shouldTrust) return;
      await promoteToTrusted(accountId, contact);
      return;
    }

    if (response.trustState === TRUST.REJECTED) {
      const details = contact.fingerprintFull ? `\nОтпечаток ключа (fingerprint): ${formatFingerprint(contact.fingerprintFull)}` : "";
      const shouldRestore = window.confirm(
        `Ключ этого контакта ранее был отклонен.${details}\n\nВернуть его в статус непроверенного?`
      );
      if (!shouldRestore) return;

      const updated = await sendMessage("mc:set-trust", {
        platform: PLATFORM,
        accountId,
        trustState: TRUST.NEW
      });
      if (!updated?.ok) {
        window.alert(updated?.error || "Не удалось вернуть ключ в статус непроверенного.");
        return;
      }
      window.alert("Ключ возвращен в статус непроверенного. Проверьте отпечаток перед доверием.");
      await wireUi();
      return;
    }

    await shareOwnKey({ shareAccountId: accountId });
  }

  function clearPendingPlaintextSendState() {
    pendingPlaintextSend = false;
    pendingPlaintextText = "";
    pendingOwnKeyShareAccountId = "";
    if (pendingPlaintextTimer) {
      clearTimeout(pendingPlaintextTimer);
      pendingPlaintextTimer = null;
    }
  }

  async function autoSendPreparedPlaintextMessage() {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const sendButton = detectSendButton();
      if (sendButton && !isMicrophoneSendButton(sendButton)) {
        const compose = detectCompose();
        if (!compose || readComposeText(compose) !== pendingPlaintextText) {
          clearPendingPlaintextSendState();
          return { sent: false, reason: "compose_changed" };
        }
        sendButton.click();
        return { sent: true, reason: "" };
      }
      if (attempt < 19) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    return { sent: false, reason: "send_button_not_found" };
  }

  async function shareOwnKey({ shareAccountId = "" } = {}) {
    try {
      const localAccountId = getLocalAccountId();
      const localDisplayName = getLocalDisplayName(localAccountId);
      if (!localAccountId) {
        window.alert("Не удалось определить ваш ID аккаунта VK для создания объявления ключа.");
        return { ok: false, sent: false };
      }

      const identityState = await sendMessage("mc:get-identity", {});
      if (!identityState?.ok) {
        window.alert(identityState?.error || "Не удалось проверить ключ шифрования Чебурчат.");
        return { ok: false, sent: false };
      }
      if (!identityState.identity) {
        await openPopupSetupFlow();
        return { ok: false, sent: false };
      }

      const announcement = await sendMessage("mc:create-key-announcement", {
        platform: PLATFORM,
        accountId: localAccountId,
        displayName: localDisplayName
      });
      if (!announcement?.ok) {
        window.alert(announcement?.error || "Не удалось создать объявление ключа.");
        return { ok: false, sent: false };
      }

      const compose = detectCompose();
      if (!compose) {
        window.alert("Объявление ключа создано. Вставьте его в поле ввода чата и отправьте.");
        return { ok: false, sent: false };
      }
      writeComposeText(compose, announcement.text);
      clearPendingPlaintextSendState();
      pendingPlaintextSend = true;
      pendingPlaintextText = announcement.text;
      pendingOwnKeyShareAccountId = isDirectDialogAccountId(shareAccountId) ? shareAccountId : "";
      pendingPlaintextTimer = setTimeout(() => {
        clearPendingPlaintextSendState();
      }, 30000);
      const autoSendResult = await autoSendPreparedPlaintextMessage();
      if (!autoSendResult.sent) {
        if (autoSendResult.reason === "compose_changed") {
          window.alert(
            "Текст в поле ввода изменился до отправки объявления ключа. Проверьте содержимое и отправьте публичный ключ вручную."
          );
        } else {
          window.alert("Объявление ключа подготовлено, но кнопку отправки VK найти не удалось. Нажмите Enter или отправьте сообщение вручную.");
        }
      }
      return { ok: true, sent: autoSendResult.sent };
    } catch (error) {
      window.alert("Ошибка при создании объявления ключа: " + (error?.message || String(error)));
      return { ok: false, sent: false };
    }
  }

  async function acceptKnownContact(node, accountId, { ownKeyAlreadyShared = false } = {}) {
    if (ownKeyAlreadyShared) {
      const updated = await sendMessage("mc:set-trust", {
        platform: PLATFORM,
        accountId,
        trustState: TRUST.TRUSTED
      });
      if (!updated?.ok) {
        window.alert(updated?.error || "Не удалось установить доверенный статус.");
        return false;
      }
      setOverlayText(node, "Ключ принят. Защищенный диалог готов.", [
        "mc-message-decrypted",
        "mc-message-system"
      ]);
      await wireUi();
      return true;
    }

    const prepared = await shareOwnKey({ shareAccountId: accountId });
    if (!prepared?.ok) return false;
    setOverlayText(
      node,
      prepared.sent
        ? "Ваш публичный ключ отправлен. Теперь проверьте отпечаток и подтвердите ключ контакта."
        : "Ключ сохранен как непроверенный. Отправьте свой публичный ключ, чтобы продолжить обмен.",
      [
        "mc-message-decrypted",
        "mc-message-system"
      ]
    );
    await wireUi();
    return true;
  }

  async function maybeHandlePendingKeyShare(accountId, composeNode, sendButton) {
    if (!composeNode || !sendButton) return;
    if (keyShareIntentCheckInFlight) return;
    if (checkedKeyShareIntentAccountId === accountId) return;

    keyShareIntentCheckInFlight = true;
    checkedKeyShareIntentAccountId = accountId;
    try {
      const response = await sendMessage("mc:consume-key-share-intent", {
        platform: PLATFORM,
        accountId
      });
      if (!response?.ok) {
        checkedKeyShareIntentAccountId = "";
        return;
      }
      if (response.pending) await shareOwnKey({ shareAccountId: accountId });
    } finally {
      keyShareIntentCheckInFlight = false;
    }
  }

  async function rejectKnownContact(node, accountId) {
    const updated = await sendMessage("mc:set-trust", {
      platform: PLATFORM,
      accountId,
      trustState: TRUST.REJECTED
    });
    if (!updated?.ok) {
      window.alert(updated?.error || "Не удалось отклонить ключ контакта.");
      return false;
    }
    setOverlayText(node, "Объявление ключа Чебурчат отклонено.", ["mc-message-system", "mc-message-warning"]);
    await wireUi();
    return true;
  }

  async function acceptChangedKey(accountId, node) {
    const updated = await sendMessage("mc:set-trust", {
      platform: PLATFORM,
      accountId,
      trustState: TRUST.TRUSTED
    });
    if (!updated?.ok) {
      window.alert(updated?.error || "Не удалось принять измененный ключ.");
      return false;
    }
    if (node) {
      setOverlayText(node, "Новый ключ принят. Защищенный диалог готов.", [
        "mc-message-decrypted",
        "mc-message-system"
      ]);
    }
    await wireUi();
    return true;
  }

  function ensureIndicator(sendButton) {
    if (!indicatorNode) {
      indicatorNode = document.createElement("span");
      indicatorNode.className = "mc-lock-indicator";
      indicatorNode.title = "Сведения о безопасности Чебурчат";
      indicatorNode.addEventListener("click", (event) => {
        if (event.isTrusted === false) return;
        if (!isIndicatorActionable(lastChatTrustState)) return;
        event.preventDefault?.();
        void onIndicatorClick();
      });
      indicatorNode.addEventListener("keydown", (event) => {
        if (event.isTrusted === false) return;
        if (!isIndicatorActionable(lastChatTrustState)) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          void onIndicatorClick();
        }
      });
    }

    if (sendButton?.parentElement) {
      if (indicatorAnchor !== sendButton.parentElement) {
        indicatorNode.classList.remove("mc-lock-floating");
        sendButton.parentElement.appendChild(indicatorNode);
        indicatorAnchor = sendButton.parentElement;
      }
      return;
    }

    if (indicatorAnchor !== document.body) {
      indicatorNode.classList.add("mc-lock-floating");
      document.body.appendChild(indicatorNode);
      indicatorAnchor = document.body;
    }
  }

  function hideIndicator() {
    if (!indicatorNode) return;
    indicatorNode.style.display = "none";
  }

  function ensureSizeWarning(composeNode) {
    if (!sizeWarningNode) {
      sizeWarningNode = document.createElement("div");
      sizeWarningNode.className = "mc-size-warning";
      sizeWarningNode.textContent = "Зашифрованное сообщение может превысить лимиты VK.";
      sizeWarningNode.style.display = "none";
    }

    const parent = composeNode?.parentElement;
    if (!parent) return;
    if (sizeWarningAnchor === parent) return;
    parent.appendChild(sizeWarningNode);
    sizeWarningAnchor = parent;
  }

  function hideSizeWarning() {
    if (!sizeWarningNode) return;
    sizeWarningNode.style.display = "none";
  }

  function updateSizeWarning(composeNode) {
    if (!composeNode) {
      hideSizeWarning();
      return;
    }
    ensureSizeWarning(composeNode);
    if (!sizeWarningNode) return;

    const shouldWarn = isTrustedForEncryptedSend(lastChatTrustState) && utf8ByteLength(readComposeText(composeNode)) >= warningThresholdBytes;
    sizeWarningNode.style.display = shouldWarn ? "" : "none";
  }

  function trustIndicatorTitle(trustState, contact = {}) {
    const lines = [];
    if (trustState === TRUST.TRUSTED) {
      lines.push("Контакт доверенный.");
      if (contact.fingerprintFull) {
        lines.push(`Отпечаток ключа (fingerprint): ${formatFingerprint(contact.fingerprintFull)}`);
      }
      lines.push("Нажмите, чтобы отправить сообщение.");
      return lines.join("\n");
    }

    if (trustState === TRUST.NEW) {
      lines.push("Ключ контакта найден, но не проверен.");
      if (contact.fingerprintFull) {
        lines.push(`Отпечаток ключа (fingerprint): ${formatFingerprint(contact.fingerprintFull)}`);
      }
      lines.push("Нажмите, чтобы пометить контакт как доверенный после проверки отпечатка.");
      return lines.join("\n");
    }

    if (trustState === TRUST.REJECTED) {
      lines.push("Ключ контакта был отклонен.");
      if (contact.fingerprintFull) {
        lines.push(`Отпечаток ключа (fingerprint): ${formatFingerprint(contact.fingerprintFull)}`);
      }
      lines.push("Шифрованная отправка отключена.");
      lines.push("Нажмите, чтобы вернуть ключ в статус непроверенного после проверки отпечатка.");
      return lines.join("\n");
    }

    if (trustState === TRUST.CHANGED) {
      lines.push("Ключ контакта изменился.");
      if (contact.previousFingerprintFull) {
        lines.push(`Предыдущий ключ: ${formatFingerprint(contact.previousFingerprintFull)}`);
      }
      if (contact.fingerprintFull) {
        lines.push(`Новый ключ: ${formatFingerprint(contact.fingerprintFull)}`);
      }
      lines.push("Шифрованная отправка заблокирована до подтверждения нового ключа.");
      return lines.join("\n");
    }

    lines.push("Ключ контакта отсутствует.");
    lines.push("Нажмите, чтобы отправить объявление публичного ключа Чебурчат.");
    return lines.join("\n");
  }

  function isIndicatorActionable(trustState) {
    return Boolean(trustState);
  }

  function syncIndicatorInteractivity(trustState) {
    if (!indicatorNode) return;
    const actionable = isIndicatorActionable(trustState);
    if (actionable) {
      indicatorNode.classList.add("mc-lock-actionable");
    } else {
      indicatorNode.classList.remove("mc-lock-actionable");
    }
    if (actionable) {
      indicatorNode.tabIndex = 0;
      indicatorNode.setAttribute("role", "button");
      indicatorNode.removeAttribute("aria-disabled");
      return;
    }
    indicatorNode.tabIndex = -1;
    indicatorNode.removeAttribute("role");
    indicatorNode.setAttribute("aria-disabled", "true");
  }

  async function refreshLockIndicator(sendButton, accountId) {
    if (!accountId) return;
    const response = await sendMessage("mc:get-chat-state", {
      platform: PLATFORM,
      accountId
    });
    if (!response?.ok) return;
    lastChatTrustState = response.trustState;

    const contact = response.contact || {};
    updateSendButtonStyle(sendButton, response.trustState, contact);
    ensureIndicator(sendButton);
    indicatorNode.classList.remove("mc-lock-green", "mc-lock-gray", "mc-lock-red", "mc-lock-ready", "mc-lock-warn");
    indicatorNode.style.display = "";
    if (response.trustState === TRUST.TRUSTED) {
      indicatorNode.classList.add("mc-lock-green");
      indicatorNode.classList.add("mc-lock-ready");
      indicatorNode.textContent = "Отправить";
    } else if (response.trustState === TRUST.NEW) {
      indicatorNode.classList.add("mc-lock-gray");
      indicatorNode.classList.add("mc-lock-ready");
      indicatorNode.textContent = "Проверить ключ";
    } else if (response.trustState === TRUST.CHANGED) {
      indicatorNode.classList.add("mc-lock-red");
      indicatorNode.classList.add("mc-lock-warn");
      indicatorNode.textContent = "Ключ изменен";
    } else if (response.trustState === TRUST.REJECTED) {
      indicatorNode.classList.add("mc-lock-red");
      indicatorNode.textContent = "Ключ отклонен";
    } else {
      indicatorNode.classList.add("mc-lock-gray");
      indicatorNode.textContent = "Поделиться ключом";
    }
    indicatorNode.title = trustIndicatorTitle(response.trustState, contact);
    syncIndicatorInteractivity(response.trustState);
  }

  async function handleSend(sendButton, composeNode) {
    const dialogAccountId = getDialogAccountId();
    if (!isDirectDialogAccountId(dialogAccountId)) return;
    if (!dialogAccountId) return;
    const senderAccountId = getLocalAccountId();
    const text = readComposeText(composeNode);
    if (!text) return;

    const result = await sendMessage("mc:process-outgoing", {
      platform: PLATFORM,
      accountId: dialogAccountId,
      senderAccountId,
      body: text
    });

    if (!result?.ok) return;
    if (result.mode === "blocked") {
      if (result.reason === "changed_key") {
        const proceedPlaintext = window.confirm(
          `${
            result.message ||
            "Ключ контакта изменен. Старые зашифрованные сообщения, отправленные на прежний ключ, могут стать недоступны."
          }\n\nОтправить это сообщение как обычный текст через VK?`
        );
        if (proceedPlaintext) {
          guardSend = true;
          try {
            sendButton.click();
          } finally {
            guardSend = false;
          }
        }
        return;
      }
      window.alert(result.message || "Чебурчат заблокировал эту отправку.");
      return;
    }

    if (result.mode === "encrypted") {
      if (result.warning === "size_warning") {
        window.alert("После шифрования сообщение может стать слишком длинным и не пройти лимиты VK.");
      }
      writeComposeText(composeNode, result.text);
    }

    guardSend = true;
    try {
      sendButton.click();
    } finally {
      guardSend = false;
    }
  }

  async function allowPendingPlaintextSend(composeNode) {
    if (!pendingPlaintextSend) return false;
    const dialogAccountId = getDialogAccountId();
    const composeText = readComposeText(composeNode);
    return (
      isDirectDialogAccountId(dialogAccountId) &&
      composeText === pendingPlaintextText &&
      dialogAccountId === pendingOwnKeyShareAccountId
    );
  }

  async function completePendingPlaintextSendFromSelfAnnouncement(dialogAccountId, rawText) {
    if (!pendingPlaintextSend) return false;
    if (!isDirectDialogAccountId(dialogAccountId)) return false;

    const normalizedRawText = normalizedWrapperSourceText(rawText);
    const normalizedPendingText = normalizedWrapperSourceText(pendingPlaintextText);
    const pendingWrapperText = normalizedWrapperSourceText(extractWrapperCandidateFromSource(pendingPlaintextText));
    if (
      !normalizedRawText ||
      (normalizedRawText !== normalizedPendingText && normalizedRawText !== pendingWrapperText)
    ) {
      return false;
    }

    const sharedOwnKeyForDialog = dialogAccountId === pendingOwnKeyShareAccountId;
    if (!sharedOwnKeyForDialog) return false;

    clearPendingPlaintextSendState();
    await sendMessage("mc:mark-own-key-shared", {
      platform: PLATFORM,
      accountId: dialogAccountId
    });
    return true;
  }

  function canInterceptEncryptedSend() {
    if (guardSend) return false;
    const activeDialogAccountId = getDialogAccountId();
    if (!isDirectDialogAccountId(activeDialogAccountId)) return false;
    return isTrustedForEncryptedSend(lastChatTrustState);
  }

  function isEncryptedSendEnter(event) {
    if (!event || event.key !== "Enter") return false;
    if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false;
    if (event.isComposing) return false;
    return true;
  }

  function ensureSendButtonHook(sendButton, composeNode) {
    if (!sendButton || sendButton.dataset.mcHooked) return;
    sendButton.dataset.mcHooked = "1";
    sendButton.addEventListener(
      "click",
      async (event) => {
        if (guardSend) return;
        const button = event.currentTarget || sendButton;
        if (isMicrophoneSendButton(button)) return;
        if (await allowPendingPlaintextSend(composeNode)) return;
        if (!canInterceptEncryptedSend()) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        await handleSend(button, composeNode);
      },
      true
    );
  }

  function setOverlayText(node, text, classes) {
    if (!node) return;
    node.style.display = "none";
    let overlay = node.__mcOverlayNode;
    if (!overlay || overlay.parentElement !== node.parentElement) {
      if (overlay?.parentElement) {
        overlay.parentElement.removeChild(overlay);
      }
      const parent = node.parentElement;
      if (!parent) return;
      overlay = document.createElement("span");
      overlay.classList.add("mc-overlay");
      parent.appendChild(overlay);
      node.__mcOverlayNode = overlay;
    }
    overlay.textContent = text;
    overlay.className = "mc-overlay " + classes.join(" ");
  }

  function setInlineActions(node, config) {
    const existing = node?.__mcInlineActionsNode;
    if (existing?.parentElement) {
      existing.parentElement.removeChild(existing);
    }
    delete node.__mcInlineActionsNode;

    const actions = Array.isArray(config) ? config : config?.actions;
    if (!Array.isArray(actions) || actions.length === 0) return;
    const parent = node?.parentElement;
    if (!parent) return;

    const actionsNode = document.createElement("div");
    actionsNode.className = "mc-inline-actions";

    if (!Array.isArray(config)) {
      const contentNode = document.createElement("div");
      contentNode.className = "mc-inline-actions-copy";

      if (config?.title) {
        const titleNode = document.createElement("div");
        titleNode.className = "mc-inline-actions-title";
        titleNode.textContent = config.title;
        contentNode.appendChild(titleNode);
      }

      if (config?.description) {
        const descriptionNode = document.createElement("div");
        descriptionNode.className = "mc-inline-actions-description";
        descriptionNode.textContent = config.description;
        contentNode.appendChild(descriptionNode);
      }

      if (contentNode.childElementCount) {
        actionsNode.appendChild(contentNode);
      }
    }

    const buttonsNode = document.createElement("div");
    buttonsNode.className = "mc-inline-actions-buttons";

    for (const action of actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "mc-inline-action-button";
      if (action.variant === "secondary") {
        button.classList.add("mc-inline-action-button-secondary");
      }
      button.textContent = action.label;
      button.addEventListener("click", async (event) => {
        if (event.isTrusted === false) return;
        event.preventDefault();
        event.stopPropagation();
        button.disabled = true;
        try {
          const completed = await action.onClick();
          if (completed) {
            setInlineActions(node, []);
          } else {
            button.disabled = false;
          }
        } catch (_error) {
          button.disabled = false;
        }
      });
      buttonsNode.appendChild(button);
    }

    actionsNode.appendChild(buttonsNode);
    parent.appendChild(actionsNode);
    node.__mcInlineActionsNode = actionsNode;
  }

  function clearOverlayText(node) {
    if (!node) return;
    node.style.display = "";
    const overlay = node.__mcOverlayNode;
    if (overlay?.parentElement) {
      overlay.parentElement.removeChild(overlay);
    }
    delete node.__mcOverlayNode;
    setInlineActions(node, []);
  }

  function extractMessageTextElements() {
    const isRetryableProcessedNode = (node) =>
      node?.dataset?.mcProcessed === "decrypt_failed" || node?.dataset?.mcProcessed === "identity_missing";

    const excludedAncestorSelectors = [
      "textarea",
      "[contenteditable='true']",
      "[role='textbox']",
      "[aria-label='Сообщение']",
      "[aria-label='Message']"
    ].join(", ");

    const targeted = Array.from(
      document.querySelectorAll(
        "article .MessageText, article .ConvoMessageWithoutBubble__text, article [class*='ConvoMessage__text'], article [class*='im_msg_text']"
      )
    ).filter((node) => {
      if (node.dataset?.mcProcessed === "1") return false;
      if (typeof node.textContent !== "string") return false;
      if (!isRetryableProcessedNode(node) && !node.textContent.includes("CHEBURCHAT:v")) return false;
      if (node.closest(excludedAncestorSelectors)) return false;
      return true;
    });

    const fallback = Array.from(document.querySelectorAll("div, span, p")).filter((node) => {
      if (node.dataset?.mcProcessed === "1") return false;
      if (node.childElementCount !== 0) return false;
      if (typeof node.textContent !== "string") return false;
      if (!isRetryableProcessedNode(node) && !node.textContent.includes("CHEBURCHAT:v")) return false;
      if (node.closest(excludedAncestorSelectors)) return false;
      const classText = String(node.className || "");
      const isMessageNode =
        Boolean(node.closest("article")) || /\bmsg\b/i.test(classText) || /ConvoMessage|im-mess/i.test(classText);
      if (!isMessageNode) return false;
      return true;
    });

    const candidates = Array.from(new Set([...targeted, ...fallback]));
    return candidates.filter(
      (node) => !candidates.some((other) => other !== node && typeof node.contains === "function" && node.contains(other))
    );
  }

  function previewPlaceholder(text) {
    const normalized = normalizedWrapperSourceText(text);
    if (!normalized.includes("CHEBURCHAT:")) return null;

    const keyMatch = normalized.match(/CHEBURCHAT:([^:\s]+):key:[A-Za-z0-9_-]+/);
    if (keyMatch) {
      if (keyMatch[1] !== SUPPORTED_PROTOCOL_VERSION) {
        return {
          text: "Неподдерживаемая версия Чебурчат",
          warning: true
        };
      }
      return {
        text: "Объявление ключа Чебурчат",
        warning: false
      };
    }

    const msgMatch = normalized.match(/CHEBURCHAT:([^:\s]+):msg:[A-Za-z0-9_-]+/);
    if (msgMatch) {
      if (msgMatch[1] !== SUPPORTED_PROTOCOL_VERSION) {
        return {
          text: "Неподдерживаемая версия Чебурчат",
          warning: true
        };
      }
      return {
        text: "Зашифрованное сообщение Чебурчат",
        warning: false
      };
    }

    return null;
  }

  function scanConversationPreviews() {
    const nodes = Array.from(
      document.querySelectorAll(
        ".ConvoListItem .MessagePreview, .ConvoListItem__message .MessagePreview, .ConvoListItem__text .MessagePreview"
      )
    );
    for (const node of nodes) {
      const placeholder = previewPlaceholder(node.textContent || "");
      if (!placeholder) {
        clearOverlayText(node);
        continue;
      }
      setOverlayText(node, placeholder.text, [placeholder.warning ? "mc-preview-warning" : "mc-preview-system"]);
    }
  }

  function normalizedWrapperSourceText(text) {
    return String(text || "").replace(/\r\n?/g, "\n").trim();
  }

  function normalizeWrapperLine(text) {
    return String(text || "").replace(/[\t\v\f\r ]+$/g, "");
  }

  function extractWrapperCandidateFromSource(sourceText) {
    const lines = String(sourceText || "").split("\n");

    for (let index = 0; index < lines.length; index += 1) {
      const current = normalizeWrapperLine(lines[index]);
      const embedded = current.match(/CHEBURCHAT:[^:\s]+:(?:msg|key):[A-Za-z0-9_-]+/);
      if (embedded?.[0]) {
        return embedded[0];
      }

      if (MSG_LINE_PATTERN.test(current)) {
        return current;
      }
      if (KEY_LINE_PATTERN.test(current)) {
        return current;
      }
    }

    return "";
  }

  function extractProtocolText(node) {
    const articleNode = node?.closest?.("article");
    const nodeText = normalizedWrapperSourceText(node?.textContent || "");
    const articleText = normalizedWrapperSourceText(articleNode?.textContent || "");
    const sources = [nodeText, articleText];

    for (const source of sources) {
      const candidate = extractWrapperCandidateFromSource(source);
      if (candidate) return candidate;
    }

    const nodeInnerText = normalizedWrapperSourceText(node?.innerText || "");
    if (nodeInnerText && nodeInnerText !== nodeText) {
      const candidate = extractWrapperCandidateFromSource(nodeInnerText);
      if (candidate) return candidate;
    }

    const articleInnerText = normalizedWrapperSourceText(articleNode?.innerText || "");
    if (articleInnerText && articleInnerText !== articleText) {
      const candidate = extractWrapperCandidateFromSource(articleInnerText);
      if (candidate) return candidate;
    }

    return nodeText || nodeInnerText;
  }

  function normalizeMessageId(raw) {
    const value = String(raw || "").trim();
    if (!value) return "";
    const match = value.match(/-?[0-9]+/);
    return match ? match[0] : "";
  }

  function extractMessageId(node) {
    const probes = [
      node,
      node?.closest?.("[data-itemkey]"),
      node?.closest?.("[data-msgid]"),
      node?.closest?.("[data-message-id]"),
      node?.closest?.("[data-id]"),
      node?.closest?.("[id]")
    ];

    for (const probe of probes) {
      if (!probe) continue;
      const candidates = [
        probe.getAttribute("data-itemkey"),
        probe.getAttribute("data-msgid"),
        probe.getAttribute("data-message-id"),
        probe.getAttribute("data-id"),
        probe.getAttribute("id")
      ];
      for (const candidate of candidates) {
        const normalized = normalizeMessageId(candidate);
        if (normalized) return normalized;
      }
    }
    return "";
  }

  function findMessageAuthorHref(node) {
    const probes = [
      node,
      node?.closest?.("article"),
      node?.closest?.("[data-itemkey]"),
      node?.closest?.("[data-msgid]"),
      node?.closest?.("[data-message-id]"),
      node?.closest?.("[data-id]")
    ];

    for (const probe of probes) {
      if (!probe) continue;
      const directHref = probe.getAttribute?.("href") || "";
      if (parseAccountIdFromHref(directHref)) return directHref;

      const link = probe.querySelector?.(
        "a.ConvoMessageHeader__authorLink[href], a[href^='/id'], a[href*='vk.com/id']"
      );
      const href = link?.getAttribute("href") || "";
      if (parseAccountIdFromHref(href)) return href;
    }
    return "";
  }

  function normalizeAuthorAccountId(raw) {
    const value = String(raw || "").trim();
    if (!value) return "";
    const match = value.match(/[1-9][0-9]*/);
    return match ? match[0] : "";
  }

  function findMessageAuthorAccountIdFromData(node) {
    const probes = [];
    let cursor = node;
    for (let depth = 0; cursor && depth < 10; depth += 1) {
      probes.push(cursor);
      cursor = cursor.parentElement;
    }

    for (const probe of probes) {
      if (!probe) continue;
      const candidates = [
        probe.getAttribute?.("data-from-id"),
        probe.getAttribute?.("data-from"),
        probe.getAttribute?.("data-author-id"),
        probe.getAttribute?.("data-sender-id")
      ];
      for (const candidate of candidates) {
        const normalized = normalizeAuthorAccountId(candidate);
        if (normalized) return normalized;
      }
    }

    return "";
  }

  function collectMessageClassHints(node) {
    const classHints = [];
    let cursor = node;
    for (let depth = 0; cursor && depth < 10; depth += 1) {
      const classText = String(cursor.className || "").trim();
      if (classText) classHints.push(classText);
      cursor = cursor.parentElement;
    }
    return classHints.join(" ");
  }

  function guessMessageAuthorAccountId(node) {
    const authorFromData = findMessageAuthorAccountIdFromData(node);
    if (authorFromData) return authorFromData;

    return guessMessageAuthorAccountIdFromClass(
      collectMessageClassHints(node),
      getLocalAccountId(),
      getDialogAccountId(),
      findMessageAuthorHref(node)
    );
  }

  async function processIncomingNode(node) {
    if (node.dataset.mcProcessed === "1") return;
    const dialogAccountId = getDialogAccountId();
    if (!isDirectDialogAccountId(dialogAccountId)) return;
    if (!dialogAccountId) return;
    const localAccountId = getLocalAccountId();
    const messageId = extractMessageId(node);
    const extractedRawText = extractProtocolText(node);
    if (String(extractedRawText).includes("CHEBURCHAT:")) {
      node.dataset.mcRawProtocolText = extractedRawText;
    }
    const rawText = String(node.dataset.mcRawProtocolText || extractedRawText);
    const messageAuthorAccountId = guessMessageAuthorAccountId(node);

    const result = await sendMessage("mc:process-incoming", {
      platform: PLATFORM,
      dialogAccountId,
      messageAuthorAccountId,
      localAccountId,
      messageId,
      rawText
    });

    if (!result?.ok) return;

    if (result.kind === "identity_missing") {
      node.dataset.mcProcessed = "identity_missing";
      showInlineIdentitySetupPrompt(node);
      return;
    }

    if (result.kind === "decrypted") {
      node.dataset.mcProcessed = "1";
      delete node.dataset.mcRawProtocolText;
      setOverlayText(node, result.body, ["mc-message-decrypted"]);
      return;
    }

    if (result.kind === "decrypt_failed") {
      node.dataset.mcProcessed = "decrypt_failed";
      setOverlayText(node, "Не удалось расшифровать сообщение. Возможные причины: неверный ключ, измененный ключ или поврежденные данные.", ["mc-message-error"]);
      return;
    }

    node.dataset.mcProcessed = "1";

    if (result.kind === "key") {
      delete node.dataset.mcRawProtocolText;
      setOverlayText(node, "Объявление ключа Чебурчат обработано.", ["mc-message-decrypted", "mc-message-system"]);
      if (result.trustState === TRUST.NEW) {
        const formattedFingerprint = formatFingerprint(result.fingerprintFull);
        setInlineActions(node, {
          title: "Контакт прислал публичный ключ.",
          description: formattedFingerprint
            ? result.ownKeyAlreadyShared
              ? `Отпечаток ключа: ${formattedFingerprint}\nВаш ключ уже был отправлен ранее. Проверьте отпечаток и примите ключ контакта.`
              : `Отпечаток ключа: ${formattedFingerprint}\nПримите ключ и отправьте свой в ответ, чтобы завершить обмен и включить защищенный диалог.`
            : result.ownKeyAlreadyShared
              ? "Ваш ключ уже был отправлен ранее. Проверьте отпечаток и примите ключ контакта."
              : "Примите ключ и отправьте свой в ответ, чтобы завершить обмен и включить защищенный диалог.",
          actions: [
            {
              label: "Принять",
              onClick: async () =>
                acceptKnownContact(node, dialogAccountId, {
                  ownKeyAlreadyShared: Boolean(result.ownKeyAlreadyShared)
                })
            },
            {
              label: "Отклонить",
              variant: "secondary",
              onClick: async () => rejectKnownContact(node, dialogAccountId)
            }
          ]
        });
      } else if (result.trustState === TRUST.CHANGED) {
        setOverlayText(node, "Ключ шифрования контакта изменился. Проверьте новый отпечаток.", ["mc-message-system", "mc-message-warning"]);
        const formattedPrev = result.previousFingerprintFull ? formatFingerprint(result.previousFingerprintFull) : "";
        const formattedNew = result.fingerprintFull ? formatFingerprint(result.fingerprintFull) : "";
        const descParts = [];
        if (formattedPrev) descParts.push(`Предыдущий ключ: ${formattedPrev}`);
        if (formattedNew) descParts.push(`Новый ключ: ${formattedNew}`);
        descParts.push("Примите новый ключ, чтобы продолжить защищённый обмен.");
        setInlineActions(node, {
          title: "Ключ контакта изменился.",
          description: descParts.join("\n"),
          actions: [
            {
              label: "Принять новый ключ",
              onClick: async () => acceptChangedKey(dialogAccountId, node)
            },
            {
              label: "Отклонить",
              variant: "secondary",
              onClick: async () => rejectKnownContact(node, dialogAccountId)
            }
          ]
        });
      } else if (result.trustState === TRUST.REJECTED) {
        setOverlayText(node, "Объявление ключа Чебурчат отклонено.", ["mc-message-system", "mc-message-warning"]);
        setInlineActions(node, []);
      } else {
        setInlineActions(node, []);
      }
      return;
    }

    if (result.kind === "key_self_announcement") {
      await completePendingPlaintextSendFromSelfAnnouncement(dialogAccountId, rawText);
      delete node.dataset.mcRawProtocolText;
      setOverlayText(node, "Ваш публичный ключ Чебурчат был отправлен.", ["mc-message-decrypted", "mc-message-system"]);
      setInlineActions(node, []);
      return;
    }

    if (result.kind === "key_ignored_stale") {
      delete node.dataset.mcRawProtocolText;
      setOverlayText(node, "Устаревшее объявление ключа Чебурчат проигнорировано.", ["mc-message-system", "mc-message-warning"]);
      setInlineActions(node, []);
      return;
    }

    if (result.kind === "invalid_key") {
      delete node.dataset.mcRawProtocolText;
      setOverlayText(node, "Некорректное объявление ключа Чебурчат.", ["mc-message-error"]);
      setInlineActions(node, []);
      return;
    }

    if (result.kind === "unsupported_version") {
      delete node.dataset.mcRawProtocolText;
      setOverlayText(node, "Неподдерживаемая версия сообщения Чебурчат. Обновите расширение.", ["mc-message-system", "mc-message-warning"]);
      setInlineActions(node, []);
    }
  }

  async function scanIncoming() {
    const nodes = extractMessageTextElements();
    // Preserve DOM order so self-announcements and later key messages update shared state predictably.
    for (const node of nodes.slice(0, MAX_INCOMING_NODES_PER_CYCLE)) {
      try {
        await processIncomingNode(node);
      } catch (_error) {}
    }
    if (nodes.length > MAX_INCOMING_NODES_PER_CYCLE) scheduleMutationRefresh();
  }

  async function wireUi() {
    const compose = detectCompose();
    const sendButton = detectSendButton();
    const accountId = getDialogAccountId();
    const localAccountId = getLocalAccountId();
    const localDisplayName = getLocalDisplayName(localAccountId);
    const dialogDisplayName = getDialogDisplayName();
    if (!accountId || !isDirectDialogAccountId(accountId)) {
      hideSizeWarning();
      hideIndicator();
      updateSendButtonStyle(sendButton, TRUST.MISSING);
      return;
    }

    if (localAccountId && localAccountId !== lastSyncedBindingAccountId) {
      const result = await sendMessage("mc:upsert-binding", {
        platform: PLATFORM,
        accountId: localAccountId,
        displayName: localDisplayName
      });
      if (result?.ok) lastSyncedBindingAccountId = localAccountId;
    }

    const contactProfileKey = `${accountId}:${dialogDisplayName}`;
    if (dialogDisplayName && contactProfileKey !== lastSyncedContactProfileKey) {
      const result = await sendMessage("mc:sync-contact-profile", {
        platform: PLATFORM,
        accountId,
        displayName: dialogDisplayName
      });
      if (result?.ok) lastSyncedContactProfileKey = contactProfileKey;
    }

    await loadWarningThreshold();
    await refreshLockIndicator(sendButton, accountId);
    updateSizeWarning(compose);
    if (!compose) return;

    if (!compose.dataset.mcInputHooked) {
      compose.dataset.mcInputHooked = "1";
      compose.addEventListener("input", () => {
        updateSizeWarning(compose);
        const liveSendButton = detectSendButton();
        updateSendButtonStyle(liveSendButton, lastChatTrustState);
        ensureSendButtonHook(liveSendButton, compose);
      });
    }

    if (!compose.dataset.mcEnterHooked) {
      compose.dataset.mcEnterHooked = "1";
      compose.addEventListener(
        "keydown",
        async (event) => {
          if (!isEncryptedSendEnter(event)) return;
          if (await allowPendingPlaintextSend(compose)) return;
          if (!canInterceptEncryptedSend()) return;
          const liveSendButton = detectSendButton();
          if (!liveSendButton) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          await handleSend(liveSendButton, compose);
        },
        true
      );
    }

    ensureSendButtonHook(sendButton, compose);
    await maybeHandlePendingKeyShare(accountId, compose, sendButton);
  }

  async function runRefreshCycle() {
    await wireUi();
    await scanIncoming();
    scanConversationPreviews();
  }

  async function flushMutationRefreshQueue() {
    if (!mutationRefreshQueued || mutationRefreshInFlight) return;
    mutationRefreshInFlight = true;
    mutationRefreshQueued = false;
    try {
      await runRefreshCycle();
    } catch (_error) {
    } finally {
      mutationRefreshInFlight = false;
      if (mutationRefreshQueued) {
        scheduleMutationRefresh();
      } else {
        flushIdleWaitersIfReady();
      }
    }
  }

  function scheduleMutationRefresh() {
    mutationRefreshQueued = true;
    if (mutationDebounceTimer !== null) return;
    mutationDebounceTimer = setTimeout(() => {
      mutationDebounceTimer = null;
      void flushMutationRefreshQueue();
    }, MUTATION_DEBOUNCE_MS);
  }

  const observer = new MutationObserver(() => {
    scheduleMutationRefresh();
  });

  if (testCleanupHooks && typeof testCleanupHooks.add === "function") {
    testCleanupHooks.add(() => {
      clearPendingPlaintextSendState();
      if (mutationDebounceTimer !== null) {
        clearTimeout(mutationDebounceTimer);
        mutationDebounceTimer = null;
      }
      mutationRefreshQueued = false;
      mutationRefreshInFlight = false;
      keyShareIntentCheckInFlight = false;
      checkedKeyShareIntentAccountId = "";
      observer.disconnect();
      idleWaiters.length = 0;
    });
  }

  if (testApi && typeof testApi === "object") {
    testApi.waitForIdle = waitForIdle;
  }

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  mutationRefreshQueued = true;
  void flushMutationRefreshQueue();
})();
