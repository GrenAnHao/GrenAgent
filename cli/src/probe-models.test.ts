import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { homedir } from "node:os";
import { collectModels, probeRuntimePaths, type RegistryLike } from "./probe-models.js";

test("probeRuntimePaths follows PI_CODING_AGENT_DIR like the Electron main process", () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(homedir(), "custom-agent-dir");
  try {
    assert.deepEqual(probeRuntimePaths(), {
      authPath: join(homedir(), "custom-agent-dir", "auth.json"),
      modelsPath: join(homedir(), "custom-agent-dir", "models.json"),
    });
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("probeRuntimePaths falls back to the default agent dir", () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
  try {
    assert.equal(probeRuntimePaths().authPath, join(homedir(), ".pi", "agent", "auth.json"));
  } finally {
    if (previous !== undefined) process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("collectModels maps registry models to serializable rows", () => {
  const registry: RegistryLike = {
    getAll: () => [
      {
        provider: "anthropic",
        id: "claude-sonnet-4",
        name: "Claude 4 Sonnet",
        contextWindow: 200000,
        maxTokens: 16384,
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  };
  assert.deepEqual(collectModels(registry), [
    {
      provider: "anthropic",
      id: "claude-sonnet-4",
      name: "Claude 4 Sonnet",
      contextWindow: 200000,
      maxTokens: 16384,
      reasoning: false,
      fast: false,
      input: ["text", "image"],
      cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
    },
  ]);
});

test("collectModels passes thinkingLevelMap through only when present", () => {
  const map = { off: null, high: "high", max: "max" };
  const registry: RegistryLike = {
    getAll: () => [
      { provider: "anthropic", id: "opus", reasoning: true, thinkingLevelMap: map },
      { provider: "x", id: "plain" },
    ],
  };
  const [withMap, without] = collectModels(registry);
  assert.deepEqual(withMap.thinkingLevelMap, map);
  assert.equal("thinkingLevelMap" in without, false);
});

test("collectModels fills defaults for sparse models", () => {
  const registry: RegistryLike = { getAll: () => [{ provider: "x", id: "m1" }] };
  const [row] = collectModels(registry);
  assert.equal(row.name, "m1");
  assert.equal(row.contextWindow, 0);
  assert.deepEqual(row.input, ["text"]);
  assert.deepEqual(row.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("collectModels returns [] when registry has no models", () => {
  assert.deepEqual(collectModels({ getAll: () => [] }), []);
});

test('collectModels preserves advanced metadata without leaking headers or credentials',()=>{
 const options={samplingParams:{top_p:0},samplingParamsByThinkingLevel:{low:{top_k:3}},inputLimits:{images:{maxPerMessage:2}},promptCache:{short:0.5}};
 const rows=collectModels({getAll:()=>[{provider:'fixture',id:'org/A',...options,apiKey:'do-not-export',headers:{Authorization:'do-not-export'}}]} as RegistryLike);
 for(const key of Object.keys(options))assert.deepEqual((rows[0] as any)[key],(options as any)[key]);
 assert.equal('headers' in rows[0],false);assert.equal('apiKey' in rows[0],false);
});
