import assert from "node:assert/strict";
import { test } from "node:test";
import { CHAT_EXCLUDED, filterExtensionsByProfile, filterManagedExtensions } from "./extension-profile.js";

const has = (arr: { name: string }[], n: string) => arr.some((e) => e.name === n);

const all = [
  { name: "safety" },
  { name: "approval" },
  { name: "agent-mode" },
  { name: "lsp" },
  { name: "dap" },
  { name: "memory" },
];

test("project profile keeps everything", () => {
  assert.equal(filterExtensionsByProfile(all, "project").length, all.length);
});

test("chat profile drops heavy code extensions but keeps chat-relevant ones", () => {
  const chat = filterExtensionsByProfile(all, "chat");
  assert.equal(has(chat, "safety"), true);
  assert.equal(has(chat, "approval"), true);
  assert.equal(has(chat, "agent-mode"), true);
  assert.equal(has(chat, "memory"), true);
  assert.equal(has(chat, "lsp"), false);
  assert.equal(has(chat, "dap"), false);
});

test("safety is never in the exclusion set", () => {
  assert.equal(CHAT_EXCLUDED.has("safety"), false);
});

test("Electron allowed ids only filter managed plugins", () => {
  const extensions = [
    { name: "safety" },
    { name: "goal", manifest: { id: "goal" } },
    { name: "mcp", manifest: { id: "mcp" } },
  ];
  assert.deepEqual(filterManagedExtensions(extensions, '["goal"]'), [extensions[0], extensions[1]]);
});

test("Electron allowed ids retain auto-title without enabling other unmanaged extensions", () => {
  const extensions = [
    { name: "safety" },
    { name: "auto-title" },
    { name: "goal", manifest: { id: "goal" } },
    { name: "mcp", manifest: { id: "mcp" } },
    { name: "code-exec" },
  ];
  assert.deepEqual(filterManagedExtensions(extensions, '["goal"]'), extensions.slice(0, 3));
});

test("Electron empty allowed ids retain only safety and auto-title", () => {
  const extensions = [
    { name: "safety" },
    { name: "auto-title" },
    { name: "goal", manifest: { id: "goal" } },
    { name: "code-exec" },
  ];
  assert.deepEqual(filterManagedExtensions(extensions, '[]'), extensions.slice(0, 2));
});
