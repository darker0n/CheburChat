import assert from "node:assert/strict";
import test from "node:test";

// Fake DOM tailored to what popup.js touches: getElementById/querySelectorAll,
// classList, hidden, replaceChildren, append/appendChild, createElement, click.

class FakeClassList {
  constructor(element) {
    this.element = element;
    this.tokens = new Set(String(element.className || "").split(/\s+/).filter(Boolean));
  }

  _sync() {
    this.element._className = [...this.tokens].join(" ");
  }

  add(token) {
    this.tokens.add(token);
    this._sync();
  }

  remove(token) {
    this.tokens.delete(token);
    this._sync();
  }

  contains(token) {
    return this.tokens.has(token);
  }
}

class FakeElement {
  constructor(tag = "div", { id = "" } = {}) {
    this.tag = tag;
    this.id = id;
    this._className = "";
    this.textContent = "";
    this.value = "";
    this.type = "";
    this.href = "";
    this.download = "";
    this.hidden = false;
    this.style = {};
    this.listeners = new Map();
    this.children = [];
    this.files = [];
    this._innerHTML = "";
  }

  get className() {
    return this._className;
  }

  set className(value) {
    this._className = String(value || "");
  }

  get classList() {
    return new FakeClassList(this);
  }

  set innerHTML(value) {
    this._innerHTML = String(value || "");
    this.children = [];
  }

  get innerHTML() {
    return this._innerHTML;
  }

  appendChild(node) {
    this.children.push(node);
    return node;
  }

  append(...nodes) {
    for (const node of nodes) this.children.push(node);
  }

  replaceChildren(...nodes) {
    this.children = [...nodes];
  }

  removeChild(node) {
    const index = this.children.indexOf(node);
    if (index >= 0) this.children.splice(index, 1);
    return node;
  }

  addEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  async dispatch(type, event) {
    const list = this.listeners.get(type) || [];
    for (const listener of list) await listener(event);
  }

  async click() {
    await this.dispatch("click");
  }
}

// Every id popup.js / popup.html references via getElementById.
const ELEMENT_IDS = [
  "view-loading",
  "view-load-error",
  "view-onboarding",
  "view-backup",
  "view-main",
  "view-contact",
  "view-import",
  "view-feedback",
  "load-error-msg",
  "retry-btn",
  "onboarding-create",
  "onboarding-import",
  "backup-key",
  "backup-copy",
  "backup-download",
  "backup-ack",
  "fp-value",
  "fp-copy",
  "contacts-list",
  "contacts-count",
  "contacts-empty",
  "open-settings",
  "contact-back",
  "contact-name",
  "contact-acct",
  "contact-trust",
  "contact-fp",
  "contact-fp-label",
  "contact-prev-block",
  "contact-prev-fp",
  "contact-actions",
  "import-back",
  "import-text",
  "import-file",
  "import-file-label",
  "import-submit",
  "fb-mark",
  "fb-title",
  "fb-msg",
  "fb-back"
];

// ids that are .view sections, used to satisfy querySelectorAll(".view").
const VIEW_IDS = [
  "view-loading",
  "view-load-error",
  "view-onboarding",
  "view-backup",
  "view-main",
  "view-contact",
  "view-import",
  "view-feedback"
];

function createDocument() {
  const byId = new Map();
  for (const id of ELEMENT_IDS) {
    const el = new FakeElement("div", { id });
    if (VIEW_IDS.includes(id)) el.className = id === "view-loading" ? "view active" : "view";
    byId.set(id, el);
  }

  const bodyChildren = [];
  return {
    _byId: byId,
    body: {
      appendChild(node) {
        bodyChildren.push(node);
      },
      removeChild(node) {
        const index = bodyChildren.indexOf(node);
        if (index >= 0) bodyChildren.splice(index, 1);
      }
    },
    getElementById(id) {
      return byId.get(id) || null;
    },
    querySelectorAll(selector) {
      if (selector === ".view") return VIEW_IDS.map((id) => byId.get(id));
      return [];
    },
    createElement(tag) {
      const node = new FakeElement(tag);
      node.focus = () => {};
      node.select = () => {};
      return node;
    },
    execCommand() {
      return true;
    }
  };
}

function activeViewId(document) {
  return VIEW_IDS.find((id) => document.getElementById(id).classList.contains("active")) || null;
}

