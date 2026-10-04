import { describe, expect, it } from "vitest";
import { shapeMcpResult } from "./resultShape.js";

describe("shapeMcpResult", () => {
  it("passes isError and keeps the full text in structuredContent", () => {
    const full = "x".repeat(30000);
    const shaped = shapeMcpResult({ content: [{ type: "text", text: full }], isError: true });
    expect(shaped.isError).toBe(true);
    expect(shaped.structuredContent).toMatchObject({ isError: true });
    expect(JSON.stringify(shaped.structuredContent)).toContain(full);
    const modelText = shaped.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
    expect(Buffer.byteLength(modelText, "utf8")).toBeLessThan(Buffer.byteLength(full, "utf8"));
    expect(modelText).toContain("截掉");
  });

  it("uses an empty string when there is no text", () => {
    const shaped = shapeMcpResult({ content: [] });
    expect(shaped.content).toEqual([{ type: "text", text: "" }]);
    expect(shaped.isError).toBe(false);
  });
});
