import { describe, expect, it } from "vitest";
import {
  __resetEmbeddedSubagentEventSinksForTest,
  emitEmbeddedSubagentEvent,
  registerEmbeddedSubagentEventSink,
} from "./embedded-events.js";

describe("embedded-events", () => {
  it("forwards events to registered sinks and unsubscribes", () => {
    __resetEmbeddedSubagentEventSinksForTest();
    const seen: string[] = [];
    const off = registerEmbeddedSubagentEventSink((event, meta) => {
      seen.push(`${meta.sessionPath}:${String(event.type)}`);
    });
    emitEmbeddedSubagentEvent({ type: "message_start" }, { sessionPath: "/s.jsonl", workspace: "/ws" });
    off();
    emitEmbeddedSubagentEvent({ type: "message_end" }, { sessionPath: "/s.jsonl", workspace: "/ws" });
    expect(seen).toEqual(["/s.jsonl:message_start"]);
    __resetEmbeddedSubagentEventSinksForTest();
  });

  it("stops at the first sink that claims the event", () => {
    __resetEmbeddedSubagentEventSinksForTest();
    const seen: string[] = [];
    registerEmbeddedSubagentEventSink(() => {
      seen.push("other-workspace");
    });
    registerEmbeddedSubagentEventSink(() => {
      seen.push("owner");
      return true;
    });
    registerEmbeddedSubagentEventSink(() => {
      seen.push("duplicate");
      return true;
    });
    emitEmbeddedSubagentEvent({ type: "message_update" }, { sessionPath: "/s.jsonl", workspace: "/ws" });
    expect(seen).toEqual(["other-workspace", "owner"]);
    __resetEmbeddedSubagentEventSinksForTest();
  });

  it("keeps trying later sinks when an earlier one throws", () => {
    __resetEmbeddedSubagentEventSinksForTest();
    const seen: string[] = [];
    registerEmbeddedSubagentEventSink(() => {
      throw new Error("broken host");
    });
    registerEmbeddedSubagentEventSink(() => {
      seen.push("next");
      return true;
    });
    emitEmbeddedSubagentEvent({ type: "message_update" }, { sessionPath: "/s.jsonl", workspace: "/ws" });
    expect(seen).toEqual(["next"]);
    __resetEmbeddedSubagentEventSinksForTest();
  });
});
