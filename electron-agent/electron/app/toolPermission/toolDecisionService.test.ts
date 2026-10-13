import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentDataStorage } from '../../agentData/storage';
import { __resetApprovalForTest, setApprovalPolicy } from '../../../../extensions/_shared/approval.js';
import { ToolAuditStore } from './auditStore';
import { ToolRuleStore } from './ruleStore';
import { ToolDecisionService } from './toolDecisionService';
import type { ToolCallFacts, ToolCallFlags } from './types';

const directories: string[] = [];
const stores: AgentDataStorage[] = [];

afterEach(async () => {
  __resetApprovalForTest();
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const NO_FLAGS: ToolCallFlags = {
  dangerousCommand: false, mutatingCommand: false, protectedPath: false, outsideWorkspace: false,
  network: false, mcp: false, codeExec: false, write: false,
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'tool-decision-'));
  directories.push(directory);
  const storage = new AgentDataStorage(join(directory, 'agent-data.db'));
  stores.push(storage);
  storage.migrate();
  const rules = new ToolRuleStore(storage.db, () => 42);
  const audit = new ToolAuditStore(storage.db, () => 42);
  return { rules, audit, service: new ToolDecisionService(rules, audit) };
}

function facts(over: Partial<ToolCallFacts> = {}): ToolCallFacts {
  return {
    tool: 'bash', workspace: 'D:/repo', origin: 'main', preset: 'auto', sessionId: 's1',
    command: 'npm run build', flags: { ...NO_FLAGS }, ...over,
  };
}

describe('ToolDecisionService.evaluate', () => {
  it('allows an unmatched call and audits it as auto', async () => {
    const { audit, service } = await fixture();
    const decision = service.evaluate(facts());
    expect(decision.decision).toBe('allow');
    expect(decision.ruleId).toBeUndefined();
    expect(audit.get(decision.auditId)).toMatchObject({ decision: 'allow', resolution: 'auto', tool: 'bash' });
  });

  it('applies a builtin rule and records its id', async () => {
    const { audit, service } = await fixture();
    const decision = service.evaluate(facts({ flags: { ...NO_FLAGS, dangerousCommand: true } }));
    expect(decision).toMatchObject({ decision: 'ask', ruleId: 'builtin.dangerous-command' });
    expect(audit.get(decision.auditId)).toMatchObject({ decision: 'ask', resolution: 'queued' });
  });

  it('applies a user rule and audits resolution as rule', async () => {
    const { rules, audit, service } = await fixture();
    const rule = rules.add({
      scope: 'workspace', scopeKey: 'D:/repo', tool: 'bash',
      matcherKind: 'command_prefix', matcher: 'npm run', effect: 'deny',
    });
    const decision = service.evaluate(facts());
    expect(decision).toMatchObject({ decision: 'deny', ruleId: rule.id });
    expect(audit.get(decision.auditId)).toMatchObject({ resolution: 'rule' });
  });

  it('lets a builtin deny outrank a user allow', async () => {
    const { rules, service } = await fixture();
    rules.add({ scope: 'global', scopeKey: '', tool: 'write', matcherKind: 'any', matcher: '', effect: 'allow' });
    const decision = service.evaluate(facts({
      tool: 'write', command: undefined, path: 'C:/Windows/x.dll',
      flags: { ...NO_FLAGS, write: true, protectedPath: true },
    }));
    expect(decision).toMatchObject({ decision: 'deny', ruleId: 'builtin.protected-path' });
  });

  it('lets a builtin ask outrank a user allow', async () => {
    const { rules, service } = await fixture();
    rules.add({ scope: 'global', scopeKey: '', tool: 'bash', matcherKind: 'any', matcher: '', effect: 'allow' });
    const decision = service.evaluate(facts({ flags: { ...NO_FLAGS, dangerousCommand: true } }));
    expect(decision).toMatchObject({ decision: 'ask', ruleId: 'builtin.dangerous-command' });
  });

  it('stores a queue payload only for headless ask decisions', async () => {
    const { audit, service } = await fixture();
    const withUi = service.evaluate(facts({ flags: { ...NO_FLAGS, dangerousCommand: true } }));
    const headless = service.evaluate(facts({ origin: 'goal', flags: { ...NO_FLAGS, dangerousCommand: true } }));
    expect(audit.get(withUi.auditId)?.queuePayload).toBeUndefined();
    expect(JSON.parse(audit.get(headless.auditId)?.queuePayload ?? '{}')).toMatchObject({ tool: 'bash' });
  });

  it('degrades to ask and still returns an audit id when the rule store throws', async () => {
    const { audit } = await fixture();
    const broken = new ToolDecisionService(
      {
        applicable: () => { throw new Error('database is locked'); },
        add: () => { throw new Error('not exercised by this test'); },
      } as never,
      audit,
    );
    const decision = broken.evaluate(facts());
    expect(decision.decision).toBe('ask');
    expect(audit.get(decision.auditId)).toMatchObject({ decision: 'ask', ruleId: 'builtin.rule-lookup-failed' });
  });

  it('writes the digested args rather than the raw payload', async () => {
    const { audit, service } = await fixture();
    const decision = service.evaluate(facts({
      tool: 'write', command: undefined, path: 'D:/repo/a.ts',
      rawArgs: { path: 'D:/repo/a.ts', content: 'x'.repeat(50_000) },
      flags: { ...NO_FLAGS, write: true },
    }));
    expect(audit.get(decision.auditId)?.args).toBe('{"path":"D:/repo/a.ts"}');
  });

  it('pins a subagent ask to deny, audited as auto with no queue payload', async () => {
    const { audit, service } = await fixture();
    const decision = service.evaluate(facts({ origin: 'subagent', flags: { ...NO_FLAGS, dangerousCommand: true } }));
    expect(decision).toMatchObject({ decision: 'deny', ruleId: 'builtin.subagent-ask-pinned' });
    const row = audit.get(decision.auditId);
    expect(row).toMatchObject({ decision: 'deny', resolution: 'auto', ruleId: 'builtin.subagent-ask-pinned' });
    expect(row?.queuePayload).toBeUndefined();
  });

  it('lets a subagent that can reach its parent window ask: queued until settled, no queue payload', async () => {
    const { audit, service } = await fixture();
    const decision = service.evaluate(facts({
      origin: 'subagent', approvalRoute: true, flags: { ...NO_FLAGS, dangerousCommand: true },
    }));
    expect(decision).toMatchObject({ decision: 'ask', ruleId: 'builtin.dangerous-command' });
    const row = audit.get(decision.auditId);
    expect(row).toMatchObject({ decision: 'ask', resolution: 'queued' });
    expect(row?.queuePayload).toBeUndefined();
    expect(service.settle(decision.auditId!, 'timeout')).toBe(true);
    expect(audit.get(decision.auditId)).toMatchObject({ resolution: 'timeout' });
  });

  it('an approval route does not loosen anything else for a subagent', async () => {
    const { service } = await fixture();
    const deny = service.evaluate(facts({
      origin: 'subagent', approvalRoute: true, tool: 'write', path: 'D:/repo/.git/config',
      flags: { ...NO_FLAGS, write: true, protectedPath: true },
    }));
    expect(deny).toMatchObject({ decision: 'deny', ruleId: 'builtin.protected-path' });
  });

  it('keeps goal ask queued (only subagent is pinned)', async () => {
    const { audit, service } = await fixture();
    const decision = service.evaluate(facts({ origin: 'goal', flags: { ...NO_FLAGS, dangerousCommand: true } }));
    expect(decision.decision).toBe('ask');
    expect(audit.get(decision.auditId)).toMatchObject({ resolution: 'queued' });
  });

  it('does not override a subagent allow or an explicit builtin deny', async () => {
    const { service } = await fixture();
    const allow = service.evaluate(facts({ origin: 'subagent' }));
    expect(allow.decision).toBe('allow');
    const deny = service.evaluate(facts({ origin: 'subagent', tool: 'write', path: 'D:/repo/.git/config', flags: { ...NO_FLAGS, write: true, protectedPath: true } }));
    expect(deny).toMatchObject({ decision: 'deny', ruleId: 'builtin.protected-path' });
  });

  it('pins the rule-lookup-failed ask for subagents too', async () => {
    const { audit } = await fixture();
    const broken = new ToolDecisionService(
      { applicable: () => { throw new Error('database is locked'); }, add: () => { throw new Error('unused'); } } as never,
      audit,
    );
    const decision = broken.evaluate(facts({ origin: 'subagent' }));
    expect(decision).toMatchObject({ decision: 'deny', ruleId: 'builtin.subagent-ask-pinned' });
  });
});

