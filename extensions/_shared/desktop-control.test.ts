import { describe, expect, it, vi } from 'vitest';
import { evaluateToolCall, rememberToolRule, settleToolCall } from './desktop-control.js';
import type { ToolCallFacts } from './desktop-control.js';

const CALL: ToolCallFacts = {
  tool: 'bash', workspace: 'D:/repo', origin: 'main', preset: 'auto', command: 'npm run build',
  flags: {
    dangerousCommand: false, mutatingCommand: false, protectedPath: false, outsideWorkspace: false,
    network: false, mcp: false, codeExec: false, write: false,
  },
};

/** DesktopControlPort 的最小替身；request 的泛型返回值用 cast 满足接口。 */
function port(result: unknown) {
  return { request: vi.fn(async () => result) } as unknown as { request: ReturnType<typeof vi.fn> } & import('./desktop-control.js').DesktopControlPort;
}

describe('evaluateToolCall', () => {
  it('forwards the call and returns the decision', async () => {
    const client = port({ decision: 'allow', auditId: 'a1' });
    await expect(evaluateToolCall(client, CALL)).resolves.toEqual({ decision: 'allow', auditId: 'a1' });
    expect(client.request).toHaveBeenCalledWith('permission.tool.evaluate', { call: CALL });
  });

  it('denies when the channel fails, never falls through to allow', async () => {
    const client = { request: vi.fn(async () => { throw new Error('connection refused'); }) };
    await expect(evaluateToolCall(client, CALL)).resolves.toEqual({ decision: 'deny', auditId: undefined });
  });

  it('denies when the host returns a malformed decision', async () => {
    await expect(evaluateToolCall(port({ decision: 'maybe' }), CALL)).resolves.toMatchObject({ decision: 'deny' });
    await expect(evaluateToolCall(port(null), CALL)).resolves.toMatchObject({ decision: 'deny' });
  });
});

describe('rememberToolRule', () => {
  it('reports false instead of throwing when the host rejects the rule', async () => {
    const client = { request: vi.fn(async () => { throw new Error('invalid permission rule'); }) };
    await expect(rememberToolRule(client, {
      scope: 'global', scopeKey: '', tool: 'bash', matcherKind: 'any', matcher: '', effect: 'allow',
    })).resolves.toBe(false);
  });

  it('reports true on success', async () => {
    await expect(rememberToolRule(port({ id: 'r1' }), {
      scope: 'global', scopeKey: '', tool: 'bash', matcherKind: 'any', matcher: '', effect: 'allow',
    })).resolves.toBe(true);
  });
});

describe('settleToolCall', () => {
  it('swallows transport errors: the decision already stands', async () => {
    const client = { request: vi.fn(async () => { throw new Error('closed'); }) };
    await expect(settleToolCall(client, 'a1', 'user_allow')).resolves.toBeUndefined();
  });

  it('skips the round trip when there is no audit id', async () => {
    const client = port({ updated: true });
    await settleToolCall(client, undefined, 'user_allow');
    expect(client.request).not.toHaveBeenCalled();
  });
});
