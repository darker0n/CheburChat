import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import { buildKeyAnnouncementText } from "../src/common/protocol.js";

const vkPureSource = await readFile(new URL("../src/content/vk_pure.js", import.meta.url), "utf8");
const vkScriptSource = await readFile(new URL("../src/content/vk.js", import.meta.url), "utf8");

function toDatasetKey(attributeName) {
  return attributeName
    .slice(5)
    .replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

function splitSelectorList(selectorText) {
  const groups = [];
  let current = "";
  let bracketDepth = 0;
  let quote = "";

  for (const char of String(selectorText || "")) {
    if (quote) {
      current += char;
      if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === "[") {
      bracketDepth += 1;
      current += char;
      continue;
    }
    if (char === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
      current += char;
      continue;
    }
    if (char === "," && bracketDepth === 0) {
      const trimmed = current.trim();
      if (trimmed) groups.push(trimmed);
      current = "";
      continue;
    }
    current += char;
  }

  const tail = current.trim();
  if (tail) groups.push(tail);
  return groups;
}

function splitDescendantSelector(group) {
  const parts = [];
  let current = "";
  let bracketDepth = 0;
  let quote = "";

  for (const char of String(group || "")) {
    if (quote) {
      current += char;
      if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === "[") {
      bracketDepth += 1;
      current += char;
      continue;
    }
    if (char === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
      current += char;
      continue;
    }
    if (/\s/.test(char) && bracketDepth === 0) {
      const trimmed = current.trim();
      if (trimmed) parts.push(trimmed);
      current = "";
      continue;
    }
    current += char;
  }

  const tail = current.trim();
  if (tail) parts.push(tail);
  return parts;
}

function parseAttributeClause(raw) {
  const match = String(raw || "")
    .trim()
    .match(/^([^\s~|^$*!=]+)\s*(?:(\^=|\$=|\*=|=)\s*(?:"([^"]*)"|'([^']*)'|(.+)))?$/);
  if (!match) return null;
  const name = match[1].toLowerCase();
  const op = match[2] || null;
  const rawValue = match[3] ?? match[4] ?? match[5] ?? "";
  return { name, op, value: String(rawValue).trim() };
}

function parseCompoundSelector(compound) {
  const value = String(compound || "").trim();
  if (!value) return null;

  const parsed = {
    tag: "",
    classes: [],
    attrs: []
  };

  let cursor = 0;
  if (value[cursor] === "*") {
    cursor += 1;
  } else {
    const tagMatch = value.slice(cursor).match(/^[a-zA-Z][\w-]*/);
    if (tagMatch) {
      parsed.tag = tagMatch[0].toLowerCase();
      cursor += tagMatch[0].length;
    }
  }

  while (cursor < value.length) {
    const token = value[cursor];
    if (token === ".") {
      const classMatch = value.slice(cursor + 1).match(/^[A-Za-z0-9_-]+/);
      if (!classMatch) return null;
      parsed.classes.push(classMatch[0]);
      cursor += classMatch[0].length + 1;
      continue;
    }
    if (token === "[") {
      let end = cursor + 1;
      let quote = "";
      while (end < value.length) {
        const char = value[end];
        if (quote) {
          if (char === quote) quote = "";
          end += 1;
          continue;
        }
        if (char === "'" || char === '"') {
          quote = char;
          end += 1;
          continue;
        }
        if (char === "]") break;
        end += 1;
      }
      if (end >= value.length || value[end] !== "]") return null;
      const clause = parseAttributeClause(value.slice(cursor + 1, end));
      if (!clause) return null;
      parsed.attrs.push(clause);
      cursor = end + 1;
      continue;
    }
    return null;
  }

  return parsed;
}

function getAttributeValue(node, name) {
  const attrName = String(name || "").toLowerCase();
  if (attrName === "class") return String(node.className || "");
  if (attrName === "id" && Object.prototype.hasOwnProperty.call(node.attrs, "id")) {
    return node.attrs.id;
  }
  if (Object.prototype.hasOwnProperty.call(node.attrs, attrName)) {
    return node.attrs[attrName];
  }
  if (attrName.startsWith("data-")) {
    const key = toDatasetKey(attrName);
    if (Object.prototype.hasOwnProperty.call(node.dataset, key)) {
      return String(node.dataset[key]);
    }
  }
  return null;
}

function matchesCompoundSelector(node, compound) {
  const parsed = parseCompoundSelector(compound);
  if (!parsed) return false;

  if (parsed.tag && String(node.tagName || "").toLowerCase() !== parsed.tag) {
    return false;
  }

  if (parsed.classes.length > 0) {
    const classSet = new Set(String(node.className || "").split(/\s+/).filter(Boolean));
    for (const className of parsed.classes) {
      if (!classSet.has(className)) return false;
    }
  }

  for (const attr of parsed.attrs) {
    const actual = getAttributeValue(node, attr.name);
    if (!attr.op) {
      if (actual === null) return false;
      continue;
    }
    if (actual === null) return false;
    const value = String(actual);
    if (attr.op === "=" && value !== attr.value) return false;
    if (attr.op === "^=" && !value.startsWith(attr.value)) return false;
    if (attr.op === "$=" && !value.endsWith(attr.value)) return false;
    if (attr.op === "*=" && !value.includes(attr.value)) return false;
  }

  return true;
}

function matchesSelectorExpression(node, selector) {
  const groups = splitSelectorList(selector);
  for (const group of groups) {
    const chain = splitDescendantSelector(group);
    if (chain.length === 0) continue;

    let cursor = node;
    if (!matchesCompoundSelector(cursor, chain[chain.length - 1])) continue;

    let matched = true;
    for (let index = chain.length - 2; index >= 0; index -= 1) {
      let probe = cursor.parentElement;
      let ancestor = null;
      while (probe) {
        if (matchesCompoundSelector(probe, chain[index])) {
          ancestor = probe;
          break;
        }
        probe = probe.parentElement;
      }
      if (!ancestor) {
        matched = false;
        break;
      }
      cursor = ancestor;
    }
    if (matched) return true;
  }
  return false;
}

function walkDescendants(root, visit) {
  for (const child of root.children) {
    if (visit(child) === false) return false;
    if (walkDescendants(child, visit) === false) return false;
  }
  return true;
}

function trackAsyncUiTask(result) {
  if (!result || typeof result.then !== "function") return;
  const pendingTasks = globalThis.__CHEBURCHAT_PENDING_UI_TASKS__;
  if (!(pendingTasks instanceof Set)) return;
  const tracked = Promise.resolve(result).finally(() => {
    pendingTasks.delete(tracked);
  });
  pendingTasks.add(tracked);
}

class FakeNode {
  constructor({
    tagName = "div",
    textContent = "",
    className = "",
    attrs = {},
    dataset = {},
    value = undefined
  } = {}) {
    this.tagName = String(tagName || "div").toLowerCase();
    this.textContent = textContent;
    this.innerText = textContent;
    this.className = className;
    this.attrs = {};
    this.dataset = { ...dataset };
    this.parentElement = null;
    this.children = [];
    this.style = {};
    this.listeners = new Map();
    if (value !== undefined) {
      this.value = value;
    }
    for (const [name, attrValue] of Object.entries(attrs)) {
      this.setAttribute(name, attrValue);
    }
    this.classList = {
      add: (...tokens) => {
        const existing = new Set(String(this.className || "").split(/\s+/).filter(Boolean));
        for (const token of tokens) existing.add(token);
        this.className = Array.from(existing).join(" ");
      },
      remove: (...tokens) => {
        const removeSet = new Set(tokens);
        const existing = String(this.className || "")
          .split(/\s+/)
          .filter(Boolean)
          .filter((token) => !removeSet.has(token));
        this.className = existing.join(" ");
      }
    };
  }

  get childElementCount() {
    return this.children.length;
  }

  getAttribute(name) {
    const normalized = String(name || "").toLowerCase();
    if (normalized === "class") return this.className || null;
    if (Object.prototype.hasOwnProperty.call(this.attrs, normalized)) {
      return this.attrs[normalized];
    }
    if (normalized.startsWith("data-")) {
      const key = toDatasetKey(normalized);
      if (Object.prototype.hasOwnProperty.call(this.dataset, key)) {
        return String(this.dataset[key]);
      }
    }
    return null;
  }

  setAttribute(name, value) {
    const normalized = String(name || "").toLowerCase();
    const normalizedValue = String(value);
    if (normalized === "class") {
      this.className = normalizedValue;
      return;
    }
    this.attrs[normalized] = normalizedValue;
    if (normalized.startsWith("data-")) {
      this.dataset[toDatasetKey(normalized)] = normalizedValue;
    }
  }

  removeAttribute(name) {
    const normalized = String(name || "").toLowerCase();
    if (normalized === "class") {
      this.className = "";
      return;
    }
    delete this.attrs[normalized];
    if (normalized.startsWith("data-")) {
      delete this.dataset[toDatasetKey(normalized)];
    }
  }

  matches(selector) {
    return matchesSelectorExpression(this, selector);
  }

  querySelector(selector) {
    let result = null;
    walkDescendants(this, (node) => {
      if (!matchesSelectorExpression(node, selector)) return true;
      result = node;
      return false;
    });
    return result;
  }

  querySelectorAll(selector) {
    const results = [];
    walkDescendants(this, (node) => {
      if (matchesSelectorExpression(node, selector)) {
        results.push(node);
      }
      return true;
    });
    return results;
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (matchesSelectorExpression(node, selector)) return node;
      node = node.parentElement;
    }
    return null;
  }

  appendChild(node) {
    if (node.parentElement) {
      node.parentElement.removeChild(node);
    }
    this.children.push(node);
    node.parentElement = this;
    return node;
  }

  removeChild(node) {
    const index = this.children.indexOf(node);
    if (index === -1) return null;
    this.children.splice(index, 1);
    node.parentElement = null;
    return node;
  }

  addEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  dispatchEvent(event) {
    const list = this.listeners.get(event?.type) || [];
    const nextEvent =
      event && typeof event === "object"
        ? {
            ...event,
            currentTarget: event.currentTarget || this,
            target: event.target || this
          }
        : event;
    for (const listener of list) {
      trackAsyncUiTask(listener(nextEvent));
    }
  }

  click() {
    const list = this.listeners.get("click") || [];
    const event = {
      type: "click",
      currentTarget: this,
      target: this,
      preventDefault() {},
      stopPropagation() {},
      stopImmediatePropagation() {}
    };
    for (const listener of list) {
      trackAsyncUiTask(listener(event));
    }
  }
}

function createDocument({ bodyDataset = {}, createdNodes = [] } = {}) {
  const documentElement = new FakeNode({ tagName: "html" });
  const body = new FakeNode({ tagName: "body", dataset: bodyDataset });
  documentElement.appendChild(body);

  return {
    body,
    documentElement,
    querySelector(selector) {
      if (body.matches(selector)) return body;
      return body.querySelector(selector);
    },
    querySelectorAll(selector) {
      const matches = body.querySelectorAll(selector);
      if (body.matches(selector)) {
        return [body, ...matches];
      }
      return matches;
    },
    createElement(tagName) {
      const node = new FakeNode({ tagName });
      node.tabIndex = 0;
      createdNodes.push(node);
      return node;
    }
  };
}

async function bootVkScript({
  href,
  vkId = "",
  responder,
  confirmSequence = [],
  setupDom
}) {
  const calls = [];
  const alerts = [];
  const confirms = [];
  const opened = [];
  const createdNodes = [];
  let observerCallback = null;

  const fakeDocument = createDocument({
    bodyDataset: vkId ? { userId: vkId } : {},
    createdNodes
  });
  if (typeof setupDom === "function") {
    setupDom(fakeDocument);
  }

  globalThis.document = fakeDocument;
  globalThis.__CHEBURCHAT_VK_TEST_CLEANUPS__ = new Set();
  globalThis.__CHEBURCHAT_VK_TEST_API__ = {};
  globalThis.__CHEBURCHAT_PENDING_UI_TASKS__ = new Set();
  const queuedConfirms = [...confirmSequence];
  globalThis.window = {
    location: { href },
    vk: vkId ? { id: vkId } : undefined,
    cur: undefined,
    confirm: (text) => {
      confirms.push(String(text || ""));
      return queuedConfirms.length > 0 ? queuedConfirms.shift() : false;
    },
    alert: (text) => {
      alerts.push(String(text));
    },
    open: (...args) => {
      opened.push(args);
      return null;
    }
  };
  globalThis.chrome = {
    runtime: {
      getURL(path) {
        return `chrome-extension://mock/${path}`;
      },
      async sendMessage(message) {
        calls.push(message);
        if (responder) return responder(message);
        return { ok: true };
      }
    }
  };
  globalThis.MutationObserver = class {
    constructor(cb) {
      observerCallback = cb;
    }
    observe() {}
    disconnect() {}
  };

  vm.runInThisContext(vkPureSource, {
    filename: "/Users/darker0n/workspace/CheburChat/src/content/vk_pure.js"
  });
  vm.runInThisContext(vkScriptSource, {
    filename: "/Users/darker0n/workspace/CheburChat/src/content/vk.js"
  });
  await globalThis.__CHEBURCHAT_VK_TEST_API__.waitForIdle?.();

  return {
    calls,
    alerts,
    confirms,
    opened,
    createdNodes,
    async triggerMutations(times = 1, waitMs = 120) {
      if (typeof observerCallback !== "function") return;
      for (let index = 0; index < times; index += 1) {
        observerCallback([{ type: "childList" }], null);
      }
      await globalThis.__CHEBURCHAT_VK_TEST_API__.waitForIdle?.();
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
  };
}

function appendChildren(parent, ...children) {
  for (const child of children) {
    parent.appendChild(child);
  }
  return parent;
}

test.afterEach(async () => {
  await flushAsyncUiWork();
  const cleanups = globalThis.__CHEBURCHAT_VK_TEST_CLEANUPS__;
  if (cleanups && typeof cleanups[Symbol.iterator] === "function") {
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch (_error) {}
    }
  }
  delete globalThis.document;
  delete globalThis.window;
  delete globalThis.chrome;
  delete globalThis.MutationObserver;
  delete globalThis.__CHEBURCHAT_VK_PURE__;
  delete globalThis.__CHEBURCHAT_VK_TEST_CLEANUPS__;
  delete globalThis.__CHEBURCHAT_VK_TEST_API__;
  delete globalThis.__CHEBURCHAT_PENDING_UI_TASKS__;
});

async function flushAsyncUiWork() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const pendingTasks = globalThis.__CHEBURCHAT_PENDING_UI_TASKS__;
    if (!(pendingTasks instanceof Set) || pendingTasks.size === 0) break;
    await Promise.allSettled(Array.from(pendingTasks));
  }
  const remaining = globalThis.__CHEBURCHAT_PENDING_UI_TASKS__;
  if (remaining instanceof Set && remaining.size > 0) {
    console.warn(`flushAsyncUiWork: ${remaining.size} tasks still pending after 10 rounds`);
  }
  await globalThis.__CHEBURCHAT_VK_TEST_API__?.waitForIdle?.();
}

