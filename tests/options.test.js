import assert from "node:assert/strict";
import test from "node:test";

class FakeElement {
  constructor({ value = "", textContent = "", className = "" } = {}) {
    this.value = value;
    this.textContent = textContent;
    this.className = className;
    this.style = {};
    this.listeners = new Map();
    this.children = [];
  }

  appendChild(node) {
    this.children.push(node);
    return node;
  }

  removeChild(node) {
    const index = this.children.indexOf(node);
    if (index >= 0) this.children.splice(index, 1);
    return node;
  }

  set innerHTML(_value) {
    this.children = [];
    this.textContent = "";
  }

  get innerHTML() {
    return "";
  }

  addEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  async click() {
    const list = this.listeners.get("click") || [];
    for (const listener of list) {
      await listener();
    }
  }
}

function createElements({ includeDebugControls = false, includeContactsControls = false } = {}) {
  const elements = {
    "#message": new FakeElement(),
    "#identity-status": new FakeElement(),
    "#fingerprint-short-output": new FakeElement(),
    "#fingerprint-full-output": new FakeElement(),
    "#public-key-output": new FakeElement(),
    "#private-key-input": new FakeElement(),
    "#create-identity": new FakeElement(),
    "#refresh-identity": new FakeElement(),
    "#import-identity": new FakeElement(),
    "#copy-fingerprint-short": new FakeElement(),
    "#copy-fingerprint-full": new FakeElement(),
    "#copy-public-key": new FakeElement(),
    "#download-private-key": new FakeElement()
  };

  if (includeDebugControls) {
    elements["#debug-mode-toggle"] = new FakeElement();
    elements["#save-debug-mode"] = new FakeElement();
    elements["#warning-threshold-input"] = new FakeElement();
    elements["#save-warning-threshold"] = new FakeElement();
  }

  if (includeContactsControls) {
    elements["#contacts-list"] = new FakeElement();
    elements["#refresh-contacts"] = new FakeElement();
  }

  return elements;
}

function createDocument(elements) {
  const bodyChildren = [];
  return {
    body: {
      appendChild(node) {
        bodyChildren.push(node);
      },
      removeChild(node) {
        const index = bodyChildren.indexOf(node);
        if (index >= 0) bodyChildren.splice(index, 1);
      }
    },
    createElement(_tag) {
      const node = new FakeElement();
      node.focus = () => {};
      node.select = () => {};
      return node;
    },
    execCommand(_name) {
      return true;
    },
    querySelector(selector) {
      const node = elements[selector];
      if (!node) throw new Error(`Missing fake node for selector: ${selector}`);
      return node;
    }
  };
}

async function bootOptions({ responder, confirmResult = true, includeDebugControls = false, includeContactsControls = false } = {}) {
  const elements = createElements({ includeDebugControls, includeContactsControls });
  const calls = [];
  const opened = [];
  const createdTabs = [];

  globalThis.document = createDocument(elements);
  globalThis.window = {
    confirm: () => confirmResult,
    alert: () => {},
    open: (...args) => {
      opened.push(args);
      return null;
    }
  };
  globalThis.chrome = {
    tabs: {
      async create(details) {
        createdTabs.push(details);
        return details;
      }
    },
    runtime: {
      async sendMessage(message) {
        calls.push(message);
        if (!responder) return { ok: true };
        return responder(message, calls);
      }
    }
  };

  const moduleUrl = new URL("../src/options/options.js", import.meta.url);
  await import(`${moduleUrl.href}?t=${Date.now()}-${Math.random()}`);
  await new Promise((resolve) => setTimeout(resolve, 0));

  return { elements, calls, opened, createdTabs };
}

test.afterEach(() => {
  delete globalThis.document;
  delete globalThis.window;
  delete globalThis.chrome;
});

