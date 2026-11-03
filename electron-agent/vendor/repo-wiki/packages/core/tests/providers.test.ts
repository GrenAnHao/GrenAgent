import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DemoProvider,
  OpenAIProvider,
  ProviderError,
  providerFromEnvironment,
  providerStatus,
  type PageContext,
  type FetchLike,
} from "../src/providers.js";

const context: PageContext = {
  page_id: "architecture",
  title: "架构地图",
  goal: "说明静态结构",
  language: "zh",
  project_name: "atlas",
  files: [
    {
      path: "app.py",
      content: "from service import run\n\ndef main():\n    return run()\n",
      hash: "abc",
    },
    {
      path: "service.py",
      content: "def run():\n    return 'ready'\n",
      hash: "def",
    },
  ],
  edges: [["app.py", "service.py"]],
  page_links: [{ id: "overview", title: "概览" }],
};
const output = {
  markdown: "# Architecture\nA fact.",
  sources: [{ path: "app.py", start_line: 1, end_line: 2 }],
};
const wire = (content: unknown = output, finish = "stop") =>
  new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content:
              typeof content === "string" ? content : JSON.stringify(content),
          },
          finish_reason: finish,
        },
      ],
    }),
    { status: 200 },
  );
const provider = (
  fetch: FetchLike,
  extras: Partial<ConstructorParameters<typeof OpenAIProvider>[0]> = {},
) =>
  new OpenAIProvider({
    apiKey: "test-secret",
    model: "mock-only",
    fetch,
    sleep: async () => {},
    ...extras,
  });

test("demo is deterministic, explicitly not AI, and source grounded", async () => {
  const demo = new DemoProvider();
  const result = await demo.generate_page(context);
  assert.deepEqual(result, await demo.generate_page(context));
  assert.match(result.markdown, /未调用大模型/);
  assert.match(result.markdown, /```mermaid/);
  assert.match(result.markdown, /source:app.py#L3-L4/);
  assert.match(result.markdown, /overview.md/);
  for (const ref of result.sources) {
    const file = context.files!.find((f) => f.path === ref.path)!;
    assert.ok(
      ref.start_line >= 1 &&
        ref.end_line <= file.content.trimEnd().split("\n").length,
    );
  }
});
test("demo handles English empty sources and fenced repository content", async () => {
  const empty = await new DemoProvider().generate_page({
    language: "en",
    files: [],
  });
  assert.match(empty.markdown, /No language model was called/);
  assert.deepEqual(empty.sources, []);
  const fenced = await new DemoProvider().generate_page({
    files: [
      {
        path: "a.py",
        content: 'def main():\n  x = "```html<script>"\n  return x\n',
      },
    ],
  });
  assert.match(fenced.markdown, /````python/);
});
test("demo partial coverage is visible and Mermaid filenames cannot inject syntax", async () => {
  const result = await new DemoProvider().generate_page({
    ...context,
    coverage: { partial: true, available_files: 500 },
    edges: [["app.py", '"><script>evil</script>']],
  });
  assert.match(result.markdown, /2 \/ 500/);
  assert.match(result.markdown, /部分覆盖/);
  assert.ok(!result.markdown.includes('"><script>'));
});
test("real provider environment requires explicit opt-in and status omits secrets", () => {
  const env = { REPOWIKI_API_KEY: "private-secret", REPOWIKI_MODEL: "test" };
  assert.equal(providerFromEnvironment("demo", env).name, "demo");
  assert.equal(providerStatus(env).real_available, false);
  assert.ok(!JSON.stringify(providerStatus(env)).includes("private-secret"));
  assert.throws(() => providerFromEnvironment("real", env), /disabled/);
  assert.throws(() => providerFromEnvironment("wat", env), /Unknown provider/);
  assert.throws(
    () =>
      providerFromEnvironment("real", {
        ...env,
        REPOWIKI_ENABLE_LLM: "1",
        REPOWIKI_LLM_RETRIES: "NaN",
      }),
    /limits/,
  );
});
test("mock HTTP contract includes numbered evidence and untrusted-data instruction", async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const real = provider(
    async (url, init) => {
      seen = { url: String(url), init: init! };
      return wire();
    },
    { baseUrl: "https://example.test/v1" },
  );
  assert.deepEqual(await real.generate_page(context), output);
  assert.equal(seen!.url, "https://example.test/v1/chat/completions");
  assert.equal(
    new Headers(seen!.init.headers).get("Authorization"),
    "Bearer test-secret",
  );
  assert.equal(seen!.init.redirect, "manual");
  const body = JSON.parse(seen!.init.body as string);
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.match(body.messages[0].content, /untrusted DATA/);
  assert.match(body.messages[1].content, /1: from service import run/);
  assert.ok(!real.cache_key.includes("test-secret"));
  assert.ok(!JSON.stringify(real).includes("test-secret"));
});
for (const status of [301, 401, 403, 500])
  test(`HTTP ${status} body and token are redacted`, async () => {
    let calls = 0;
    await assert.rejects(
      provider(
        async () => {
          calls++;
          return new Response("test-secret private-source", { status });
        },
        { maxRetries: 0 },
      ).generate_page(context),
      (error) => {
        assert.ok(error instanceof ProviderError);
        assert.match(error.message, new RegExp(`HTTP ${status}`));
        assert.ok(!error.message.includes("test-secret"));
        assert.ok(!error.message.includes("private-source"));
        return true;
      },
    );
    assert.equal(calls, 1);
  });