test("vk content script debounces mutation bursts into one refresh cycle", async () => {
  const { calls, triggerMutations } = await bootVkScript({
    href: "https://vk.com/im?sel=555",
    setupDom: (document) => {
      const compose = new FakeNode({ tagName: "textarea", value: "" });
      const composeParent = appendChildren(new FakeNode(), compose);
      const sendButton = new FakeNode({
        tagName: "button",
        attrs: { type: "submit" }
      });
      const sendParent = appendChildren(new FakeNode(), sendButton);
      document.body.appendChild(composeParent);
      document.body.appendChild(sendParent);
    },
    responder: (message) => {
      if (message.type === "mc:get-settings") {
        return { ok: true, settings: { warningThresholdChars: 1800 } };
      }
      if (message.type === "mc:get-chat-state") {
        return { ok: true, trustState: "missing", contact: {} };
      }
      if (message.type === "mc:process-incoming") {
        return { ok: true, kind: "none" };
      }
      return { ok: true };
    }
  });

  const initialChatStateCalls = calls.filter((entry) => entry.type === "mc:get-chat-state").length;
  assert.equal(initialChatStateCalls, 1);

  await triggerMutations(8, 180);

  const totalChatStateCalls = calls.filter((entry) => entry.type === "mc:get-chat-state").length;
  assert.equal(totalChatStateCalls, 2);
});

test("vk content script drains incoming protocol nodes in bounded batches", async () => {
  const { calls } = await bootVkScript({
    href: "https://vk.com/im?sel=556",
    setupDom: (document) => {
      for (let index = 0; index < 12; index += 1) {
        const message = new FakeNode({
          className: "MessageText msg incoming",
          textContent: `CHEBURCHAT:v1:msg:payload${index}`
        });
        document.body.appendChild(appendChildren(new FakeNode({ tagName: "article" }), message));
      }
    },
    responder: (message) => {
      if (message.type === "mc:get-settings") {
        return { ok: true, settings: { warningThresholdChars: 1800 } };
      }
      if (message.type === "mc:get-chat-state") return { ok: false };
      if (message.type === "mc:process-incoming") return { ok: true, kind: "none" };
      return { ok: true };
    }
  });

  assert.equal(calls.filter((entry) => entry.type === "mc:process-incoming").length, 12);
});

test("vk content script resolves dialog and author ids from href fallbacks", async () => {
  const { calls } = await bootVkScript({
    href: "https://vk.com/im",
    setupDom: (document) => {
      const dialogLink = new FakeNode({
        tagName: "a",
        attrs: { href: "/im?sel=555" }
      });
      const header = appendChildren(
        new FakeNode({
          className: "ConvoHeader"
        }),
        dialogLink
      );
      document.body.appendChild(header);

      const authorLink = new FakeNode({
        tagName: "a",
        className: "ConvoMessageHeader__authorLink",
        attrs: { href: "/id777" }
      });
      const incomingNode = appendChildren(
        new FakeNode({
          className: "MessageText msg incoming",
          textContent: "CHEBURCHAT:v1:msg:abc"
        }),
        authorLink
      );
      const article = appendChildren(
        new FakeNode({
          tagName: "article"
        }),
        incomingNode
      );
      document.body.appendChild(article);
    },
    responder: (message) => {
      if (message.type === "mc:get-settings") {
        return { ok: true, settings: { warningThresholdChars: 1800 } };
      }
      if (message.type === "mc:get-chat-state") return { ok: false };
      if (message.type === "mc:process-incoming") return { ok: true, kind: "none" };
      return { ok: true };
    }
  });

  const incomingCall = calls.find((entry) => entry.type === "mc:process-incoming");
  assert.ok(incomingCall, "expected mc:process-incoming to be sent");
  assert.equal(incomingCall.payload.dialogAccountId, "555");
  assert.equal(incomingCall.payload.messageAuthorAccountId, "777");
});

test("vk content script resolves local author id from outgoing class hints on ancestors", async () => {
  const { calls } = await bootVkScript({
    href: "https://vk.com/im?sel=555",
    vkId: "100",
    setupDom: (document) => {
      const incomingNode = new FakeNode({
        className: "MessageText",
        textContent: "CHEBURCHAT:v1:msg:abc"
      });
      const article = appendChildren(
        new FakeNode({
          tagName: "article",
          className: "ConvoMessage ConvoMessage--out"
        }),
        incomingNode
      );
      document.body.appendChild(article);
    },
    responder: (message) => {
      if (message.type === "mc:get-settings") {
        return { ok: true, settings: { warningThresholdChars: 1800 } };
      }
      if (message.type === "mc:get-chat-state") return { ok: false };
      if (message.type === "mc:process-incoming") return { ok: true, kind: "none" };
      return { ok: true };
    }
  });

  const incomingCall = calls.find((entry) => entry.type === "mc:process-incoming");
  assert.ok(incomingCall, "expected mc:process-incoming to be sent");
  assert.equal(incomingCall.payload.dialogAccountId, "555");
  assert.equal(incomingCall.payload.localAccountId, "100");
  assert.equal(incomingCall.payload.messageAuthorAccountId, "100");
});

test("vk content script resolves local author id when outgoing marker is on stack ancestor", async () => {
  const { calls } = await bootVkScript({
    href: "https://vk.com/im?sel=555",
    vkId: "100",
    setupDom: (document) => {
      const textNode = new FakeNode({
        className: "ConvoMessageWithoutBubble__text",
        textContent: "CHEBURCHAT:v1:msg:abc"
      });
      const article = appendChildren(
        new FakeNode({
          tagName: "article",
          className: "ConvoHistory__messageBlock ConvoHistory__messageBlock--withoutBubbles"
        }),
        textNode
      );
      const virtualItem = appendChildren(
        new FakeNode({
          className: "VirtualScrollItem",
          attrs: { "data-itemkey": "-123" }
        }),
        article
      );
      const stack = appendChildren(
        new FakeNode({
          tagName: "section",
          className: "ConvoStack ConvoStack--out ConvoStack--withoutBubbles",
          attrs: { role: "listitem" }
        }),
        virtualItem
      );
      document.body.appendChild(stack);
    },
    responder: (message) => {
      if (message.type === "mc:get-settings") {
        return { ok: true, settings: { warningThresholdChars: 1800 } };
      }
      if (message.type === "mc:get-chat-state") return { ok: false };
      if (message.type === "mc:process-incoming") return { ok: true, kind: "none" };
      return { ok: true };
    }
  });

  const incomingCall = calls.find((entry) => entry.type === "mc:process-incoming");
  assert.ok(incomingCall, "expected mc:process-incoming to be sent");
  assert.equal(incomingCall.payload.dialogAccountId, "555");
  assert.equal(incomingCall.payload.localAccountId, "100");
  assert.equal(incomingCall.payload.messageAuthorAccountId, "100");
});

test("vk content script resolves author id from data attributes before class fallback", async () => {
  const { calls } = await bootVkScript({
    href: "https://vk.com/im?sel=555",
    setupDom: (document) => {
      const incomingNode = new FakeNode({
        className: "MessageText msg incoming",
        textContent: "CHEBURCHAT:v1:msg:abc"
      });
      const article = appendChildren(
        new FakeNode({
          tagName: "article",
          className: "ConvoMessage",
          attrs: { "data-from-id": "777" }
        }),
        incomingNode
      );
      document.body.appendChild(article);
    },
    responder: (message) => {
      if (message.type === "mc:get-settings") {
        return { ok: true, settings: { warningThresholdChars: 1800 } };
      }
      if (message.type === "mc:get-chat-state") return { ok: false };
      if (message.type === "mc:process-incoming") return { ok: true, kind: "none" };
      return { ok: true };
    }
  });

  const incomingCall = calls.find((entry) => entry.type === "mc:process-incoming");
  assert.ok(incomingCall, "expected mc:process-incoming to be sent");
  assert.equal(incomingCall.payload.dialogAccountId, "555");
  assert.equal(incomingCall.payload.messageAuthorAccountId, "777");
});

