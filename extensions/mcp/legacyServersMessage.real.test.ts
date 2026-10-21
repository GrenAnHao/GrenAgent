// Real run (no network): a real AgentSession with this extension bound to a manager that has two
// codemode servers, and a faux model that records what it is sent. Before the fix the request
// carried a user-role "antd codemode\ndeepwiki codemode" right after the prompt and the model went
// on to call both servers. Now nothing about the servers is injected, and a list an older version
// left in the session is not sent either.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const home = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "pi-mcp-legacy-agent-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
});

import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { bind } from "./index.js";
import type { McpSnapshot } from "./manager.js";

type Entry = McpSnapshot["servers"] extends Map<string, infer E> ? E : never;

function twoCodemodeServers() {
  const snapshot: McpSnapshot = {
    servers: new Map([
      ["antd", { status: "connected", tools: [{ name: "antd_list" }], exposure: "codemode" } as unknown as Entry],
      ["deepwiki", { status: "connected", tools: [{ name: "read_wiki_structure" }], exposure: "codemode" } as unknown as Entry],
    ]),
  };
  return {
    init() {},
    reconcile() {},
    async closeAll() {},
    async applyExtensionServers() {},
    snapshot: () => snapshot,
    subscribe: () => () => {},
    connectPromise: () => undefined,
    async callTool() { return { content: [] }; },
    async listResources() { return { content: [] }; },
    async listResourceTemplates() { return { content: [] }; },
    async readResource() { return { content: [] }; },
  };
}

function textOf(message: unknown): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part as { text?: string }).text ?? "").join("");
}

describe("MCP server names are not injected into the model request (real SDK, faux model)", () => {
  const ws = mkdtempSync(join(tmpdir(), "pi-mcp-legacy-ws-"));
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
  let runtime: ModelRuntime;

  beforeAll(async () => {
    mkdirSync(join(home, "sessions"), { recursive: true });
    runtime = await ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: null, refreshOnCreate: false });
    runtime.registerNativeProvider(faux.provider);
  });

  afterAll(() => {
    rmSync(ws, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("sends only the user's text, with no server list and no legacy list", async () => {
    const sent: Array<{ role: string; text: string }> = [];
    let systemPrompt = "";
    faux.setResponses([
      (context) => {
        for (const message of context.messages) {
          sent.push({ role: String((message as { role?: string }).role), text: textOf(message) });
        }
        systemPrompt = JSON.stringify((context as { systemPrompt?: unknown }).systemPrompt ?? "");
        return fauxAssistantMessage(fauxText("ok"));
      },
    ]);
    const services = await createAgentSessionServices({
      cwd: ws,
      agentDir: home,
      modelRuntime: runtime,
      resourceLoaderOptions: {
        extensionFactories: [((pi: ExtensionAPI) => bind(pi, twoCodemodeServers() as never, { request: async () => ({}) } as never)) as never],
        noContextFiles: true,
      },
    });
    const sessionManager = SessionManager.inMemory(ws);
    // What a session written by the old version carries.
    (sessionManager as unknown as { appendMessage(m: unknown): void }).appendMessage({
      role: "custom",
      customType: "mcp-servers",
      content: "antd codemode\ndeepwiki codemode",
      display: false,
      timestamp: 1,
    });
    const model = resolveCliModel({ cliModel: "faux/faux-1", modelRuntime: services.modelRuntime }).model;
    const { session } = await createAgentSessionFromServices({ services, sessionManager, model });
    await session.bindExtensions({});

    await session.prompt("// Note: see the codegraph host note");
    await session.waitForIdle();

    const all = sent.map((message) => message.text).join("\n");
    expect(all).toContain("// Note: see the codegraph host note");
    expect(all).not.toMatch(/antd codemode|deepwiki codemode/);
    expect(systemPrompt).not.toMatch(/antd codemode|deepwiki codemode|mcp_servers/);
    session.dispose?.();
  }, 60_000);
});