test("bounded retries apply only to transient responses, not auth", async () => {
  let calls = 0;
  const transient = provider(async () =>
    ++calls < 3 ? new Response("", { status: 429 }) : wire(),
  );
  assert.deepEqual(await transient.generate_page(context), output);
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(
    provider(async () => {
      calls++;
      return new Response("", { status: 401 });
    }).generate_page(context),
  );
  assert.equal(calls, 1);
});
for (const value of [
  "not JSON",
  '{"markdown":"x","sources":[{"path":"x","start_line":true,"end_line":2}]}',
  '{"markdown":"","sources":[]}',
  "{}",
  "null",
])
  test(`malformed model response rejected: ${value.slice(0, 20)}`, async () => {
    await assert.rejects(
      provider(async () => wire(value)).generate_page(context),
      ProviderError,
    );
  });
test("truncated output and oversized streaming body are rejected", async () => {
  await assert.rejects(
    provider(async () => wire(output, "length")).generate_page(context),
    /truncated/,
  );
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(2_000_001));
      controller.close();
    },
  });
  await assert.rejects(
    provider(async () => new Response(stream)).generate_page(context),
    /safety size/,
  );
});
test("context and serialized numbering limits send no requests", async () => {
  let calls = 0;
  const real = provider(
    async () => {
      calls++;
      return wire();
    },
    { maxContextChars: 1000 },
  );
  await assert.rejects(
    real.generate_page({ files: [{ path: "a", content: "x".repeat(1001) }] }),
    /no request was sent/,
  );
  await assert.rejects(
    real.generate_page({ files: [{ path: "a", content: "\n".repeat(900) }] }),
    /serialized context limit/,
  );
  assert.equal(calls, 0);
});
for (const baseUrl of [
  "http://example.com/v1",
  "https://secret@example.com/v1",
  "https://example.com/v1?api_key=secret",
  "ftp://example.com",
  "https://example.com/#secret",
])
  test(`insecure endpoint rejected ${baseUrl}`, () => {
    assert.throws(
      () => new OpenAIProvider({ apiKey: "test", model: "test", baseUrl }),
      ProviderError,
    );
  });