test("vk content script syncs dialog display name to background", async () => {
  const { calls } = await bootVkScript({
    href: "https://vk.com/im?sel=888",
    setupDom: (document) => {
      const dialogTitle = new FakeNode({
        className: "ConvoTitle__author",
        textContent: "  VK Support  "
      });
      const titleContainer = appendChildren(
        new FakeNode({
          className: "ConvoHeader__title"
        }),
        dialogTitle
      );
      document.body.appendChild(titleContainer);
    },
    responder: (message) => {
      if (message.type === "mc:get-settings") {
        return { ok: true, settings: { warningThresholdChars: 1800 } };
      }
      if (message.type === "mc:get-chat-state") return { ok: false };
      if (message.type === "mc:sync-contact-profile") return { ok: true, contact: {} };
      return { ok: true };
    }
  });

  const syncCall = calls.find((entry) => entry.type === "mc:sync-contact-profile");
  assert.ok(syncCall, "expected mc:sync-contact-profile call");
  assert.deepEqual(syncCall.payload, {
    platform: "vk",
    accountId: "888",
    displayName: "VK Support"
  });
});

test("vk content script does not bind local account id from unrelated profile links", async () => {
  const { calls } = await bootVkScript({
    href: "https://vk.com/im?sel=888",
    setupDom: (document) => {
      document.body.appendChild(
        new FakeNode({
          tagName: "a",
          textContent: "Собеседник",
          attrs: { href: "/id777" }
        })
      );
    },
    responder: (message) => {
      if (message.type === "mc:get-settings") {
        return { ok: true, settings: { warningThresholdChars: 1800 } };
      }
      if (message.type === "mc:get-chat-state") return { ok: false };
      if (message.type === "mc:sync-contact-profile") return { ok: true, contact: {} };
      return { ok: true };
    }
  });

  assert.equal(calls.some((entry) => entry.type === "mc:upsert-binding"), false);
});

test("vk content script normalizes key wrapper in chat preview", async () => {
  const previewNode = new FakeNode({
    tagName: "span",
    className: "MessagePreview",
    textContent:
      "I shared my CheburChat encryption key with you. Install CheburChat to enable encrypted chat: https://cheburchat.com/install CHEBURCHAT:v1:key:abc"
  });

  await bootVkScript({
    href: "https://vk.com/im?sel=777",
    setupDom: (document) => {
      const row = appendChildren(
        new FakeNode({
          className: "ConvoListItem"
        }),
        previewNode
      );
      document.body.appendChild(row);
    },
    responder: (message) => {
      if (message.type === "mc:get-settings") {
        return { ok: true, settings: { warningThresholdChars: 1800 } };
      }
      if (message.type === "mc:get-chat-state") return { ok: false };
      return { ok: true };
    }
  });

  const overlay = previewNode.parentElement.querySelector(".mc-overlay");
  assert.equal(overlay.textContent, "Объявление ключа Чебурчат");
  assert.match(overlay.className, /\bmc-preview-system\b/);
  assert.equal(previewNode.style.display, "none");
});

test("vk content script normalizes encrypted wrapper in chat preview", async () => {
  const previewNode = new FakeNode({
    tagName: "span",
    className: "MessagePreview",
    textContent: "CHEBURCHAT:v1:msg:abc"
  });

  await bootVkScript({
    href: "https://vk.com/im?sel=777",
    setupDom: (document) => {
      const row = appendChildren(
        new FakeNode({
          className: "ConvoListItem__message"
        }),
        previewNode
      );
      document.body.appendChild(row);
    },
    responder: (message) => {
      if (message.type === "mc:get-settings") {
        return { ok: true, settings: { warningThresholdChars: 1800 } };
      }
      if (message.type === "mc:get-chat-state") return { ok: false };
      return { ok: true };
    }
  });

  const overlay = previewNode.parentElement.querySelector(".mc-overlay");
  assert.equal(overlay.textContent, "Зашифрованное сообщение Чебурчат");
  assert.match(overlay.className, /\bmc-preview-system\b/);
  assert.equal(previewNode.style.display, "none");
});

test("vk content script marks unsupported key wrapper in chat preview", async () => {
  const previewNode = new FakeNode({
    tagName: "span",
    className: "MessagePreview",
    textContent:
      "I shared my CheburChat encryption key with you. Install CheburChat to enable encrypted chat: https://cheburchat.com/install CHEBURCHAT:v2:key:abc"
  });

  await bootVkScript({
    href: "https://vk.com/im?sel=777",
    setupDom: (document) => {
      const row = appendChildren(
        new FakeNode({
          className: "ConvoListItem"
        }),
        previewNode
      );
      document.body.appendChild(row);
    },
    responder: (message) => {
      if (message.type === "mc:get-settings") {
        return { ok: true, settings: { warningThresholdChars: 1800 } };
      }
      if (message.type === "mc:get-chat-state") return { ok: false };
      return { ok: true };
    }
  });

  const overlay = previewNode.parentElement.querySelector(".mc-overlay");
  assert.equal(overlay.textContent, "Неподдерживаемая версия Чебурчат");
  assert.match(overlay.className, /\bmc-preview-warning\b/);
  assert.equal(previewNode.style.display, "none");
});

test("vk content script marks unsupported encrypted wrapper in chat preview", async () => {
  const previewNode = new FakeNode({
    tagName: "span",
    className: "MessagePreview",
    textContent: "CHEBURCHAT:v2:msg:abc"
  });

  await bootVkScript({
    href: "https://vk.com/im?sel=777",
    setupDom: (document) => {
      const row = appendChildren(
        new FakeNode({
          className: "ConvoListItem__message"
        }),
        previewNode
      );
      document.body.appendChild(row);
    },
    responder: (message) => {
      if (message.type === "mc:get-settings") {
        return { ok: true, settings: { warningThresholdChars: 1800 } };
      }
      if (message.type === "mc:get-chat-state") return { ok: false };
      return { ok: true };
    }
  });

  const overlay = previewNode.parentElement.querySelector(".mc-overlay");
  assert.equal(overlay.textContent, "Неподдерживаемая версия Чебурчат");
  assert.match(overlay.className, /\bmc-preview-warning\b/);
  assert.equal(previewNode.style.display, "none");
});

test("vk content script refreshes preview overlay when VK reuses preview node", async () => {
  const previewNode = new FakeNode({
    tagName: "span",
    className: "MessagePreview",
    textContent: "CHEBURCHAT:v1:msg:abc"
  });

  const { triggerMutations } = await bootVkScript({
    href: "https://vk.com/im?sel=777",
    setupDom: (document) => {
      const row = appendChildren(
        new FakeNode({
          className: "ConvoListItem__message"
        }),
        previewNode
      );
      document.body.appendChild(row);
    },
    responder: (message) => {
      if (message.type === "mc:get-settings") {
        return { ok: true, settings: { warningThresholdChars: 1800 } };
      }
      if (message.type === "mc:get-chat-state") return { ok: false };
      return { ok: true };
    }
  });

  let overlay = previewNode.parentElement.querySelector(".mc-overlay");
  assert.equal(overlay.textContent, "Зашифрованное сообщение Чебурчат");
  assert.equal(previewNode.style.display, "none");

  previewNode.textContent = "Обычное новое сообщение";
  previewNode.innerText = "Обычное новое сообщение";
  await triggerMutations(1, 180);

  overlay = previewNode.parentElement.querySelector(".mc-overlay");
  assert.equal(overlay, null);
  assert.equal(previewNode.style.display, "");
});

test("vk content script extracts canonical key payload from mutated announcement text", async () => {
  const validText = buildKeyAnnouncementText({
    v: "v1",
    platform: "vk",
    accountId: "777",
    publicKeyArmored: "pub",
    fingerprint: "ABCD",
    displayName: "",
    sig: "sig"
  });
  const mutatedText = `${validText}.`;
  const incomingNode = new FakeNode({
    className: "MessageText msg incoming",
    textContent: mutatedText
  });

  const { calls } = await bootVkScript({
    href: "https://vk.com/im?sel=777",
    setupDom: (document) => {
      const article = appendChildren(
        new FakeNode({
          tagName: "article"
        }),
        incomingNode
      );
      document.body.appendChild(article);
    },
    responder: (message) => {
      if (message.type === "mc:get-settings") {
        return { ok: true, settings: { warningThresholdChars: 1800 } };
      }
      if (message.type === "mc:get-chat-state") return { ok: false };
      if (message.type === "mc:process-incoming") return { ok: true, kind: "none" };
      return { ok: true };
    }
  });

  const incomingCall = calls.find((entry) => entry.type === "mc:process-incoming");
  assert.ok(incomingCall, "expected mc:process-incoming call");
  assert.equal(incomingCall.payload.rawText, validText.split("\n")[1]);
});

test("vk content script forwards canonical key announcements by machine-readable payload line", async () => {
  const validText = buildKeyAnnouncementText({
    v: "v1",
    platform: "vk",
    accountId: "777",
    publicKeyArmored: "pub",
    fingerprint: "ABCD",
    displayName: "",
    sig: "sig"
  });
  const incomingNode = new FakeNode({
    className: "MessageText msg incoming",
    textContent: validText,
  });

  const { calls } = await bootVkScript({
    href: "https://vk.com/im?sel=777",
    setupDom: (document) => {
      const article = appendChildren(
        new FakeNode({
          tagName: "article"
        }),
        incomingNode
      );
      document.body.appendChild(article);
    },
    responder: (message) => {
      if (message.type === "mc:get-settings") {
        return { ok: true, settings: { warningThresholdChars: 1800 } };
      }
      if (message.type === "mc:get-chat-state") return { ok: false };
      if (message.type === "mc:process-incoming") return { ok: true, kind: "none" };
      return { ok: true };
    }
  });

  const incomingCall = calls.find((entry) => entry.type === "mc:process-incoming");
  assert.ok(incomingCall, "expected mc:process-incoming call");
  assert.equal(
    incomingCall.payload.rawText,
    validText.split("\n")[1]
  );
});

test("vk content script prefers innerText for canonical wrapper extraction", async () => {
  const validText = buildKeyAnnouncementText({
    v: "v1",
    platform: "vk",
    accountId: "777",
    publicKeyArmored: "pub",
    fingerprint: "ABCD",
    displayName: "",
    sig: "sig"
  });
  const incomingNode = new FakeNode({
    className: "MessageText msg incoming",
    textContent: validText.replace(/\n/g, " "),
  });
  incomingNode.innerText = validText;

  const { calls } = await bootVkScript({
    href: "https://vk.com/im?sel=777",
    setupDom: (document) => {
      const article = appendChildren(
        new FakeNode({
          tagName: "article"
        }),
        incomingNode
      );
      document.body.appendChild(article);
    },
    responder: (message) => {
      if (message.type === "mc:get-settings") {
        return { ok: true, settings: { warningThresholdChars: 1800 } };
      }
      if (message.type === "mc:get-chat-state") return { ok: false };
      if (message.type === "mc:process-incoming") return { ok: true, kind: "none" };
      return { ok: true };
    }
  });

  const incomingCall = calls.find((entry) => entry.type === "mc:process-incoming");
  assert.ok(incomingCall, "expected mc:process-incoming call");
  assert.equal(
    incomingCall.payload.rawText,
    validText.split("\n")[1]
  );
});

