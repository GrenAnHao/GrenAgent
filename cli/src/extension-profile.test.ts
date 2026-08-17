import assert from "node:assert/strict";
import { test } from "node:test";
import { CHAT_EXCLUDED, filterExtensionsByProfile } from "./extension-profile.js";

const has = (arr: { name: string }[], n: string) => arr.some((e) => e.name === n);

const all = [
  { name: "safety" },
  { name: "approval" },
  { name: "agent-mode" },
  { name: "lsp" },
  { name: "dap" },
  { name: "tencentdb-memory" },
];

test("project profile keeps everything", () => {
  assert.equal(filterExtensionsByProfile(all, "project").length, all.length);
});

test("chat profile drops heavy code extensions but keeps chat-relevant ones", () => {
  const chat = filterExtensionsByProfile(all, "chat");
  assert.equal(has(chat, "safety"), true);
  assert.equal(has(chat, "approval"), true);
  assert.equal(has(chat, "agent-mode"), true);
  assert.equal(has(chat, "tencentdb-memory"), true);
  assert.equal(has(chat, "lsp"), false);
  assert.equal(has(chat, "dap"), false);
});

test("safety is never in the exclusion set", () => {
  assert.equal(CHAT_EXCLUDED.has("safety"), false);
});