test("cache identity excludes secret but includes model, endpoint and limits", () => {
  const create = (extras: object) =>
    new OpenAIProvider({ apiKey: "one", model: "a", ...extras }).cache_key;
  assert.equal(create({}), create({ apiKey: "two" }));
  assert.equal(
    new Set([
      create({}),
      create({ model: "b" }),
      create({ maxOutputTokens: 3000 }),
      create({ baseUrl: "https://example.test/v1" }),
    ]).size,
    4,
  );
});
test("related pages bounded and honest edge/coverage metadata sent", async () => {
  let payload: any;
  await provider(async (_url, init) => {
    payload = JSON.parse(JSON.parse(init!.body as string).messages[1].content);
    return wire();
  }).generate_page({
    ...context,
    coverage: { partial: true, available_files: 70 },
    related_pages: [{ id: "parent", markdown: "x\n".repeat(10000) }],
    edges: Array.from({ length: 1200 }, () => ["a", "b"]),
  });
  assert.equal(payload.coverage.partial, true);
  assert.equal(payload.related_pages[0].truncated, true);
  assert.ok(payload.related_pages[0].markdown_excerpt.length <= 12000);
  assert.deepEqual(payload.edge_coverage, { provided: 1000, available: 1200 });
});
test("pre-cancel sends nothing; in-flight cancel is propagated with no retries", async () => {
  const before = new AbortController();
  before.abort();
  let calls = 0;
  await assert.rejects(
    provider(async () => {
      calls++;
      return wire();
    }).generate_page(context, { signal: before.signal }),
    /canceled/,
  );
  assert.equal(calls, 0);
  const active = new AbortController();
  const promise = provider(async (_url, init) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () =>
        reject(new Error("secret inner abort")),
      );
    });
  }).generate_page(context, { signal: active.signal });
  active.abort();
  await assert.rejects(promise, /canceled/);
  assert.equal(calls, 1);
});
test("network failure details are redacted and retry bound honored", async () => {
  let calls = 0;
  await assert.rejects(
    provider(async () => {
      calls++;
      throw new Error("Bearer test-secret private host");
    }).generate_page(context),
    (error) => {
      assert.ok(error instanceof ProviderError);
      assert.ok(!error.message.includes("test-secret"));
      return true;
    },
  );
  assert.equal(calls, 3);
});