test("vk content script renders key system message when only innerText is canonical", async () => {
  const validText = buildKeyAnnouncementText({
    v: "v1",
    platform: "vk",
    accountId: "777",
    publicKeyArmored: "pub",
    fingerprint: "ABCD",
    displayName: "",
    sig: "sig"
  });
  const incomingNode = new FakeNode({
    className: "MessageText msg incoming",
    textContent: validText.replace(/\n/g, " "),
  });
  incomingNode.innerText = validText;

  await bootVkScript({
    href: "https://vk.com/im?sel=777",
    setupDom: (document) => {
      const article = appendChildren(
        new FakeNode({
          tagName: "article"
        }),
        incomingNode
      );
      document.body.appendChild(article);
    },
    responder: (message) => {
      if (message.type === "mc:get-settings") {
        return { ok: true, settings: { warningThresholdChars: 1800 } };
      }
      if (message.type === "mc:get-chat-state") return { ok: false };
      if (message.type === "mc:process-incoming") {
        if (message.payload?.rawText === validText || message.payload?.rawText === validText.split("\n")[1]) {
          return { ok: true, kind: "key_self_announcement" };
        }
        return { ok: true, kind: "none" };
      }
      return { ok: true };
    }
  });

  const overlay = incomingNode.parentElement.querySelector(".mc-overlay");
  assert.equal(overlay.textContent, "Ваш публичный ключ Чебурчат был отправлен.");
  assert.match(overlay.className, /\bmc-message-system\b/);
  assert.equal(incomingNode.style.display, "none");
});

test("vk content script renders inline key actions and can accept plus share back", async () => {
  const validText = buildKeyAnnouncementText({
    v: "v1",
    platform: "vk",
    accountId: "777",
    publicKeyArmored: "pub",
    fingerprint: "ABCD",
    displayName: "",
    sig: "sig"
  });
  const selfAnnouncementText = buildKeyAnnouncementText({
    v: "v1",
    platform: "vk",
    accountId: "100",
    publicKeyArmored: "self-pub",
    fingerprint: "LOCAL",
    displayName: "",
    sig: "self-sig"
  });
  const incomingNode = new FakeNode({
    className: "MessageText msg incoming",
    textContent: validText
  });
  const selfAnnouncementNode = new FakeNode({
    className: "MessageText msg outgoing",
    textContent: selfAnnouncementText
  });
  let compose = null;
  let sendButton = null;
  let article = null;

  const { calls, alerts, createdNodes, triggerMutations } = await bootVkScript({
    href: "https://vk.com/im?sel=777",
    vkId: "100",
    setupDom: (document) => {
      article = appendChildren(
        new FakeNode({
          tagName: "article"
        }),
        incomingNode
      );
      compose = new FakeNode({ tagName: "textarea", value: "" });
      const composeParent = appendChildren(new FakeNode(), compose);
      sendButton = new FakeNode({
        tagName: "button",
        attrs: { type: "submit", "aria-label": "Send", title: "Send" }
      });
      const sendParent = appendChildren(new FakeNode(), sendButton);
      document.body.appendChild(article);
      document.body.appendChild(composeParent);
      document.body.appendChild(sendParent);
    },
    responder: (message) => {
      if (message.type === "mc:get-settings") {
        return { ok: true, settings: { warningThresholdChars: 1800 } };
      }
      if (message.type === "mc:get-chat-state") {
        return {
          ok: true,
          trustState: "new",
          contact: {
            fingerprintFull: "ABCD"
          }
        };
      }
      if (message.type === "mc:process-incoming") {
        if (
          message.payload?.rawText === selfAnnouncementText ||
          message.payload?.rawText === selfAnnouncementText.split("\n")[1]
        ) {
          return { ok: true, kind: "key_self_announcement" };
        }
        return {
          ok: true,
          kind: "key",
          trustState: "new",
          fingerprintFull: "ABCD1234EF567890"
        };
      }
      if (message.type === "mc:set-trust") {
        return { ok: true, contact: { trustState: "trusted" } };
      }
      if (message.type === "mc:mark-own-key-shared") {
        return { ok: true, contact: {} };
      }
      if (message.type === "mc:get-identity") {
        return { ok: true, identity: { fingerprintFull: "LOCAL" } };
      }
      if (message.type === "mc:create-key-announcement") {
        return { ok: true, text: selfAnnouncementText };
      }
      return { ok: true };
    }
  });

  const buttons = createdNodes.filter((node) => /\bmc-inline-action-button\b/.test(node.className));
  assert.equal(buttons.length, 2);
  assert.equal(buttons[0].textContent, "Принять");
  assert.equal(buttons[1].textContent, "Отклонить");
  assert.match(
    incomingNode.parentElement.querySelector(".mc-inline-actions-description").textContent,
    /ABCD 1234 EF56 7890/
  );

  await buttons[0].click();
  await flushAsyncUiWork();

  const announcementCall = calls.find((entry) => entry.type === "mc:create-key-announcement");
  assert.ok(announcementCall, "expected mc:create-key-announcement call");
  assert.equal(announcementCall.payload.accountId, "100");
  assert.equal(compose.value, selfAnnouncementText);
  assert.equal(incomingNode.parentElement.querySelector(".mc-inline-actions"), null);
  assert.equal(alerts.length, 0);
  assert.equal(
    incomingNode.parentElement.querySelector(".mc-overlay").textContent,
    "Ваш публичный ключ отправлен. Теперь проверьте отпечаток и подтвердите ключ контакта."
  );
  assert.equal(calls.some((entry) => entry.type === "mc:mark-own-key-shared"), false);
  assert.equal(calls.some((entry) => entry.type === "mc:set-trust"), false);

  article.appendChild(selfAnnouncementNode);
  await triggerMutations();

  const markOwnKeySharedCall = calls.find((entry) => entry.type === "mc:mark-own-key-shared");
  assert.ok(markOwnKeySharedCall, "expected mc:mark-own-key-shared call");
  assert.deepEqual(markOwnKeySharedCall.payload, {
    platform: "vk",
    accountId: "777"
  });

  assert.equal(calls.some((entry) => entry.type === "mc:set-trust"), false);
});

test("vk content indicator shares own key immediately after click", async () => {
  let compose = null;
  let article = null;
  const selfAnnouncementText = buildKeyAnnouncementText({
    v: "v1",
    platform: "vk",
    accountId: "100",
    publicKeyArmored: "self-pub",
    fingerprint: "LOCAL",
    displayName: "",
    sig: "self-sig"
  });
  const selfAnnouncementNode = new FakeNode({
    className: "MessageText msg outgoing",
    textContent: selfAnnouncementText
  });

  const { calls, alerts, createdNodes, triggerMutations } = await bootVkScript({
    href: "https://vk.com/im?sel=778",
    vkId: "100",
    setupDom: (document) => {
      article = new FakeNode({ tagName: "article" });
      compose = new FakeNode({ tagName: "textarea", value: "" });
      const composeParent = appendChildren(new FakeNode(), compose);
      const sendButton = new FakeNode({
        tagName: "button",
        attrs: { type: "submit", "aria-label": "Send", title: "Send" }
      });
      const sendParent = appendChildren(new FakeNode(), sendButton);
      document.body.appendChild(article);
      document.body.appendChild(composeParent);
      document.body.appendChild(sendParent);
    },
    responder: (message) => {
      if (message.type === "mc:get-settings") {
        return { ok: true, settings: { warningThresholdChars: 1800 } };
      }
      if (message.type === "mc:get-chat-state") {
        return { ok: true, trustState: "missing", contact: {} };
      }
      if (message.type === "mc:get-identity") {
        return { ok: true, identity: { fingerprintFull: "LOCAL" } };
      }
      if (message.type === "mc:create-key-announcement") {
        return { ok: true, text: selfAnnouncementText };
      }
      if (message.type === "mc:mark-own-key-shared") {
        return { ok: true, contact: {} };
      }
      if (
        message.type === "mc:process-incoming" &&
        (message.payload?.rawText === selfAnnouncementText ||
          message.payload?.rawText === selfAnnouncementText.split("\n")[1])
      ) {
        return { ok: true, kind: "key_self_announcement" };
      }
      return { ok: true };
    }
  });

  const indicator = createdNodes.find((node) => /\bmc-lock-indicator\b/.test(node.className));
  assert.ok(indicator, "expected lock indicator node to be created");

  await indicator.click();
  await flushAsyncUiWork();

  const announcementCall = calls.find((entry) => entry.type === "mc:create-key-announcement");
  assert.ok(announcementCall, "expected mc:create-key-announcement call");
  assert.equal(announcementCall.payload.accountId, "100");
  assert.equal(compose.value, selfAnnouncementText);
  assert.equal(calls.some((entry) => entry.type === "mc:mark-own-key-shared"), false);

  article.appendChild(selfAnnouncementNode);
  await triggerMutations();

  const markOwnKeySharedCall = calls.find((entry) => entry.type === "mc:mark-own-key-shared");
  assert.ok(markOwnKeySharedCall, "expected mc:mark-own-key-shared call");
  assert.deepEqual(markOwnKeySharedCall.payload, {
    platform: "vk",
    accountId: "778"
  });
  assert.equal(alerts.length, 0);
});

test("vk content indicator aborts auto share when compose text changes before VK send becomes available", async () => {
  let compose = null;
  let actionButton = null;
  const selfAnnouncementText = buildKeyAnnouncementText({
    v: "v1",
    platform: "vk",
    accountId: "100",
    publicKeyArmored: "self-pub",
    fingerprint: "LOCAL",
    displayName: "",
    sig: "self-sig"
  });

  const { calls, alerts, createdNodes } = await bootVkScript({
    href: "https://vk.com/im?sel=778",
    vkId: "100",
    setupDom: (document) => {
      compose = new FakeNode({ tagName: "textarea", value: "" });
      const composeParent = appendChildren(new FakeNode({ className: "ConvoComposer" }), compose);
      actionButton = new FakeNode({
        tagName: "button",
        className: "ConvoComposer__button ConvoComposer__sendButton--mic",
        attrs: { "aria-label": "Записать голосовое сообщение", title: "Записать голосовое сообщение" },
        dataset: {}
      });
      composeParent.appendChild(actionButton);
      document.body.appendChild(composeParent);
    },
    responder: (message) => {
      if (message.type === "mc:get-settings") {
        return { ok: true, settings: { warningThresholdChars: 1800 } };
      }
      if (message.type === "mc:get-chat-state") {
        return { ok: true, trustState: "missing", contact: {} };
      }
      if (message.type === "mc:get-identity") {
        return { ok: true, identity: { fingerprintFull: "LOCAL" } };
      }
      if (message.type === "mc:create-key-announcement") {
        return { ok: true, text: selfAnnouncementText };
      }
      if (message.type === "mc:mark-own-key-shared") {
        return { ok: true, contact: {} };
      }
      return { ok: true };
    }
  });

  const indicator = createdNodes.find((node) => /\bmc-lock-indicator\b/.test(node.className));
  assert.ok(indicator, "expected lock indicator node to be created");

  setTimeout(() => {
    compose.value = "hello";
    actionButton.className = "ConvoComposer__button ConvoComposer__sendButton--submit";
    actionButton.setAttribute("aria-label", "Send");
    actionButton.setAttribute("title", "Send");
  }, 10);

  await indicator.click();
  await flushAsyncUiWork();
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(compose.value, "hello");
  assert.equal(calls.some((entry) => entry.type === "mc:mark-own-key-shared"), false);
  assert.ok(alerts.some((text) => /Текст в поле ввода изменился до отправки объявления ключа/i.test(text)));
});

