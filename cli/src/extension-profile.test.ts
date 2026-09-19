import assert from "node:assert/strict";
import { test } from "node:test";
import { CHAT_EXCLUDED, CORE_ALWAYS_ON, filterExtensionsByProfile, filterManagedExtensions } from "./extension-profile.js";

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

test("Electron empty allowed ids retain only safety, auto-title and sandbox", () => {
  const extensions = [
    { name: "safety" },
    { name: "auto-title" },
    { name: "sandbox" },
    { name: "goal", manifest: { id: "goal" } },
    { name: "code-exec" },
  ];
  assert.deepEqual(filterManagedExtensions(extensions, '[]'), extensions.slice(0, 3));
});

test("Electron allowlist keeps product-core extensions and still drops heavy tools", () => {
  const extensions = [
    { name: "safety" },
    { name: "approval" },
    { name: "multi-agent" },
    { name: "todo" },
    { name: "web-fetch" },
    { name: "goal", manifest: { id: "goal" } },
    { name: "mcp", manifest: { id: "mcp" } },
    { name: "code-exec" },
    { name: "lsp" },
  ];
  const loaded = filterManagedExtensions(extensions, '["goal"]');
  assert.deepEqual(
    loaded.map((e) => e.name),
    ["safety", "approval", "multi-agent", "todo", "web-fetch", "goal"],
  );
});

test("product core and chat-excluded sets do not overlap", () => {
  for (const name of CORE_ALWAYS_ON) {
    assert.equal(CHAT_EXCLUDED.has(name), false, `${name} cannot be both core and chat-excluded`);
  }
});