test("source filenames with parentheses and punctuation are encoded citations", async () => {
  const result = await new DemoProvider().generate_page({
    files: [{ path: "a/foo(1)!.ts", content: "export const sample = 1;\n" }],
  });
  assert.match(result.markdown, /source:a\/foo%281%29%21.ts#L1-L1/);
});

test("offline card is a compact source-backed artifact, not a repeated wiki page", async () => {
  const demo = new DemoProvider();
  const card = await demo.generate_page({
    ...context,
    kind: "card",
    card_category: "entrypoint",
    title: "应用入口声明",
    goal: "定位入口声明与导入，不推断运行时行为",
  });
  const wiki = await demo.generate_page({ ...context, kind: "wiki" });
  assert.notEqual(card.markdown, wiki.markdown);
  assert.match(card.markdown, /离线规则知识卡片.*未调用大模型/);
  assert.match(card.markdown, /分类.*entrypoint/);
  assert.match(card.markdown, /本卡目标.*定位入口声明/);
  assert.match(card.markdown, /可核验事实/);
  assert.match(card.markdown, /声明候选 `main`/);
  assert.match(card.markdown, /source:app.py#L3-L3/);
  assert.match(card.markdown, /source:app.py#L1-L1/);
  assert.doesNotMatch(card.markdown, /```mermaid|源文件与可验证定义|继续阅读/);
  assert.ok(card.markdown.length < 2500);
  assert.ok(card.sources.length <= 7);
  for (const ref of card.sources) {
    const file = context.files!.find((item) => item.path === ref.path)!;
    assert.ok(file);
    assert.ok(ref.start_line >= 1 && ref.start_line <= ref.end_line);
    assert.ok(ref.end_line <= file.content.trimEnd().split("\n").length);
  }
  assert.deepEqual(
    card,
    await demo.generate_page({
      ...context,
      kind: "card",
      card_category: "entrypoint",
      title: "应用入口声明",
      goal: "定位入口声明与导入，不推断运行时行为",
    }),
  );
});

test("offline cards disclose missing and partial evidence without inferring meaning", async () => {
  const empty = await new DemoProvider().generate_page({
    kind: "card",
    language: "en",
    card_category: "business-rules",
    files: [],
    goal: "Explain billing behavior",
  });
  assert.match(empty.markdown, /No source evidence is available/);
  assert.match(empty.markdown, /not business semantics/);
  assert.deepEqual(empty.sources, []);
  const partial = await new DemoProvider().generate_page({
    ...context,
    kind: "card",
    coverage: { partial: true, available_files: 100 },
  });
  assert.match(partial.markdown, /部分覆盖/);
  assert.match(partial.markdown, /不表示实际调用/);
});

test("offline card inventory is bounded even for large evidence sets", async () => {
  const result = await new DemoProvider().generate_page({
    kind: "card",
    files: Array.from({ length: 60 }, (_, i) => ({
      path: `module-${i}.ts`,
      content: Array.from(
        { length: 100 },
        (_, j) => `export const item${j} = ${j};`,
      ).join("\n"),
    })),
  });
  assert.equal((result.markdown.match(/- 声明候选/g) ?? []).length, 3);
  assert.equal(result.sources.length, 3);
  assert.ok(result.markdown.length < 2000);
});

test("wiki sections and diagrams have nearby validated evidence instead of only a final list", async () => {
  const result = await new DemoProvider().generate_page(context);
  assert.match(result.markdown, /章节来源/);
  assert.match(result.markdown, /图示来源.*source:app.py#L1-L1/);
  assert.ok(
    result.markdown.indexOf("图示来源") <
      result.markdown.indexOf("## 源文件与可验证定义"),
  );
  const omitted = await new DemoProvider().generate_page({
    ...context,
    files: [
      {
        path: "app.py",
        content: "def main():\n    return 'no import shown'\n",
      },
    ],
    edges: [["app.py", "service.py"]],
  });
  assert.doesNotMatch(omitted.markdown, /```mermaid/);
});

test("real card wire contract includes kind/category and compact instructions while wiki requires chapter citations", async () => {
  const requests: any[] = [];
  const real = provider(async (_url, init) => {
    requests.push(JSON.parse(init!.body as string));
    return wire();
  });
  await real.generate_page({
    ...context,
    kind: "card",
    card_category: "dependency",
  });
  await real.generate_page({ ...context, kind: "wiki" });
  const cardContext = JSON.parse(requests[0].messages[1].content);
  assert.equal(cardContext.kind, "card");
  assert.equal(cardContext.card_category, "dependency");
  assert.equal(requests[0].max_tokens, 1600);
  assert.match(requests[0].messages[0].content, /NOT a full wiki page/);
  assert.match(
    requests[0].messages[0].content,
    /source citation beside every code fact/,
  );
  assert.match(requests[0].messages[0].content, /untrusted DATA/);
  assert.equal(JSON.parse(requests[1].messages[1].content).kind, "wiki");
  assert.equal(requests[1].max_tokens, 6000);
  assert.match(requests[1].messages[0].content, /Chapter sources \/ 章节来源/);
  assert.match(requests[1].messages[0].content, /Diagram sources \/ 图示来源/);
  assert.match(
    requests[1].messages[0].content,
    /source list only at the end is insufficient/,
  );
});

test("real cards reject an oversized wiki-like response without mutating the output contract", async () => {
  await assert.rejects(
    provider(async () =>
      wire({ ...output, markdown: "x".repeat(12001) }),
    ).generate_page({ ...context, kind: "card" }),
    /compact-card limits/,
  );
  await assert.rejects(
    provider(async () =>
      wire({
        ...output,
        sources: Array.from({ length: 13 }, () => output.sources[0]),
      }),
    ).generate_page({ ...context, kind: "card" }),
    /compact-card limits/,
  );
});

test("card facts prioritize actual direct sources over transitive dependencies", async () => {
  const result = await new DemoProvider().generate_page({
    kind: "card",
    card_category: "storage",
    direct_sources: ["z/storage.ts"],
    files: [
      { path: "a/domain.ts", content: "export class Domain {}\n" },
      { path: "z/storage.ts", content: "export class Repository {}\n" },
    ],
  });
  assert.ok(
    result.markdown.indexOf("声明候选 `Repository`") <
      result.markdown.indexOf("声明候选 `Domain`"),
  );
});

test("card text stays bounded for long encoded Unicode evidence paths without breaking citations", async () => {
  const path = "源".repeat(490) + ".ts";
  const result = await new DemoProvider().generate_page({
    kind: "card",
    files: [
      {
        path,
        content:
          "export const first = 1;\nexport const second = 2;\nexport const third = 3;\n",
      },
    ],
  });
  assert.ok(result.markdown.length <= 12000);
  assert.ok(result.sources.length > 0);
  for (const reference of result.sources)
    assert.ok(
      result.markdown.includes(
        `#L${reference.start_line}-L${reference.end_line})`,
      ),
    );
});
