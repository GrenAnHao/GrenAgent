import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetEscalationGrantsForTest,
  clearEscalationGrants,
  grantEscalation,
  takeEscalationGrant,
} from "./escalationGrant.js";

beforeEach(() => __resetEscalationGrantsForTest());

describe("escalation grants", () => {
  it("a grant is used once, for its call and mode", () => {
    grantEscalation("s1", "call-1", "workspace-write");
    expect(takeEscalationGrant("s1", "call-1", "workspace-write")).toBe(true);
    expect(takeEscalationGrant("s1", "call-1", "workspace-write")).toBe(false);
  });

  it("another session or call does not match", () => {
    grantEscalation("s1", "call-1", "workspace-write");
    expect(takeEscalationGrant("s2", "call-1", "workspace-write")).toBe(false);
    expect(takeEscalationGrant("s1", "call-2", "workspace-write")).toBe(false);
    expect(takeEscalationGrant("s1", "call-1", "workspace-write")).toBe(true);
  });

  it("a different mode does not match and still spends the grant", () => {
    grantEscalation("s1", "call-1", "workspace-write");
    expect(takeEscalationGrant("s1", "call-1", "danger-full-access")).toBe(false);
    expect(takeEscalationGrant("s1", "call-1", "workspace-write")).toBe(false);
  });

  it("closing a session drops only its grants", () => {
    grantEscalation("s1", "call-1", "workspace-write");
    grantEscalation("s2", "call-1", "workspace-write");
    clearEscalationGrants("s1");
    expect(takeEscalationGrant("s1", "call-1", "workspace-write")).toBe(false);
    expect(takeEscalationGrant("s2", "call-1", "workspace-write")).toBe(true);
  });
});