test("vk content script consumes internal intent before auto sharing key", async () => {
  let compose = null;
  let article = null;
  const selfAnnouncementText = buildKeyAnnouncementText({
    v: "v1",
    platform: "vk",
    accountId: "100",
    publicKeyArmored: "self-pub",
    fingerprint: "LOCAL",
    displayName: "",
    sig: "self-sig"
  });
  const selfAnnouncementNode = new FakeNode({
    className: "MessageText msg outgoing",
    textContent: selfAnnouncementText
  });

  const { calls, alerts, triggerMutations } = await bootVkScript({
    href: "https://vk.com/im?sel=779",
    vkId: "100",
    setupDom: (document) => {
      article = new FakeNode({ tagName: "article" });
      compose = new FakeNode({ tagName: "textarea", value: "" });
      const composeParent = appendChildren(new FakeNode({ className: "ConvoComposer" }), compose);
      const sendButton = new FakeNode({
        tagName: "button",
        className: "ConvoComposer__button ConvoComposer__sendButton--submit",
        attrs: { type: "submit", "aria-label": "Send", title: "Send" }
      });
      composeParent.appendChild(sendButton);
      document.body.appendChild(article);
      document.body.appendChild(composeParent);
    },
    responder: (message) => {
      if (message.type === "mc:get-settings") {
        return { ok: true, settings: { warningThresholdChars: 1800 } };
      }
      if (message.type === "mc:get-chat-state") {
        return {
          ok: true,
          trustState: "trusted",
          contact: {
            fingerprintFull: "ABCD"
          }
        };
      }
      if (message.type === "mc:consume-key-share-intent") {
        return { ok: true, pending: true };
      }
      if (message.type === "mc:get-identity") {
        return { ok: true, identity: { fingerprintFull: "LOCAL" } };
      }
      if (message.type === "mc:create-key-announcement") {
        return { ok: true, text: selfAnnouncementText };
      }
      if (message.type === "mc:mark-own-key-shared") {
        return { ok: true, contact: {} };
      }
      if (
        message.type === "mc:process-incoming" &&
        (message.payload?.rawText === selfAnnouncementText ||
          message.payload?.rawText === selfAnnouncementText.split("\n")[1])
      ) {
        return { ok: true, kind: "key_self_announcement" };
      }
      if (message.type === "mc:process-outgoing") {
        return { ok: true, mode: "encrypted", text: "CHEBURCHAT:v1:msg:test" };
      }
      return { ok: true };
    }
  });

  await flushAsyncUiWork();

  const announcementCall = calls.find((entry) => entry.type === "mc:create-key-announcement");
  assert.ok(announcementCall, "expected mc:create-key-announcement call");
  assert.equal(announcementCall.payload.accountId, "100");
  assert.equal(compose.value, selfAnnouncementText);
  assert.equal(calls.filter((entry) => entry.type === "mc:consume-key-share-intent").length, 1);
  assert.equal(calls.some((entry) => entry.type === "mc:mark-own-key-shared"), false);

  article.appendChild(selfAnnouncementNode);
  await triggerMutations();

  const markOwnKeySharedCall = calls.find((entry) => entry.type === "mc:mark-own-key-shared");
  assert.ok(markOwnKeySharedCall, "expected mc:mark-own-key-shared call");
  assert.deepEqual(markOwnKeySharedCall.payload, {
    platform: "vk",
    accountId: "779"
  });
  assert.equal(calls.some((entry) => entry.type === "mc:process-outgoing"), false);
  assert.equal(alerts.length, 0);
});

test("vk content script can reject incoming key and keep it rejected", async () => {
  const validText = buildKeyAnnouncementText({
    v: "v1",
    platform: "vk",
    accountId: "777",
    publicKeyArmored: "pub",
    fingerprint: "ABCD",
    displayName: "",
    sig: "sig"
  });
  const incomingNode = new FakeNode({
    className: "MessageText msg incoming",
    textContent: validText
  });

  const { calls, createdNodes } = await bootVkScript({
    href: "https://vk.com/im?sel=777",
    setupDom: (document) => {
      const article = appendChildren(
        new FakeNode({
          tagName: "article"
        }),
        incomingNode
      );
      document.body.appendChild(article);
    },
    responder: (message) => {
      if (message.type === "mc:get-settings") {
        return { ok: true, settings: { warningThresholdChars: 1800 } };
      }
      if (message.type === "mc:get-chat-state") {
        return {
          ok: true,
          trustState: "missing",
          contact: {}
        };
      }
      if (message.type === "mc:process-incoming") {
        return {
          ok: true,
          kind: "key",
          trustState: "new",
          fingerprintFull: "ABCD1234"
        };
      }
      if (message.type === "mc:set-trust") {
        return { ok: true, contact: { trustState: "rejected" } };
      }
      return { ok: true };
    }
  });

  const buttons = createdNodes.filter((node) => /\bmc-inline-action-button\b/.test(node.className));
  assert.equal(buttons.length, 2);
  assert.equal(buttons[1].textContent, "Отклонить");

  buttons[1].dispatchEvent({
    type: "click",
    isTrusted: false,
    preventDefault() {},
    stopPropagation() {}
  });
  await flushAsyncUiWork();
  assert.equal(calls.some((entry) => entry.type === "mc:set-trust"), false);

  await buttons[1].click();
  await flushAsyncUiWork();

  const setTrustCall = calls.find((entry) => entry.type === "mc:set-trust");
  assert.ok(setTrustCall, "expected mc:set-trust call");
  assert.deepEqual(setTrustCall.payload, {
    platform: "vk",
    accountId: "777",
    trustState: "rejected"
  });
  assert.match(incomingNode.parentElement.querySelector(".mc-overlay").textContent, /отклонено/i);
  assert.equal(incomingNode.parentElement.querySelector(".mc-inline-actions"), null);
});

test("vk content script accepts key without resharing when own key was already sent earlier", async () => {
  const validText = buildKeyAnnouncementText({
    v: "v1",
    platform: "vk",
    accountId: "777",
    publicKeyArmored: "pub",
    fingerprint: "ABCD",
    displayName: "",
    sig: "sig"
  });
  const incomingNode = new FakeNode({
    className: "MessageText msg incoming",
    textContent: validText
  });

  const { calls, createdNodes } = await bootVkScript({
    href: "https://vk.com/im?sel=777",
    setupDom: (document) => {
      const article = appendChildren(
        new FakeNode({
          tagName: "article"
        }),
        incomingNode
      );
      const compose = new FakeNode({ tagName: "textarea", value: "" });
      const composeParent = appendChildren(new FakeNode(), compose);
      const sendButton = new FakeNode({
        tagName: "button",
        attrs: { type: "submit", "aria-label": "Send", title: "Send" }
      });
      const sendParent = appendChildren(new FakeNode(), sendButton);
      document.body.appendChild(article);
      document.body.appendChild(composeParent);
      document.body.appendChild(sendParent);
    },
    responder: (message) => {
      if (message.type === "mc:get-settings") {
        return { ok: true, settings: { warningThresholdChars: 1800 } };
      }
      if (message.type === "mc:get-chat-state") {
        return {
          ok: true,
          trustState: "new",
          contact: {
            fingerprintFull: "ABCD"
          }
        };
      }
      if (message.type === "mc:process-incoming") {
        return {
          ok: true,
          kind: "key",
          trustState: "new",
          fingerprintFull: "0CDC5427E00D70BC7BE1D6A280F594E1099E80C7",
          ownKeyAlreadyShared: true
        };
      }
      if (message.type === "mc:set-trust") {
        return { ok: true, contact: { trustState: "trusted" } };
      }
      return { ok: true };
    }
  });

  const description = incomingNode.parentElement.querySelector(".mc-inline-actions-description").textContent;
  assert.match(description, /Ваш ключ уже был отправлен ранее/i);
  assert.ok(!/отправьте свой в ответ/i.test(description));

  const buttons = createdNodes.filter((node) => /\bmc-inline-action-button\b/.test(node.className));
  await buttons[0].click();
  await flushAsyncUiWork();

  const setTrustCall = calls.find((entry) => entry.type === "mc:set-trust");
  assert.ok(setTrustCall, "expected mc:set-trust call");
  assert.deepEqual(setTrustCall.payload, {
    platform: "vk",
    accountId: "777",
    trustState: "trusted"
  });
  assert.equal(calls.some((entry) => entry.type === "mc:create-key-announcement"), false);
  assert.equal(calls.some((entry) => entry.type === "mc:mark-own-key-shared"), false);
  assert.match(incomingNode.parentElement.querySelector(".mc-overlay").textContent, /Защищенный диалог готов/i);
});

test("vk content script processes self announcement before reply key and avoids resharing loop", async () => {
  const selfAnnouncementText = buildKeyAnnouncementText({
    v: "v1",
    platform: "vk",
    accountId: "100",
    publicKeyArmored: "self-pub",
    fingerprint: "SELF",
    displayName: "",
    sig: "self-sig"
  });
  const replyAnnouncementText = buildKeyAnnouncementText({
    v: "v1",
    platform: "vk",
    accountId: "777",
    publicKeyArmored: "reply-pub",
    fingerprint: "REPLY",
    displayName: "",
    sig: "reply-sig"
  });
  const ownNode = new FakeNode({
    className: "MessageText msg outgoing",
    textContent: selfAnnouncementText
  });
  const replyNode = new FakeNode({
    className: "MessageText msg incoming",
    textContent: replyAnnouncementText
  });

  const { calls } = await bootVkScript({
    href: "https://vk.com/im?sel=777",
    vkId: "100",
    setupDom: (document) => {
      const article = new FakeNode({ tagName: "article" });
      article.appendChild(ownNode);
      article.appendChild(replyNode);
      const compose = new FakeNode({ tagName: "textarea", value: "" });
      const composeParent = appendChildren(new FakeNode(), compose);
      const sendButton = new FakeNode({
        tagName: "button",
        attrs: { type: "submit", "aria-label": "Send", title: "Send" }
      });
      const sendParent = appendChildren(new FakeNode(), sendButton);
      document.body.appendChild(article);
      document.body.appendChild(composeParent);
      document.body.appendChild(sendParent);
    },
    responder: (message) => {
      if (message.type === "mc:get-settings") {
        return { ok: true, settings: { warningThresholdChars: 1800 } };
      }
      if (message.type === "mc:get-chat-state") {
        return { ok: true, trustState: "new", contact: { fingerprintFull: "REPLY" } };
      }
      if (message.type === "mc:process-incoming") {
        if (
          message.payload.rawText === selfAnnouncementText ||
          message.payload.rawText === selfAnnouncementText.split("\n")[1]
        ) {
          return { ok: true, kind: "key_self_announcement" };
        }
        if (
          message.payload.rawText === replyAnnouncementText ||
          message.payload.rawText === replyAnnouncementText.split("\n")[1]
        ) {
          return {
            ok: true,
            kind: "key",
            trustState: "new",
            fingerprintFull: "0CDC5427E00D70BC7BE1D6A280F594E1099E80C7",
            ownKeyAlreadyShared: true
          };
        }
      }
      if (message.type === "mc:set-trust") {
        return { ok: true, contact: { trustState: "trusted" } };
      }
      return { ok: true };
    }
  });

  const description = replyNode.parentElement.querySelector(".mc-inline-actions-description").textContent;
  assert.match(description, /Ваш ключ уже был отправлен ранее/i);
  assert.ok(!/отправьте свой в ответ/i.test(description));
  assert.equal(calls.some((entry) => entry.type === "mc:create-key-announcement"), false);
});

