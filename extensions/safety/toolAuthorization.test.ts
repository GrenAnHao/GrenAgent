import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  evaluateToolCall: vi.fn(async () => ({ decision: 'allow' as const, auditId: 'a1' })),
  rememberToolRule: vi.fn(async () => true),
  settleToolCall: vi.fn(async () => undefined),
  getApprovalPolicy: vi.fn(() => 'auto' as const),
  getConfig: vi.fn(() => undefined as string | undefined),
}));

// resolveToolOrigin 保留真实实现：origin 的测试靠设置 PI_IS_SUBAGENT 等环境变量驱动。
vi.mock('../_shared/desktop-control.js', async () => {
  const actual = await vi.importActual<typeof import('../_shared/desktop-control.js')>('../_shared/desktop-control.js');
  return {
    ...actual,
    desktopControl: () => ({ request: vi.fn() }),
    evaluateToolCall: mocks.evaluateToolCall,
    rememberToolRule: mocks.rememberToolRule,
    settleToolCall: mocks.settleToolCall,
  };
});
vi.mock('../_shared/approval.js', () => ({ getApprovalPolicy: mocks.getApprovalPolicy }));
vi.mock('../_shared/runtime-config.js', () => ({ getConfig: mocks.getConfig }));

import safety from './index.js';

type Handler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<{ block?: boolean; reason?: string } | undefined>;

function loadToolCall(): Handler {
  let handler: Handler | undefined;
  safety({
    on: (name: string, fn: Handler) => { if (name === 'tool_call') handler = fn; },
  } as never);
  if (!handler) throw new Error('tool_call handler was not registered');
  return handler;
}

function ctx(over: Record<string, unknown> = {}) {
  return {
    cwd: 'D:/repo',
    hasUI: true,
    ui: { select: vi.fn(async () => '允许本次') },
    sessionManager: { getSessionId: () => 's1' },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.SAFETY_DENY_TOOLS;
  delete process.env.SAFETY_READONLY;
  delete process.env.PI_IS_SUBAGENT;
  delete process.env.PI_GOAL_WORKER;
  mocks.getApprovalPolicy.mockReturnValue('auto');
  mocks.getConfig.mockReturnValue(undefined);
  mocks.evaluateToolCall.mockResolvedValue({ decision: 'allow', auditId: 'a1' });
});

describe('safety tool_call · capability hard limits still come first', () => {
  it('blocks a denied tool without asking the host', async () => {
    process.env.SAFETY_DENY_TOOLS = 'bash';
    const result = await loadToolCall()({ toolName: 'bash', input: { command: 'ls' } }, ctx());
    expect(result).toMatchObject({ block: true });
    expect(mocks.evaluateToolCall).not.toHaveBeenCalled();
  });

  it('blocks a write tool in readonly mode without asking the host', async () => {
    process.env.SAFETY_READONLY = '1';
    const result = await loadToolCall()({ toolName: 'ast_edit', input: { path: 'a.ts' } }, ctx());
    expect(result).toMatchObject({ block: true });
    expect(mocks.evaluateToolCall).not.toHaveBeenCalled();
  });
});

describe('safety tool_call · host decision', () => {
  it('passes the extracted facts to the host', async () => {
    await loadToolCall()({ toolName: 'bash', toolCallId: 'c1', input: { command: 'rm -rf /' } }, ctx());
    const call = mocks.evaluateToolCall.mock.calls[0][1];
    expect(call).toMatchObject({
      tool: 'bash', workspace: 'D:/repo', origin: 'main', preset: 'auto', toolCallId: 'c1', sessionId: 's1',
    });
    expect(call.flags.dangerousCommand).toBe(true);
  });

  it('marks mcp, network and code exec flags', async () => {
    await loadToolCall()({ toolName: 'mcp__github__x', input: {} }, ctx());
    expect(mocks.evaluateToolCall.mock.calls[0][1].flags.mcp).toBe(true);
    await loadToolCall()({ toolName: 'py_run', input: {} }, ctx());
    expect(mocks.evaluateToolCall.mock.calls[1][1].flags.codeExec).toBe(true);
  });

  it('reports the process origin for a sub-agent', async () => {
    process.env.PI_IS_SUBAGENT = '1';
    await loadToolCall()({ toolName: 'bash', input: { command: 'ls' } }, ctx({ hasUI: false }));
    expect(mocks.evaluateToolCall.mock.calls[0][1].origin).toBe('subagent');
  });

  it('honours SAFETY_BASH_CONFIRM=0 by withholding the dangerous flag', async () => {
    mocks.getConfig.mockImplementation((k: string) => (k === 'SAFETY_BASH_CONFIRM' ? '0' : undefined));
    await loadToolCall()({ toolName: 'bash', input: { command: 'rm -rf /' } }, ctx());
    expect(mocks.evaluateToolCall.mock.calls[0][1].flags.dangerousCommand).toBe(false);
  });

  it('honours SAFETY_PROTECT_PATHS=0 by withholding the protected-path flag', async () => {
    mocks.getConfig.mockImplementation((k: string) => (k === 'SAFETY_PROTECT_PATHS' ? '0' : undefined));
    await loadToolCall()({ toolName: 'write', input: { path: 'C:/Windows/System32/x.dll' } }, ctx());
    expect(mocks.evaluateToolCall.mock.calls[0][1].flags.protectedPath).toBe(false);
  });

  it('allows the call through when the host says allow', async () => {
    await expect(loadToolCall()({ toolName: 'bash', input: { command: 'ls' } }, ctx())).resolves.toBeUndefined();
  });

  it('blocks when the host says deny', async () => {
    mocks.evaluateToolCall.mockResolvedValue({ decision: 'deny', auditId: 'a1' });
    const result = await loadToolCall()({ toolName: 'bash', input: { command: 'ls' } }, ctx());
    expect(result).toMatchObject({ block: true });
  });
});