async function bootPopup({ responder, confirmResult = true } = {}) {
  const document = createDocument();
  const calls = [];
  const openedTabs = [];

  globalThis.document = document;
  globalThis.confirm = () => confirmResult;
  // navigator is a getter-only accessor on globalThis in Node; override via defineProperty.
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: { writeText: async () => {} } },
    configurable: true,
    writable: true
  });
  globalThis.chrome = {
    runtime: {
      openOptionsPage() {},
      async sendMessage(message) {
        calls.push(message);
        if (!responder) return { ok: true };
        return responder(message, calls);
      }
    },
    tabs: {
      async create(details) {
        openedTabs.push(details);
        return details;
      }
    }
  };

  const moduleUrl = new URL("../src/popup/popup.js", import.meta.url);
  await import(`${moduleUrl.href}?t=${Date.now()}-${Math.random()}`);
  // bootstrap() runs on import; let its async Promise.all chain settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setImmediate(resolve));

  return {
    document,
    calls,
    openedTabs,
    $: (id) => document.getElementById(id),
    active: () => activeViewId(document)
  };
}

test.afterEach(() => {
  delete globalThis.document;
  delete globalThis.confirm;
  delete globalThis.navigator;
  delete globalThis.chrome;
});

// ---------- 1. effectiveTrustState unit cases ----------

test("effectiveTrustState classifies missing/changed/trusted/new/rejected", async () => {
  await bootPopup({
    responder: (message) => {
      if (message.type === "mc:get-identity") return { ok: true, identity: null };
      if (message.type === "mc:list-contacts") return { ok: true, contacts: [] };
      if (message.type === "mc:get-settings") return { ok: true, settings: {} };
      throw new Error(`Unexpected message: ${message.type}`);
    }
  });

  const { effectiveTrustState } = await import(
    `${new URL("../src/popup/popup.js", import.meta.url).href}?probe=${Date.now()}-${Math.random()}`
  );

  assert.equal(effectiveTrustState({}), "missing");
  assert.equal(effectiveTrustState({ publicKeyArmored: "" }), "missing");
  assert.equal(
    effectiveTrustState({ publicKeyArmored: "PUB", hasKeyConflict: true, trustState: "trusted" }),
    "changed"
  );
  assert.equal(effectiveTrustState({ publicKeyArmored: "PUB", trustState: "trusted" }), "trusted");
  assert.equal(effectiveTrustState({ publicKeyArmored: "PUB", trustState: "rejected" }), "rejected");
  assert.equal(effectiveTrustState({ publicKeyArmored: "PUB", trustState: "changed" }), "changed");
  assert.equal(effectiveTrustState({ publicKeyArmored: "PUB", trustState: "new" }), "new");
  assert.equal(effectiveTrustState({ publicKeyArmored: "PUB" }), "new");
});

// ---------- 2. Bootstrap routing ----------

test("bootstrap routes to onboarding when no identity exists", async () => {
  const { active, calls } = await bootPopup({
    responder: (message) => {
      if (message.type === "mc:get-identity") return { ok: true, identity: null };
      if (message.type === "mc:list-contacts") return { ok: true, contacts: [] };
      if (message.type === "mc:get-settings") return { ok: true, settings: {} };
      throw new Error(`Unexpected message: ${message.type}`);
    }
  });

  assert.deepEqual(
    calls.map((c) => c.type).sort(),
    ["mc:get-identity", "mc:get-settings", "mc:list-contacts"]
  );
  assert.equal(active(), "view-onboarding");
});

test("bootstrap routes to backup when needsBackupAcknowledgement is set", async () => {
  const { active, calls } = await bootPopup({
    responder: (message) => {
      if (message.type === "mc:get-identity") {
        return { ok: true, identity: { fingerprintFull: "ABCDEF0123456789ABCDEF0123456789ABCDEF01" } };
      }
      if (message.type === "mc:list-contacts") return { ok: true, contacts: [] };
      if (message.type === "mc:get-settings") return { ok: true, settings: { needsBackupAcknowledgement: true } };
      if (message.type === "mc:get-private-key") return { ok: true, privateKeyArmored: "PRIV_KEY" };
      throw new Error(`Unexpected message: ${message.type}`);
    }
  });

  assert.ok(calls.some((c) => c.type === "mc:get-private-key"));
  assert.equal(active(), "view-backup");
});