test("vk content script keeps wrapped message retryable when background reports missing identity", async () => {
  const incomingNode = new FakeNode({
    className: "MessageText msg incoming",
    textContent: "CHEBURCHAT:v1:msg:abc"
  });
  let processIncomingCalls = 0;

  const { triggerMutations } = await bootVkScript({
    href: "https://vk.com/im?sel=777",
    setupDom: (document) => {
      const article = appendChildren(
        new FakeNode({
          tagName: "article"
        }),
        incomingNode
      );
      document.body.appendChild(article);
    },
    responder: (message) => {
      if (message.type === "mc:get-settings") {
        return { ok: true, settings: { warningThresholdChars: 1800 } };
      }
      if (message.type === "mc:get-chat-state") return { ok: false };
      if (message.type === "mc:process-incoming") {
        processIncomingCalls += 1;
        if (processIncomingCalls === 1) return { ok: true, kind: "identity_missing" };
        return { ok: true, kind: "decrypted", body: "Привет", ts: "2026-03-20T00:00:00.000Z" };
      }
      return { ok: true };
    }
  });

  assert.equal(incomingNode.textContent, "CHEBURCHAT:v1:msg:abc");
  assert.equal(incomingNode.dataset.mcProcessed, "identity_missing");

  await triggerMutations(1, 180);

  assert.equal(processIncomingCalls >= 2, true);
  assert.equal(incomingNode.dataset.mcProcessed, "1");
  const overlay = incomingNode.parentElement.querySelector(".mc-overlay");
  assert.equal(overlay.textContent, "Привет");
  assert.match(overlay.className, /\bmc-message-decrypted\b/);
  assert.equal(incomingNode.style.display, "none");
});

test("vk content script retries decrypt_failed message using stored wrapper payload", async () => {
  const incomingNode = new FakeNode({
    className: "MessageText msg incoming",
    textContent: "CHEBURCHAT:v1:msg:abc"
  });
  const incomingRawTexts = [];

  const { triggerMutations } = await bootVkScript({
    href: "https://vk.com/im?sel=777",
    setupDom: (document) => {
      const article = appendChildren(
        new FakeNode({
          tagName: "article"
        }),
        incomingNode
      );
      document.body.appendChild(article);
    },
    responder: (message) => {
      if (message.type === "mc:get-settings") {
        return { ok: true, settings: { warningThresholdChars: 1800 } };
      }
      if (message.type === "mc:get-chat-state") return { ok: false };
      if (message.type === "mc:process-incoming") {
        incomingRawTexts.push(String(message.payload?.rawText || ""));
        if (incomingRawTexts.length === 1) {
          return { ok: true, kind: "decrypt_failed", reason: "missing_contact_key" };
        }
        return { ok: true, kind: "decrypted", body: "Расшифровано", ts: "2026-03-20T00:00:00.000Z" };
      }
      return { ok: true };
    }
  });

  assert.equal(incomingNode.dataset.mcProcessed, "decrypt_failed");
  assert.equal(incomingNode.dataset.mcRawProtocolText, "CHEBURCHAT:v1:msg:abc");
  const overlay = incomingNode.parentElement.querySelector(".mc-overlay");
  assert.match(overlay.textContent, /Не удалось расшифровать сообщение/);
  assert.equal(incomingNode.style.display, "none");

  await triggerMutations(1, 180);

  assert.equal(incomingRawTexts.length >= 2, true);
  assert.equal(incomingRawTexts[0], "CHEBURCHAT:v1:msg:abc");
  assert.equal(incomingRawTexts[1], "CHEBURCHAT:v1:msg:abc");
  assert.equal(incomingNode.dataset.mcProcessed, "1");
  assert.equal(incomingNode.dataset.mcRawProtocolText, undefined);
  const overlayAfterRetry = incomingNode.parentElement.querySelector(".mc-overlay");
  assert.equal(overlayAfterRetry.textContent, "Расшифровано");
  assert.match(overlayAfterRetry.className, /\bmc-message-decrypted\b/);
  assert.equal(incomingNode.style.display, "none");
});

test("vk content script processes nested message text node once and keeps retry payload stable", async () => {
  const incomingNode = new FakeNode({
    className: "MessageText",
    textContent: "CHEBURCHAT:v1:msg:abc"
  });
  const incomingWrapper = new FakeNode({
    className: "ConvoMessageWithoutBubble__text"
  });
  const incomingRawTexts = [];

  const { triggerMutations } = await bootVkScript({
    href: "https://vk.com/im?sel=777",
    setupDom: (document) => {
      const article = appendChildren(
        new FakeNode({
          tagName: "article",
          className: "ConvoHistory__messageBlock ConvoHistory__messageBlock--withoutBubbles"
        }),
        appendChildren(incomingWrapper, incomingNode)
      );
      document.body.appendChild(article);
    },
    responder: (message) => {
      if (message.type === "mc:get-settings") {
        return { ok: true, settings: { warningThresholdChars: 1800 } };
      }
      if (message.type === "mc:get-chat-state") return { ok: false };
      if (message.type === "mc:process-incoming") {
        incomingRawTexts.push(String(message.payload?.rawText || ""));
        if (incomingRawTexts.length === 1) {
          return { ok: true, kind: "decrypt_failed", reason: "missing_contact_key" };
        }
        return { ok: true, kind: "decrypted", body: "Расшифровано", ts: "2026-03-20T00:00:00.000Z" };
      }
      return { ok: true };
    }
  });

  assert.deepEqual(incomingRawTexts, ["CHEBURCHAT:v1:msg:abc"]);
  assert.equal(incomingNode.dataset.mcProcessed, "decrypt_failed");
  assert.equal(incomingWrapper.dataset.mcProcessed, undefined);

  await triggerMutations(1, 180);

  assert.deepEqual(incomingRawTexts, ["CHEBURCHAT:v1:msg:abc", "CHEBURCHAT:v1:msg:abc"]);
  assert.equal(incomingNode.dataset.mcProcessed, "1");
  assert.equal(incomingWrapper.dataset.mcProcessed, undefined);
});

test("vk content script renders stale key announcement state from background result", async () => {
  const validText = buildKeyAnnouncementText({
    v: "v1",
    platform: "vk",
    accountId: "777",
    publicKeyArmored: "pub",
    fingerprint: "ABCD",
    displayName: "",
    sig: "sig"
  });
  const incomingNode = new FakeNode({
    className: "MessageText msg incoming",
    textContent: validText
  });

  await bootVkScript({
    href: "https://vk.com/im?sel=777",
    setupDom: (document) => {
      const article = appendChildren(
        new FakeNode({
          tagName: "article"
        }),
        incomingNode
      );
      document.body.appendChild(article);
    },
    responder: (message) => {
      if (message.type === "mc:get-settings") {
        return { ok: true, settings: { warningThresholdChars: 1800 } };
      }
      if (message.type === "mc:get-chat-state") return { ok: false };
      if (message.type === "mc:process-incoming") return { ok: true, kind: "key_ignored_stale" };
      return { ok: true };
    }
  });

  const overlay = incomingNode.parentElement.querySelector(".mc-overlay");
  assert.equal(overlay.textContent, "Устаревшее объявление ключа Чебурчат проигнорировано.");
  assert.match(overlay.className, /\bmc-message-system\b/);
  assert.match(overlay.className, /\bmc-message-warning\b/);
  assert.equal(incomingNode.style.display, "none");
});

test("vk content script renders invalid key message state from background result", async () => {
  const validText = buildKeyAnnouncementText({
    v: "v1",
    platform: "vk",
    accountId: "777",
    publicKeyArmored: "pub",
    fingerprint: "ABCD",
    displayName: "",
    sig: "sig"
  });
  const incomingNode = new FakeNode({
    className: "MessageText msg incoming",
    textContent: validText
  });

  await bootVkScript({
    href: "https://vk.com/im?sel=777",
    setupDom: (document) => {
      const article = appendChildren(
        new FakeNode({
          tagName: "article"
        }),
        incomingNode
      );
      document.body.appendChild(article);
    },
    responder: (message) => {
      if (message.type === "mc:get-settings") {
        return { ok: true, settings: { warningThresholdChars: 1800 } };
      }
      if (message.type === "mc:get-chat-state") return { ok: false };
      if (message.type === "mc:process-incoming") return { ok: true, kind: "invalid_key" };
      return { ok: true };
    }
  });

  const overlay = incomingNode.parentElement.querySelector(".mc-overlay");
  assert.equal(overlay.textContent, "Некорректное объявление ключа Чебурчат.");
  assert.match(overlay.className, /\bmc-message-error\b/);
  assert.equal(incomingNode.style.display, "none");
});

test("vk content script renders unsupported version message state from background result", async () => {
  const incomingNode = new FakeNode({
    className: "MessageText msg incoming",
    textContent: "CHEBURCHAT:v2:msg:abc"
  });

  await bootVkScript({
    href: "https://vk.com/im?sel=777",
    setupDom: (document) => {
      const article = appendChildren(
        new FakeNode({
          tagName: "article"
        }),
        incomingNode
      );
      document.body.appendChild(article);
    },
    responder: (message) => {
      if (message.type === "mc:get-settings") {
        return { ok: true, settings: { warningThresholdChars: 1800 } };
      }
      if (message.type === "mc:get-chat-state") return { ok: false };
      if (message.type === "mc:process-incoming") return { ok: true, kind: "unsupported_version" };
      return { ok: true };
    }
  });

  const overlay = incomingNode.parentElement.querySelector(".mc-overlay");
  assert.equal(overlay.textContent, "Неподдерживаемая версия сообщения Чебурчат. Обновите расширение.");
  assert.match(overlay.className, /\bmc-message-system\b/);
  assert.match(overlay.className, /\bmc-message-warning\b/);
  assert.equal(incomingNode.style.display, "none");
});

test("vk content script sends set-trust trusted when changed key is accepted from indicator", async () => {
  let sendButton = null;

  const { calls, confirms, createdNodes } = await bootVkScript({
    href: "https://vk.com/im?sel=321",
    setupDom: (document) => {
      const compose = new FakeNode({ tagName: "textarea", value: "" });
      const composeParent = appendChildren(new FakeNode(), compose);
      sendButton = new FakeNode({
        tagName: "button",
        attrs: { type: "submit", "aria-label": "Send", title: "Send" }
      });
      const sendParent = appendChildren(new FakeNode(), sendButton);
      document.body.appendChild(composeParent);
      document.body.appendChild(sendParent);
    },
    confirmSequence: [true],
    responder: (message) => {
      if (message.type === "mc:get-settings") {
        return { ok: true, settings: { warningThresholdChars: 1800 } };
      }
      if (message.type === "mc:get-chat-state") {
        return {
          ok: true,
          trustState: "changed",
          contact: {
            previousFingerprintFull: "OLD",
            fingerprintFull: "NEW",
            lastOwnKeyFingerprintShared: "OWNFP"
          }
        };
      }
      if (message.type === "mc:get-identity") {
        return { ok: true, identity: { fingerprintFull: "OWNFP" } };
      }
      if (message.type === "mc:set-trust") return { ok: true };
      return { ok: true };
    }
  });

  const indicator = createdNodes.find((node) => /\bmc-lock-indicator\b/.test(node.className));
  assert.ok(indicator, "expected lock indicator node to be created");
  indicator.dispatchEvent({
    type: "click",
    isTrusted: false,
    preventDefault() {}
  });
  await flushAsyncUiWork();
  assert.equal(calls.some((entry) => entry.type === "mc:set-trust"), false);

  await indicator.click();
  await flushAsyncUiWork();

  const setTrustCall = calls.find((entry) => entry.type === "mc:set-trust");
  assert.ok(setTrustCall, "expected mc:set-trust call");
  assert.deepEqual(setTrustCall.payload, {
    platform: "vk",
    accountId: "321",
    trustState: "trusted"
  });
  assert.ok(confirms.some((text) => /пометить контакт как доверенный/i.test(text)));
  assert.ok(sendButton, "expected send button to be created");
});

