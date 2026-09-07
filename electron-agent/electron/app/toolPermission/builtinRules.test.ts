import { describe, expect, it } from 'vitest';
import { matchBuiltinRules } from './builtinRules';
import type { ApprovalPreset, ToolCallFacts, ToolCallFlags } from './types';

const NO_FLAGS: ToolCallFlags = {
  dangerousCommand: false, mutatingCommand: false, protectedPath: false, outsideWorkspace: false,
  network: false, mcp: false, codeExec: false, write: false,
};

function facts(preset: ApprovalPreset, flags: Partial<ToolCallFlags> = {}): ToolCallFacts {
  return {
    tool: 'bash', workspace: 'D:/repo', origin: 'main', preset,
    flags: { ...NO_FLAGS, ...flags },
  };
}

describe('matchBuiltinRules', () => {
  it('full preset has no builtin rules, preserving current behaviour', () => {
    // 现状：extensions/safety/index.ts 第 53-55 行在 full 档直接 return undefined，
    // 危险命令与受保护路径在 full 下同样不拦。改变这个行为属于回归。
    expect(matchBuiltinRules(facts('full', { dangerousCommand: true }))).toBeUndefined();
    expect(matchBuiltinRules(facts('full', { protectedPath: true }))).toBeUndefined();
  });

  it('auto denies protected paths', () => {
    expect(matchBuiltinRules(facts('auto', { protectedPath: true, write: true }))).toMatchObject({
      effect: 'deny', id: 'builtin.protected-path',
    });
  });

  it('auto asks for dangerous commands', () => {
    expect(matchBuiltinRules(facts('auto', { dangerousCommand: true }))).toMatchObject({
      effect: 'ask', id: 'builtin.dangerous-command',
    });
  });

  it('auto allows a plain mutating command', () => {
    expect(matchBuiltinRules(facts('auto', { mutatingCommand: true }))).toBeUndefined();
  });

  it('ask asks for mcp, network, code exec, mutating commands and out-of-workspace writes', () => {
    expect(matchBuiltinRules(facts('ask', { mcp: true }))?.id).toBe('builtin.mcp');
    expect(matchBuiltinRules(facts('ask', { network: true }))?.id).toBe('builtin.network');
    expect(matchBuiltinRules(facts('ask', { codeExec: true }))?.id).toBe('builtin.code-exec');
    expect(matchBuiltinRules(facts('ask', { mutatingCommand: true }))?.id).toBe('builtin.mutating-command');
    expect(matchBuiltinRules(facts('ask', { write: true, outsideWorkspace: true }))?.id)
      .toBe('builtin.outside-workspace-write');
  });

  it('ask allows an in-workspace write', () => {
    expect(matchBuiltinRules(facts('ask', { write: true }))).toBeUndefined();
  });

  it('deny outranks ask when both match', () => {
    expect(matchBuiltinRules(facts('ask', { protectedPath: true, write: true, outsideWorkspace: true })))
      .toMatchObject({ effect: 'deny' });
  });
});
