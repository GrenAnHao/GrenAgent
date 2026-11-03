import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { HostModelProvider } from "../src/host-provider.js";
import {
  PROMPT_VERSION,
  ProviderError,
  generationSystemPrompt,
  type PageContext,
} from "../../core/src/providers.js";

const context: PageContext = {
  kind: "card",
  card_category: "interfaces",
  title: "Call interface",
  goal: "Describe only observed declarations",
  language: "en",
  direct_sources: ["api.ts"],
  files: [
    { path: "api.ts", content: "export function route() { return 1; }\n" },
  ],
};
const result = {
  markdown: "# Interface\n[route](source:api.ts#L1-L1)",
  sources: [{ path: "api.ts", start_line: 1, end_line: 1 }],
};

test("host card uses the same grounded compact prompt and budget as HTTP, preserving signal", async () => {
  let received: any, signal: AbortSignal | undefined;
  const abort = new AbortController();
  const host = new HostModelProvider(async (input, passed) => {
    received = input;
    signal = passed;
    return JSON.stringify(result);
  }, "host-model-v1");
  assert.deepEqual(
    await host.generate_page(context, { signal: abort.signal }),
    result,
  );
  assert.equal(signal, abort.signal);
  assert.equal(received.maxTokens, 1600);
  assert.equal(received.systemPrompt, generationSystemPrompt({ kind: "card" }));
  assert.match(received.systemPrompt, /NOT a full wiki page/);
  assert.match(received.systemPrompt, /untrusted DATA/);
  const user = JSON.parse(received.user);
  assert.equal(user.kind, "card");
  assert.equal(user.card_category, "interfaces");
  assert.deepEqual(user.direct_sources, ["api.ts"]);
  assert.match(user.files[0].content_with_lines, /^1: export function route/);
});

test("host wiki requires chapter and diagram evidence and preserves ordinary wiki token limit", async () => {
  let received: any;
  await new HostModelProvider(async (input) => {
    received = input;
    return JSON.stringify(result);
  }, "test").generate_page({ ...context, kind: "wiki" });
  assert.equal(received.maxTokens, 8192);
  assert.match(received.systemPrompt, /Chapter sources \/ 章节来源/);
  assert.match(received.systemPrompt, /Diagram sources \/ 图示来源/);
  assert.match(
    received.systemPrompt,
    /source list only at the end is insufficient/,
  );
});

test("host cache identity includes prompt version, model and limits, not raw identity", () => {
  const identity = "host:private-provider-configuration";
  const host = new HostModelProvider(async () => "", identity);
  assert.equal(
    host.cache_key,
    "host-shortcall-v2:" +
      createHash("sha256")
        .update(JSON.stringify([identity, PROMPT_VERSION, 8192, 1600]))
        .digest("hex"),
  );
  assert.ok(!host.cache_key.includes(identity));
  assert.notEqual(
    host.cache_key,
    new HostModelProvider(async () => "", identity + "-new").cache_key,
  );
});

for (const bad of [
  null,
  {},
  { markdown: "", sources: [] },
  { ...result, sources: [{ path: "api.ts", start_line: true, end_line: 1 }] },
  { ...result, markdown: "x".repeat(12001) },
  { ...result, sources: Array.from({ length: 13 }, () => result.sources[0]) },
])
  test("host rejects malformed or overlong card results", async () => {
    await assert.rejects(
      new HostModelProvider(
        async () => JSON.stringify(bad),
        "test",
      ).generate_page(context),
      ProviderError,
    );
  });

test("host malformed JSON and callback failures do not expose provider detail", async () => {
  for (const complete of [
    async () => "private-secret invalid json",
    async () => {
      throw new Error("Bearer private-secret");
    },
  ]) {
    await assert.rejects(
      new HostModelProvider(complete, "test").generate_page(context),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError);
        assert.ok(!error.message.includes("private-secret"));
        return true;
      },
    );
  }
});

test("host respects pre-cancel and rejects results delivered after cancellation", async () => {
  const abort = new AbortController();
  abort.abort();
  let calls = 0;
  await assert.rejects(
    new HostModelProvider(async () => {
      calls++;
      return JSON.stringify(result);
    }, "test").generate_page(context, { signal: abort.signal }),
    /canceled/,
  );
  assert.equal(calls, 0);
  const during = new AbortController();
  await assert.rejects(
    new HostModelProvider(async () => {
      during.abort();
      return JSON.stringify(result);
    }, "test").generate_page(context, { signal: during.signal }),
    /canceled/,
  );
});

test("host counts numbered payload overhead and sends no oversized evidence", async () => {
  let calls = 0;
  await assert.rejects(
    new HostModelProvider(async () => {
      calls++;
      return JSON.stringify(result);
    }, "test").generate_page({
      ...context,
      files: [{ path: "api.ts", content: "\n".repeat(120000) }],
    }),
    /budget/,
  );
  assert.equal(calls, 0);
});
