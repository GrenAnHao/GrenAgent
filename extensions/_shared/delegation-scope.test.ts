import { describe, expect, it } from "vitest";
import {
  DELEGATION_DENY_REASON,
  DELEGATION_SCOPE_STATEMENT,
  SUBAGENT_ASK_PINNED_RULE_ID,
  delegationScopeWithApprovals,
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

describe("delegationScopeWithApprovals", () => {
  it("says approvals go to the user, how long they wait, and not to retry", () => {
    const text = delegationScopeWithApprovals(60);
    expect(text).toContain("转给用户批准");
    expect(text).toContain("最多等 60 秒");
    expect(text).toContain("不要重试");
    expect(text).not.toContain("自动拒绝");
  });

  it("withDelegationScope takes either statement and still does not double-append", () => {
    const statement = delegationScopeWithApprovals(30);
    const once = withDelegationScope("You are scout.", statement);
    expect(once.endsWith(statement)).toBe(true);
    expect(withDelegationScope(once, statement)).toBe(once);
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