test("bootstrap routes to main with contacts when identity exists and no backup pending", async () => {
  const { active, $ } = await bootPopup({
    responder: (message) => {
      if (message.type === "mc:get-identity") {
        return { ok: true, identity: { fingerprintFull: "ABCDEF0123456789ABCDEF0123456789ABCDEF01" } };
      }
      if (message.type === "mc:list-contacts") {
        return {
          ok: true,
          contacts: [
            {
              platform: "vk",
              accountId: "200",
              displayName: "Алиса",
              publicKeyArmored: "PUB",
              trustState: "trusted",
              fingerprintFull: "BEEFBEEFBEEFBEEFBEEFBEEFBEEFBEEFBEEFBEEF"
            }
          ]
        };
      }
      if (message.type === "mc:get-settings") return { ok: true, settings: { needsBackupAcknowledgement: false } };
      throw new Error(`Unexpected message: ${message.type}`);
    }
  });

  assert.equal(active(), "view-main");
  assert.equal($("contacts-count").textContent, "1");
  assert.equal($("contacts-list").children.length, 1);
});

test("bootstrap routes to load-error when any response is not ok", async () => {
  const { active, $ } = await bootPopup({
    responder: (message) => {
      if (message.type === "mc:get-identity") return { ok: true, identity: null };
      if (message.type === "mc:list-contacts") return { ok: false, error: "boom" };
      if (message.type === "mc:get-settings") return { ok: true, settings: {} };
      throw new Error(`Unexpected message: ${message.type}`);
    }
  });

  assert.equal(active(), "view-load-error");
  assert.equal($("load-error-msg").textContent, "Не удалось загрузить данные расширения.");
});

// ---------- 3. Main render ----------

test("main render shows short fingerprint, filters missing contacts, counts visible", async () => {
  const { $ } = await bootPopup({
    responder: (message) => {
      if (message.type === "mc:get-identity") {
        return { ok: true, identity: { fingerprintFull: "ABCDEF0123456789ABCDEF0123456789ABCDEF01" } };
      }
      if (message.type === "mc:list-contacts") {
        return {
          ok: true,
          contacts: [
            {
              platform: "vk",
              accountId: "1",
              displayName: "Withkey",
              publicKeyArmored: "PUB",
              trustState: "trusted",
              fingerprintFull: "1111111111111111111111111111111111111111"
            },
            {
              // no publicKeyArmored => effective trust missing => excluded
              platform: "vk",
              accountId: "2",
              displayName: "Nokey",
              trustState: "new"
            }
          ]
        };
      }
      if (message.type === "mc:get-settings") return { ok: true, settings: {} };
      throw new Error(`Unexpected message: ${message.type}`);
    }
  });

  // formatShortFingerprint takes first 12 chars formatted in groups of 4.
  assert.equal($("fp-value").textContent, "ABCD EF01 2345");
  assert.equal($("contacts-count").textContent, "1");
  assert.equal($("contacts-list").children.length, 1);
  assert.equal($("contacts-empty").hidden, true);
  assert.equal($("contacts-list").hidden, false);
});

test("main render shows empty state when no visible contacts", async () => {
  const { $ } = await bootPopup({
    responder: (message) => {
      if (message.type === "mc:get-identity") {
        return { ok: true, identity: { fingerprintFull: "ABCDEF0123456789ABCDEF0123456789ABCDEF01" } };
      }
      if (message.type === "mc:list-contacts") return { ok: true, contacts: [] };
      if (message.type === "mc:get-settings") return { ok: true, settings: {} };
      throw new Error(`Unexpected message: ${message.type}`);
    }
  });

  assert.equal($("contacts-count").textContent, "0");
  assert.equal($("contacts-empty").hidden, false);
  assert.equal($("contacts-list").hidden, true);
});

// ---------- 4. Create flow ----------

test("create flow inits identity and shows backup with private key", async () => {
  const { active, $, calls } = await bootPopup({
    responder: (message) => {
      if (message.type === "mc:get-identity") return { ok: true, identity: null };
      if (message.type === "mc:list-contacts") return { ok: true, contacts: [] };
      if (message.type === "mc:get-settings") return { ok: true, settings: {} };
      if (message.type === "mc:init-identity") {
        return {
          ok: true,
          identity: {
            fingerprintFull: "ABCDEF0123456789ABCDEF0123456789ABCDEF01",
            privateKeyArmored: "NEW_PRIVATE_KEY"
          }
        };
      }
      throw new Error(`Unexpected message: ${message.type}`);
    }
  });

  await $("onboarding-create").click();

  assert.ok(calls.some((c) => c.type === "mc:init-identity"));
  assert.equal(active(), "view-backup");
  assert.equal($("backup-key").value, "NEW_PRIVATE_KEY");
});

