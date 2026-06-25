import assert from "node:assert/strict";
import { test } from "node:test";
import { collectModels, type RegistryLike } from "./probe-models.js";

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
      input: ["text", "image"],
      cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
    },
  ]);
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
