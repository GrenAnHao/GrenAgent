import { describe, expect, it } from "vitest";
import { rankSessions } from "./rank.js";

const infos = [
  { id: "s1", allMessagesText: "we fixed the auth bug in login" },
  { id: "s2", allMessagesText: "discussion about auth auth auth tokens" },
  { id: "s3", allMessagesText: "unrelated css tweaks" },
];

describe("rankSessions", () => {
  it("ranks by keyword occurrence and returns snippets", () => {
    const hits = rankSessions(infos, "auth", 5, 40);
    expect(hits.map((h) => h.id)).toEqual(["s2", "s1"]);
    expect(hits[0].score).toBe(3);
    expect(hits[0].snippet).toMatch(/auth/);
  });
  it("respects topK", () => {
    expect(rankSessions(infos, "auth", 1, 40).map((h) => h.id)).toEqual(["s2"]);
  });
  it("empty query or no match → []", () => {
    expect(rankSessions(infos, "   ", 5, 40)).toEqual([]);
    expect(rankSessions(infos, "nonexistent", 5, 40)).toEqual([]);
  });
});
