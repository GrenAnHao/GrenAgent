import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentDataStorage } from '../../agentData/storage';
import { ToolAuditStore } from './auditStore';
import { ToolRuleStore } from './ruleStore';
import { ToolDecisionService } from './toolDecisionService';
import { toolPermissionMethods } from './rpc';

const directories: string[] = [];
const stores: AgentDataStorage[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(owner?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'tool-permission-rpc-'));
  directories.push(directory);
  const storage = new AgentDataStorage(join(directory, 'agent-data.db'));
  stores.push(storage);
  storage.migrate();
  const audit = new ToolAuditStore(storage.db, () => 42);
  const service = new ToolDecisionService(new ToolRuleStore(storage.db, () => 42), audit);
  // 无参默认绑到 D:/repo；显式传入 undefined 表示 token 未绑定工作区（默认参数会把 undefined 吃掉）。
  return { service, audit, methods: toolPermissionMethods(service, arguments.length === 0 ? 'D:/repo' : owner) };
}

const CALL = {
  tool: 'bash', workspace: 'D:/repo', origin: 'main', preset: 'auto', sessionId: 's1',
  command: 'npm run build',
  flags: {
    dangerousCommand: false, mutatingCommand: false, protectedPath: false, outsideWorkspace: false,
    network: false, mcp: false, codeExec: false, write: false,
  },
};

describe('toolPermissionMethods', () => {
  it('exposes exactly the three tool permission methods', async () => {
    const { methods } = await fixture();
    expect(Object.keys(methods).sort()).toEqual(['permission.tool.evaluate', 'permission.tool.remember', 'permission.tool.settle']);
  });

  it('evaluates a call passed as params.call', async () => {
    const { methods } = await fixture();
    const result = await methods['permission.tool.evaluate']({ call: CALL });
    expect(result).toMatchObject({ decision: 'allow' });
  });

  it('rejects a params payload without a call object', async () => {
    const { methods } = await fixture();
    await expect(methods['permission.tool.evaluate']({})).rejects.toThrow('invalid tool call');
  });

  it('rejects a call whose required fields have the wrong type', async () => {
    const { methods } = await fixture();
    await expect(methods['permission.tool.evaluate']({ call: { ...CALL, tool: 42 } })).rejects.toThrow('invalid tool call');
    await expect(methods['permission.tool.evaluate']({ call: { ...CALL, flags: null } })).rejects.toThrow('invalid tool call');
    await expect(methods['permission.tool.evaluate']({ call: { ...CALL, preset: 'nope' } })).rejects.toThrow('invalid tool call');
    await expect(methods['permission.tool.evaluate']({ call: { ...CALL, origin: 'nope' } })).rejects.toThrow('invalid tool call');
  });

  it('rejects a call whose flags are incomplete rather than defaulting them to false', async () => {
    const { methods } = await fixture();
    // 缺失的特征若当成 false，等于静默宣称「这不是危险命令」，方向与 fail-closed 相反。
    await expect(methods['permission.tool.evaluate']({
      call: { ...CALL, flags: { dangerousCommand: true } },
    })).rejects.toThrow('invalid tool call: flags.mutatingCommand');
    await expect(methods['permission.tool.evaluate']({
      call: { ...CALL, flags: { ...CALL.flags, network: 'yes' } },
    })).rejects.toThrow('invalid tool call: flags.network');
  });

  it('overrides the caller-supplied workspace with the token owner', async () => {
    const { audit, methods } = await fixture('D:/repo');
    const result = await methods['permission.tool.evaluate']({
      call: { ...CALL, workspace: 'D:/someone-elses-project' },
    }) as { auditId: string };
    expect(audit.get(result.auditId)?.workspace).toBe('D:/repo');
  });

  it('rejects every call when the token owns no workspace', async () => {
    const { methods } = await fixture(undefined);
    await expect(methods['permission.tool.evaluate']({ call: CALL })).rejects.toThrow('workspace is not bound');
    await expect(methods['permission.tool.remember']({
      rule: { scope: 'global', scopeKey: '', tool: 'bash', matcherKind: 'any', matcher: '', effect: 'allow' },
    })).rejects.toThrow('workspace is not bound');
  });

  it('forces a remembered workspace rule onto the token owner', async () => {
    const { methods } = await fixture('D:/repo');
    const rule = await methods['permission.tool.remember']({
      rule: { scope: 'workspace', scopeKey: 'D:/elsewhere', tool: 'bash', matcherKind: 'any', matcher: '', effect: 'allow' },
    }) as { scopeKey: string };
    expect(rule.scopeKey).toBe('D:/repo');
  });

  it('remembers a rule', async () => {
    const { methods } = await fixture();
    const rule = await methods['permission.tool.remember']({
      rule: { scope: 'global', scopeKey: '', tool: 'bash', matcherKind: 'any', matcher: '', effect: 'allow' },
    });
    expect(rule).toMatchObject({ effect: 'allow', tool: 'bash' });
  });

  it('rejects a remembered rule with an unknown effect', async () => {
    const { methods } = await fixture();
    await expect(methods['permission.tool.remember']({
      rule: { scope: 'global', scopeKey: '', tool: 'bash', matcherKind: 'any', matcher: '', effect: 'maybe' },
    })).rejects.toThrow('invalid permission rule');
  });

  it('settles an audit row', async () => {
    const { methods } = await fixture();
    const decision = await methods['permission.tool.evaluate']({
      call: { ...CALL, flags: { ...CALL.flags, dangerousCommand: true } },
    }) as { auditId: string };
    await expect(methods['permission.tool.settle']({ auditId: decision.auditId, resolution: 'user_allow' }))
      .resolves.toEqual({ updated: true });
  });

  it('carries approvalRoute only when it is literally true, and accepts a timeout settlement', async () => {
    const { methods, audit } = await fixture();
    const dangerous = { ...CALL, origin: 'subagent', flags: { ...CALL.flags, dangerousCommand: true } };
    const routed = await methods['permission.tool.evaluate']({ call: { ...dangerous, approvalRoute: true } }) as { decision: string; auditId: string };
    expect(routed.decision).toBe('ask');
    const pinned = await methods['permission.tool.evaluate']({ call: { ...dangerous, approvalRoute: 'yes' } }) as { decision: string };
    expect(pinned.decision).toBe('deny');
    await expect(methods['permission.tool.settle']({ auditId: routed.auditId, resolution: 'timeout' }))
      .resolves.toEqual({ updated: true });
    expect(audit.get(routed.auditId)).toMatchObject({ resolution: 'timeout' });
  });

  it('rejects an unknown resolution', async () => {
    const { methods } = await fixture();
    await expect(methods['permission.tool.settle']({ auditId: 'x', resolution: 'whatever' }))
      .rejects.toThrow('invalid resolution');
  });
});
