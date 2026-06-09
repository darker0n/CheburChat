import assert from "node:assert/strict";
import test from "node:test";

await import("../src/content/vk_pure.js");

const vkPure = globalThis.__CHEBURCHAT_VK_PURE__;
const {
  parseSelToken,
  parseSelFromParams,
  parseDialogFromPath,
  parseAccountIdFromHref,
  parseOwnAccountIdFromNavHref,
  parseDialogFromHref,
  guessMessageAuthorAccountIdFromClass
} = vkPure;

test("vk pure helpers are registered on global scope", () => {
  assert.ok(vkPure);
});

test("parseSelToken parses valid selectors and rejects invalid values", () => {
  assert.equal(parseSelToken("123"), "123");
  assert.equal(parseSelToken(" sel=123 "), "123");
  assert.equal(parseSelToken("c123"), "123");
  assert.equal(parseSelToken("sel=c123"), "123");
  assert.equal(parseSelToken("-7"), "-7");
  assert.equal(parseSelToken("not-a-number"), "");
  assert.equal(parseSelToken(""), "");
});

test("parseSelToken safely handles malformed URI encoding", () => {
  assert.equal(parseSelToken("%E0%A4%A"), "");
});

test("parseSelFromParams finds sel in hash/query-like input", () => {
  assert.equal(parseSelFromParams("#sel=321"), "321");
  assert.equal(parseSelFromParams("?a=1&sel=c42&b=2"), "42");
  assert.equal(parseSelFromParams("#a=1&b=2"), "");
});

test("parseDialogFromPath matches known VK routes", () => {
  assert.equal(parseDialogFromPath("/im/convo/999"), "999");
  assert.equal(parseDialogFromPath("/im/-15"), "-15");
  assert.equal(parseDialogFromPath("/messages/77"), "77");
  assert.equal(parseDialogFromPath("/feed"), "");
});

test("parseAccountIdFromHref extracts vk id links", () => {
  assert.equal(parseAccountIdFromHref("/id123"), "123");
  assert.equal(parseAccountIdFromHref("https://vk.com/id456?z=1"), "456");
  assert.equal(parseAccountIdFromHref("https://example.com/u/12"), "");
});

test("parseOwnAccountIdFromNavHref reads own id from nav sections, not from /id links", () => {
  assert.equal(parseOwnAccountIdFromNavHref("/photos568343076"), "568343076");
  assert.equal(parseOwnAccountIdFromNavHref("/audios568343076"), "568343076");
  assert.equal(parseOwnAccountIdFromNavHref("https://vk.com/photos42?rev=1"), "42");
  // bare /id links can be a stranger's profile in chat — never a local-id source
  assert.equal(parseOwnAccountIdFromNavHref("/id100"), "");
  assert.equal(parseOwnAccountIdFromNavHref("https://vk.com/id999"), "");
  // single-photo / album links must not false-match
  assert.equal(parseOwnAccountIdFromNavHref("/photo123_456"), "");
  assert.equal(parseOwnAccountIdFromNavHref(""), "");
});

test("parseDialogFromHref supports sel, convo path, and profile id fallback", () => {
  assert.equal(parseDialogFromHref("/im?sel=c42"), "42");
  assert.equal(parseDialogFromHref("https://vk.com/im/convo/999"), "999");
  assert.equal(parseDialogFromHref("/id123"), "123");
  assert.equal(parseDialogFromHref(""), "");
});

test("guessMessageAuthorAccountIdFromClass returns local id for outgoing class tokens", () => {
  assert.equal(guessMessageAuthorAccountIdFromClass("msg out", "100", "200"), "100");
  assert.equal(guessMessageAuthorAccountIdFromClass("my message", "100", "200"), "100");
  assert.equal(guessMessageAuthorAccountIdFromClass("bubble self selected", "100", "200"), "100");
  assert.equal(
    guessMessageAuthorAccountIdFromClass("ConvoMessage ConvoMessage--out", "100", "200"),
    "100"
  );
  assert.equal(
    guessMessageAuthorAccountIdFromClass("im-mess outgoing", "100", "200"),
    "100"
  );
  assert.equal(
    guessMessageAuthorAccountIdFromClass("msg incoming", "100", "200", "/id999"),
    "999"
  );
});

test("guessMessageAuthorAccountIdFromClass falls back to dialog id for non-outgoing nodes", () => {
  assert.equal(guessMessageAuthorAccountIdFromClass("msg incoming", "100", "200"), "200");
  assert.equal(guessMessageAuthorAccountIdFromClass("msg out", "", "200"), "200");
  assert.equal(guessMessageAuthorAccountIdFromClass("msg\\sout", "100", "200"), "200");
});
