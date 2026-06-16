import { describe, expect, it } from "vitest";
import factory from "./index.js";

describe("session-search factory", () => {
  it("registers history_search tool and /history command", () => {
    const tools: string[] = [];
    const commands: string[] = [];
    factory({
      registerTool: (t: { name: string }) => tools.push(t.name),
      registerCommand: (n: string) => commands.push(n),
      on: () => {},
    } as never);
    expect(tools).toContain("history_search");
    expect(commands).toContain("history");
  });
});
