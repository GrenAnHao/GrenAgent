// Real run (no network): a real AgentSession with pi's built-in codemode, the faux model scripting
// one codemode call, and this extension bound to a manager whose server "docs" is still connecting.
// The script calls tools.mcp__docs__search. codemode's reachesTools names mcp__docs__search, so the
// tool_call hook waits for "docs"; the server connects, the projection registers its tool, and the
// script finds it. Without the wait the script runs first and the tool does not exist yet.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const home = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "pi-mcp-reach-agent-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
});

import {
  createAgentSessionFromServices,
  createCodemodeExtension,
  createAgentSessionServices,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { bind } from "./index.js";
import type { McpSnapshot } from "./manager.js";

type Entry = McpSnapshot["servers"] extends Map<string, infer E> ? E : never;

/** A manager with one codemode server that finishes connecting `delayMs` after the first wait. */
function connectingManager(delayMs: number) {
  let snapshot: McpSnapshot = {
    servers: new Map([["docs", { status: "connecting", tools: [], exposure: "codemode" } as unknown as Entry]]),
  };
  const listeners = new Set<(s: McpSnapshot) => void>();
  let connecting: Promise<void> | undefined;
  const waits: string[] = [];
  return {
    waits,
    init() {},
    reconcile() {},
    async closeAll() {},
    async applyExtensionServers() {},
    snapshot: () => snapshot,
    subscribe(listener: (s: McpSnapshot) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    connectPromise(name: string) {
      if (name !== "docs" || snapshot.servers.get("docs")?.status === "connected") return undefined;
      waits.push(name);
      connecting ??= new Promise<void>((resolve) =>
        setTimeout(() => {
          snapshot = {
            servers: new Map([[
              "docs",
              {
                status: "connected",
                tools: [{ name: "search", description: "Search docs", inputSchema: { type: "object", properties: {} } }],
                exposure: "codemode",
              } as unknown as Entry,
            ]]),
          };
          for (const listener of listeners) listener(snapshot);
          resolve();
        }, delayMs),
      );
      return connecting;
    },
    async callTool() {
      return { content: [{ type: "text", text: "DOCS_OK" }] };
    },
    async listResources() { return { content: [] }; },
    async listResourceTemplates() { return { content: [] }; },
    async readResource() { return { content: [] }; },
  };
}

const allow = { request: async () => ({ status: "allowed" }) } as never;

describe("codemode waits for the MCP server its script reaches (real SDK, faux model)", () => {
  const ws = mkdtempSync(join(tmpdir(), "pi-mcp-reach-ws-"));
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

  it("registers the server's tools before the script runs", async () => {
    const mgr = connectingManager(300);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("codemode", { code: "const r = await tools.mcp__docs__search({});\nreturn r.content[0].text;" })),
      fauxAssistantMessage(fauxText("done")),
    ]);
    const services = await createAgentSessionServices({
      cwd: ws,
      agentDir: home,
      modelRuntime: runtime,
      resourceLoaderOptions: {
        // Same order as the desktop runtime (cli/src/gren-runtime.ts): managed extensions, then official codemode.
        extensionFactories: [((pi: ExtensionAPI) => bind(pi, mgr as never, allow)) as never, createCodemodeExtension()],
        noContextFiles: true,
      },
    });
    const model = resolveCliModel({ cliModel: "faux/faux-1", modelRuntime: services.modelRuntime }).model;
    const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(ws), model });
    await session.bindExtensions({});
    session.setActiveToolsByName([...new Set([...session.getActiveToolNames(), "codemode"])]);

    const codemode = session.getAllTools().find((tool) => tool.name === "codemode");
    expect(typeof codemode?.reachesTools).toBe("function");
    expect(session.getAllTools().some((tool) => tool.name === "mcp__docs__search")).toBe(false);

    await session.prompt("search the docs");
    await session.waitForIdle();

    const result = session.messages.find(
      (message) => (message as { role?: string; toolName?: string }).role === "toolResult"
        && (message as { toolName?: string }).toolName === "codemode",
    ) as { isError?: boolean; content?: Array<{ type: string; text?: string }> } | undefined;
    const text = (result?.content ?? []).map((part) => part.text ?? "").join("");
    expect(text).toContain("DOCS_OK");
    expect(mgr.waits).toContain("docs");
    expect(result?.isError).not.toBe(true);
    session.dispose?.();
  }, 60_000);
});