// ---------- 5. Backup acknowledgement ----------

test("backup ack sends mc:set-backup-acknowledged and routes to main", async () => {
  const { active, $, calls } = await bootPopup({
    responder: (message) => {
      if (message.type === "mc:get-identity") {
        return { ok: true, identity: { fingerprintFull: "ABCDEF0123456789ABCDEF0123456789ABCDEF01" } };
      }
      if (message.type === "mc:list-contacts") return { ok: true, contacts: [] };
      if (message.type === "mc:get-settings") return { ok: true, settings: { needsBackupAcknowledgement: true } };
      if (message.type === "mc:get-private-key") return { ok: true, privateKeyArmored: "PRIV_KEY" };
      if (message.type === "mc:set-backup-acknowledged") {
        return { ok: true, settings: { needsBackupAcknowledgement: false } };
      }
      throw new Error(`Unexpected message: ${message.type}`);
    }
  });

  assert.equal(active(), "view-backup");
  await $("backup-ack").click();

  const ackCall = calls.find((c) => c.type === "mc:set-backup-acknowledged");
  assert.ok(ackCall, "mc:set-backup-acknowledged was sent");
  assert.deepEqual(ackCall.payload, { acknowledged: true });
  assert.equal(active(), "view-main");
});

// ---------- 6. Import (text) ----------

test("import via text sends mc:import-identity and routes to main", async () => {
  let imported = false;
  const { active, $, calls } = await bootPopup({
    responder: (message) => {
      if (message.type === "mc:get-identity") {
        return imported
          ? { ok: true, identity: { fingerprintFull: "ABCDEF0123456789ABCDEF0123456789ABCDEF01" } }
          : { ok: true, identity: null };
      }
      if (message.type === "mc:list-contacts") return { ok: true, contacts: [] };
      if (message.type === "mc:get-settings") return { ok: true, settings: {} };
      if (message.type === "mc:import-identity") {
        imported = true;
        assert.equal(message.payload.privateKeyArmored, "PASTED_KEY");
        return { ok: true, identity: { fingerprintFull: "ABCDEF0123456789ABCDEF0123456789ABCDEF01" } };
      }
      throw new Error(`Unexpected message: ${message.type}`);
    }
  });

  await $("onboarding-import").click();
  assert.equal(active(), "view-import");

  $("import-text").value = "PASTED_KEY";
  await $("import-submit").click();

  assert.ok(calls.some((c) => c.type === "mc:import-identity"));
  assert.equal(active(), "view-main");
});

// ---------- 7. Contact detail + trust action ----------

test("opening a new contact renders verify action that sends mc:set-trust trusted", async () => {
  const newContact = {
    platform: "vk",
    accountId: "200",
    displayName: "Алиса",
    publicKeyArmored: "PUB",
    trustState: "new",
    fingerprintFull: "BEEFBEEFBEEFBEEFBEEFBEEFBEEFBEEFBEEFBEEF"
  };

  const { active, $, calls } = await bootPopup({
    responder: (message) => {
      if (message.type === "mc:get-identity") {
        return { ok: true, identity: { fingerprintFull: "ABCDEF0123456789ABCDEF0123456789ABCDEF01" } };
      }
      if (message.type === "mc:list-contacts") return { ok: true, contacts: [newContact] };
      if (message.type === "mc:get-settings") return { ok: true, settings: {} };
      if (message.type === "mc:set-trust") {
        return { ok: true, contact: { ...newContact, trustState: "trusted" } };
      }
      throw new Error(`Unexpected message: ${message.type}`);
    }
  });

  assert.equal(active(), "view-main");
  const row = $("contacts-list").children[0];
  await row.click();

  assert.equal(active(), "view-contact");
  assert.equal($("contact-name").textContent, "Алиса");
  assert.equal($("contact-acct").textContent, "vk:200");
  assert.equal($("contact-trust").textContent, "Не проверен");

  const actionLabels = $("contact-actions").children.map((b) => b.textContent);
  assert.deepEqual(actionLabels, [
    "Проверил отпечаток",
    "Поделиться ключом",
    "Открыть диалог",
    "Отклонить"
  ]);

  const verifyButton = $("contact-actions").children[0];
  await verifyButton.click();

  const trustCall = calls.find((c) => c.type === "mc:set-trust");
  assert.ok(trustCall, "mc:set-trust was sent");
  assert.deepEqual(trustCall.payload, { platform: "vk", accountId: "200", trustState: "trusted" });
});