describe('safety tool_call · ask flow', () => {
  it('prompts the user and allows once when they pick 允许本次', async () => {
    mocks.evaluateToolCall.mockResolvedValue({ decision: 'ask', auditId: 'a1' });
    const c = ctx();
    await expect(loadToolCall()({ toolName: 'bash', input: { command: 'rm -rf x' } }, c)).resolves.toBeUndefined();
    expect(c.ui.select).toHaveBeenCalled();
    expect(mocks.settleToolCall).toHaveBeenCalledWith(expect.anything(), 'a1', 'user_allow');
    expect(mocks.rememberToolRule).not.toHaveBeenCalled();
  });

  it('writes a command_prefix rule when the user picks 总是允许 for bash', async () => {
    mocks.evaluateToolCall.mockResolvedValue({ decision: 'ask', auditId: 'a1' });
    const c = ctx({ ui: { select: vi.fn(async () => '总是允许') } });
    await loadToolCall()({ toolName: 'bash', input: { command: 'npm run build' } }, c);
    expect(mocks.rememberToolRule).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      scope: 'workspace', scopeKey: 'D:/repo', tool: 'bash', matcherKind: 'command_prefix', effect: 'allow',
    }));
  });

  it('writes a plain tool rule when the tool has no command or path', async () => {
    mocks.evaluateToolCall.mockResolvedValue({ decision: 'ask', auditId: 'a1' });
    const c = ctx({ ui: { select: vi.fn(async () => '总是允许') } });
    await loadToolCall()({ toolName: 'web_search', input: { query: 'x' } }, c);
    expect(mocks.rememberToolRule).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      tool: 'web_search', matcherKind: 'any', effect: 'allow',
    }));
  });

  it('blocks and settles as user_deny when the user refuses', async () => {
    mocks.evaluateToolCall.mockResolvedValue({ decision: 'ask', auditId: 'a1' });
    const c = ctx({ ui: { select: vi.fn(async () => '拒绝') } });
    const result = await loadToolCall()({ toolName: 'bash', input: { command: 'rm -rf x' } }, c);
    expect(result).toMatchObject({ block: true });
    expect(mocks.settleToolCall).toHaveBeenCalledWith(expect.anything(), 'a1', 'user_deny');
  });

  it('blocks without prompting when there is no UI, leaving the row queued', async () => {
    mocks.evaluateToolCall.mockResolvedValue({ decision: 'ask', auditId: 'a1' });
    const c = ctx({ hasUI: false });
    const result = await loadToolCall()({ toolName: 'bash', input: { command: 'rm -rf x' } }, c);
    expect(result).toMatchObject({ block: true });
    expect(c.ui.select).not.toHaveBeenCalled();
    expect(mocks.settleToolCall).not.toHaveBeenCalled();
  });

  it('settles as aborted when the prompt throws', async () => {
    mocks.evaluateToolCall.mockResolvedValue({ decision: 'ask', auditId: 'a1' });
    const c = ctx({ ui: { select: vi.fn(async () => { throw new Error('aborted'); }) } });
    const result = await loadToolCall()({ toolName: 'bash', input: { command: 'rm -rf x' } }, c);
    expect(result).toMatchObject({ block: true });
    expect(mocks.settleToolCall).toHaveBeenCalledWith(expect.anything(), 'a1', 'aborted');
  });
});
