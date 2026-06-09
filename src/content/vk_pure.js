(function initVkPureHelpers(globalScope) {
  function parseSelToken(raw) {
    if (!raw) return "";
    const value = String(raw).trim();

    let decoded = value;
    try {
      decoded = decodeURIComponent(value);
    } catch (_error) {
      return "";
    }

    const stripped = decoded.replace(/^sel=/, "").replace(/^c/, "");
    return /^-?[0-9]+$/.test(stripped) ? stripped : "";
  }

  function parseSelFromParams(text) {
    const match = String(text || "").match(/(?:^|[?&#])sel=([^&#]+)/);
    return parseSelToken(match ? match[1] : "");
  }

  function parseDialogFromPath(pathname) {
    const path = String(pathname || "");
    const patterns = [/\/im\/convo\/(-?\d+)/, /\/im\/(-?\d+)/, /\/messages\/(-?\d+)/];
    for (const pattern of patterns) {
      const match = path.match(pattern);
      if (match && match[1]) return match[1];
    }
    return "";
  }

  function parseAccountIdFromHref(href) {
    const value = String(href || "");
    const match = value.match(/(?:^|\/)id(\d+)(?:$|[/?#])/);
    return match && match[1] ? match[1] : "";
  }

  // The logged-in user's own nav sections (/photos<id>, /audios<id>) carry the own
  // account id. Unlike bare /id links, these do not appear in chat content, so they are
  // a safe local-id source (avoids binding a stranger's id — see vk.js getLocalAccountId).
  function parseOwnAccountIdFromNavHref(href) {
    const value = String(href || "");
    const match = value.match(/(?:^|\/)(?:photos|audios)(\d+)(?:$|[/?#])/);
    return match && match[1] ? match[1] : "";
  }

  function parseDialogFromHref(href) {
    const raw = String(href || "").trim();
    if (!raw) return "";

    let parsedUrl;
    try {
      parsedUrl = new URL(raw, "https://vk.com");
    } catch (_error) {
      return "";
    }

    return (
      parseSelToken(parsedUrl.searchParams.get("sel")) ||
      parseSelFromParams(parsedUrl.hash) ||
      parseDialogFromPath(parsedUrl.pathname) ||
      parseAccountIdFromHref(parsedUrl.pathname) ||
      parseAccountIdFromHref(parsedUrl.href)
    );
  }

  function guessMessageAuthorAccountIdFromClass(className, localAccountId, dialogAccountId, authorHref = "") {
    const authorIdFromHref = parseAccountIdFromHref(authorHref);
    if (authorIdFromHref) return authorIdFromHref;

    const classTokens = String(className || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    const outgoingHints = new Set(["out", "my", "self", "outgoing"]);
    const hasOutgoingHint = classTokens.some((token) => outgoingHints.has(token));
    if (hasOutgoingHint && localAccountId) {
      return String(localAccountId).trim();
    }
    return String(dialogAccountId || "").trim();
  }

  globalScope.__CHEBURCHAT_VK_PURE__ = Object.freeze({
    parseSelToken,
    parseSelFromParams,
    parseDialogFromPath,
    parseAccountIdFromHref,
    parseOwnAccountIdFromNavHref,
    parseDialogFromHref,
    guessMessageAuthorAccountIdFromClass
  });
})(globalThis);
