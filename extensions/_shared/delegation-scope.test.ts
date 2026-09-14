import { describe, expect, it } from "vitest";
import {
  DELEGATION_DENY_REASON,
  DELEGATION_SCOPE_STATEMENT,
  SUBAGENT_ASK_PINNED_RULE_ID,
  withDelegationScope,
} from "./delegation-scope.js";

describe("withDelegationScope", () => {
  it("returns only the statement when there is no system prompt", () => {
    expect(withDelegationScope(undefined)).toBe(DELEGATION_SCOPE_STATEMENT);
    expect(withDelegationScope("")).toBe(DELEGATION_SCOPE_STATEMENT);
    expect(withDelegationScope("   ")).toBe(DELEGATION_SCOPE_STATEMENT);
  });

  it("puts the named-agent prompt first, then a blank line, then the statement", () => {
    expect(withDelegationScope("You are scout.\n")).toBe(`You are scout.\n\n${DELEGATION_SCOPE_STATEMENT}`);
  });

  it("does not double-append when the prompt already ends with the statement", () => {
    const once = withDelegationScope("You are scout.");
    expect(withDelegationScope(once)).toBe(once);
  });
});

describe("constants", () => {
  it("rule id is stable", () => {
    expect(SUBAGENT_ASK_PINNED_RULE_ID).toBe("builtin.subagent-ask-pinned");
  });
  it("deny reason tells the model not to retry", () => {
    expect(DELEGATION_DENY_REASON).toContain("不要重试");
  });
});
