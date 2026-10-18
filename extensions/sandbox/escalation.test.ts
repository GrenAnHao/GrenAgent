import { describe, expect, it, vi } from "vitest";
import { approveEscalation, canOfferEscalation, readEscalationArgs, type SandboxGate } from "./escalation.js";

describe("readEscalationArgs (DSH validateEscalationArgs)", () => {
  it("returns nothing when neither field is given", () => {
    expect(readEscalationArgs({})).toBeUndefined();
  });

  it("returns the pair with the reason trimmed", () => {
    expect(readEscalationArgs({ sandbox_permissions: "workspace-write", justification: "  需要写构建产物  " })).toEqual({
      mode: "workspace-write",
      justification: "需要写构建产物",
    });
  });

  it.each([
    [{ sandbox_permissions: "workspace-write" }, "invalid escalation: sandbox_permissions requires a justification"],
    [{ justification: "需要写入" }, "invalid escalation: justification is only valid together with sandbox_permissions"],
    [{ sandbox_permissions: "workspace-write", justification: "   " }, "invalid justification: expected a non-empty sentence"],
    [
      { sandbox_permissions: "read-only", justification: "需要写入" },
      "invalid escalation: sandbox_permissions must be one of workspace-write, danger-full-access",
    ],
  ])("rejects %j", (params, message) => {
    expect(() => readEscalationArgs(params)).toThrow(message);
  });
});

describe("canOfferEscalation", () => {
  const gate: SandboxGate = { mode: "read-only", presetBlocksEscalation: false };

  it("offers when a wider mode exists, the preset allows it, and someone can approve", () => {
    expect(canOfferEscalation(gate, "read-only", true)).toBe(true);
    expect(canOfferEscalation(gate, "workspace-write", true)).toBe(true);
  });

  it("does not offer at the top, under a blocking preset, or without an approval channel", () => {
    expect(canOfferEscalation(gate, "danger-full-access", true)).toBe(false);
    expect(canOfferEscalation({ mode: "workspace-write", presetBlocksEscalation: true }, "workspace-write", true)).toBe(false);
    expect(canOfferEscalation(gate, "read-only", false)).toBe(false);
  });

  it("isolated workspace: no offer from workspace-write (only full-access is wider), read-only still offers", () => {
    const iso: SandboxGate = { mode: "read-only", presetBlocksEscalation: false, fullAccessBlocked: true };
    expect(canOfferEscalation(iso, "workspace-write", true)).toBe(false);
    expect(canOfferEscalation(iso, "read-only", true)).toBe(true);
  });
});

describe("approveEscalation · isolated workspace", () => {
  it("refuses full-access before asking, even when safety pre-approved the call", async () => {
    const select = vi.fn(async () => "允许本次");
    const gate: SandboxGate = { mode: "workspace-write", presetBlocksEscalation: false, fullAccessBlocked: true };
    await expect(
      approveEscalation("git push", { mode: "danger-full-access", justification: "推到主仓" }, gate, { channel: true, select, preApproved: true }),
    ).rejects.toThrow(/isolated workspace/);
    expect(select).not.toHaveBeenCalled();
  });

  it("still lets read-only widen to workspace-write with approval", async () => {
    const select = vi.fn(async () => "允许本次");
    const gate: SandboxGate = { mode: "read-only", presetBlocksEscalation: false, fullAccessBlocked: true };
    await expect(
      approveEscalation("npm run build", { mode: "workspace-write", justification: "写产物" }, gate, { channel: true, select, preApproved: false }),
    ).resolves.toBe("workspace-write");
  });
});

describe("approveEscalation (DSH order)", () => {
  const gate: SandboxGate = { mode: "read-only", presetBlocksEscalation: false };
  const request = { mode: "workspace-write" as const, justification: "需要写构建产物" };
  const ask = (answer: string | undefined) => vi.fn(async () => answer);

  it("asking for the current mode is not an escalation and asks nobody", async () => {
    const select = ask("允许本次");
    await expect(
      approveEscalation("x", request, { mode: "workspace-write", presetBlocksEscalation: false }, { channel: true, select, preApproved: false }),
    ).resolves.toBeUndefined();
    expect(select).not.toHaveBeenCalled();
  });

  it("asks once with the command, the reason and the target, and grants this call only", async () => {
    const select = ask("允许本次");
    const signal = new AbortController().signal;
    await expect(
      approveEscalation("npm run build", request, gate, { channel: true, select, preApproved: false, signal }),
    ).resolves.toBe("workspace-write");
    expect(select).toHaveBeenCalledWith(
      "沙箱升权\n\nnpm run build\n\n需要写构建产物\n\n→ workspace-write",
      ["允许本次", "拒绝"],
      { signal },
    );
  });

  it("a rejection tells the model to stop and explain", async () => {
    await expect(approveEscalation("x", request, gate, { channel: true, select: ask("拒绝"), preApproved: false })).rejects.toThrow(
      'the user rejected escalating this command to "workspace-write"; it stays denied, so stop and explain instead of working around it',
    );
  });

  it.each([
    ["dismissed", ask(undefined)],
    ["closed with an error", vi.fn(async () => { throw new Error("closed"); })],
  ])("a %s prompt is a cancellation", async (_name, select) => {
    await expect(approveEscalation("x", request, gate, { channel: true, select, preApproved: false })).rejects.toThrow(
      'approval for escalating to "workspace-write" was cancelled',
    );
  });

  it("a safety pre-approval skips the second prompt", async () => {
    const select = ask("拒绝");
    await expect(approveEscalation("x", request, gate, { channel: true, select, preApproved: true })).resolves.toBe("workspace-write");
    expect(select).not.toHaveBeenCalled();
  });

  it("fails before asking when the target is not strictly wider", async () => {
    const select = ask("允许本次");
    await expect(
      approveEscalation("x", request, { mode: "danger-full-access", presetBlocksEscalation: false }, { channel: true, select, preApproved: false }),
    ).rejects.toThrow('sandbox escalation to "workspace-write" is not strictly wider than this call\'s current "danger-full-access" mode');
    expect(select).not.toHaveBeenCalled();
  });

  it("the workspace-edit preset refuses even a pre-approved call", async () => {
    const select = ask("允许本次");
    await expect(
      approveEscalation(
        "x",
        { mode: "danger-full-access", justification: "需要写工作区外" },
        { mode: "workspace-write", presetBlocksEscalation: true },
        { channel: true, select, preApproved: true },
      ),
    ).rejects.toThrow("the workspace-edit approval preset keeps commands inside the workspace");
    expect(select).not.toHaveBeenCalled();
  });

  it("without an approval channel nothing is asked", async () => {
    const select = ask("允许本次");
    await expect(approveEscalation("x", request, gate, { channel: false, select, preApproved: false })).rejects.toThrow(
      'sandbox escalation to "workspace-write" requires approval, but no approval channel is available',
    );
    expect(select).not.toHaveBeenCalled();
  });

  it("without a sandbox policy there is nothing to widen", async () => {
    await expect(
      approveEscalation("x", request, undefined, { channel: true, select: ask("允许本次"), preApproved: false }),
    ).rejects.toThrow("this bash runs without a sandbox policy");
  });
});
