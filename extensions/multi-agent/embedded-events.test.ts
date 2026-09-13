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
});