describe('ToolDecisionService approval preset', () => {
  it('按扩展现读的 facts.preset 决定：full 放行危险命令', async () => {
    const { service } = await fixture();
    const decision = service.evaluate(facts({ preset: 'full', flags: { ...NO_FLAGS, dangerousCommand: true } }));
    expect(decision.decision).toBe('allow');
    expect(decision.ruleId).toBeUndefined();
  });

  it('按扩展现读的 facts.preset 决定：ask 拦改动命令', async () => {
    const { service } = await fixture();
    const decision = service.evaluate(facts({ preset: 'ask', flags: { ...NO_FLAGS, mutatingCommand: true } }));
    expect(decision).toMatchObject({ decision: 'ask', ruleId: 'builtin.mutating-command' });
  });

  it('主进程的审批档表不再覆盖 facts.preset（表在 agent-host 子进程里）', async () => {
    const { service } = await fixture();
    setApprovalPolicy('full', 'D:/repo');
    const decision = service.evaluate(facts({ preset: 'auto', flags: { ...NO_FLAGS, dangerousCommand: true } }));
    expect(decision).toMatchObject({ decision: 'ask', ruleId: 'builtin.dangerous-command' });
  });
});

describe('ToolDecisionService.remember', () => {
  it('persists a rule from a user approval', async () => {
    const { rules, service } = await fixture();
    const rule = service.remember({
      scope: 'workspace', scopeKey: 'D:/repo', tool: 'bash',
      matcherKind: 'command_prefix', matcher: 'npm run', effect: 'allow',
    });
    expect(rules.list().map((r) => r.id)).toEqual([rule.id]);
  });
});

describe('ToolDecisionService.settle', () => {
  it('updates the audit row with the user answer', async () => {
    const { audit, service } = await fixture();
    const decision = service.evaluate(facts({ flags: { ...NO_FLAGS, dangerousCommand: true } }));
    expect(service.settle(decision.auditId, 'user_deny')).toBe(true);
    expect(audit.get(decision.auditId)).toMatchObject({ resolution: 'user_deny', resolvedAt: 42 });
  });
});