test("vk content script sends set-trust trusted when known key is accepted from indicator", async () => {
  let sendButton = null;

  const { calls, confirms, alerts, createdNodes } = await bootVkScript({
    href: "https://vk.com/im?sel=321",
    setupDom: (document) => {
      const compose = new FakeNode({ tagName: "textarea", value: "" });
      const composeParent = appendChildren(new FakeNode(), compose);
      sendButton = new FakeNode({
        tagName: "button",
        attrs: { type: "submit", "aria-label": "Send", title: "Send" }
      });
      const sendParent = appendChildren(new FakeNode(), sendButton);
      document.body.appendChild(composeParent);
      document.body.appendChild(sendParent);
    },
    confirmSequence: [true],
    responder: (message) => {
      if (message.type === "mc:get-settings") {
        return { ok: true, settings: { warningThresholdChars: 1800 } };
      }
      if (message.type === "mc:get-chat-state") {
        return {
          ok: true,
          trustState: "new",
          contact: {
            fingerprintFull: "ABCD",
            lastOwnKeyFingerprintShared: "LOCAL"
          }
        };
      }
      if (message.type === "mc:get-identity") {
        return { ok: true, identity: { fingerprintFull: "LOCAL" } };
      }
      if (message.type === "mc:set-trust") return { ok: true, contact: { trustState: "trusted" } };
      return { ok: true };
    }
  });

  const indicator = createdNodes.find((node) => /\bmc-lock-indicator\b/.test(node.className));
  assert.ok(indicator, "expected lock indicator node to be created");
  assert.equal(indicator.textContent, "Проверить ключ");
  assert.match(indicator.className, /\bmc-lock-ready\b/);
  assert.ok(/не проверен|найден/i.test(indicator.title || ""));
  assert.ok(/Отпечаток ключа/i.test(indicator.title || ""));
  assert.ok(sendButton, "expected native send button to be created");
  assert.doesNotMatch(sendButton.className, /\bmc-send-encrypted\b/);
  assert.equal(sendButton.getAttribute("aria-label"), "Send");
  await indicator.click();
  await flushAsyncUiWork();

  const setTrustCall = calls.find((entry) => entry.type === "mc:set-trust");
  assert.ok(setTrustCall, "expected mc:set-trust call");
  assert.equal(setTrustCall.payload.trustState, "trusted");
  assert.ok(confirms.some((text) => /Отпечаток ключа/i.test(text)));
  assert.equal(alerts.length, 0);
});

test("vk content indicator for new contact shares our key before promoting trust", async () => {
  let compose = null;
  let article = null;
  const selfAnnouncementText = buildKeyAnnouncementText({
    v: "v1",
    platform: "vk",
    accountId: "100",
    publicKeyArmored: "self-pub",
    fingerprint: "LOCAL",
    displayName: "",
    sig: "self-sig"
  });
  const selfAnnouncementNode = new FakeNode({
    className: "MessageText msg outgoing",
    textContent: selfAnnouncementText
  });

  const { calls, alerts, createdNodes, triggerMutations } = await bootVkScript({
    href: "https://vk.com/im?sel=329",
    vkId: "100",
    setupDom: (document) => {
      article = new FakeNode({ tagName: "article" });
      compose = new FakeNode({ tagName: "textarea", value: "" });
      const composeParent = appendChildren(new FakeNode(), compose);
      const sendButton = new FakeNode({
        tagName: "button",
        attrs: { type: "submit", "aria-label": "Send", title: "Send" }
      });
      const sendParent = appendChildren(new FakeNode(), sendButton);
      document.body.appendChild(article);
      document.body.appendChild(composeParent);
      document.body.appendChild(sendParent);
    },
    confirmSequence: [true],
    responder: (message) => {
      if (message.type === "mc:get-settings") {
        return { ok: true, settings: { warningThresholdChars: 1800 } };
      }
      if (message.type === "mc:get-chat-state") {
        return {
          ok: true,
          trustState: "new",
          contact: {
            fingerprintFull: "ABCD"
          }
        };
      }
      if (message.type === "mc:get-identity") {
        return { ok: true, identity: { fingerprintFull: "LOCAL" } };
      }
      if (message.type === "mc:create-key-announcement") {
        return { ok: true, text: selfAnnouncementText };
      }
      if (message.type === "mc:mark-own-key-shared") {
        return { ok: true, contact: {} };
      }
      if (
        message.type === "mc:process-incoming" &&
        (message.payload?.rawText === selfAnnouncementText ||
          message.payload?.rawText === selfAnnouncementText.split("\n")[1])
      ) {
        return { ok: true, kind: "key_self_announcement" };
      }
      if (message.type === "mc:set-trust") {
        return { ok: true, contact: { trustState: "trusted" } };
      }
      return { ok: true };
    }
  });

  const indicator = createdNodes.find((node) => /\bmc-lock-indicator\b/.test(node.className));
  assert.ok(indicator, "expected lock indicator node to be created");

  await indicator.click();
  await flushAsyncUiWork();

  assert.equal(compose.value, selfAnnouncementText);
  assert.equal(calls.some((entry) => entry.type === "mc:create-key-announcement"), true);
  assert.equal(calls.some((entry) => entry.type === "mc:set-trust"), false);
  assert.equal(calls.some((entry) => entry.type === "mc:mark-own-key-shared"), false);
  assert.equal(alerts.length, 0);

  article.appendChild(selfAnnouncementNode);
  await triggerMutations();

  const markOwnKeySharedCall = calls.find((entry) => entry.type === "mc:mark-own-key-shared");
  assert.ok(markOwnKeySharedCall, "expected mc:mark-own-key-shared call");
  assert.equal(calls.some((entry) => entry.type === "mc:set-trust"), false);
});

test("vk content script shows custom encrypted send control and hides native button for trusted contact", async () => {
  let sendButton = null;

  const { calls, alerts, createdNodes } = await bootVkScript({
    href: "https://vk.com/im?sel=321",
    setupDom: (document) => {
      const compose = new FakeNode({ tagName: "textarea", value: "" });
      const composeParent = appendChildren(new FakeNode(), compose);
      sendButton = new FakeNode({
        tagName: "button",
        attrs: { type: "submit", "aria-label": "Send", title: "Send" }
      });
      const sendParent = appendChildren(new FakeNode(), sendButton);
      document.body.appendChild(composeParent);
      document.body.appendChild(sendParent);
    },
    responder: (message) => {
      if (message.type === "mc:get-settings") {
        return { ok: true, settings: { warningThresholdChars: 1800 } };
      }
      if (message.type === "mc:get-chat-state") {
        return {
          ok: true,
          trustState: "trusted",
          contact: {
            fingerprintFull: "ABCD"
          }
        };
      }
      return { ok: true };
    }
  });

  const indicator = createdNodes.find((node) => /\bmc-lock-indicator\b/.test(node.className));
  assert.ok(indicator, "expected lock indicator node to be created");
  assert.equal(indicator.textContent, "Отправить");
  assert.ok(sendButton, "expected native send button to be created");
  assert.match(sendButton.className, /\bmc-send-native-hidden\b/);
  assert.ok(/Нажмите, чтобы отправить сообщение/i.test(indicator.getAttribute("title") || indicator.title || ""));
  assert.equal(calls.some((entry) => entry.type === "mc:set-trust"), false);
  assert.equal(alerts.length, 0);
});

test("vk content script sends encrypted message from custom trusted control", async () => {
  let compose = null;
  let sendButton = null;

  const { calls, alerts, createdNodes } = await bootVkScript({
    href: "https://vk.com/im?sel=326",
    setupDom: (document) => {
      compose = new FakeNode({ tagName: "textarea", value: "hello" });
      const composeParent = appendChildren(new FakeNode(), compose);
      sendButton = new FakeNode({
        tagName: "button",
        attrs: { type: "submit", "aria-label": "Send", title: "Send" },
        dataset: {}
      });
      const sendParent = appendChildren(new FakeNode(), sendButton);
      document.body.appendChild(composeParent);
      document.body.appendChild(sendParent);
    },
    responder: (message) => {
      if (message.type === "mc:get-settings") {
        return { ok: true, settings: { warningThresholdChars: 1800 } };
      }
      if (message.type === "mc:get-chat-state") {
        return {
          ok: true,
          trustState: "trusted",
          contact: {
            fingerprintFull: "ABCD"
          }
        };
      }
      if (message.type === "mc:process-outgoing") {
        return { ok: true, mode: "encrypted", text: "CHEBURCHAT:v1:msg:test" };
      }
      return { ok: true };
    }
  });

  const indicator = createdNodes.find((node) => /\bmc-lock-indicator\b/.test(node.className));
  assert.ok(indicator, "expected lock indicator node to be created");
  assert.ok(sendButton, "expected native send button to be created");
  assert.equal(indicator.textContent, "Отправить");
  assert.match(sendButton.className, /\bmc-send-native-hidden\b/);

  await indicator.click();
  await flushAsyncUiWork();

  const outgoingCall = calls.find((entry) => entry.type === "mc:process-outgoing");
  assert.ok(outgoingCall, "expected mc:process-outgoing call");
  assert.equal(compose.value, "CHEBURCHAT:v1:msg:test");
  assert.equal(alerts.length, 0);
});

test("vk content script blocks encryption send interception for changed trust state", async () => {
  let sendButton = null;

  const { calls } = await bootVkScript({
    href: "https://vk.com/im?sel=322",
    setupDom: (document) => {
      const compose = new FakeNode({ tagName: "textarea", value: "hello" });
      const composeParent = appendChildren(new FakeNode(), compose);
      sendButton = new FakeNode({
        tagName: "button",
        attrs: { type: "submit" },
        dataset: {}
      });
      const sendParent = appendChildren(new FakeNode(), sendButton);
      document.body.appendChild(composeParent);
      document.body.appendChild(sendParent);
    },
    responder: (message) => {
      if (message.type === "mc:get-settings") {
        return { ok: true, settings: { warningThresholdChars: 1800 } };
      }
      if (message.type === "mc:get-chat-state") {
        return { ok: true, trustState: "changed", contact: {} };
      }
      return { ok: true };
    }
  });

  assert.ok(sendButton, "expected send button to be created");
  await sendButton.click();
  await flushAsyncUiWork();
  assert.equal(calls.some((entry) => entry.type === "mc:process-outgoing"), false);
});

