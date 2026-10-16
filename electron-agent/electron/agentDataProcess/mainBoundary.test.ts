import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// agent-data.db 只能有一个持有者（agentdata-host）。主进程直接打开它会和子进程抢回滚日志锁，
// busy_timeout 期间两个进程都被同步阻塞。见 .agents/notes/implemented/architecture/2026-10-16-agentdata-host-process.md。
describe('main process boundary', () => {
  const main = readFileSync(join(__dirname, '..', 'main.ts'), 'utf8');

  it('main.ts never opens the AgentData database itself', () => {
    expect(main).not.toMatch(/from ['"]\.\/agentData\/storage['"]/);
    expect(main).not.toMatch(/new AgentDataStorage\(/);
    expect(main).not.toMatch(/new DatabaseSync\(/);
    expect(main).not.toMatch(/new PluginManager\(\{\s*storage:/);
  });

  it('agentdata-host is the default; inproc is an explicit fallback', () => {
    expect(main).toMatch(/process\.env\.GREN_AGENTDATA_PROCESS === 'inproc'/);
    expect(main).toMatch(/resolveAgentDataHostEntry\(entryInput\)/);
  });
});