test("initial refresh shows empty identity state when identity is missing", async () => {
  const { elements, calls } = await bootOptions({
    responder: (message) => {
      if (message.type === "mc:get-identity") return { ok: true, identity: null };
      throw new Error(`Unexpected message: ${message.type}`);
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, "mc:get-identity");
  assert.equal(elements["#create-identity"].textContent, "Создать ключ");
  assert.equal(elements["#public-key-output"].value, "");
  assert.equal(elements["#fingerprint-short-output"].value, "");
  assert.equal(elements["#fingerprint-full-output"].value, "");
});

test("create identity triggers init and refreshes displayed identity", async () => {
  const createdIdentity = {
    fingerprintShort: "ABCD EF01 2345",
    fingerprintFull: "ABCDEF0123456789ABCDEF0123456789ABCDEF01",
    publicKeyArmored: "PUBLIC"
  };
  let identity = null;

  const { elements, calls } = await bootOptions({
    responder: (message) => {
      if (message.type === "mc:get-identity") return { ok: true, identity };
      if (message.type === "mc:init-identity") {
        identity = createdIdentity;
        return { ok: true, identity: createdIdentity };
      }
      throw new Error(`Unexpected message: ${message.type}`);
    }
  });

  await elements["#create-identity"].click();

  assert.deepEqual(
    calls.map((entry) => entry.type),
    ["mc:get-identity", "mc:init-identity", "mc:get-identity"]
  );
  assert.equal(elements["#message"].textContent, "Ключ шифрования создан.");
  assert.equal(elements["#message"].style.color, "#0d5a20");
  assert.equal(elements["#create-identity"].textContent, "Заменить ключ");
  assert.equal(elements["#public-key-output"].value, "PUBLIC");
  assert.equal(elements["#fingerprint-short-output"].value, "ABCD EF01 2345");
  assert.equal(elements["#fingerprint-full-output"].value, "ABCD EF01 2345 6789 ABCD EF01 2345 6789 ABCD EF01");
});

test("create identity is canceled by confirmation when identity already exists", async () => {
  const existingIdentity = {
    fingerprintShort: "AAAA BBBB CCCC",
    fingerprintFull: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    publicKeyArmored: "PUB"
  };

  const { elements, calls } = await bootOptions({
    confirmResult: false,
    responder: (message) => {
      if (message.type === "mc:get-identity") return { ok: true, identity: existingIdentity };
      if (message.type === "mc:init-identity") throw new Error("mc:init-identity should not be called");
      throw new Error(`Unexpected message: ${message.type}`);
    }
  });

  await elements["#create-identity"].click();

  assert.deepEqual(
    calls.map((entry) => entry.type),
    ["mc:get-identity"]
  );
});

test("private key export fetches secret only after explicit download action", async () => {
  const identity = {
    fingerprintShort: "AAAA BBBB CCCC",
    fingerprintFull: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    publicKeyArmored: "PUB"
  };
  const { elements, calls } = await bootOptions({
    responder: (message) => {
      if (message.type === "mc:get-identity") return { ok: true, identity };
      if (message.type === "mc:get-private-key") return { ok: true, privateKeyArmored: "PRIVATE" };
      throw new Error(`Unexpected message: ${message.type}`);
    }
  });

  assert.deepEqual(calls.map((entry) => entry.type), ["mc:get-identity"]);
  await elements["#download-private-key"].click();

  assert.deepEqual(calls.map((entry) => entry.type), ["mc:get-identity", "mc:get-private-key"]);
  assert.equal(elements["#message"].textContent, "Приватный ключ сохранён в файл.");
});

test("import identity validates private key input before sending request", async () => {
  const { elements, calls } = await bootOptions({
    responder: (message) => {
      if (message.type === "mc:get-identity") return { ok: true, identity: null };
      throw new Error(`Unexpected message: ${message.type}`);
    }
  });

  elements["#private-key-input"].value = "   ";
  await elements["#import-identity"].click();

  assert.deepEqual(
    calls.map((entry) => entry.type),
    ["mc:get-identity"]
  );
  assert.equal(elements["#message"].textContent, "Требуется приватный ключ.");
  assert.equal(elements["#message"].style.color, "#8f1f1f");
});

test("debug toggle loads current setting on init when controls exist", async () => {
  const { elements, calls } = await bootOptions({
    includeDebugControls: true,
    responder: (message) => {
      if (message.type === "mc:get-identity") return { ok: true, identity: null };
      if (message.type === "mc:get-settings") {
        return { ok: true, settings: { debugMode: true, warningThresholdChars: 1900 } };
      }
      throw new Error(`Unexpected message: ${message.type}`);
    }
  });

  assert.deepEqual(
    calls.map((entry) => entry.type),
    ["mc:get-identity", "mc:get-settings"]
  );
  assert.equal(elements["#debug-mode-toggle"].checked, true);
  assert.equal(elements["#warning-threshold-input"].value, "1900");
});

test("saving debug toggle sends mc:set-debug-mode and reports success", async () => {
  const { elements, calls } = await bootOptions({
    includeDebugControls: true,
    responder: (message) => {
      if (message.type === "mc:get-identity") return { ok: true, identity: null };
      if (message.type === "mc:get-settings") return { ok: true, settings: { debugMode: false } };
      if (message.type === "mc:set-debug-mode") {
        assert.equal(message.payload.debugMode, true);
        return { ok: true, settings: { debugMode: true } };
      }
      throw new Error(`Unexpected message: ${message.type}`);
    }
  });

  elements["#debug-mode-toggle"].checked = true;
  await elements["#save-debug-mode"].click();

  assert.deepEqual(
    calls.map((entry) => entry.type),
    ["mc:get-identity", "mc:get-settings", "mc:set-debug-mode"]
  );
  assert.equal(elements["#message"].textContent, "Режим отладки включен.");
  assert.equal(elements["#message"].style.color, "#0d5a20");
});

test("saving warning threshold sends mc:set-warning-threshold and reports success", async () => {
  const { elements, calls } = await bootOptions({
    includeDebugControls: true,
    responder: (message) => {
      if (message.type === "mc:get-identity") return { ok: true, identity: null };
      if (message.type === "mc:get-settings") return { ok: true, settings: { debugMode: false, warningThresholdChars: 1800 } };
      if (message.type === "mc:set-warning-threshold") {
        assert.equal(message.payload.warningThresholdChars, 1500);
        return { ok: true, settings: { warningThresholdChars: 1500 } };
      }
      throw new Error(`Unexpected message: ${message.type}`);
    }
  });

  elements["#warning-threshold-input"].value = "1500";
  await elements["#save-warning-threshold"].click();

  assert.deepEqual(
    calls.map((entry) => entry.type),
    ["mc:get-identity", "mc:get-settings", "mc:set-warning-threshold"]
  );
  assert.equal(elements["#warning-threshold-input"].value, "1500");
  assert.equal(elements["#message"].textContent, "Порог предупреждения сохранен.");
  assert.equal(elements["#message"].style.color, "#0d5a20");
});

test("contacts list renders stored contacts from options", async () => {
  const { elements, calls } = await bootOptions({
    includeContactsControls: true,
    responder: (message) => {
      if (message.type === "mc:get-identity") return { ok: true, identity: null };
      if (message.type === "mc:list-contacts") {
        return {
          ok: true,
          contacts: [
            {
              platform: "vk",
              accountId: "200",
              displayName: "Алиса",
              trustState: "trusted",
              fingerprintShort: "ABCD EF01 2345"
            }
          ]
        };
      }
      throw new Error(`Unexpected message: ${message.type}`);
    }
  });

  assert.deepEqual(
    calls.map((entry) => entry.type),
    ["mc:get-identity", "mc:list-contacts"]
  );
  assert.equal(elements["#contacts-list"].children.length, 1);
  assert.equal(elements["#contacts-list"].children[0].children[0].textContent, "Алиса (vk:200) — trusted — ABCD EF01 2345");
  assert.equal(elements["#contacts-list"].children[0].children[1].children[0].textContent, "Поделиться ключом");
  assert.equal(elements["#contacts-list"].children[0].children[1].children[1].textContent, "Удалить");
});

test("contact removal from options calls remove-contact and refreshes list", async () => {
  let removed = false;
  const { elements, calls } = await bootOptions({
    includeContactsControls: true,
    responder: (message) => {
      if (message.type === "mc:get-identity") return { ok: true, identity: null };
      if (message.type === "mc:list-contacts") {
        return {
          ok: true,
          contacts: removed
            ? []
            : [
                {
                  platform: "vk",
                  accountId: "200",
                  displayName: "Алиса",
                  trustState: "new"
                }
              ]
        };
      }
      if (message.type === "mc:remove-contact") {
        removed = true;
        assert.deepEqual(message.payload, { platform: "vk", accountId: "200" });
        return { ok: true };
      }
      throw new Error(`Unexpected message: ${message.type}`);
    }
  });

  const row = elements["#contacts-list"].children[0];
  const removeButton = row.children[1].children[1];
  await removeButton.click();

  assert.deepEqual(
    calls.map((entry) => entry.type),
    ["mc:get-identity", "mc:list-contacts", "mc:remove-contact", "mc:list-contacts"]
  );
  assert.equal(elements["#contacts-list"].textContent, "Нет сохраненных контактов.");
  assert.equal(elements["#message"].textContent, "Контакт Алиса удален.");
  assert.equal(elements["#message"].style.color, "#0d5a20");
});

test("contact share from options requests internal one-time share flow", async () => {
  const { elements, calls, opened, createdTabs } = await bootOptions({
    includeContactsControls: true,
    responder: (message) => {
      if (message.type === "mc:get-identity") {
        return {
          ok: true,
          identity: {
            fingerprintShort: "ABCD EF01 2345",
            fingerprintFull: "ABCDEF0123456789ABCDEF0123456789ABCDEF01",
            publicKeyArmored: "PUBLIC"
          }
        };
      }
      if (message.type === "mc:list-contacts") {
        return {
          ok: true,
          contacts: [
            {
              platform: "vk",
              accountId: "200",
              displayName: "Алиса",
              trustState: "trusted"
            }
          ]
        };
      }
      if (message.type === "mc:open-key-share-dialog") {
        assert.deepEqual(message.payload, { platform: "vk", accountId: "200" });
        return { ok: true };
      }
      throw new Error(`Unexpected message: ${message.type}`);
    }
  });

  const row = elements["#contacts-list"].children[0];
  const shareButton = row.children[1].children[0];
  await shareButton.click();

  assert.deepEqual(
    calls.map((entry) => entry.type),
    ["mc:get-identity", "mc:list-contacts", "mc:open-key-share-dialog"]
  );
  assert.deepEqual(createdTabs, []);
  assert.deepEqual(opened, []);
  assert.equal(
    elements["#message"].textContent,
    "Открываю диалог с контактом Алиса. Публичный ключ будет отправлен автоматически."
  );
  assert.equal(elements["#message"].style.color, "#0d5a20");
});