test("vk content script does not style microphone action button", async () => {
  let micButton = null;

  await bootVkScript({
    href: "https://vk.com/im?sel=324",
    setupDom: (document) => {
      const compose = new FakeNode({ tagName: "textarea", value: "" });
      const composeParent = appendChildren(new FakeNode({ className: "ConvoComposer" }), compose);
      micButton = new FakeNode({
        tagName: "button",
        className: "ConvoComposer__button ConvoComposer__sendButton--mic",
        attrs: { "aria-label": "Записать голосовое сообщение", title: "Записать голосовое сообщение" },
        dataset: {}
      });
      composeParent.appendChild(micButton);
      document.body.appendChild(composeParent);
    },
    responder: (message) => {
      if (message.type === "mc:get-settings") {
        return { ok: true, settings: { warningThresholdChars: 1800 } };
      }
      if (message.type === "mc:get-chat-state") {
        return { ok: true, trustState: "new", contact: { publicKeyArmored: "pub" } };
      }
      return { ok: true };
    }
  });

  assert.ok(micButton, "expected microphone button to be created");
  assert.doesNotMatch(micButton.className, /\bmc-send-encrypted\b/);
  assert.equal(micButton.getAttribute("aria-label"), "Записать голосовое сообщение");
});

test("vk content script keeps trusted custom send visible when VK action button falls back to microphone", async () => {
  let actionButton = null;

  const { createdNodes } = await bootVkScript({
    href: "https://vk.com/im?sel=327",
    setupDom: (document) => {
      const compose = new FakeNode({ tagName: "textarea", value: "" });
      const composeParent = appendChildren(new FakeNode({ className: "ConvoComposer" }), compose);
      actionButton = new FakeNode({
        tagName: "button",
        className: "ConvoComposer__button ConvoComposer__sendButton--mic",
        attrs: { "aria-label": "Отправить сообщение", title: "Отправить сообщение" },
        dataset: {}
      });
      composeParent.appendChild(actionButton);
      document.body.appendChild(composeParent);
    },
    responder: (message) => {
      if (message.type === "mc:get-settings") {
        return { ok: true, settings: { warningThresholdChars: 1800 } };
      }
      if (message.type === "mc:get-chat-state") {
        return {
          ok: true,
          trustState: "trusted",
          contact: {
            fingerprintFull: "ABCD"
          }
        };
      }
      return { ok: true };
    }
  });

  const indicator = createdNodes.find((node) => /\bmc-lock-indicator\b/.test(node.className));
  assert.ok(indicator, "expected lock indicator node to be created");
  assert.equal(indicator.textContent, "Отправить");
  assert.doesNotMatch(indicator.className, /\bmc-send-native-hidden\b/);
  assert.ok(actionButton, "expected action button to be created");
  assert.doesNotMatch(actionButton.className, /\bmc-send-native-hidden\b/);
});

test("vk content script keeps native submit button plain after mic switches to send on input for known contact", async () => {
  let compose = null;
  let actionButton = null;

  await bootVkScript({
    href: "https://vk.com/im?sel=325",
    setupDom: (document) => {
      compose = new FakeNode({ tagName: "textarea", value: "" });
      const composeParent = appendChildren(new FakeNode({ className: "ConvoComposer" }), compose);
      actionButton = new FakeNode({
        tagName: "button",
        className: "ConvoComposer__button ConvoComposer__sendButton--mic",
        attrs: { "aria-label": "Записать голосовое сообщение", title: "Записать голосовое сообщение" },
        dataset: {}
      });
      composeParent.appendChild(actionButton);
      document.body.appendChild(composeParent);
    },
    responder: (message) => {
      if (message.type === "mc:get-settings") {
        return { ok: true, settings: { warningThresholdChars: 1800 } };
      }
      if (message.type === "mc:get-chat-state") {
        return { ok: true, trustState: "new", contact: { publicKeyArmored: "pub" } };
      }
      return { ok: true };
    }
  });

  assert.ok(compose, "expected compose to be created");
  assert.ok(actionButton, "expected action button to be created");
  assert.doesNotMatch(actionButton.className, /\bmc-send-encrypted\b/);

  actionButton.className = "ConvoComposer__button ConvoComposer__sendButton--submit";
  actionButton.setAttribute("aria-label", "Отправить");
  compose.value = "hello";
  compose.dispatchEvent({ type: "input" });

  assert.doesNotMatch(actionButton.className, /\bmc-send-encrypted\b/);
  assert.equal(actionButton.getAttribute("aria-label"), "Отправить");
});

test("vk content script does not intercept native send or Enter for new contact", async () => {
  let compose = null;
  let sendButton = null;

  const { calls } = await bootVkScript({
    href: "https://vk.com/im?sel=328",
    setupDom: (document) => {
      compose = new FakeNode({ tagName: "textarea", value: "hello" });
      const composeParent = appendChildren(new FakeNode(), compose);
      sendButton = new FakeNode({
        tagName: "button",
        attrs: { type: "submit", "aria-label": "Send", title: "Send" },
        dataset: {}
      });
      const sendParent = appendChildren(new FakeNode(), sendButton);
      document.body.appendChild(composeParent);
      document.body.appendChild(sendParent);
    },
    responder: (message) => {
      if (message.type === "mc:get-settings") {
        return { ok: true, settings: { warningThresholdChars: 1800 } };
      }
      if (message.type === "mc:get-chat-state") {
        return { ok: true, trustState: "new", contact: { publicKeyArmored: "pub", fingerprintFull: "ABCD" } };
      }
      if (message.type === "mc:process-outgoing") {
        return { ok: true, mode: "encrypted", text: "CHEBURCHAT:v1:msg:test" };
      }
      return { ok: true };
    }
  });

  assert.ok(sendButton, "expected send button to be created");
  await sendButton.click();
  await flushAsyncUiWork();
  compose.dispatchEvent({
    type: "keydown",
    key: "Enter",
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    isComposing: false,
    preventDefault() {},
    stopImmediatePropagation() {}
  });
  await flushAsyncUiWork();

  assert.equal(calls.some((entry) => entry.type === "mc:process-outgoing"), false);
  assert.equal(compose.value, "hello");
});

test("vk content script intercepts Enter and runs encrypted outgoing flow only for trusted contact", async () => {
  let compose = null;

  const { calls } = await bootVkScript({
    href: "https://vk.com/im?sel=323",
    setupDom: (document) => {
      compose = new FakeNode({ tagName: "textarea", value: "hello" });
      const composeParent = appendChildren(new FakeNode(), compose);
      const sendButton = new FakeNode({
        tagName: "button",
        attrs: { type: "submit" },
        dataset: {}
      });
      const sendParent = appendChildren(new FakeNode(), sendButton);
      document.body.appendChild(composeParent);
      document.body.appendChild(sendParent);
    },
    responder: (message) => {
      if (message.type === "mc:get-settings") {
        return { ok: true, settings: { warningThresholdChars: 1800 } };
      }
      if (message.type === "mc:get-chat-state") {
        return { ok: true, trustState: "trusted", contact: { publicKeyArmored: "pub", fingerprintFull: "ABCD" } };
      }
      if (message.type === "mc:process-outgoing") {
        return { ok: true, mode: "encrypted", text: "CHEBURCHAT:v1:msg:test" };
      }
      return { ok: true };
    }
  });

  assert.ok(compose, "expected compose to be created");
  compose.dispatchEvent({
    type: "keydown",
    key: "Enter",
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    isComposing: false,
    preventDefault() {},
    stopImmediatePropagation() {}
  });
  await flushAsyncUiWork();

  const outgoingCall = calls.find((entry) => entry.type === "mc:process-outgoing");
  assert.ok(outgoingCall, "expected mc:process-outgoing call");
  assert.equal(compose.value, "CHEBURCHAT:v1:msg:test");
});

test("vk content script does not wire encrypted flow for non-direct dialogs", async () => {
  let sendButton = null;

  const { calls } = await bootVkScript({
    href: "https://vk.com/im?sel=-200",
    setupDom: (document) => {
      const compose = new FakeNode({ tagName: "textarea", value: "hello" });
      const composeParent = appendChildren(new FakeNode(), compose);
      sendButton = new FakeNode({
        tagName: "button",
        attrs: { type: "submit" },
        dataset: {}
      });
      const sendParent = appendChildren(new FakeNode(), sendButton);
      document.body.appendChild(composeParent);
      document.body.appendChild(sendParent);
    },
    responder: () => ({ ok: true })
  });

  assert.ok(sendButton, "expected send button to be created");
  await sendButton.click();
  await flushAsyncUiWork();
  assert.equal(calls.some((entry) => entry.type === "mc:get-chat-state"), false);
  assert.equal(calls.some((entry) => entry.type === "mc:process-outgoing"), false);
});

test("vk content indicator prompts setup when identity is missing", async () => {
  const { calls, opened, alerts, createdNodes } = await bootVkScript({
    href: "https://vk.com/im?sel=333",
    vkId: "100",
    setupDom: (document) => {
      const compose = new FakeNode({ tagName: "textarea", value: "" });
      const composeParent = appendChildren(new FakeNode(), compose);
      const sendButton = new FakeNode({
        tagName: "button",
        attrs: { type: "submit" },
        dataset: {}
      });
      const sendParent = appendChildren(new FakeNode(), sendButton);
      document.body.appendChild(composeParent);
      document.body.appendChild(sendParent);
    },
    confirmSequence: [true],
    responder: (message) => {
      if (message.type === "mc:get-settings") {
        return { ok: true, settings: { warningThresholdChars: 1800 } };
      }
      if (message.type === "mc:get-chat-state") {
        return { ok: true, trustState: "missing", contact: {} };
      }
      if (message.type === "mc:get-identity") {
        return { ok: true, identity: null };
      }
      if (message.type === "mc:open-popup") {
        return { ok: true };
      }
      return { ok: true };
    }
  });

  const indicator = createdNodes.find((node) => /\bmc-lock-indicator\b/.test(node.className));
  assert.ok(indicator, "expected lock indicator node to be created");
  await indicator.click();
  await flushAsyncUiWork();

  assert.equal(calls.some((entry) => entry.type === "mc:get-identity"), true);
  assert.equal(calls.some((entry) => entry.type === "mc:create-key-announcement"), false);
  assert.equal(calls.some((entry) => entry.type === "mc:open-popup"), true);
  assert.equal(opened.length, 0);
  assert.equal(alerts.length, 0);
});

test("vk content shows inline popup CTA when key announcement arrives before local setup", async () => {
  const incomingNode = new FakeNode({
    className: "MessageText msg incoming",
    textContent: "CHEBURCHAT:v1:key:abc"
  });

  const { calls, triggerMutations } = await bootVkScript({
    href: "https://vk.com/im?sel=777",
    setupDom: (document) => {
      const article = appendChildren(
        new FakeNode({
          tagName: "article"
        }),
        incomingNode
      );
      document.body.appendChild(article);
    },
    responder: (message) => {
      if (message.type === "mc:get-settings") {
        return { ok: true, settings: { warningThresholdChars: 1800 } };
      }
      if (message.type === "mc:get-chat-state") return { ok: false };
      if (message.type === "mc:process-incoming") {
        return { ok: true, kind: "identity_missing" };
      }
      if (message.type === "mc:open-popup") {
        return { ok: true };
      }
      return { ok: true };
    }
  });

  await triggerMutations(1, 180);

  const overlay = incomingNode.parentElement.querySelector(".mc-overlay");
  assert.ok(overlay, "expected identity setup overlay");
  assert.match(overlay.textContent, /создайте или импортируйте свой ключ/i);

  const actionButton = incomingNode.parentElement.querySelector(".mc-inline-action-button");
  assert.ok(actionButton, "expected setup CTA button");
  assert.equal(actionButton.textContent, "Создать ключ");

  await actionButton.click();
  await flushAsyncUiWork();

  assert.equal(calls.some((entry) => entry.type === "mc:open-popup"), true);
});
