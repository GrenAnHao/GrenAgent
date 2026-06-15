import { describe, expect, it } from "vitest";
import { headTailSlice, isUsableLlmsBody } from "./truncate.js";

describe("headTailSlice", () => {
  it("splits the budget 70/30 and reports the omitted count", () => {
    const text = "x".repeat(1000);
    const { head, tail, omitted } = headTailSlice(text, 100);
    expect(head.length).toBe(70);
    expect(tail.length).toBe(30);
    expect(omitted).toBe(900);
    expect(head.length + tail.length + omitted).toBe(text.length);
  });

  it("draws head from the start and tail from the end", () => {
    const text = `HEAD${"-".repeat(50)}TAIL`;
    const { head, tail } = headTailSlice(text, 20); // headLen=14, tailLen=6
    expect(head.startsWith("HEAD")).toBe(true);
    expect(tail.endsWith("TAIL")).toBe(true);
  });

  it("handles a tiny budget where the head rounds down to empty", () => {
    const { head, tail, omitted } = headTailSlice("abcdef", 1); // headLen=0, tailLen=1
    expect(head).toBe("");
    expect(tail).toBe("f");
    expect(omitted).toBe(5);
  });
});

describe("isUsableLlmsBody", () => {
  it("accepts plain-text / markdown bodies", () => {
    expect(isUsableLlmsBody("text/plain", "# Docs\n- a\n- b")).toBe(true);
    expect(isUsableLlmsBody("text/markdown; charset=utf-8", "hello world")).toBe(true);
  });

  it("rejects responses served as text/html (soft-404 pages)", () => {
    expect(isUsableLlmsBody("text/html", "looks like md but served as html")).toBe(false);
  });

  it("rejects html-looking bodies even under a non-html content-type", () => {
    expect(isUsableLlmsBody("text/plain", "<!DOCTYPE html><html>...")).toBe(false);
    expect(isUsableLlmsBody("application/octet-stream", "  <html><head>")).toBe(false);
  });

  it("rejects empty / whitespace-only bodies", () => {
    expect(isUsableLlmsBody("text/plain", "")).toBe(false);
    expect(isUsableLlmsBody("text/plain", "   \n  ")).toBe(false);
  });
});
