import { describe, expect, it } from "vitest";
import {
  __resetCatalogChangeSinksForTest,
  emitCatalogChanged,
  registerCatalogChangeSink,
} from "./catalog-events.js";

describe("catalog-events", () => {
  it("forwards events to registered sinks and unsubscribes", () => {
    __resetCatalogChangeSinksForTest();
    const seen: string[] = [];
    const off = registerCatalogChangeSink((meta) => {
      seen.push(meta.sessionPath);
    });
    emitCatalogChanged({ sessionPath: "/p.jsonl" });
    off();
    emitCatalogChanged({ sessionPath: "/q.jsonl" });
    expect(seen).toEqual(["/p.jsonl"]);
    __resetCatalogChangeSinksForTest();
  });

  it("one sink throw does not block others", () => {
    __resetCatalogChangeSinksForTest();
    const seen: string[] = [];
    registerCatalogChangeSink(() => {
      throw new Error("boom");
    });
    registerCatalogChangeSink((meta) => {
      seen.push(meta.sessionPath);
    });
    emitCatalogChanged({ sessionPath: "/p.jsonl" });
    expect(seen).toEqual(["/p.jsonl"]);
    __resetCatalogChangeSinksForTest();
  });
});
